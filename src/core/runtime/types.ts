import type { BrowserSelectionContext } from '../../utils/browser';
import type { CanvasSelectionContext } from '../../utils/canvas';
import type { EditorSelectionContext } from '../../utils/editor';
import type {
  ApprovalDecision,
  Conversation,
  ExitPlanModeCallback,
  ImageAttachment,
} from '../types';

export interface ApprovalCallbackOptions {
  decisionReason?: string;
  blockedPath?: string;
  agentID?: string;
}

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  options?: ApprovalCallbackOptions,
) => Promise<ApprovalDecision>;

export type AskUserQuestionCallback = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

export interface ChatTurnRequest {
  text: string;
  images?: ImageAttachment[];
  currentNotePath?: string;
  editorSelection?: EditorSelectionContext | null;
  browserSelection?: BrowserSelectionContext | null;
  canvasSelection?: CanvasSelectionContext | null;
  externalContextPaths?: string[];
  enabledMcpServers?: Set<string>;
}

export interface PreparedChatTurn {
  request: ChatTurnRequest;
  persistedContent: string;
  prompt: string;
  isCompact: boolean;
  mcpMentions: Set<string>;
}

export interface ChatRuntimeQueryOptions {
  allowedTools?: string[];
  model?: string;
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  forceColdStart?: boolean;
  externalContextPaths?: string[];
}

export interface ChatRuntimeEnsureReadyOptions {
  sessionId?: string;
  externalContextPaths?: string[];
  force?: boolean;
  preserveHandlers?: boolean;
}

export type ChatRuntimeConversationState = Pick<
  Conversation,
  'sessionId'
>;

export interface SessionUpdateResult {
  updates: Partial<Conversation>;
}

export interface ChatRewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface SubagentRuntimeState {
  hasRunning: boolean;
}

export type {
  ApprovalDecision,
  ExitPlanModeCallback,
};
