import type { ComposerDrafts } from '@/features/chat/composer/ComposerDraftController';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

const DESTINATIONS = ['main', 'side'] as const;

/**
 * Unsent composer text held while no presentation shows its session. Keyed by session, so
 * whichever presentation reattaches the session takes it. In memory only; everything else a
 * draft carries (selections, Linked content) belongs to the session itself.
 */
export class ParkedDrafts {
  readonly #parked = new Map<string, ComposerDrafts>();

  /** Text follows its session: by conversation once it has one, otherwise by its draft session. */
  static keyFor(tab: AssembledTabRuntime): string {
    return tab.conversationId ? `session:${tab.conversationId}` : `draft:${tab.session.runtime.sessionKey}`;
  }

  /** The key an unloaded tab's presentation will take its text from when it reattaches. */
  static keyForIdentity(identity: Pick<TabIdentity, 'id' | 'conversationId' | 'draftSessionKey'>): string {
    if (identity.conversationId) return `session:${identity.conversationId}`;
    return identity.draftSessionKey ? `draft:${identity.draftSessionKey}` : `tab:${identity.id}`;
  }

  /** Holds `tab`'s unsent text under `key`, replacing what was held there. */
  park(tab: AssembledTabRuntime, key = ParkedDrafts.keyFor(tab)): void {
    const { drafts } = tab.controllers;
    const held: ComposerDrafts = { main: drafts.capture('main'), side: drafts.capture('side') };
    if (DESTINATIONS.some(destination => held[destination].content.trim() || held[destination].images.length > 0)) {
      this.#parked.set(key, held);
    } else {
      this.#parked.delete(key);
    }
  }

  /** Moves the text held for `tab` into its composer. */
  restoreInto(tab: AssembledTabRuntime, key = ParkedDrafts.keyFor(tab)): void {
    const held = this.#parked.get(key);
    if (!held) return;
    this.#parked.delete(key);
    for (const destination of DESTINATIONS) {
      tab.controllers.drafts.restore(destination, held[destination], { merge: true });
    }
  }
}
