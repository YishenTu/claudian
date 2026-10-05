import type { WorkspaceLeaf } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import type { ChatActivity } from '@/features/chat/state/types';

/** Containers owned by the zen surface that receive a source's live nodes. */
export interface ZenModeSlots {
  readonly historyEl: HTMLElement;
  readonly composerEl: HTMLElement;
  /** Receives the collapsed side-chat chip below the composer. */
  readonly sideChatChipEl: HTMLElement;
}

/**
 * A chat view whose existing presentation can move into the zen surface. The
 * view stays the placement authority; zen mode never owns chat state.
 */
export interface ZenModeSource {
  readonly leaf: WorkspaceLeaf;
  /** The committed active runtime, or null while the view is not ready. */
  getZenPresentation(): ZenPresentationPort | null;
  /** The provider whose brand color the view currently shows. */
  getZenProviderId(): ProviderId | null;
  /** Notifies readiness, active-runtime, and brand-provider changes. */
  onZenPresentationChanged(listener: () => void): () => void;
  /** Moves the active runtime's transcript and composer; the release restores them and is idempotent. */
  attachZenPresentation(slots: ZenModeSlots): () => void;
}

/** Reading intent captured before the transcript is relocated. */
export interface ZenScrollSnapshot {
  readonly top: number;
  readonly follow: boolean;
}

/** Activity reads and tab-owned scroll behavior available to the zen presentation. */
export interface ZenPresentationPort {
  readonly state: {
    readonly activity: ChatActivity | null;
    readonly isStreaming: boolean;
    readonly lastMessage: ChatMessage | null;
    readonly requiresAction: boolean;
    readonly waitingStatus: string | null;
    readonly messages: readonly ChatMessage[];
  };
  readonly window: Window | null;
  subscribeActivity(listener: () => void): () => void;
  captureScroll(): ZenScrollSnapshot;
  restoreScroll(snapshot?: ZenScrollSnapshot): void;
}
