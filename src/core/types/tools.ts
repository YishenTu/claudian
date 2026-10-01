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
  value?: string;
}

/** Parsed question for AskUserQuestion tool. */
export interface AskUserQuestionItem {
  question: string;
  id?: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

/** User-provided answers keyed by question text or stable question id. */
export type AskUserAnswers = Record<string, string | string[]>;

/** One web search hit, as far as the provider reports it. */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

/** Image produced by a tool: a local file or inline base64 data. */
export type ToolResultImage =
  | { kind: 'file'; path: string; alt?: string }
  | { kind: 'data'; mediaType: string; data: string; alt?: string };

/** A call a script tool made to another tool; it never reached the model as its own tool call. */
export interface ScriptToolCallItem {
  /** Shared tool name when the provider maps one. */
  name: string;
  /** Input in the shared renderer shape, when the provider reports complete arguments. */
  input?: Record<string, unknown>;
  /** Provider-formatted arguments, shown only when `input` is absent. */
  args?: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  durationMs?: number;
  error?: string;
}

/** Provider-owned fields for lossless per-tool replay and persistence. */
export interface ToolProviderPayload {
  rawInput?: unknown;
  rawName?: string;
  rawOutput?: unknown;
}

/** Tool call tracking with status and result. */
export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'completed' | 'error' | 'blocked';
  result?: string;
  /** Plain results are displayed verbatim; unmarked Read results retain legacy gutter decoding. */
  resultFormat?: 'plain';
  providerPayload?: ToolProviderPayload;
  isExpanded?: boolean;
  diffData?: ToolDiffData;
  resolvedAnswers?: AskUserAnswers;
  /** Structured web search hits; renderers fall back to result text when absent. */
  webSearchResults?: WebSearchResultItem[];
  /** Provider-synthesized answer accompanying structured hits. */
  webSearchSummary?: string;
  /** Images the tool produced, shown after its expanded result. */
  resultImages?: ToolResultImage[];
  /** Calls a script tool made to other tools, in call order. Live snapshots only append calls or advance their status. */
  scriptToolCalls?: ScriptToolCallItem[];
  /** Live async question presentation; replay alone never opens a prompt. */
  questionStatus?: 'pending' | 'expired';
  subagent?: SubagentInfo;
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

/** Subagent (Agent tool) tracking for sync and async modes. */
export interface SubagentInfo {
  /** Session events own this state independently of the parent tool result. */
  lifecycleSource?: 'session';
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

/** Display-only snapshot of a running subagent; newer snapshots replace older ones and none is persisted. */
export interface SubagentProgress {
  /** Tool call that spawned the subagent. */
  toolCallId: string;
  /** One-line description of what the subagent is doing now. */
  summary?: string;
  lastToolName?: string;
  toolUses?: number;
  totalTokens?: number;
  durationMs?: number;
}
