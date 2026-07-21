import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';
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
  startedAt: number;
  tools: Map<string, StoredTool>;
  toolOrder: string[];
  turnIndex: number;
  userContent: string;
  userId?: string;
}

export function parseGrokHistoryContent(
  content: string,
  sessionId: string,
): ParsedGrokHistory {
  const messages: ChatMessage[] = [];
  let lastUsage: GrokHistoryUsage | undefined;
  let pending: PendingTurn | null = null;
  let turnIndex = 0;

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
    if (updateType === 'user_message_chunk') {
      const incomingUserId = resolveNativeId(update, 'user');
      const startsNewTurn = pending && (
        pending.assistantContent
        || pending.blocks.length > 0
        || (
          pending.userContent
          && pending.userId !== undefined
          && incomingUserId !== undefined
          && pending.userId !== incomingUserId
        )
      );
      if (pending && startsNewTurn) {
        if (pending.assistantContent || pending.blocks.length > 0 || pending.tools.size > 0) {
          messages.push(...finalizeTurn(pending, sessionId));
          turnIndex += 1;
        }
        pending = createPendingTurn(turnIndex, record.timestamp);
      } else if (!pending) {
        pending = createPendingTurn(turnIndex, record.timestamp);
      }
      const text = extractContentText(update.content);
      pending.userContent += text;
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
      pending.assistantId ??= resolveNativeId(update, 'assistant');
      appendContentBlock(pending.blocks, 'text', text);
      continue;
    }

    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      reconcileToolUpdate(pending, update);
      continue;
    }

    if (updateType === 'turn_completed') {
      const promptId = readString(update.prompt_id) ?? readString(update.promptId);
      const completed = finalizeTurn(pending, sessionId, promptId);
      messages.push(...completed);
      const usage = normalizeUsage(update.usage);
      if (usage) {
        lastUsage = usage;
      }
      turnIndex += 1;
      pending = null;
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

function createPendingTurn(turnIndex: number, timestamp: number): PendingTurn {
  return {
    assistantContent: '',
    blocks: [],
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
  if (!turn.userContent) {
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
    userMessageId: userId,
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

function resolveNativeId(update: Record<string, unknown>, role: string): string | undefined {
  const metadata = readRecord(update._meta);
  return readString(update.messageId)
    ?? readString(metadata?.eventId)
    ?? readString(metadata?.promptId)
    ?? (typeof metadata?.promptIndex === 'number'
      ? `${role}-${metadata.promptIndex}`
      : undefined);
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
