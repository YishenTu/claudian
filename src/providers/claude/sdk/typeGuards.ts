import type { StreamChunk } from '../../../core/types';
import type { ContextWindowEvent, SessionInitEvent, TransformEvent } from './types';

export function isSessionInitEvent(event: TransformEvent): event is SessionInitEvent {
  return event.type === 'session_init';
}

export function isContextWindowEvent(event: TransformEvent): event is ContextWindowEvent {
  return event.type === 'context_window';
}

export function isStreamChunk(event: TransformEvent): event is StreamChunk {
  return event.type !== 'session_init' && event.type !== 'context_window';
}
