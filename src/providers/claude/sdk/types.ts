import type { StreamChunk } from '../../../core/types';

export interface ClaudeAsyncSubagentCompletionEvent {
  type: 'async_subagent_completion';
  providerSessionId: string;
  taskId: string;
  toolUseId?: string;
  status: 'completed' | 'error';
  result?: string;
}

export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
  agents?: string[];
  permissionMode?: string;
}

export interface ContextWindowEvent {
  type: 'context_window';
  contextWindow: number;
}

export type TransformEvent =
  | StreamChunk
  | SessionInitEvent
  | ContextWindowEvent
  | ClaudeAsyncSubagentCompletionEvent;
