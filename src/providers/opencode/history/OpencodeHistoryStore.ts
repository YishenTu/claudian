import * as fs from 'node:fs';

import {
  buildImageAttachmentFromBase64,
  parseImageDataUri,
} from '@/core/execution/imageAttachment';
import { extractUserQuery } from '@/core/prompt/promptContext';
import { decodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import { decodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import { resolveToolDiffData } from '@/core/tools/toolDiff';

import { extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import { isWriteEditTool, TOOL_ASK_USER_QUESTION } from '../../../core/tools/toolNames';
import type { ChatMessage, ContentBlock, ImageAttachment, ToolCallInfo } from '../../../core/types';
import { settleInterruptedTurn } from '../../../core/types';
import { encodeOpencodeModelId } from '../models';
import {
  normalizeOpencodeToolInput,
  normalizeOpencodeToolName,
  normalizeOpencodeToolResult,
  normalizeOpencodeToolResultDetails,
} from '../normalization/opencodeToolNormalization';
import { resolveExistingOpencodeDatabasePath } from '../runtime/OpencodePaths';
import type { OpencodeProviderState } from '../types';
import { loadOpencodeSessionRows, type StoredRow } from './OpencodeSqliteReader';
import { getMessageCompletedAt, getMessageCreatedAt, OpencodeTurnStats } from './OpencodeTurnStats';

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

  let rows: StoredRow[];
  try {
    rows = await loadOpencodeSessionRows(databasePath, sessionId, { environment });
  } catch (error) {
    return [createOpencodeHydrationDiagnosticMessage({
      databasePath,
      reason: formatUnknownError(error),
      sessionId,
    })];
  }

  return mapOpencodeV2Messages(rows, { databasePath, sessionId });
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

  const rows = await loadOpencodeSessionRows(databasePath, sessionId, { environment }).catch(() => null);
  let rawModelId: string | null = null;
  for (const row of rows ?? []) {
    const model = getObject(parseJSONObject(row.data)?.model);
    const providerId = getString(model?.providerID);
    const modelId = getString(model?.id);
    if (providerId && modelId) {
      rawModelId = `${providerId}/${modelId}`;
    }
  }
  return rawModelId ? encodeOpencodeModelId(rawModelId) : null;
}

function mapStoredMessage(
  message: StoredMessage,
  context: OpencodeHydrationDiagnosticContext,
): ChatMessage | null {
  const role = getString(message.info.role);
  const id = getString(message.info.id);
  if (!id) {
    return null;
  }
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }

  const createdAt = getMessageCreatedAt(message.info)
    ?? Date.now();

  if (role === 'user') {
    const nativePrompt = getJoinedTextParts(message.parts);
    // Replayed Claudian history is already shown from the sessions it came from.
    const recovery = decodeRecoveryPrompt(nativePrompt);
    const images = buildUserImages(message.parts, id);
    if (recovery?.currentInput === null && images.length === 0) return null;
    const rawPrompt = recovery ? recovery.currentInput ?? '' : nativePrompt;
    const sessionMessage = decodeSessionMessage(rawPrompt);
    const promptText = extractUserQuery(rawPrompt);
    return {
      assistantMessageId: undefined,
      content: promptText,
      ...(sessionMessage ? { sessionMessage: { from: sessionMessage.from, sessionId: sessionMessage.sessionId } } : {}),
      id,
      ...(images.length > 0 ? { images } : {}),
      role: 'user',
      timestamp: createdAt,
      userMessageId: id,
    };
  }

  const contentBlocks = buildAssistantContentBlocks(message.parts);
  const toolCalls = buildAssistantToolCalls(message.parts);
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
      && !message.contentBlocks?.some(block => block.type === 'context_compacted')
      && !previous.contentBlocks?.some(block => block.type === 'context_compacted')
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

function buildAssistantToolCalls(parts: StoredRow[]): ToolCallInfo[] {
  return parts.flatMap((part) => {
    if (getString(part.type) !== 'tool') {
      return [];
    }

    const id = getString(part.callID) ?? getString(part.id);
    const rawName = getString(part.tool) ?? getString(part.name);
    const state = getObject(part.state);
    const nativeStatus = mapToolStatus(getString(state?.status));
    if (!id || !rawName || !nativeStatus) {
      return [];
    }

    const input = normalizeOpencodeToolInput(rawName, getObject(state?.input) ?? {});
    const name = normalizeOpencodeToolName(rawName);
    const nativeContent = Array.isArray(state?.content) ? state.content.filter(isPlainObject) : [];
    const nativeResult = getString(state?.output) ?? getString(state?.error)
      ?? getString(getObject(state?.error)?.message)
      ?? (nativeContent.length ? nativeContent.filter((item) => item.type === 'text').map((item) => getString(item.text) ?? '').join('\n') : undefined);
    const rawOutput = {
      ...(nativeResult ? { output: nativeResult } : {}),
      ...(getObject(state?.metadata) ? { metadata: getObject(state?.metadata) } : {}),
    };
    const details = normalizeOpencodeToolResultDetails(rawName, input, rawOutput);
    const normalizedResult = nativeResult === undefined || nativeStatus === 'running'
      ? undefined
      : normalizeOpencodeToolResult(rawName, nativeResult, rawOutput);
    const result = normalizedResult?.content ?? nativeResult;
    const status = nativeStatus === 'completed' && normalizedResult?.isError ? 'error' : nativeStatus;

    const toolCall: ToolCallInfo = {
      id,
      input,
      name,
      result,
      resultFormat: details?.resultFormat,
      status,
      providerPayload: {
        rawInput: state?.input,
        rawName,
        rawOutput: state,
      },
    };

    if (details?.webSearchResults) {
      toolCall.webSearchResults = details.webSearchResults;
    }

    if (name === TOOL_ASK_USER_QUESTION) {
      toolCall.resolvedAnswers = details?.resolvedAnswers
        ?? extractResolvedAnswersFromResultText(result);
    }

    if (status === 'completed' && isWriteEditTool(name)) {
      const diffData = resolveToolDiffData(details?.diff, toolCall);
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

/**
 * A stopped turn has no completion: its replies after the last prompt, across
 * compaction, lose their timing and the last carries the interrupt; or the marker
 * stands in for a reply that never started.
 */
function markInterruptedTurn(messages: ChatMessage[], turnStart: number, marker: ChatMessage): void {
  const turn = messages.slice(turnStart);
  const replies = turn.slice(turn.findLastIndex(message => message.role === 'user') + 1)
    .filter(message => message.role === 'assistant' && !isOpencodeHydrationDiagnosticMessage(message));
  settleInterruptedTurn(replies);
  const last = replies.at(-1);
  if (last) last.isInterrupt = true;
  else if (turn.some(message => message.role === 'user')) messages.push(marker);
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
  // Compaction flushes segments mid-turn; only an idle entry ends the turn.
  let turnStart = 0;
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
      if (row.type === 'idle') {
        // V2 rows carry no turn ID: an idle entry ends the turn, so the rows since the last one share it.
        for (const message of result.slice(turnStart)) if (message.role === 'assistant') message.turnId = `opencode-turn-${turnStart}`;
        // The idle entry's outcome is the turn's authority: a step can abort and still resume.
        if (data.outcome === 'interrupted') {
          markInterruptedTurn(result, turnStart, {
            id: getString(row.id) ?? `opencode-interrupt-${result.length}`, role: 'assistant', content: '',
            timestamp: getMessageCreatedAt({ ...data, time_created: row.time_created }) ?? Date.now(), isInterrupt: true,
            turnId: `opencode-turn-${turnStart}`,
          });
        }
        turnStart = result.length;
      }
      if (row.type === 'compaction' && data.status === 'completed' && typeof row.id === 'string') {
        result.push({
          id: row.id, role: 'assistant', content: '',
          timestamp: getMessageCreatedAt({ ...data, time_created: row.time_created }) ?? Date.now(),
          contentBlocks: [{ type: 'context_compacted' }],
        });
      }
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
    }, context);
    if (message) {
      if (message.role === 'user') previousAssistant = undefined;
      else {
        if (previousAssistant) previousAssistant.turnStats = undefined;
        previousAssistant = message;
      }
      message.turnStats = stats.add(info);
      segment.push(message);
    }
  }
  flush();
  return result;
}
