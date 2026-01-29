/**
 * Types and constants for the ClaudianService module.
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { SystemPromptSettings } from '../prompts/mainAgent';
import type { ClaudeModel, PermissionMode, StreamChunk } from '../types';

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type SDKContentBlock = TextContentBlock | ImageContentBlock;

/** Overflow: newest message is dropped with a warning. */
export const MESSAGE_CHANNEL_CONFIG = {
  MAX_QUEUED_MESSAGES: 8, // Memory protection from rapid user input
  MAX_MERGED_CHARS: 12000, // ~3k tokens — batch size under context limits
} as const;

/** Pending message in the queue (text-only for merging). */
export interface PendingTextMessage {
  type: 'text';
  content: string;
}

/** Pending message with attachments (cannot be merged). */
export interface PendingAttachmentMessage {
  type: 'attachment';
  message: SDKUserMessage;
}

export type PendingMessage = PendingTextMessage | PendingAttachmentMessage;

export interface ClosePersistentQueryOptions {
  preserveHandlers?: boolean;
}

/**
 * Handler for routing stream chunks to the appropriate query caller.
 *
 * Lifecycle:
 * 1. Created: Handler is registered via registerResponseHandler() when a query starts
 * 2. Receiving: Chunks arrive via onChunk(), sawAnyChunk and sawStreamText track state
 * 3. Terminated: Exactly one of onDone() or onError() is called when the turn ends
 *
 * Invariants:
 * - Only one handler is active at a time (MessageChannel enforces single-turn)
 * - After onDone()/onError(), the handler is unregistered and should not receive more chunks
 * - sawAnyChunk is used for crash recovery (restart if no chunks seen before error)
 * - sawStreamText prevents duplicate text from non-streamed assistant messages
 */
export interface ResponseHandler {
  readonly id: string;
  onChunk: (chunk: StreamChunk) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  readonly sawStreamText: boolean;
  readonly sawAnyChunk: boolean;
  markStreamTextSeen(): void;
  resetStreamText(): void;
  markChunkSeen(): void;
}

export interface ResponseHandlerOptions {
  id: string;
  onChunk: (chunk: StreamChunk) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export function createResponseHandler(options: ResponseHandlerOptions): ResponseHandler {
  let _sawStreamText = false;
  let _sawAnyChunk = false;

  return {
    id: options.id,
    onChunk: options.onChunk,
    onDone: options.onDone,
    onError: options.onError,
    get sawStreamText() { return _sawStreamText; },
    get sawAnyChunk() { return _sawAnyChunk; },
    markStreamTextSeen() { _sawStreamText = true; },
    resetStreamText() { _sawStreamText = false; },
    markChunkSeen() { _sawAnyChunk = true; },
  };
}

/** Tracked configuration for detecting changes that require restart. */
export interface PersistentQueryConfig {
  model: string | null;
  thinkingTokens: number | null;
  permissionMode: PermissionMode | null;
  systemPromptKey: string;
  disallowedToolsKey: string;
  mcpServersKey: string;
  pluginsKey: string;
  externalContextPaths: string[];
  allowedExportPaths: string[];
  settingSources: string;
  claudeCliPath: string;
  show1MModel: boolean;  // Whether 1M beta flag is always included
  enableChrome: boolean;  // Whether --chrome flag is passed to CLI
}

export interface SessionState {
  sessionId: string | null;
  sessionModel: ClaudeModel | null;
  pendingSessionModel: ClaudeModel | null;
  wasInterrupted: boolean;
  /** Set when SDK returns a different session ID than expected (context lost). */
  needsHistoryRebuild: boolean;
  /** Set when the current session is invalidated by SDK errors. */
  sessionInvalidated: boolean;
}

/** SDK tools that require canUseTool interception (not supported in bypassPermissions mode). */
export const UNSUPPORTED_SDK_TOOLS = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

/** Built-in subagents that don't apply to Obsidian context. */
export const DISABLED_BUILTIN_SUBAGENTS = [
  'Task(statusline-setup)',
] as const;

/**
 * Check if an SDK message signals turn completion.
 * - 'result' is the normal completion signal
 * - 'error' may also complete the turn when SDK emits an error without result
 *
 * Note: We cast to string because TypeScript's SDK types may not include 'error'
 * but it can occur at runtime.
 */
export function isTurnCompleteMessage(message: SDKMessage): boolean {
  const messageType = message.type as string;
  return messageType === 'result' || messageType === 'error';
}

export function computeSystemPromptKey(settings: SystemPromptSettings): string {
  // Include only fields surfaced in the system prompt to avoid stale cache hits.
  const parts = [
    settings.mediaFolder || '',
    settings.customPrompt || '',
    (settings.allowedExportPaths || []).sort().join('|'),
    settings.vaultPath || '',
    (settings.userName || '').trim(),
    // Note: hasEditorContext is per-message, not tracked here
  ];
  return parts.join('::');
}
