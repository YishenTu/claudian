import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ChatMessage,
  ContentBlock,
  ToolCallInfo,
} from '../../../core/types';

const DEFAULT_SESSION_TITLE = 'New Session';

interface ParsedKimiHistory {
  messages: ChatMessage[];
  title?: string;
}

interface KimiWireRecord {
  payload: Record<string, unknown>;
  time: number;
  type: string;
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

    if (record.type === 'turn.prompt' || record.type === 'turn.steer') {
      if (pending) {
        commitPending(pending);
      }
      pending = createPendingTurn(turnIndex, record.time, record.type === 'turn.steer');
      pending.userContent = extractUserInputText(record.payload.input);
      continue;
    }

    if (!pending) {
      continue;
    }

    switch (record.type) {
      case 'turn.cancel': {
        commitPending(pending);
        pending = null;
        break;
      }
      case 'context.append_message': {
        applyContextMessage(pending, readRecord(record.payload.message));
        break;
      }
      default:
        // Loop events, usage, plan-mode, and config records are replayed by
        // the CLI only to rebuild internal state; the context messages above
        // are the authoritative chat history (see acp-adapter replayHistory).
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
  const title = await readSessionTitle(sessionDirectory);
  try {
    const content = await fs.readFile(
      path.join(sessionDirectory, 'agents', 'main', 'wire.jsonl'),
      'utf8',
    );
    return { ...parseKimiHistoryContent(content, sessionId), ...(title ? { title } : {}) };
  } catch {
    return title ? { messages: [], title } : { messages: [] };
  }
}

// Session titles live in `<sessionDir>/state.json` (SessionMeta), not in the
// wire log. The CLI's default title carries no information, so it is dropped.
async function readSessionTitle(sessionDirectory: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(sessionDirectory, 'state.json'), 'utf8'),
    ) as unknown;
    const title = readString(readRecord(parsed)?.title);
    return title && title !== DEFAULT_SESSION_TITLE ? title : undefined;
  } catch {
    return undefined;
  }
}

function applyContextMessage(
  turn: PendingTurn,
  message: Record<string, unknown> | null,
): void {
  if (!message) {
    return;
  }
  const role = readString(message.role);
  if (role === 'assistant') {
    for (const part of readContentParts(message.content)) {
      if (part.type === 'think') {
        appendContentBlock(turn.blocks, 'thinking', part.text);
      } else {
        turn.assistantContent += part.text;
        appendContentBlock(turn.blocks, 'text', part.text);
      }
    }
    for (const toolCall of readToolCalls(message.tool_calls ?? message.toolCalls)) {
      if (!turn.tools.has(toolCall.id)) {
        turn.toolOrder.push(toolCall.id);
        turn.blocks.push({ toolId: toolCall.id, type: 'tool_use' });
      }
      turn.tools.set(toolCall.id, {
        args: toolCall.args,
        id: toolCall.id,
        name: toolCall.name,
        output: turn.tools.get(toolCall.id)?.output ?? '',
        status: turn.tools.get(toolCall.id)?.status ?? 'running',
      });
    }
    return;
  }
  if (role === 'tool') {
    const id = readString(message.tool_call_id ?? message.toolCallId);
    const tool = id ? turn.tools.get(id) : undefined;
    if (!tool) {
      // Orphaned tool result (no call in this turn): skip like the CLI replay.
      return;
    }
    tool.output = readContentParts(message.content)
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
    tool.status = message.isError === true ? 'error' : 'completed';
  }
  // User-role context messages duplicate turn.prompt/turn.steer input (or
  // carry injections); the turn records already captured the user text.
}

function createPendingTurn(
  turnIndex: number,
  time: number,
  isInterjection = false,
): PendingTurn {
  return {
    assistantContent: '',
    blocks: [],
    isInterjection,
    startedAt: time,
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
  return readContentParts(value)
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

function readContentParts(value: unknown): { text: string; type: 'text' | 'think' }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parts: { text: string; type: 'text' | 'think' }[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    if (!record) {
      continue;
    }
    if (readString(record.type) === 'think') {
      const think = readString(record.think);
      if (think) {
        parts.push({ text: think, type: 'think' });
      }
      continue;
    }
    const text = readString(record.text);
    if (text) {
      parts.push({ text, type: 'text' });
    }
  }
  return parts;
}

function readToolCalls(value: unknown): { args: string; id: string; name: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    const id = readString(record?.id);
    if (!record || !id) {
      return [];
    }
    // Wire messages use the kosong function-call shape; the ACP replay uses a
    // flattened name/arguments shape. Accept both.
    const fn = readRecord(record.function);
    const name = readString(fn?.name) ?? readString(record.name) ?? 'tool';
    const args = readString(fn?.arguments) ?? readString(record.arguments) ?? '';
    return [{ args, id, name }];
  });
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
    const record = readRecord(JSON.parse(line) as unknown);
    const type = readString(record?.type);
    if (!record || !type || type === 'metadata') {
      return null;
    }
    return {
      payload: record,
      time: typeof record.time === 'number' && record.time > 0 ? record.time : 0,
      type,
    };
  } catch {
    return null;
  }
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
