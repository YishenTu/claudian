import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';
import {
  isCodexToolOutputError,
  normalizeCodexMcpToolInput,
  normalizeCodexMcpToolName,
  normalizeCodexMcpToolState,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
} from '../normalization/codexToolNormalization';

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  error?: { message: string };
  message?: string;
}

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  query?: string;
  message?: string;
  server?: string;
  tool?: string;
}

interface PersistedMessagePart {
  type?: string;
  text?: string;
}

interface PersistedMessagePayload {
  type: 'message';
  role?: string;
  content?: PersistedMessagePart[];
}

interface PersistedReasoningPayload {
  type: 'reasoning';
  summary?: Array<{ type?: string; text?: string } | string>;
  content?: Array<{ type?: string; text?: string } | string>;
  text?: string;
}

interface PersistedToolCallPayload {
  type: 'function_call' | 'custom_tool_call';
  name?: string;
  arguments?: string;
  call_id?: string;
  input?: string;
}

interface PersistedToolCallOutputPayload {
  type: 'function_call_output' | 'custom_tool_call_output';
  call_id?: string;
  output?: string | unknown[];
}

interface PersistedWebSearchCallPayload {
  type: 'web_search_call';
  action?: {
    type?: string;
    query?: string;
    queries?: string[];
    url?: string;
    pattern?: string;
  };
  status?: string;
  call_id?: string;
}

interface PersistedMcpToolCallPayload {
  type: 'mcp_tool_call';
  server?: string;
  tool?: string;
  call_id?: string;
  status?: string;
  arguments?: string | Record<string, unknown>;
  result?: { content?: Array<{ type?: string; text?: string }> } | null;
  error?: string | null;
  duration_ms?: number | null;
}

interface PersistedEventPayload {
  type?: string;
  text?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Multi-bubble turn model
// ---------------------------------------------------------------------------

interface CodexAssistantBubble {
  contentChunks: string[];
  thinkingChunks: string[];
  toolCalls: ToolCallInfo[];
  toolIndexesById: Map<string, number>;
  contentBlocks: ContentBlock[];
  startedAt: number;
  lastEventAt: number;
  interrupted: boolean;
}

interface CodexTurnState {
  id: string;
  startedAt: number;
  completedAt?: number;
  lastEventAt: number;
  userTimestamp?: number;
  userChunks: string[];
  assistantBubbles: CodexAssistantBubble[];
  activeBubbleIndex: number | null;
}

type PersistedPayload =
  | PersistedMessagePayload
  | PersistedReasoningPayload
  | PersistedToolCallPayload
  | PersistedToolCallOutputPayload
  | PersistedWebSearchCallPayload
  | PersistedMcpToolCallPayload
  | PersistedEventPayload
  | undefined;

// ---------------------------------------------------------------------------
// Turn/bubble lifecycle helpers
// ---------------------------------------------------------------------------

function newBubble(timestamp: number): CodexAssistantBubble {
  return {
    contentChunks: [],
    thinkingChunks: [],
    toolCalls: [],
    toolIndexesById: new Map(),
    contentBlocks: [],
    startedAt: timestamp,
    lastEventAt: timestamp,
    interrupted: false,
  };
}

function newTurnState(id: string, timestamp: number): CodexTurnState {
  return {
    id,
    startedAt: timestamp,
    lastEventAt: timestamp,
    userChunks: [],
    assistantBubbles: [],
    activeBubbleIndex: null,
  };
}

function ensureTurn(
  turns: Map<string, CodexTurnState>,
  turnOrder: string[],
  preferredTurnId: string,
  currentTurnId: string | null,
  timestamp: number,
): CodexTurnState {
  const id = currentTurnId ?? preferredTurnId;
  const existing = turns.get(id);
  if (existing) {
    if (timestamp > 0 && timestamp > existing.lastEventAt) {
      existing.lastEventAt = timestamp;
    }
    return existing;
  }

  const turn = newTurnState(id, timestamp);
  turns.set(id, turn);
  turnOrder.push(id);
  return turn;
}

function ensureAssistantBubble(turn: CodexTurnState, timestamp: number): CodexAssistantBubble {
  if (turn.activeBubbleIndex !== null) {
    const bubble = turn.assistantBubbles[turn.activeBubbleIndex];
    if (timestamp > 0 && timestamp > bubble.lastEventAt) {
      bubble.lastEventAt = timestamp;
    }
    return bubble;
  }

  const bubble = newBubble(timestamp);
  turn.assistantBubbles.push(bubble);
  turn.activeBubbleIndex = turn.assistantBubbles.length - 1;
  return bubble;
}

function closeAssistantBubble(turn: CodexTurnState): void {
  turn.activeBubbleIndex = null;
}

function pushToolInvocation(bubble: CodexAssistantBubble, toolCall: ToolCallInfo): void {
  const existingIndex = bubble.toolIndexesById.get(toolCall.id);
  if (existingIndex !== undefined) {
    bubble.toolCalls[existingIndex] = toolCall;
    return;
  }

  bubble.toolIndexesById.set(toolCall.id, bubble.toolCalls.length);
  bubble.toolCalls.push(toolCall);
  bubble.contentBlocks.push({ type: 'tool_use', toolId: toolCall.id });
}

function appendUniqueChunk(chunks: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (chunks[chunks.length - 1] === trimmed) return;
  chunks.push(trimmed);
}

function appendUserChunk(turn: CodexTurnState, value: string, timestamp: number): void {
  const chunkCountBefore = turn.userChunks.length;
  appendUniqueChunk(turn.userChunks, value);

  if (turn.userChunks.length > chunkCountBefore && !turn.userTimestamp && timestamp > 0) {
    turn.userTimestamp = timestamp;
  }
}

// ---------------------------------------------------------------------------
// Legacy TurnAccumulator — kept for the `event` wrapper format
// ---------------------------------------------------------------------------

interface TurnAccumulator {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallInfo[];
  contentBlocks: ContentBlock[];
  interrupted: boolean;
  timestamp: number;
}

function newTurn(timestamp = 0): TurnAccumulator {
  return {
    assistantText: '',
    thinkingText: '',
    toolCalls: [],
    contentBlocks: [],
    interrupted: false,
    timestamp,
  };
}

function flushTurn(turn: TurnAccumulator, messages: ChatMessage[], msgIndex: number): number {
  if (
    !turn.assistantText &&
    !turn.thinkingText &&
    turn.toolCalls.length === 0
  ) {
    return msgIndex;
  }

  const msg: ChatMessage = {
    id: `codex-msg-${msgIndex}`,
    role: 'assistant',
    content: turn.assistantText,
    timestamp: turn.timestamp || Date.now(),
    toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    contentBlocks: turn.contentBlocks.length > 0 ? turn.contentBlocks : undefined,
  };

  if (turn.interrupted) {
    msg.isInterrupt = true;
  }

  messages.push(msg);
  return msgIndex + 1;
}

function setTextBlock(turn: TurnAccumulator, content: string): void {
  const index = turn.contentBlocks.findIndex(block => block.type === 'text');
  if (index === -1) {
    turn.contentBlocks.push({ type: 'text', content });
    return;
  }

  turn.contentBlocks[index] = { type: 'text', content };
}

function setThinkingBlock(turn: TurnAccumulator, content: string): void {
  const normalized = content.trim();
  if (!normalized) {
    return;
  }

  turn.thinkingText = normalized;

  const index = turn.contentBlocks.findIndex(block => block.type === 'thinking');
  if (index === -1) {
    turn.contentBlocks.push({ type: 'thinking', content: normalized });
    return;
  }

  turn.contentBlocks[index] = { type: 'thinking', content: normalized };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const CODEX_SYSTEM_MESSAGE_PREFIXES = [
  '# AGENTS.md instructions',
  '<environment_context>',
  '<subagent_notification>',
  '<skill>',
];

const CODEX_BRACKET_CONTEXT_PATTERN = /\n\[(?:Current note|Editor selection from|Browser selection from|Canvas selection from)\b/;

function isCodexSystemMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return CODEX_SYSTEM_MESSAGE_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function extractCodexDisplayContent(text: string): string | undefined {
  if (!text) return undefined;

  const bracketMatch = text.match(CODEX_BRACKET_CONTEXT_PATTERN);
  if (bracketMatch?.index !== undefined) {
    return text.substring(0, bracketMatch.index).trim();
  }

  return undefined;
}

function extractMessageText(content: PersistedMessagePart[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

function extractReasoningText(payload: PersistedReasoningPayload | PersistedEventPayload): string {
  if ('summary' in payload && Array.isArray(payload.summary) && payload.summary.length > 0) {
    return payload.summary
      .map((part) => {
        if (typeof part === 'string') return part;
        return typeof part?.text === 'string' ? part.text : '';
      })
      .map(part => part.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  if ('content' in payload && Array.isArray(payload.content) && payload.content.length > 0) {
    return payload.content
      .map((part) => {
        if (typeof part === 'string') return part;
        return typeof part?.text === 'string' ? part.text : '';
      })
      .map(part => part.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  return typeof payload.text === 'string' ? payload.text.trim() : '';
}

// ---------------------------------------------------------------------------
// Legacy event wrapper processing (kept as-is)
// ---------------------------------------------------------------------------

function processLegacyItem(
  eventType: string,
  item: CodexItem,
  turn: TurnAccumulator,
): void {
  switch (item.type) {
    case 'agent_message':
      if (eventType === 'item.completed' || eventType === 'item.updated') {
        if (item.text) {
          turn.assistantText = item.text;
          setTextBlock(turn, item.text);
        }
      }
      break;

    case 'reasoning':
      if (eventType === 'item.completed' || eventType === 'item.updated') {
        if (item.text) {
          setThinkingBlock(turn, item.text);
        }
      }
      break;

    case 'command_execution':
      if (eventType === 'item.started') {
        turn.toolCalls.push({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { command: item.command ?? '' }),
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          const rawOutput = item.aggregated_output ?? '';
          tc.result = normalizeCodexToolResult(tc.name, rawOutput);
          tc.status = item.exit_code === 0 ? 'completed' : 'error';
        }
      }
      break;

    case 'file_change': {
      const changes = item.changes ?? [];
      if (eventType === 'item.started' || eventType === 'item.completed') {
        const existing = turn.toolCalls.find(tool => tool.id === item.id);
        if (!existing) {
          const paths = changes.map(change => `${change.kind}: ${change.path}`).join(', ');
          turn.toolCalls.push({
            id: item.id,
            name: normalizeCodexToolName('file_change'),
            input: { changes },
            status: item.status === 'completed' ? 'completed' : 'error',
            result: paths ? `Applied: ${paths}` : 'Applied',
          });
          turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
        } else if (eventType === 'item.completed') {
          existing.status = item.status === 'completed' ? 'completed' : 'error';
        }
      }
      break;
    }

    case 'web_search':
      if (eventType === 'item.started') {
        turn.toolCalls.push({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { query: item.query ?? '' }),
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          tc.result = 'Search complete';
          tc.status = 'completed';
        }
      }
      break;

    case 'mcp_tool_call':
      if (eventType === 'item.started') {
        const server = item.server ?? '';
        const tool = item.tool ?? '';
        turn.toolCalls.push({
          id: item.id,
          name: `mcp__${server}__${tool}`,
          input: {},
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          tc.status = item.status === 'completed' ? 'completed' : 'error';
          tc.result = item.status === 'completed' ? 'Completed' : 'Failed';
        }
      }
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Persisted-format (response_item) processing — with bubble model
// ---------------------------------------------------------------------------

interface PersistedParseContext {
  turns: Map<string, CodexTurnState>;
  turnOrder: string[];
  currentTurnId: string | null;
  toolCallToTurn: Map<string, { turnId: string; bubbleIndex: number }>;
  turnCounter: number;
}

function nextTurnId(ctx: PersistedParseContext): string {
  ctx.turnCounter += 1;
  return `turn-${ctx.turnCounter}`;
}

function processPersistedToolCall(
  payload: PersistedToolCallPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);

  const rawArgs = payload.arguments ?? payload.input;
  const parsedArgs = parseCodexArguments(rawArgs);
  const normalizedName = normalizeCodexToolName(payload.name);
  const normalizedInput = normalizeCodexToolInput(payload.name, parsedArgs);

  const toolCall: ToolCallInfo = {
    id: callId,
    name: normalizedName,
    input: normalizedInput,
    status: 'running',
  };

  pushToolInvocation(bubble, toolCall);

  ctx.toolCallToTurn.set(callId, {
    turnId: turn.id,
    bubbleIndex: turn.assistantBubbles.indexOf(bubble),
  });
}

function processPersistedToolOutput(
  payload: PersistedToolCallOutputPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  // output can be a string or an array (e.g. view_image returns image objects)
  const rawOutput = typeof payload.output === 'string'
    ? payload.output
    : Array.isArray(payload.output)
      ? JSON.stringify(payload.output)
      : '';

  // Cross-turn resolution: look up where the tool call was originally pushed
  const origin = ctx.toolCallToTurn.get(callId);
  if (origin) {
    const originTurn = ctx.turns.get(origin.turnId);
    if (originTurn && origin.bubbleIndex < originTurn.assistantBubbles.length) {
      const originBubble = originTurn.assistantBubbles[origin.bubbleIndex];
      const existing = originBubble.toolCalls.find(tool => tool.id === callId);
      if (existing) {
        existing.result = normalizePersistedToolOutput(existing, payload.output, rawOutput);
        existing.status = isCodexToolOutputError(rawOutput) ? 'error' : 'completed';
        return;
      }
    }
  }

  // Fallback: push orphan entry into current turn
  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);
  const normalizedResult = normalizeCodexToolResult('tool', rawOutput);

  pushToolInvocation(bubble, {
    id: callId,
    name: 'tool',
    input: {},
    status: isCodexToolOutputError(rawOutput) ? 'error' : 'completed',
    result: normalizedResult,
  });
}

function normalizePersistedToolOutput(
  toolCall: ToolCallInfo,
  rawOutputValue: string | unknown[] | undefined,
  rawOutputText: string,
): string {
  if (Array.isArray(rawOutputValue) && toolCall.name === 'Read') {
    const filePath = toolCall.input.file_path;
    if (typeof filePath === 'string' && filePath) {
      return filePath;
    }
  }

  return normalizeCodexToolResult(toolCall.name, rawOutputText);
}

function processPersistedWebSearchCall(
  payload: PersistedWebSearchCallPayload,
  timestamp: number,
  lineIndex: number,
  ctx: PersistedParseContext,
): void {
  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);

  // Persisted web_search_call entries commonly omit call_id. Use transcript line index
  // so live tailing and history reload reconstruct the same visible tool sequence.
  const callId = payload.call_id || `tail-ws-${lineIndex}`;

  if (bubble.toolIndexesById.has(callId)) return;

  const input = normalizeCodexToolInput('web_search_call', {
    action: payload.action ?? {},
  });

  const isTerminal = payload.status === 'completed' || payload.status === 'failed'
    || payload.status === 'error' || payload.status === 'cancelled';

  const toolCall: ToolCallInfo = {
    id: callId,
    name: 'WebSearch',
    input,
    status: isTerminal ? (payload.status === 'completed' ? 'completed' : 'error') : 'running',
    ...(isTerminal ? { result: 'Search complete' } : {}),
  };

  pushToolInvocation(bubble, toolCall);

  ctx.toolCallToTurn.set(callId, {
    turnId: turn.id,
    bubbleIndex: turn.assistantBubbles.indexOf(bubble),
  });
}

function processPersistedMcpToolCall(
  payload: PersistedMcpToolCallPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
  const bubble = ensureAssistantBubble(turn, timestamp);

  if (bubble.toolIndexesById.has(callId)) return;

  const normalizedInput = normalizeCodexMcpToolInput(payload.arguments);
  const normalizedState = normalizeCodexMcpToolState(payload.status, payload.result, payload.error);

  const toolCall: ToolCallInfo = {
    id: callId,
    name: normalizeCodexMcpToolName(payload.server, payload.tool),
    input: normalizedInput,
    status: normalizedState.status,
    ...(normalizedState.result ? { result: normalizedState.result } : {}),
  };

  pushToolInvocation(bubble, toolCall);

  ctx.toolCallToTurn.set(callId, {
    turnId: turn.id,
    bubbleIndex: turn.assistantBubbles.indexOf(bubble),
  });
}

function processPersistedPayload(
  payload: PersistedPayload,
  timestamp: number,
  lineIndex: number,
  ctx: PersistedParseContext,
): void {
  if (!payload?.type) {
    return;
  }

  switch (payload.type) {
    case 'message': {
      const messagePayload = payload as PersistedMessagePayload;
      const text = extractMessageText(messagePayload.content);

      if (messagePayload.role === 'user') {
        if (isCodexSystemMessage(text)) break;

        // Close any active bubble in the current turn before starting user content
        if (ctx.currentTurnId) {
          const prevTurn = ctx.turns.get(ctx.currentTurnId);
          if (prevTurn) closeAssistantBubble(prevTurn);
        }

        // User message opens a new turn
        ctx.currentTurnId = null;
        const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), null, timestamp);
        ctx.currentTurnId = turn.id;
        if (text) {
          appendUserChunk(turn, text, timestamp);
        }
      } else if (messagePayload.role === 'assistant') {
        const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
        const bubble = ensureAssistantBubble(turn, timestamp);
        if (text) {
          appendUniqueChunk(bubble.contentChunks, text);
        }
      }
      break;
    }

    case 'reasoning': {
      const reasoningPayload = payload as PersistedReasoningPayload;
      const text = extractReasoningText(reasoningPayload);
      if (!text) break;

      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const bubble = ensureAssistantBubble(turn, timestamp);
      appendUniqueChunk(bubble.thinkingChunks, text);
      break;
    }

    case 'function_call':
    case 'custom_tool_call':
      processPersistedToolCall(payload as PersistedToolCallPayload, timestamp, ctx);
      break;

    case 'function_call_output':
    case 'custom_tool_call_output':
      processPersistedToolOutput(payload as PersistedToolCallOutputPayload, timestamp, ctx);
      break;

    case 'web_search_call':
      processPersistedWebSearchCall(payload as PersistedWebSearchCallPayload, timestamp, lineIndex, ctx);
      break;

    case 'mcp_tool_call':
      processPersistedMcpToolCall(payload as PersistedMcpToolCallPayload, timestamp, ctx);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// event_msg processing
// ---------------------------------------------------------------------------

function processEventMsg(
  payload: PersistedEventPayload,
  timestamp: number,
  ctx: PersistedParseContext,
): void {
  if (!payload?.type) return;

  switch (payload.type) {
    case 'task_started': {
      const id = nextTurnId(ctx);
      const turn = ensureTurn(ctx.turns, ctx.turnOrder, id, null, timestamp);
      turn.startedAt = timestamp;
      ctx.currentTurnId = turn.id;
      break;
    }

    case 'task_complete': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) {
          turn.completedAt = timestamp;
          closeAssistantBubble(turn);
        }
      }
      ctx.currentTurnId = null;
      break;
    }

    case 'turn_aborted': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) {
          const bubble = ensureAssistantBubble(turn, timestamp);
          bubble.interrupted = true;
          closeAssistantBubble(turn);
          turn.completedAt = timestamp;
        }
      }
      ctx.currentTurnId = null;
      break;
    }

    case 'user_message': {
      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const msg = payload.message;
      if (typeof msg === 'string' && msg.trim()) {
        appendUserChunk(turn, msg, timestamp);
      }
      break;
    }

    case 'agent_message': {
      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const bubble = ensureAssistantBubble(turn, timestamp);
      const msg = payload.message;
      if (typeof msg === 'string') {
        appendUniqueChunk(bubble.contentChunks, msg);
      }
      break;
    }

    case 'agent_reasoning': {
      const text = extractReasoningText(payload);
      if (!text) break;

      const turn = ensureTurn(ctx.turns, ctx.turnOrder, nextTurnId(ctx), ctx.currentTurnId, timestamp);
      const bubble = ensureAssistantBubble(turn, timestamp);
      appendUniqueChunk(bubble.thinkingChunks, text);
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Flush multi-bubble turns to ChatMessage[]
// ---------------------------------------------------------------------------

function flushBubbleTurns(
  turns: Map<string, CodexTurnState>,
  turnOrder: string[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let msgIndex = 0;

  for (const turnId of turnOrder) {
    const turn = turns.get(turnId);
    if (!turn) continue;

    // Emit user message from userChunks
    const userText = turn.userChunks.join('\n').trim();
    if (userText && !isCodexSystemMessage(userText)) {
      const displayContent = extractCodexDisplayContent(userText);
      messages.push({
        id: `codex-msg-${msgIndex}`,
        role: 'user',
        content: userText,
        ...(displayContent !== undefined ? { displayContent } : {}),
        timestamp: turn.userTimestamp || turn.startedAt || Date.now(),
      });
      msgIndex += 1;
    }

    // Track last assistant timestamp across all bubbles for duration calculation
    let lastAssistantTimestamp = 0;
    const assistantMessages: ChatMessage[] = [];

    for (const bubble of turn.assistantBubbles) {
      const contentText = bubble.contentChunks.join('\n\n');
      const thinkingText = bubble.thinkingChunks.join('\n\n');
      const hasContent = contentText.trim().length > 0;
      const hasThinking = thinkingText.trim().length > 0;
      const hasToolCalls = bubble.toolCalls.length > 0;

      if (!hasContent && !hasThinking && !hasToolCalls) {
        // Empty bubble with interrupt flag → bare interrupt marker
        if (bubble.interrupted) {
          messages.push({
            id: `codex-msg-${msgIndex}`,
            role: 'assistant',
            content: '',
            timestamp: bubble.startedAt || turn.startedAt || Date.now(),
            isInterrupt: true,
          });
          msgIndex += 1;
        }
        continue;
      }

      // Build content blocks
      const contentBlocks: ContentBlock[] = [];
      if (hasThinking) {
        contentBlocks.push({ type: 'thinking', content: thinkingText.trim() });
      }
      contentBlocks.push(...bubble.contentBlocks);
      if (hasContent) {
        contentBlocks.push({ type: 'text', content: contentText.trim() });
      }

      const msg: ChatMessage = {
        id: `codex-msg-${msgIndex}`,
        role: 'assistant',
        content: contentText.trim(),
        timestamp: bubble.startedAt || turn.startedAt || Date.now(),
        toolCalls: hasToolCalls ? bubble.toolCalls : undefined,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      };

      // Interrupted bubble with content → isInterrupt: true
      if (bubble.interrupted) {
        msg.isInterrupt = true;
      }

      if (bubble.lastEventAt > lastAssistantTimestamp) {
        lastAssistantTimestamp = bubble.lastEventAt;
      }

      assistantMessages.push(msg);
      messages.push(msg);
      msgIndex += 1;
    }

    // Attach response duration to the last assistant message of the turn
    if (assistantMessages.length > 0 && turn.userTimestamp && lastAssistantTimestamp > turn.userTimestamp) {
      const durationMs = lastAssistantTimestamp - turn.userTimestamp;
      const lastMsg = assistantMessages[assistantMessages.length - 1];
      lastMsg.durationSeconds = Math.round(durationMs / 1000);
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Session file discovery
// ---------------------------------------------------------------------------

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function findCodexSessionFile(
  threadId: string,
  root: string = path.join(os.homedir(), '.codex', 'sessions'),
): string | null {
  if (!threadId || !SAFE_SESSION_ID_PATTERN.test(threadId) || !fs.existsSync(root)) {
    return null;
  }

  const directPath = path.join(root, `${threadId}.jsonl`);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
        return fullPath;
      }
    }
  }

  return null;
}

export function parseCodexSessionFile(filePath: string): ChatMessage[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseCodexSessionContent(content);
}

export function parseCodexSessionContent(content: string): ChatMessage[] {
  const lines = content.split('\n').filter(line => line.trim());

  // Detect format: legacy uses type=event, modern uses event_msg/response_item
  let hasLegacy = false;
  let hasModern = false;
  for (const line of lines) {
    if (line.includes('"type":"event"') || line.includes('"type": "event"')) {
      hasLegacy = true;
    }
    if (line.includes('"type":"event_msg"') || line.includes('"type":"response_item"')
        || line.includes('"type": "event_msg"') || line.includes('"type": "response_item"')) {
      hasModern = true;
    }
    if (hasLegacy && hasModern) break;
  }

  // Pure legacy sessions use the old flat accumulator
  if (hasLegacy && !hasModern) {
    return parseLegacySession(lines);
  }

  // Modern or mixed sessions use the bubble model
  return parseModernSession(lines);
}

// ---------------------------------------------------------------------------
// Legacy (event wrapper) parser — preserved for backward compat
// ---------------------------------------------------------------------------

function parseLegacySession(lines: string[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turn = newTurn();
  let msgIndex = 0;

  for (const line of lines) {
    let parsed: { timestamp?: string; type?: string; event?: CodexEvent };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === 'event' && parsed.event) {
      const event = parsed.event;

      switch (event.type) {
        case 'turn.started':
          if (turn.assistantText || turn.thinkingText || turn.toolCalls.length > 0) {
            msgIndex = flushTurn(turn, messages, msgIndex);
          }
          turn = newTurn();
          break;

        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          if (event.item) {
            processLegacyItem(event.type, event.item, turn);
          }
          break;

        case 'turn.completed':
          msgIndex = flushTurn(turn, messages, msgIndex);
          turn = newTurn();
          break;

        case 'turn.failed':
          turn.interrupted = true;
          msgIndex = flushTurn(turn, messages, msgIndex);
          turn = newTurn();
          break;

        default:
          break;
      }
    }
  }

  flushTurn(turn, messages, msgIndex);
  return messages;
}

// ---------------------------------------------------------------------------
// Modern (response_item + event_msg) parser — bubble model
// ---------------------------------------------------------------------------

function parseModernSession(lines: string[]): ChatMessage[] {
  const ctx: PersistedParseContext = {
    turns: new Map(),
    turnOrder: [],
    currentTurnId: null,
    toolCallToTurn: new Map(),
    turnCounter: 0,
  };

  for (const [lineIndex, line] of lines.entries()) {
    let parsed: { timestamp?: string; type?: string; event?: CodexEvent; payload?: PersistedPayload };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = parseTimestamp(parsed.timestamp);

    // Legacy event records can appear in mixed sessions
    if (parsed.type === 'event' && parsed.event) {
      processLegacyEventInModernContext(parsed.event, ctx);
      continue;
    }

    if (parsed.type === 'event_msg') {
      processEventMsg(parsed.payload as PersistedEventPayload, timestamp, ctx);
      continue;
    }

    if (parsed.type === 'response_item') {
      processPersistedPayload(parsed.payload, timestamp, lineIndex, ctx);
    }
  }

  return flushBubbleTurns(ctx.turns, ctx.turnOrder);
}

function processLegacyEventInModernContext(event: CodexEvent, ctx: PersistedParseContext): void {
  switch (event.type) {
    case 'turn.started': {
      const id = nextTurnId(ctx);
      ensureTurn(ctx.turns, ctx.turnOrder, id, null, 0);
      ctx.currentTurnId = id;
      break;
    }

    case 'turn.completed': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) closeAssistantBubble(turn);
      }
      ctx.currentTurnId = null;
      break;
    }

    case 'turn.failed': {
      if (ctx.currentTurnId) {
        const turn = ctx.turns.get(ctx.currentTurnId);
        if (turn) {
          const bubble = ensureAssistantBubble(turn, 0);
          bubble.interrupted = true;
          closeAssistantBubble(turn);
        }
      }
      ctx.currentTurnId = null;
      break;
    }

    default:
      break;
  }
}
