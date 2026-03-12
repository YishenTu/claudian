import type { StreamChunk } from '../types';

export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
  /** Resolved model name from CLI (e.g. gemini-2.5-pro, gemini-3.0-flash). */
  model?: string;
  agents?: string[];
  permissionMode?: string;
}

export type TransformEvent = StreamChunk | SessionInitEvent;
