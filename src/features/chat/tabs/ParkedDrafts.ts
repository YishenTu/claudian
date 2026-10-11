import type { ComposerDrafts } from '@/features/chat/composer/ComposerDraftController';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

const DESTINATIONS = ['main', 'side'] as const;

/**
 * Unsent composer text held while no presentation shows it: a session's text while the wide
 * viewer shows another, a narrow tab's text while the wide layout unloads it, and the new-session
 * draft. In memory only. Every assembled presentation takes the text held for it.
 */
export class ParkedDrafts {
  readonly #drafts = new Map<string, ComposerDrafts>();

  /** A session's text follows the session; a blank tab's stays with that tab or the new-session draft. */
  static keyFor(identity: Pick<TabIdentity, 'id' | 'conversationId' | 'lifecycleState'>): string {
    if (identity.conversationId) return `session:${identity.conversationId}`;
    return identity.lifecycleState === 'provisional' ? 'new-session' : `tab:${identity.id}`;
  }

  /** Holds `tab`'s unsent text under `key`, replacing what was held there. */
  park(tab: AssembledTabRuntime, key = ParkedDrafts.keyFor(tab)): void {
    const { drafts } = tab.controllers;
    const held: ComposerDrafts = { main: drafts.capture('main'), side: drafts.capture('side') };
    if (DESTINATIONS.some(destination => held[destination].content.trim() || held[destination].images.length > 0)) {
      this.#drafts.set(key, held);
    } else {
      this.#drafts.delete(key);
    }
  }

  /** Moves the text held for `tab` into its composer. */
  restoreInto(tab: AssembledTabRuntime, key = ParkedDrafts.keyFor(tab)): void {
    const held = this.#drafts.get(key);
    if (!held) return;
    this.#drafts.delete(key);
    for (const destination of DESTINATIONS) {
      tab.controllers.drafts.restore(destination, held[destination], { merge: true });
    }
  }
}
