import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ChatMessage,
  ContentBlock,
  ImageAttachment,
  ImageMediaType,
  ToolCallInfo,
} from '../../../core/types';
import {
  buildGrokToolProviderPayload,
  type GrokRawToolNameResolution,
  normalizeGrokToolCall,
  resolveGrokRawToolName,
} from '../normalization/grokToolNormalization';

const HISTORY_METHODS = new Set([
  '_x.ai/session/update',
  'session/update',
  'x.ai/session/update',
]);

export interface GrokHistoryUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

export interface ParsedGrokHistory {
  lastUsage?: GrokHistoryUsage;
  messages: ChatMessage[];
}

interface GrokHistoryRecord {
  method: string;
  params: Record<string, unknown>;
  timestamp: number;
}

interface StoredTool {
  id: string;
  input: Record<string, unknown>;
  name: string;
  output: string;
  rawInput: unknown;
  rawName: string;
  rawNameProvenance: GrokRawToolNameResolution['provenance'];
  rawOutput: unknown;
  status: ToolCallInfo['status'];
}

interface PendingTurn {
  assistantContent: string;
  assistantId?: string;
  blocks: ContentBlock[];
  images: ImageAttachment[];
  isInterjection: boolean;
  promptIndex: number | null;
  timelinePromptIndex: number | null;
  startedAt: number;
  tools: Map<string, StoredTool>;
  toolOrder: string[];
  turnIndex: number;
  userContent: string;
  userId?: string;
}

interface CompletedTurn {
  messages: ChatMessage[];
  promptIndex: number;
  usage?: GrokHistoryUsage;
}

export function parseGrokHistoryContent(
  content: string,
  sessionId: string,
): ParsedGrokHistory {
  let completedTurns: CompletedTurn[] = [];
  let pending: PendingTurn | null = null;
  let activePromptIndex: number | null = null;
  let nextFallbackPromptIndex = 0;
  let turnIndex = 0;

  const commitPending = (
    turn: PendingTurn,
    promptId?: string,
    usage?: GrokHistoryUsage,
  ): boolean => {
    const messages = finalizeTurn(turn, sessionId, promptId);
    if (messages.length === 0 || turn.timelinePromptIndex === null) return false;
    completedTurns.push({
      messages,
      promptIndex: turn.timelinePromptIndex,
      ...(usage ? { usage } : {}),
    });
    turnIndex += 1;
    return true;
  };

  for (const line of content.split(/\r?\n/)) {
    const record = parseRecord(line);
    if (!record || !HISTORY_METHODS.has(record.method)) {
      continue;
    }
    if (readString(record.params.sessionId) !== sessionId) {
      continue;
    }
    const update = readRecord(record.params.update);
    if (!update) {
      continue;
    }

    const updateType = readString(update.sessionUpdate) ?? readString(update.type);
    if (updateType === 'rewind_marker') {
      const targetPromptIndex = readNonNegativeInteger(update.target_prompt_index)
        ?? readNonNegativeInteger(update.targetPromptIndex);
      pending = null;
      if (targetPromptIndex !== null) {
        completedTurns = completedTurns.filter(turn => turn.promptIndex < targetPromptIndex);
        activePromptIndex = completedTurns.at(-1)?.promptIndex ?? null;
        nextFallbackPromptIndex = targetPromptIndex;
        turnIndex = completedTurns.length;
      }
      continue;
    }
    if (updateType === 'user_message_chunk') {
      const incomingUserId = resolveGrokUpdateMessageId(
        update,
        'user',
        record.params._meta,
      );
      const incomingPromptIndex = readPromptIndex(update);
      const hasPendingUserContent = Boolean(
        pending
        && (pending.userContent || pending.images.length > 0),
      );
      const startsEarlyInterjection = Boolean(
        pending
        && incomingPromptIndex === null
        && (
          pending.promptIndex !== null
          || (pending.isInterjection && hasPendingUserContent && isTextContent(update.content))
        ),
      );
      const startsNewTurn = pending && (
        pending.assistantContent
        || pending.blocks.length > 0
        || startsEarlyInterjection
        || (
          hasPendingUserContent
          && pending.userId !== undefined
          && incomingUserId !== undefined
          && pending.userId !== incomingUserId
        )
      );
      if (pending && startsNewTurn) {
        if (
          startsEarlyInterjection
          || pending.assistantContent
          || pending.blocks.length > 0
          || pending.tools.size > 0
        ) {
          commitPending(pending);
        }
        pending = createPendingTurn(
          turnIndex,
          record.timestamp,
          startsEarlyInterjection,
        );
      } else if (!pending) {
        pending = createPendingTurn(turnIndex, record.timestamp);
      }
      if (incomingPromptIndex !== null) {
        pending.promptIndex ??= incomingPromptIndex;
        pending.timelinePromptIndex ??= incomingPromptIndex;
        activePromptIndex = incomingPromptIndex;
        nextFallbackPromptIndex = Math.max(
          nextFallbackPromptIndex,
          incomingPromptIndex + 1,
        );
      } else if (pending.timelinePromptIndex === null) {
        if (pending.isInterjection && activePromptIndex !== null) {
          pending.timelinePromptIndex = activePromptIndex;
        } else {
          pending.timelinePromptIndex = nextFallbackPromptIndex;
          activePromptIndex = nextFallbackPromptIndex;
          nextFallbackPromptIndex += 1;
        }
      }
      const text = extractContentText(update.content);
      pending.userContent += text;
      const image = extractImageAttachment(
        update.content,
        sessionId,
        pending.turnIndex,
        pending.images.length,
      );
      if (image) pending.images.push(image);
      pending.userId ??= incomingUserId;
      continue;
    }

    if (!pending) {
      continue;
    }

    if (updateType === 'agent_thought_chunk') {
      const text = extractContentText(update.content);
      appendContentBlock(pending.blocks, 'thinking', text);
      continue;
    }

    if (updateType === 'agent_message_chunk') {
      const text = extractContentText(update.content);
      pending.assistantContent += text;
      pending.assistantId ??= resolveGrokUpdateMessageId(
        update,
        'assistant',
        record.params._meta,
      );
      appendContentBlock(pending.blocks, 'text', text);
      continue;
    }

    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      reconcileToolUpdate(pending, update);
      continue;
    }

    if (updateType === 'turn_completed') {
      const promptId = readString(update.prompt_id) ?? readString(update.promptId);
      const usage = normalizeUsage(update.usage);
      commitPending(pending, promptId, usage);
      pending = null;
    }
  }

  const messages = completedTurns.flatMap(turn => turn.messages);
  let lastUsage: GrokHistoryUsage | undefined;
  for (let index = completedTurns.length - 1; index >= 0; index -= 1) {
    if (completedTurns[index].usage) {
      lastUsage = completedTurns[index].usage;
      break;
    }
  }
  return {
    ...(lastUsage ? { lastUsage } : {}),
    messages,
  };
}

export async function loadGrokHistory(
  sessionDirectory: string,
  sessionId: string,
): Promise<ParsedGrokHistory> {
  try {
    const content = await fs.readFile(path.join(sessionDirectory, 'updates.jsonl'), 'utf8');
    return parseGrokHistoryContent(content, sessionId);
  } catch {
    return { messages: [] };
  }
}

export function resolveGrokPromptIndexAfterAssistant(
  content: string,
  sessionId: string,
  resumeAt: string,
): number | null {
  let activePromptIndex: number | null = null;
  let nextFallbackPromptIndex = 0;

  for (const line of content.split(/\r?\n/)) {
    const record = parseRecord(line);
    if (!record || !HISTORY_METHODS.has(record.method)) continue;
    if (readString(record.params.sessionId) !== sessionId) continue;
    const update = readRecord(record.params.update);
    if (!update) continue;
    const updateType = readString(update.sessionUpdate) ?? readString(update.type);

    if (updateType === 'rewind_marker') {
      const target = readNonNegativeInteger(update.target_prompt_index)
        ?? readNonNegativeInteger(update.targetPromptIndex);
      if (target !== null) nextFallbackPromptIndex = target;
      activePromptIndex = null;
      continue;
    }
    if (updateType === 'user_message_chunk') {
      const advertisedPromptIndex = readPromptIndex(update);
      if (advertisedPromptIndex !== null) {
        activePromptIndex = advertisedPromptIndex;
        nextFallbackPromptIndex = Math.max(
          nextFallbackPromptIndex,
          advertisedPromptIndex + 1,
        );
      } else if (activePromptIndex === null) {
        activePromptIndex = nextFallbackPromptIndex;
        nextFallbackPromptIndex += 1;
      }
      continue;
    }
    if (
      updateType === 'agent_message_chunk'
      && resolveGrokUpdateMessageId(update, 'assistant', record.params._meta) === resumeAt
      && activePromptIndex !== null
    ) {
      return activePromptIndex + 1;
    }
    if (updateType === 'turn_completed') {
      const promptId = readString(update.prompt_id) ?? readString(update.promptId);
      if (promptId === resumeAt && activePromptIndex !== null) {
        return activePromptIndex + 1;
      }
      activePromptIndex = null;
    }
  }

  return resolveLegacyForkTargetPromptIndex(content, sessionId, resumeAt);
}

function resolveLegacyForkTargetPromptIndex(
  content: string,
  sessionId: string,
  resumeAt: string,
): number | null {
  let completedPrompts = 0;
  for (const message of parseGrokHistoryContent(content, sessionId).messages) {
    if (message.role === 'user' && message.userMessageId) {
      completedPrompts += 1;
      continue;
    }
    if (message.assistantMessageId === resumeAt) {
      return completedPrompts;
    }
  }
  return null;
}

export async function loadGrokPromptIndexAfterAssistant(
  sessionDirectory: string,
  sessionId: string,
  resumeAt: string,
): Promise<number | null> {
  try {
    const content = await fs.readFile(path.join(sessionDirectory, 'updates.jsonl'), 'utf8');
    return resolveGrokPromptIndexAfterAssistant(content, sessionId, resumeAt);
  } catch {
    return null;
  }
}

function createPendingTurn(
  turnIndex: number,
  timestamp: number,
  isInterjection = false,
): PendingTurn {
  return {
    assistantContent: '',
    blocks: [],
    images: [],
    isInterjection,
    promptIndex: null,
    timelinePromptIndex: null,
    startedAt: normalizeTimestamp(timestamp),
    tools: new Map(),
    toolOrder: [],
    turnIndex,
    userContent: '',
  };
}

function reconcileToolUpdate(turn: PendingTurn, update: Record<string, unknown>): void {
  const id = readString(update.toolCallId);
  if (!id) {
    return;
  }
  const current = turn.tools.get(id);
  const rawNameResolution = resolveGrokRawToolName(current ? {
    provenance: current.rawNameProvenance,
    rawName: current.rawName,
  } : undefined, {
    kind: readString(update.kind),
    title: readString(update.title),
  });
  const rawName = rawNameResolution.rawName;
  const rawInput = update.rawInput !== undefined ? update.rawInput : current?.rawInput;
  const renderedContent = renderToolContent(update.content);
  const rawOutput = update.rawOutput !== undefined
    ? update.rawOutput
    : current?.rawOutput;
  const normalized = normalizeGrokToolCall({
    kind: readString(update.kind),
    rawInput,
    rawOutput,
    title: rawName,
  }, rawNameResolution);
  const status = normalizeToolStatus(readString(update.status), current?.status);
  const output = renderedContent || (update.rawOutput === undefined
    ? current?.output || normalized.output
    : normalized.output || current?.output) || '';

  if (!current) {
    turn.toolOrder.push(id);
    turn.blocks.push({ toolId: id, type: 'tool_use' });
  }
  turn.tools.set(id, {
    id,
    input: normalized.input,
    name: normalized.name,
    output,
    rawInput,
    rawName,
    rawNameProvenance: rawNameResolution.provenance,
    rawOutput,
    status,
  });
}

function finalizeTurn(
  turn: PendingTurn,
  sessionId: string,
  promptId?: string,
): ChatMessage[] {
  if (!turn.userContent && turn.images.length === 0) {
    return [];
  }
  const scope = sanitizeId(sessionId);
  const userId = turn.userId ?? `grok-${scope}-turn-${turn.turnIndex}-user`;
  const assistantId = turn.assistantId
    ?? promptId
    ?? `grok-${scope}-turn-${turn.turnIndex}-assistant`;
  const user: ChatMessage = {
    content: turn.userContent,
    id: userId,
    role: 'user',
    timestamp: turn.startedAt,
    ...(!turn.isInterjection ? { userMessageId: userId } : {}),
    ...(turn.images.length > 0 ? { images: turn.images } : {}),
  };

  if (!turn.assistantContent && turn.blocks.length === 0 && turn.tools.size === 0) {
    return [user];
  }
  const toolCalls = turn.toolOrder.flatMap((id) => {
    const tool = turn.tools.get(id);
    if (!tool) {
      return [];
    }
    return [{
      id: tool.id,
      input: tool.input,
      name: tool.name,
      providerPayload: buildGrokToolProviderPayload({
        rawInput: tool.rawInput,
        rawName: tool.rawName,
        rawOutput: tool.rawOutput,
      }),
      ...(tool.output ? { result: tool.output } : {}),
      status: tool.status,
    } satisfies ToolCallInfo];
  });
  const assistant: ChatMessage = {
    assistantMessageId: assistantId,
    content: turn.assistantContent,
    ...(turn.blocks.length > 0 ? { contentBlocks: turn.blocks } : {}),
    id: assistantId,
    role: 'assistant',
    timestamp: turn.startedAt,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return [user, assistant];
}

function appendContentBlock(
  blocks: ContentBlock[],
  type: 'text' | 'thinking',
  content: string,
): void {
  if (!content) {
    return;
  }
  const previous = blocks[blocks.length - 1];
  if (previous?.type === type) {
    previous.content += content;
    return;
  }
  blocks.push({ content, type });
}

function normalizeToolStatus(
  value: string | undefined,
  fallback: ToolCallInfo['status'] | undefined,
): ToolCallInfo['status'] {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'error';
  if (value === 'pending' || value === 'in_progress') return 'running';
  return fallback ?? 'running';
}

function extractContentText(value: unknown): string {
  const content = readRecord(value);
  if (!content) {
    return '';
  }
  if (content.type === 'text') {
    return typeof content.text === 'string' ? content.text : '';
  }
  const resource = readRecord(content.resource);
  return resource && typeof resource.text === 'string' ? resource.text : '';
}

function isTextContent(value: unknown): boolean {
  return readRecord(value)?.type === 'text';
}

function extractImageAttachment(
  value: unknown,
  sessionId: string,
  turnIndex: number,
  imageIndex: number,
): ImageAttachment | null {
  const content = readRecord(value);
  if (!content || content.type !== 'image') return null;
  const data = readString(content.data);
  const mediaType = readImageMediaType(content.mimeType);
  if (!data || !mediaType) return null;
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length);
  return {
    data,
    id: `grok-${sanitizeId(sessionId)}-turn-${turnIndex}-image-${imageIndex}`,
    mediaType,
    name: `Grok image ${imageIndex + 1}.${extension}`,
    size: Buffer.from(data, 'base64').byteLength,
    source: 'file',
  };
}

function readImageMediaType(value: unknown): ImageMediaType | null {
  switch (value) {
    case 'image/gif':
    case 'image/jpeg':
    case 'image/png':
    case 'image/webp':
      return value;
    default:
      return null;
  }
}

function renderToolContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    if (!record) {
      return [];
    }
    if (record.type === 'content') {
      const text = extractContentText(record.content);
      return text ? [text] : [];
    }
    if (record.type === 'diff') {
      const targetPath = readString(record.path);
      return targetPath ? [`Diff: ${targetPath}`] : [];
    }
    if (record.type === 'terminal') {
      const terminalId = readString(record.terminalId);
      return terminalId ? [`Terminal: ${terminalId}`] : [];
    }
    return [];
  }).join('\n\n');
}

export function resolveGrokUpdateMessageId(
  value: unknown,
  role: 'assistant' | 'user',
  notificationMetadata?: unknown,
): string | undefined {
  const update = readRecord(value);
  if (!update) return undefined;
  const updateMetadata = readRecord(update._meta);
  const outerMetadata = readRecord(notificationMetadata);
  return readString(update.messageId)
    ?? readString(updateMetadata?.eventId)
    ?? readString(outerMetadata?.eventId)
    ?? readString(updateMetadata?.promptId)
    ?? readString(outerMetadata?.promptId)
    ?? (typeof updateMetadata?.promptIndex === 'number'
      ? `${role}-${updateMetadata.promptIndex}`
      : undefined);
}

function readPromptIndex(update: Record<string, unknown>): number | null {
  const metadata = readRecord(update._meta);
  return readNonNegativeInteger(metadata?.promptIndex);
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(value: unknown): GrokHistoryUsage | undefined {
  const usage = readRecord(value);
  if (!usage) {
    return undefined;
  }
  const normalized: GrokHistoryUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) {
      normalized[key] = usage[key];
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseRecord(line: string): GrokHistoryRecord | null {
  if (!line.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    const record = readRecord(parsed);
    const params = readRecord(record?.params);
    const method = readString(record?.method);
    if (!record || !params || !method) {
      return null;
    }
    return {
      method,
      params,
      timestamp: typeof record.timestamp === 'number' ? record.timestamp : 0,
    };
  } catch {
    return null;
  }
}

function normalizeTimestamp(value: number): number {
  return value > 0 && value < 1_000_000_000_000 ? value * 1_000 : value;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'session';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
