import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

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
  permissionMode?: PermissionMode;
}

export interface ContextWindowEvent {
  type: 'context_window';
  contextWindow: number;
}

/** Claude reports errors as text only; it never produces the shared chunk's session-missing code. */
export interface ClaudeErrorChunk {
  type: 'error';
  content: string;
}

type WithNativeToolUseResult<Chunk> = Chunk extends unknown
  ? Omit<Chunk, 'resultDetails'> & { toolUseResult?: unknown }
  : never;

/** Tool results keep the native `tool_use_result` until the event normalizer decodes it. */
export type ClaudeToolResultChunk = WithNativeToolUseResult<
  Extract<StreamChunk, { type: 'tool_result' | 'subagent_tool_result' }>
>;

/** The subset of shared stream chunks the Claude transform actually emits. */
export type ClaudeOutputChunk =
  | Extract<StreamChunk, {
    type:
      | 'text'
      | 'thinking'
      | 'tool_use'
      | 'subagent_tool_use'
      | 'usage'
      | 'context_compacted';
  }>
  | ClaudeToolResultChunk;

export type ClaudeStreamChunk = ClaudeOutputChunk | ClaudeErrorChunk;

export type TransformEvent =
  | ClaudeStreamChunk
  | SessionInitEvent
  | ContextWindowEvent
  | ClaudeAsyncSubagentCompletionEvent
  | ClaudeSubagentProgressEvent;
