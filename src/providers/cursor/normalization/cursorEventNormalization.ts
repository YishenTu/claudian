import type { StreamChunk, UsageInfo } from '../../../core/types';
import type {
  CursorAssistantMessageEvent,
  CursorResultEvent,
  CursorShellToolCall,
  CursorStreamEvent,
  CursorSystemInitEvent,
  CursorThinkingDeltaEvent,
  CursorToolCallCompletedEvent,
  CursorToolCallShape,
  CursorToolCallStartedEvent,
} from '../runtime/cursorEventTypes';
import { extractAssistantText } from '../runtime/cursorEventTypes';

const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface CursorNormalizationContext {
  contextWindowSize?: number;
  /** Tracks the currently selected model id reported by the runtime. */
  modelHint?: string;
}

export interface CursorNormalizationState {
  /** Cumulative assistant text emitted so far (concatenation of all `assistant` deltas). */
  assistantTextSoFar: string;
  sessionId: string | null;
  finalText: string | null;
  finalUsage: UsageInfo | null;
  errorMessage: string | null;
  done: boolean;
}

export function createCursorNormalizationState(): CursorNormalizationState {
  return {
    assistantTextSoFar: '',
    sessionId: null,
    finalText: null,
    finalUsage: null,
    errorMessage: null,
    done: false,
  };
}

function isSystemInit(event: CursorStreamEvent): event is CursorSystemInitEvent {
  return event.type === 'system' && (event as { subtype?: string }).subtype === 'init';
}

function isThinkingDelta(event: CursorStreamEvent): event is CursorThinkingDeltaEvent {
  return event.type === 'thinking' && (event as { subtype?: string }).subtype === 'delta';
}

function isAssistantMessage(event: CursorStreamEvent): event is CursorAssistantMessageEvent {
  return event.type === 'assistant';
}

function isToolCallStarted(event: CursorStreamEvent): event is CursorToolCallStartedEvent {
  return event.type === 'tool_call' && (event as { subtype?: string }).subtype === 'started';
}

function isToolCallCompleted(event: CursorStreamEvent): event is CursorToolCallCompletedEvent {
  return event.type === 'tool_call' && (event as { subtype?: string }).subtype === 'completed';
}

function isResult(event: CursorStreamEvent): event is CursorResultEvent {
  return event.type === 'result';
}

function isShellToolCall(toolCall: CursorToolCallShape): toolCall is CursorShellToolCall {
  return Object.prototype.hasOwnProperty.call(toolCall, 'shellToolCall');
}

function summarizeToolName(toolCall: CursorToolCallShape): string {
  if (isShellToolCall(toolCall)) {
    return 'shell';
  }
  const keys = Object.keys(toolCall);
  return keys[0] ?? 'tool';
}

function summarizeToolInput(toolCall: CursorToolCallShape): Record<string, unknown> {
  if (isShellToolCall(toolCall)) {
    const args = toolCall.shellToolCall.args ?? {};
    const summary: Record<string, unknown> = {};
    if (typeof args.command === 'string') summary.command = args.command;
    if (typeof args.workingDirectory === 'string' && args.workingDirectory) {
      summary.workingDirectory = args.workingDirectory;
    }
    if (typeof args.description === 'string' && args.description) {
      summary.description = args.description;
    }
    if (typeof toolCall.shellToolCall.description === 'string' && toolCall.shellToolCall.description) {
      summary.description = toolCall.shellToolCall.description;
    }
    return summary;
  }
  return toolCall as Record<string, unknown>;
}

function summarizeToolResult(toolCall: CursorToolCallShape): { content: string; isError: boolean } {
  if (isShellToolCall(toolCall)) {
    const result = toolCall.shellToolCall.result;
    if (result?.error) {
      const errorMessage = typeof result.error === 'string'
        ? result.error
        : result.error.message ?? 'Tool error';
      return { content: errorMessage, isError: true };
    }
    if (result?.success) {
      const success = result.success;
      const exitCode = typeof success.exitCode === 'number' ? success.exitCode : 0;
      const stdout = success.stdout ?? '';
      const stderr = success.stderr ?? '';
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      return {
        content: parts.join('\n').trim() || `(exit ${exitCode})`,
        isError: exitCode !== 0,
      };
    }
  }
  return { content: '', isError: false };
}

function buildUsageInfo(
  event: CursorResultEvent,
  contextWindow: number,
  modelHint: string | undefined,
): UsageInfo {
  const inputTokens = event.usage?.inputTokens ?? 0;
  const outputTokens = event.usage?.outputTokens ?? 0;
  const cacheReadInputTokens = event.usage?.cacheReadTokens ?? 0;
  const cacheCreationInputTokens = event.usage?.cacheWriteTokens ?? 0;

  const contextTokens = inputTokens + outputTokens
    + cacheReadInputTokens + cacheCreationInputTokens;
  const percentage = contextWindow > 0
    ? Math.round(Math.min(100, Math.max(0, (contextTokens / contextWindow) * 100)))
    : 0;

  return {
    model: modelHint,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextWindow,
    contextWindowIsAuthoritative: false,
    contextTokens,
    percentage,
  };
}

/**
 * Translates a single Cursor NDJSON event into zero or more provider-neutral
 * `StreamChunk`s and updates the running normalization state.
 */
export function normalizeCursorEvent(
  event: CursorStreamEvent,
  state: CursorNormalizationState,
  context: CursorNormalizationContext = {},
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const contextWindow = context.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW;

  if (typeof event.session_id === 'string' && event.session_id) {
    state.sessionId = event.session_id;
  }

  if (isSystemInit(event)) {
    if (event.session_id) {
      state.sessionId = event.session_id;
    }
    return chunks;
  }

  if (event.type === 'user') {
    return chunks;
  }

  if (isThinkingDelta(event)) {
    if (typeof event.text === 'string' && event.text.length > 0) {
      chunks.push({ type: 'thinking', content: event.text });
    }
    return chunks;
  }

  if (event.type === 'thinking') {
    return chunks;
  }

  if (isAssistantMessage(event)) {
    const text = extractAssistantText(event.message);
    if (typeof event.timestamp_ms === 'number') {
      // Streaming delta: emit the new text only.
      if (text.length > 0) {
        chunks.push({ type: 'text', content: text });
        state.assistantTextSoFar += text;
      }
      return chunks;
    }

    // Final consolidated assistant message with no timestamp: capture for
    // post-stream sanity checks but do not re-emit (would duplicate).
    state.finalText = text;
    return chunks;
  }

  if (isToolCallStarted(event)) {
    chunks.push({
      type: 'tool_use',
      id: event.call_id,
      name: summarizeToolName(event.tool_call),
      input: summarizeToolInput(event.tool_call),
    });
    return chunks;
  }

  if (isToolCallCompleted(event)) {
    const result = summarizeToolResult(event.tool_call);
    chunks.push({
      type: 'tool_result',
      id: event.call_id,
      content: result.content,
      isError: result.isError,
    });
    return chunks;
  }

  if (isResult(event)) {
    if (event.is_error || event.subtype === 'error') {
      const message = typeof event.error === 'string'
        ? event.error
        : event.error?.message
          ?? (typeof event.result === 'string' ? event.result : 'Cursor agent reported an error.');
      state.errorMessage = message;
      chunks.push({ type: 'error', content: message });
    } else {
      if (typeof event.result === 'string' && event.result.length > 0) {
        state.finalText = event.result;
      }
      const usage = buildUsageInfo(event, contextWindow, context.modelHint);
      state.finalUsage = usage;
      chunks.push({
        type: 'usage',
        usage,
        sessionId: state.sessionId,
      });
    }
    chunks.push({ type: 'done' });
    state.done = true;
    return chunks;
  }

  return chunks;
}

/**
 * Convenience helper for tests: feed an entire NDJSON transcript and collect
 * the StreamChunk sequence + final state.
 */
export function normalizeCursorEventStream(
  events: CursorStreamEvent[],
  context: CursorNormalizationContext = {},
): { chunks: StreamChunk[]; state: CursorNormalizationState } {
  const state = createCursorNormalizationState();
  const chunks: StreamChunk[] = [];
  for (const event of events) {
    if (state.done) {
      break;
    }
    chunks.push(...normalizeCursorEvent(event, state, context));
  }
  return { chunks, state };
}
