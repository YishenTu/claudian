import type { StreamChunk } from '../../../core/types';
import type {
  ClaudeAsyncSubagentCompletionEvent,
  ContextWindowEvent,
  SessionInitEvent,
  TransformEvent,
} from './types';

export function isSessionInitEvent(event: TransformEvent): event is SessionInitEvent {
  return event.type === 'session_init';
}

export function isContextWindowEvent(event: TransformEvent): event is ContextWindowEvent {
  return event.type === 'context_window';
}

export function isAsyncSubagentCompletion(
  event: TransformEvent,
): event is ClaudeAsyncSubagentCompletionEvent {
  return event.type === 'async_subagent_completion';
}

export function isStreamChunk(event: TransformEvent): event is StreamChunk {
  return event.type !== 'session_init'
    && event.type !== 'context_window'
    && event.type !== 'async_subagent_completion';
}
