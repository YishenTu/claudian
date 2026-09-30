import type { WorkspaceLeaf } from 'obsidian';

import type { AssembledTabRuntime } from '../tabs/types';

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
  getZenRuntime(): AssembledTabRuntime | null;
  /** Notifies readiness and active-runtime changes. */
  onZenPresentationChanged(listener: () => void): () => void;
  /** Moves the active runtime's transcript and composer; the release restores them and is idempotent. */
  attachZenPresentation(slots: ZenModeSlots): () => void;
}
