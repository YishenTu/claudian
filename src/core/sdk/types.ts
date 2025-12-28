/**
 * SDK transformer type definitions.
 */

import type { StreamChunk } from '../types';

/** Event emitted when a session is initialized */
export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
}

/** Union type for all events that can be yielded by the transformer */
export type TransformEvent = StreamChunk | SessionInitEvent;
