/**
 * Types and constants for the ClaudianService module.
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { SystemPromptSettings } from '../prompts/mainAgent';
import type { ClaudeModel, PermissionMode, StreamChunk } from '../types';

// ============================================
// SDK Content Types
// ============================================

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

// ============================================
// Message Channel Types
// ============================================

/**
 * Message queue configuration for the persistent query channel.
 *
 * MAX_QUEUED_MESSAGES: Maximum pending messages before dropping.
 * This prevents memory buildup from rapid user input. 8 allows
 * reasonable queuing while protecting against runaway scenarios.
 *
 * MAX_MERGED_CHARS: Maximum merged text content size.
 * Text messages are merged to reduce API calls. 12000 chars allows
 * substantial batching while staying well under token limits.
 */
export const MESSAGE_CHANNEL_CONFIG = {
  MAX_QUEUED_MESSAGES: 8,
  MAX_MERGED_CHARS: 12000,
};

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

// ============================================
// Response Handler for Routing
// ============================================

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
  id: string;
  onChunk: (chunk: StreamChunk) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  sawStreamText: boolean;
  sawAnyChunk: boolean;
}

// ============================================
// Persistent Query Configuration State
// ============================================

/** Tracked configuration for detecting changes that require restart. */
export interface PersistentQueryConfig {
  model: string | null;
  thinkingTokens: number | null;
  permissionMode: PermissionMode | null;
  allowDangerouslySkip: boolean;
  systemPromptKey: string;
  disallowedToolsKey: string;
  mcpServersKey: string;
  externalContextPaths: string[];
  allowedExportPaths: string[];
  settingSources: string;
  claudeCliPath: string;
}

// ============================================
// Session State Types
// ============================================

export interface SessionState {
  sessionId: string | null;
  sessionModel: ClaudeModel | null;
  pendingSessionModel: ClaudeModel | null;
  wasInterrupted: boolean;
}

// ============================================
// Constants
// ============================================

/** SDK tools that require canUseTool interception (not supported in bypassPermissions mode). */
export const UNSUPPORTED_SDK_TOOLS = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

// ============================================
// Helper Functions
// ============================================

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

/** Compute a stable key for system prompt inputs. */
export function computeSystemPromptKey(settings: SystemPromptSettings): string {
  const parts = [
    settings.mediaFolder || '',
    settings.customPrompt || '',
    (settings.allowedExportPaths || []).sort().join('|'),
    settings.vaultPath || '',
    // Note: hasEditorContext is per-message, not tracked here
  ];
  return parts.join('::');
}
