import type { ComposerDrafts } from '@/features/chat/composer/ComposerDraftController';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

const DESTINATIONS = ['main', 'side'] as const;

interface ParkedDraft {
  readonly drafts: ComposerDrafts;
  /** A blank draft's explicit Linked content choice; null explicitly chooses none. */
  readonly linkedContentPath?: string | null;
}

/**
 * Unsent input held while no presentation shows it: a session's text while the wide viewer
 * shows another or the wide layout unloads its narrow tab, and the new-session draft's text and
 * Linked content choice. In memory only. Every assembled presentation takes what is held for it.
 */
export class ParkedDrafts {
  readonly #parked = new Map<string, ParkedDraft>();

  /** Whether a held Linked content path still exists when it is restored. */
  constructor(private readonly linkedContentExists: (path: string) => boolean) {}

  /** A session's input follows the session; a blank tab's stays with that tab or the new-session draft. */
  static keyFor(identity: Pick<TabIdentity, 'id' | 'conversationId' | 'lifecycleState'>): string {
    if (identity.conversationId) return `session:${identity.conversationId}`;
    return identity.lifecycleState === 'provisional' ? 'new-session' : `tab:${identity.id}`;
  }

  /** Holds `tab`'s unsent input under `key`, replacing what was held there. */
  park(tab: AssembledTabRuntime, key = ParkedDrafts.keyFor(tab)): void {
    const { drafts } = tab.controllers;
    const held: ComposerDrafts = { main: drafts.capture('main'), side: drafts.capture('side') };
    const linked = tab.conversationId === null ? tab.linkedContent.getSnapshot() : null;
    const hasText = DESTINATIONS.some(destination => (
      held[destination].content.trim() || held[destination].images.length > 0
    ));
    if (!hasText && linked?.mode !== 'explicit-draft') {
      this.#parked.delete(key);
      return;
    }
    this.#parked.set(key, {
      drafts: held,
      ...(linked?.mode === 'explicit-draft' ? { linkedContentPath: linked.path } : {}),
    });
  }

  /** Moves the input held for `tab` into its composer and, for a blank draft, its Linked content. */
  restoreInto(tab: AssembledTabRuntime, key = ParkedDrafts.keyFor(tab)): void {
    const held = this.#parked.get(key);
    if (!held) return;
    this.#parked.delete(key);
    for (const destination of DESTINATIONS) {
      tab.controllers.drafts.restore(destination, held.drafts[destination], { merge: true });
    }
    const path = held.linkedContentPath;
    if (
      path !== undefined
      && tab.conversationId === null
      && tab.linkedContent.getSnapshot().mode === 'auto-draft'
      && (path === null || this.linkedContentExists(path))
    ) {
      tab.linkedContent.selectExplicit(path);
    }
  }
}
