import type { StreamChunk } from '../types';

export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
  agents?: string[];
  skills?: string[];
  slashCommands?: string[];
}

export type TransformEvent = StreamChunk | SessionInitEvent;
