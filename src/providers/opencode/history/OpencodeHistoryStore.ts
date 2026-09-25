import * as fs from 'node:fs';

import { extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import { isWriteEditTool, TOOL_ASK_USER_QUESTION } from '../../../core/tools/toolNames';
import type { ChatMessage, ContentBlock, ImageAttachment, ToolCallInfo } from '../../../core/types';
import { extractUserQuery } from '../../../utils/context';
import { extractDiffData } from '../../../utils/diff';
import {
  buildImageAttachmentFromBase64,
  parseImageDataUri,
} from '../../../utils/imageAttachment';
import { encodeOpencodeModelId } from '../models';
import {
  normalizeOpencodeToolInput,
  normalizeOpencodeToolName,
  normalizeOpencodeToolUseResult,
} from '../normalization/opencodeToolNormalization';
import { resolveExistingOpencodeDatabasePath } from '../runtime/OpencodePaths';
import type { OpencodeProviderState } from '../types';
import {
  loadOpencodeSessionRows,
  type StoredRow,
  type StoredSessionRows,
} from './OpencodeSqliteReader';
import { getMessageCompletedAt, getMessageCreatedAt, OpencodeTurnStats } from './OpencodeTurnStats';

export { OPENCODE_MESSAGE_ROW_SQL } from './OpencodeSqliteReader';

interface StoredMessage {
  info: StoredRow;
  parts: StoredRow[];
}

interface OpencodeHydrationDiagnosticContext {
  databasePath?: string;
  sessionId?: string;
}

const OPENCODE_HYDRATION_DIAGNOSTIC_ID_PREFIX = 'opencode-hydration-error';

export async function loadOpencodeSessionMessages(
  sessionId: string,
  providerState?: OpencodeProviderState,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ChatMessage[]> {
  const databasePath = resolveExistingOpencodeDatabasePath(providerState?.databasePath, environment);
  if (!databasePath || databasePath === ':memory:' || !fs.existsSync(databasePath)) {
    return [];
  }

  let rows: StoredSessionRows;
  try {
    rows = await loadOpencodeSessionRows(databasePath, sessionId, { environment, nativeVersion: providerState?.nativeVersion === 2 ? 2 : 'auto' });
  } catch (error) {
    return [createOpencodeHydrationDiagnosticMessage({
      databasePath,
      reason: formatUnknownError(error),
      sessionId,
    })];
  }

  if (rows.nativeVersion === 2) return mapOpencodeV2Messages(rows.messageRows, { databasePath, sessionId });

  return mapOpencodeMessages(
    hydrateStoredMessages(rows.messageRows, rows.partRows),
    { databasePath, sessionId },
  );
}

export async function loadOpencodeSessionModel(
  sessionId: string,
  providerState?: OpencodeProviderState,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const databasePath = resolveExistingOpencodeDatabasePath(providerState?.databasePath, environment);
  if (!databasePath || databasePath === ':memory:' || !fs.existsSync(databasePath)) {
    return null;
  }

  const rows = await loadOpencodeSessionRows(databasePath, sessionId, { environment, nativeVersion: providerState?.nativeVersion === 2 ? 2 : 'auto' }).catch(() => null);
  let rawModelId: string | null = null;
  for (const row of rows?.messageRows ?? []) {
    const data = parseJSONObject(row.data);
    const model = rows?.nativeVersion === 2 ? getObject(data?.model) : null;
    const providerId = getString(model?.providerID) ?? getString(row.provider_id) ?? getString(data?.providerID);
    const modelId = getString(model?.id) ?? getString(row.model_id) ?? getString(data?.modelID);
    if (providerId && modelId) {
      rawModelId = `${providerId}/${modelId}`;
    }
  }
  return rawModelId ? encodeOpencodeModelId(rawModelId) : null;
}

export function mapOpencodeMessages(
  messages: StoredMessage[],
  context: OpencodeHydrationDiagnosticContext = {},
): ChatMessage[] {
  const mappedMessages: ChatMessage[] = [];
  const stats = new OpencodeTurnStats();
  let previousAssistant: ChatMessage | undefined;

  for (const message of messages) {
    try {
      const mappedMessage = mapStoredMessage(message, context);
      if (mappedMessage) {
        if (mappedMessage.role === 'user') previousAssistant = undefined;
        else {
          if (previousAssistant) previousAssistant.turnStats = undefined;
          previousAssistant = mappedMessage;
        }
        mappedMessage.turnStats = stats.add(message.info, 1);
        mappedMessages.push(mappedMessage);
      }
    } catch (error) {
      stats.reset();
      previousAssistant = undefined;
      mappedMessages.push(createOpencodeHydrationDiagnosticMessage({
        ...context,
        messageId: getString(message.info.id) ?? undefined,
        reason: formatUnknownError(error),
      }));
    }
  }

  return mergeAdjacentAssistantMessages(mappedMessages);
}

function hydrateStoredMessages(
  messageRows: StoredRow[],
  partRows: StoredRow[],
): StoredMessage[] {
  const partsByMessage = new Map<string, StoredRow[]>();

  for (const row of partRows) {
    const messageId = getString(row.message_id);
    const id = getString(row.id);
    const data = parseJSONObject(row.data);
    if (!messageId || !id || !data) {
      continue;
    }

    const parts = partsByMessage.get(messageId) ?? [];
    parts.push({ ...data, id });
    partsByMessage.set(messageId, parts);
  }

  return messageRows.flatMap((row) => {
    const id = getString(row.id);
    if (!id) {
      return [];
    }

    const data = parseJSONObject(row.data);
    return [{
      info: data
        ? { ...data, id, time_created: row.time_created }
        : {
            data_time_completed: row.data_time_completed,
            data_time_created: row.data_time_created,
            data_valid: row.data_valid,
            parentID: row.parent_id,
            tokens: { output: row.output_tokens, reasoning: row.reasoning_tokens },
            finish: row.finish,
            error: row.error,
            id,
            role: row.role,
            time_created: row.time_created,
          },
      parts: partsByMessage.get(id) ?? [],
    }];
  });
}

function mapStoredMessage(
  message: StoredMessage,
  context: OpencodeHydrationDiagnosticContext,
  nativeVersion: 1 | 2 = 1,
): ChatMessage | null {
  const role = getString(message.info.role);
  const id = getString(message.info.id);
  if (!id) {
    return null;
  }
  if (isInvalidStoredMessageData(message.info)) {
    return createOpencodeHydrationDiagnosticMessage({
      ...context,
      messageId: id,
      reason: 'OpenCode message metadata is not valid JSON.',
    });
  }
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }

  const createdAt = getMessageCreatedAt(message.info)
    ?? Date.now();

  if (role === 'user') {
    const promptText = extractUserQuery(getJoinedTextParts(message.parts));
    const images = buildUserImages(message.parts, id);
    return {
      assistantMessageId: undefined,
      content: promptText,
      id,
      ...(images.length > 0 ? { images } : {}),
      role: 'user',
      timestamp: createdAt,
      userMessageId: id,
    };
  }

  const contentBlocks = buildAssistantContentBlocks(message.parts);
  const toolCalls = buildAssistantToolCalls(message.parts, nativeVersion);
  const completedAt = getMessageCompletedAt(message.info);
  const durationSeconds = completedAt && completedAt >= createdAt
    ? Math.max(0, (completedAt - createdAt) / 1_000)
    : undefined;

  return {
    assistantMessageId: id,
    content: contentBlocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.content)
      .join(''),
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
    durationSeconds,
    completedAt: durationSeconds !== undefined ? completedAt ?? undefined : undefined,
    id,
    role: 'assistant',
    timestamp: createdAt,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function mergeAdjacentAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      message.role === 'assistant'
      && previous?.role === 'assistant'
      && !message.isInterrupt
      && !previous.isInterrupt
      && !isOpencodeHydrationDiagnosticMessage(message)
      && !isOpencodeHydrationDiagnosticMessage(previous)
    ) {
      previous.content += message.content;
      previous.assistantMessageId = message.assistantMessageId ?? previous.assistantMessageId;
      previous.durationFlavorWord = message.durationFlavorWord ?? previous.durationFlavorWord;
      previous.durationSeconds = mergeAssistantDurationSeconds(previous, message);
      previous.completedAt = message.completedAt;
      previous.turnStats = message.turnStats;
      previous.toolCalls = mergeOptionalArrays(previous.toolCalls, message.toolCalls);
      previous.contentBlocks = mergeOptionalArrays(previous.contentBlocks, message.contentBlocks);
      continue;
    }

    merged.push(message);
  }

  return merged;
}

function mergeOptionalArrays<T>(left?: T[], right?: T[]): T[] | undefined {
  if (!left?.length && !right?.length) {
    return undefined;
  }

  return [
    ...(left ?? []),
    ...(right ?? []),
  ];
}

function mergeAssistantDurationSeconds(
  first: ChatMessage,
  next: ChatMessage,
): number | undefined {
  const firstEnd = getMessageCompletionTime(first);
  const nextEnd = getMessageCompletionTime(next);
  if (firstEnd === null && nextEnd === null) {
    return undefined;
  }

  const end = Math.max(firstEnd ?? first.timestamp, nextEnd ?? next.timestamp);
  return Math.max(0, (end - first.timestamp) / 1_000);
}

function getMessageCompletionTime(message: ChatMessage): number | null {
  if (typeof message.durationSeconds !== 'number') {
    return null;
  }

  return message.timestamp + (message.durationSeconds * 1_000);
}

function isInvalidStoredMessageData(info: StoredRow): boolean {
  return getNumber(info.data_valid) === 0;
}

export function createOpencodeHydrationDiagnosticMessage(params: {
  databasePath?: string;
  messageId?: string;
  reason: string;
  sessionId?: string;
}): ChatMessage {
  const detailLines = [
    'Failed to hydrate OpenCode session.',
    'provider: OpenCode',
    ...(params.sessionId ? [`sessionId: ${params.sessionId}`] : []),
    ...(params.databasePath ? [`databasePath: ${params.databasePath}`] : []),
    ...(params.messageId ? [`messageId: ${params.messageId}`] : []),
    `reason: ${params.reason}`,
  ];
  const details = detailLines.join('\n');
  const fenceLength = (details.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3);
  const fence = '`'.repeat(fenceLength);
  const content = `${fence}text\n${details}\n${fence}`;

  return {
    assistantMessageId: undefined,
    content,
    contentBlocks: [{ content, type: 'text' }],
    id: buildOpencodeHydrationDiagnosticId(params),
    role: 'assistant',
    timestamp: Date.now(),
  };
}

function buildOpencodeHydrationDiagnosticId(params: {
  messageId?: string;
  sessionId?: string;
}): string {
  const scope = params.messageId ? 'message' : 'session';
  const rawId = params.messageId ?? params.sessionId ?? String(Date.now());
  const safeId = rawId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || String(Date.now());
  return `${OPENCODE_HYDRATION_DIAGNOSTIC_ID_PREFIX}-${scope}-${safeId}`;
}

export function isOpencodeSessionHydrationDiagnosticMessage(message: ChatMessage): boolean {
  return message.id.startsWith(`${OPENCODE_HYDRATION_DIAGNOSTIC_ID_PREFIX}-session-`);
}

function isOpencodeHydrationDiagnosticMessage(message: ChatMessage): boolean {
  return message.id.startsWith(OPENCODE_HYDRATION_DIAGNOSTIC_ID_PREFIX);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildAssistantContentBlocks(parts: StoredRow[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    switch (getString(part.type)) {
      case 'reasoning': {
        const text = getString(part.text)?.trim();
        if (!text) {
          break;
        }
        blocks.push({
          content: text,
          durationSeconds: getDurationSeconds(part),
          type: 'thinking',
        });
        break;
      }
      case 'text': {
        const text = getString(part.text);
        if (!text || getBoolean(part.ignored)) {
          break;
        }
        blocks.push({
          content: text,
          type: 'text',
        });
        break;
      }
      case 'tool': {
        const toolId = getString(part.callID) ?? getString(part.id);
        if (!toolId) {
          break;
        }
        blocks.push({
          toolId,
          type: 'tool_use',
        });
        break;
      }
    }
  }

  return blocks;
}

function buildAssistantToolCalls(parts: StoredRow[], nativeVersion: 1 | 2): ToolCallInfo[] {
  return parts.flatMap((part) => {
    if (getString(part.type) !== 'tool') {
      return [];
    }

    const id = getString(part.callID) ?? getString(part.id);
    const rawName = getString(part.tool) ?? getString(part.name);
    const state = getObject(part.state);
    const status = mapToolStatus(getString(state?.status));
    if (!id || !rawName || !status) {
      return [];
    }

    const input = normalizeOpencodeToolInput(rawName, getObject(state?.input) ?? {});
    const name = normalizeOpencodeToolName(rawName);
    const nativeContent = Array.isArray(state?.content) ? state.content.filter(isPlainObject) : [];
    const result = getString(state?.output) ?? getString(state?.error)
      ?? getString(getObject(state?.error)?.message)
      ?? (nativeContent.length ? nativeContent.filter((item) => item.type === 'text').map((item) => getString(item.text) ?? '').join('\n') : undefined);
    const toolUseResult = normalizeOpencodeToolUseResult(rawName, input, {
      ...(result ? { output: result } : {}),
      ...(getObject(state?.metadata) ? { metadata: getObject(state?.metadata) } : {}),
    });

    const toolCall: ToolCallInfo = {
      id,
      input,
      name,
      result,
      status,
      ...(nativeVersion === 2 ? { providerPayload: {
        rawInput: state?.input,
        rawName,
        rawOutput: state,
      } } : {}),
    };

    if (name === TOOL_ASK_USER_QUESTION) {
      toolCall.resolvedAnswers = toolUseResult?.answers as ToolCallInfo['resolvedAnswers']
        ?? extractResolvedAnswersFromResultText(result);
    }

    if (status === 'completed' && isWriteEditTool(name)) {
      const diffData = extractDiffData(toolUseResult, toolCall);
      if (diffData) {
        toolCall.diffData = diffData;
      }
    }

    return [toolCall];
  });
}

function getJoinedTextParts(parts: StoredRow[]): string {
  return parts
    .filter((part) => getString(part.type) === 'text' && !getBoolean(part.ignored))
    .map((part) => getString(part.text) ?? '')
    .join('');
}

function buildUserImages(parts: StoredRow[], messageId: string): ImageAttachment[] {
  const images: ImageAttachment[] = [];

  for (const part of parts) {
    if (getString(part.type) !== 'file') {
      continue;
    }

    const parsed = parseImageDataUri(getString(part.url));
    const mime = getString(part.mime);
    const mediaType = parsed?.mediaType ?? mime;
    const data = parsed?.data ?? getString(part.data);
    if (!data || !mediaType) {
      continue;
    }

    const image = buildImageAttachmentFromBase64({
      data,
      id: `opencode-img-${messageId}-${images.length}`,
      mediaType,
      name: getString(part.filename) ?? getString(part.name) ?? `image-${images.length + 1}.${String(mediaType).split('/')[1] ?? 'img'}`,
    });
    if (image) {
      images.push(image);
    }
  }

  return images;
}

function getDurationSeconds(part: StoredRow): number | undefined {
  const start = getNestedNumber(part, ['time', 'start']) ?? getNestedNumber(part, ['time', 'created']);
  const end = getNestedNumber(part, ['time', 'end']) ?? getNestedNumber(part, ['time', 'completed']);
  if (start === null || end === null || end < start) {
    return undefined;
  }

  return Math.max(0, (end - start) / 1_000);
}

function mapToolStatus(status: string | null): ToolCallInfo['status'] | null {
  switch (status) {
    case 'streaming':
    case 'pending':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

function parseJSONObject(value: unknown): StoredRow | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getBoolean(value: unknown): boolean {
  return value === true;
}

function getObject(value: unknown): StoredRow | null {
  return isPlainObject(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function getNestedNumber(
  value: StoredRow,
  keys: string[],
): number | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!isPlainObject(current)) {
      return null;
    }
    current = current[key];
  }
  return getNumber(current);
}

/** v2 control entries delimit turns even when they have no chat presentation. */
export function mapOpencodeV2Messages(
  rows: StoredRow[],
  context: OpencodeHydrationDiagnosticContext = {},
): ChatMessage[] {
  return mapV2Messages(rows.map(row => ({ row, data: parseJSONObject(row.data) })), context);
}

export function mapOpencodeV2NativeMessages(
  messages: StoredRow[],
  context: OpencodeHydrationDiagnosticContext = {},
): ChatMessage[] {
  return mapV2Messages(messages.map(data => ({ row: data, data })), context);
}

function mapV2Messages(
  messages: Array<{ row: StoredRow; data: StoredRow | null }>,
  context: OpencodeHydrationDiagnosticContext,
): ChatMessage[] {
  const result: ChatMessage[] = [];
  let segment: ChatMessage[] = [];
  const stats = new OpencodeTurnStats();
  let previousAssistant: ChatMessage | undefined;
  const flush = () => {
    result.push(...mergeAdjacentAssistantMessages(segment));
    segment = [];
    stats.reset();
    previousAssistant = undefined;
  };
  for (const { row, data } of messages) {
    if (!data) {
      flush();
      result.push(createOpencodeHydrationDiagnosticMessage({
        ...context, messageId: getString(row.id) ?? undefined,
        reason: 'OpenCode message metadata is not valid JSON.',
      }));
      continue;
    }
    if (row.type !== 'user' && row.type !== 'assistant') {
      flush();
      continue;
    }
    const parts = row.type === 'user'
      ? [
          { type: 'text', text: data.text },
          ...(Array.isArray(data.files) ? data.files.filter(isPlainObject).map((file) => ({ ...file, type: 'file' })) : []),
        ]
      : Array.isArray(data.content) ? data.content.filter(isPlainObject) : [];
    const info = { ...data, id: row.id, role: row.type, time_created: row.time_created };
    const message = mapStoredMessage({
      info,
      parts,
    }, context, 2);
    if (message) {
      if (message.role === 'user') previousAssistant = undefined;
      else {
        if (previousAssistant) previousAssistant.turnStats = undefined;
        previousAssistant = message;
      }
      message.turnStats = stats.add(info, 2);
      segment.push(message);
    }
  }
  flush();
  return result;
}
