import type { StreamChunk, SubagentProgress } from '../../../core/types';

export interface ClaudeAsyncSubagentCompletionEvent {
  type: 'async_subagent_completion';
  providerSessionId: string;
  taskId: string;
  toolUseId?: string;
  status: 'completed' | 'error';
  result?: string;
}

export interface ClaudeSubagentProgressEvent {
  type: 'subagent_progress';
  progress: SubagentProgress;
}

export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
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
  | ClaudeAsyncSubagentCompletionEvent
  | ClaudeSubagentProgressEvent;
