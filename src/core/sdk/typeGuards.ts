/**
 * Type guards for SDK transformer events.
 */

import type { StreamChunk } from '../types';
import type { SessionInitEvent, TransformEvent } from './types';

/**
 * Type guard to check if an event is a session init event
 */
export function isSessionInitEvent(event: TransformEvent): event is SessionInitEvent {
  return event.type === 'session_init';
}

/**
 * Type guard to check if an event is a stream chunk
 */
export function isStreamChunk(event: TransformEvent): event is StreamChunk {
  return event.type !== 'session_init';
}
