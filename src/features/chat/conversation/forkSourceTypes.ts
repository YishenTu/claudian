import type { ProviderCapabilities, ProviderId } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';

export interface ForkContext {
  messages: ChatMessage[];
  providerId?: ProviderId;
  forkMode?: ProviderCapabilities['forkMode'];
  sourceConversationId: string | null;
  sourceSessionId: string;
  sourceProviderState?: Record<string, unknown>;
  sourceSelectedModel?: string;
  resumeAt: string;
  sourceTitle?: string;
  /** 1-based index used for fork title suffix (counts only canonical user messages). */
  forkAtUserMessage?: number;
  linkedContentPath?: string;
}

export type ForkSourceUnavailableReason =
  | 'unsupported-provider'
  | 'streaming'
  | 'rewinding'
  | 'no-messages'
  | 'not-latest-reply'
  | 'no-checkpoint'
  | 'no-session'
  | 'stale-binding';

export type ForkSourceCapture =
  | { readonly ok: true; readonly context: ForkContext }
  | { readonly ok: false; readonly reason: ForkSourceUnavailableReason };
