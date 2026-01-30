/**
 * Tool-related type definitions.
 */

import type { DiffLine, DiffStats } from './diff';

/** Diff data for Write/Edit tool operations (pre-computed from SDK structuredPatch). */
export interface ToolDiffData {
  filePath: string;
  diffLines: DiffLine[];
  stats: DiffStats;
}

/** Parsed option for AskUserQuestion tool. */
export interface AskUserQuestionOption {
  label: string;
  description: string;
}

/** Parsed question for AskUserQuestion tool. */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/** User-provided answers keyed by question text. */
export type AskUserAnswers = Record<string, string>;

/** Tool call tracking with status and result. */
export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'completed' | 'error' | 'blocked';
  result?: string;
  isExpanded?: boolean;
  diffData?: ToolDiffData;
  resolvedAnswers?: AskUserAnswers;
}

/** Subagent execution mode: sync (nested tools) or async (background). */
export type SubagentMode = 'sync' | 'async';

/** Async subagent lifecycle states. */
export type AsyncSubagentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'orphaned';

/** Subagent (Task tool) tracking for sync and async modes. */
export interface SubagentInfo {
  id: string;
  description: string;
  prompt?: string;
  mode?: SubagentMode;
  isExpanded: boolean;
  result?: string;
  status: 'running' | 'completed' | 'error';
  toolCalls: ToolCallInfo[];
  asyncStatus?: AsyncSubagentStatus;
  agentId?: string;
  outputToolId?: string;
  startedAt?: number;
  completedAt?: number;
}
