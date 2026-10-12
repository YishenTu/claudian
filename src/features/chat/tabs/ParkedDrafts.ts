import type { ComposerDrafts } from '@/features/chat/composer/ComposerDraftController';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

const DESTINATIONS = ['main', 'side'] as const;

/**
 * Unsent composer text held while no presentation shows its session, so whichever presentation
 * shows the session next takes it. In memory only; everything else a draft carries (selections,
 * Linked content) belongs to the session itself.
 */
export class ParkedDrafts {
  readonly #byConversation = new Map<string, ComposerDrafts>();
  /** A draft session's text, kept after it creates its conversation and dropped with the session. */
  readonly #byDraftSession = new WeakMap<ChatSessionRuntime, ComposerDrafts>();

  /** Holds `tab`'s unsent text for its session, replacing what was held for it. */
  park(tab: AssembledTabRuntime): void {
    const { drafts } = tab.controllers;
    const held: ComposerDrafts = { main: drafts.capture('main'), side: drafts.capture('side') };
    const hasText = DESTINATIONS.some(destination => held[destination].content.trim() || held[destination].images.length > 0);
    const { conversationId, session: { runtime } } = tab;
    if (conversationId) {
      if (hasText) this.#byConversation.set(conversationId, held);
      else this.#byConversation.delete(conversationId);
    } else if (hasText) {
      this.#byDraftSession.set(runtime, held);
    } else {
      this.#byDraftSession.delete(runtime);
    }
  }

  /** Moves the text held for `tab`'s session into its composer, including text parked before promotion. */
  restoreInto(tab: AssembledTabRuntime): void {
    const { conversationId, session: { runtime } } = tab;
    const held = [
      conversationId ? this.#byConversation.get(conversationId) : undefined,
      this.#byDraftSession.get(runtime),
    ];
    if (conversationId) this.#byConversation.delete(conversationId);
    this.#byDraftSession.delete(runtime);
    for (const drafts of held) {
      if (!drafts) continue;
      for (const destination of DESTINATIONS) {
        tab.controllers.drafts.restore(destination, drafts[destination], { merge: true });
      }
    }
  }
}
