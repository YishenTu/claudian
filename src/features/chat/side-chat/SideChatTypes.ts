import type { ProviderId } from '../../../core/providers/types';
import type { ChatMessage, ImageAttachment } from '../../../core/types';

/** Composer destination derived from side panel expansion; never separately mutable. */
export type SideChatDestination = 'main' | 'side';

export type SideChatStatus =
  | 'preparing'
  | 'idle'
  | 'working'
  | 'error'
  | 'action-required';

/**
 * Frozen source captured when a nonempty side command is submitted. It is never
 * refreshed from a later main checkpoint.
 */
export interface SideChatSource {
  readonly providerId: ProviderId;
  readonly conversationId: string | null;
  readonly sessionId: string;
  readonly resumeAt: string;
  readonly providerState?: Record<string, unknown>;
  readonly selectedModel?: string;
  readonly linkedContentPath?: string;
  readonly messages: readonly ChatMessage[];
}

/** In-memory provider settings projection owned by one side chat. */
export interface SideChatSettingsProjection {
  model?: string;
  permissionMode?: string;
  reasoning?: string | null;
  serviceTier?: string;
}

/**
 * Destination-owned composer draft. Editor/browser/canvas selection context is
 * read live from the shared composer at submission, so only restorable state
 * lives here.
 */
export interface SideChatComposerDraft {
  readonly content: string;
  readonly images: readonly ImageAttachment[];
}

export const EMPTY_SIDE_CHAT_DRAFT: SideChatComposerDraft = Object.freeze({
  content: '',
  images: Object.freeze([]),
});
