import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ChatMessage,
  ContentBlock,
  ToolCallInfo,
} from '../../../core/types';

export interface ParsedKimiHistory {
  messages: ChatMessage[];
}

interface KimiWireRecord {
  message: {
    payload: Record<string, unknown>;
    type: string;
  };
  timestamp: number;
}

interface StoredTool {
  args: string;
  id: string;
  name: string;
  output: string;
  status: ToolCallInfo['status'];
}

interface PendingTurn {
  assistantContent: string;
  blocks: ContentBlock[];
  isInterjection: boolean;
  lastToolId: string | null;
  startedAt: number;
  tools: Map<string, StoredTool>;
  toolOrder: string[];
  turnIndex: number;
  userContent: string;
}

export function parseKimiHistoryContent(content: string, sessionId: string): ParsedKimiHistory {
  const completedTurns: ChatMessage[][] = [];
  let pending: PendingTurn | null = null;
  let turnIndex = 0;

  const commitPending = (turn: PendingTurn): void => {
    const messages = finalizeTurn(turn, sessionId);
    if (messages.length > 0) {
      completedTurns.push(messages);
      turnIndex += 1;
    }
  };

  for (const line of content.split(/\r?\n/)) {
    const record = parseRecord(line);
    if (!record) {
      continue;
    }

    const messageType = record.message.type;
    const payload = record.message.payload;

    if (messageType === 'TurnBegin' || messageType === 'SteerInput') {
      if (pending) {
        commitPending(pending);
      }
      pending = createPendingTurn(turnIndex, record.timestamp, messageType === 'SteerInput');
      pending.userContent = extractUserInputText(payload.user_input);
      continue;
    }

    if (!pending) {
      continue;
    }

    switch (messageType) {
      case 'ThinkPart': {
        const text = readString(payload.think);
        if (text) {
          appendContentBlock(pending.blocks, 'thinking', text);
        }
        break;
      }
      case 'TextPart': {
        const text = readString(payload.text);
        if (text) {
          pending.assistantContent += text;
          appendContentBlock(pending.blocks, 'text', text);
        }
        break;
      }
      case 'ToolCall': {
        const id = readString(payload.id);
        if (!id) {
          break;
        }
        const fn = readRecord(payload.function);
        const args = readString(fn?.arguments) ?? '';
        if (!pending.tools.has(id)) {
          pending.toolOrder.push(id);
          pending.blocks.push({ toolId: id, type: 'tool_use' });
        }
        pending.tools.set(id, {
          args,
          id,
          name: readString(fn?.name) ?? 'tool',
          output: '',
          status: 'running',
        });
        pending.lastToolId = id;
        break;
      }
      case 'ToolCallPart': {
        const argsPart = readString(payload.arguments_part);
        if (argsPart && pending.lastToolId) {
          const tool = pending.tools.get(pending.lastToolId);
          if (tool) {
            tool.args += argsPart;
          }
        }
        break;
      }
      case 'ToolResult': {
        const id = readString(payload.tool_call_id);
        const tool = id ? pending.tools.get(id) : undefined;
        if (!tool) {
          break;
        }
        const returnValue = readRecord(payload.return_value);
        tool.output = renderToolReturnValue(returnValue);
        tool.status = returnValue?.is_error === true ? 'error' : 'completed';
        break;
      }
      case 'TurnEnd':
      case 'StepInterrupted': {
        commitPending(pending);
        pending = null;
        break;
      }
      default:
        break;
    }
  }

  if (pending) {
    commitPending(pending);
  }

  return { messages: completedTurns.flat() };
}

export async function loadKimiHistory(sessionDirectory: string): Promise<ParsedKimiHistory> {
  const sessionId = path.basename(sessionDirectory);
  try {
    const content = await fs.readFile(path.join(sessionDirectory, 'wire.jsonl'), 'utf8');
    return parseKimiHistoryContent(content, sessionId);
  } catch {
    return { messages: [] };
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
    isInterjection,
    lastToolId: null,
    startedAt: normalizeTimestamp(timestamp),
    tools: new Map(),
    toolOrder: [],
    turnIndex,
    userContent: '',
  };
}

function finalizeTurn(turn: PendingTurn, sessionId: string): ChatMessage[] {
  if (!turn.userContent) {
    return [];
  }
  const scope = sanitizeId(sessionId);
  const userId = `kimi-${scope}-turn-${turn.turnIndex}-user`;
  const assistantId = `kimi-${scope}-turn-${turn.turnIndex}-assistant`;
  const user: ChatMessage = {
    content: turn.userContent,
    id: userId,
    role: 'user',
    timestamp: turn.startedAt,
    ...(!turn.isInterjection ? { userMessageId: userId } : {}),
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
      input: parseToolArgs(tool.args),
      name: tool.name,
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

function extractUserInputText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value.flatMap((part) => {
    const record = readRecord(part);
    const text = record ? readString(record.text) : undefined;
    return text ? [text] : [];
  }).join('\n');
}

function renderToolReturnValue(returnValue: Record<string, unknown> | null): string {
  if (!returnValue) {
    return '';
  }
  const output = returnValue.output;
  if (typeof output === 'string' && output) {
    return output;
  }
  if (Array.isArray(output)) {
    const text = output.flatMap((part) => {
      const record = readRecord(part);
      const value = record ? readString(record.text) : undefined;
      return value ? [value] : [];
    }).join('\n');
    if (text) {
      return text;
    }
  }
  return readString(returnValue.message) ?? '';
}

function parseToolArgs(args: string): Record<string, unknown> {
  if (!args) {
    return {};
  }
  try {
    const parsed = JSON.parse(args) as unknown;
    return readRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function parseRecord(line: string): KimiWireRecord | null {
  if (!line.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    const record = readRecord(parsed);
    if (!record || record.type === 'metadata') {
      return null;
    }
    const message = readRecord(record.message);
    const payload = readRecord(message?.payload);
    const type = readString(message?.type);
    if (!message || !payload || !type) {
      return null;
    }
    return {
      message: { payload, type },
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
  return typeof value === 'string' && value ? value : undefined;
}
