import type { App } from 'obsidian';

import type { ComposerDrafts } from '@/features/chat/composer/ComposerDraftController';
import type { TabId } from '@/features/chat/tabs/ChatTab';
import type { NavigationRequestCheck, TabConversationNavigation } from '@/features/chat/tabs/TabConversationNavigation';
import { commitProvisionalTab } from '@/features/chat/tabs/TabLifecycle';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';

/** Whether Linked content still exists; vaults without path lookup accept every path. */
export function linkedContentExists(app: Pick<App, 'vault'>, contentPath: string): boolean {
  const { vault } = app;
  return typeof vault.getAbstractFileByPath !== 'function'
    || vault.getAbstractFileByPath(contentPath) !== null;
}

/** Manager-owned operations the slot drives and revalidates after every await. */
export interface ViewerSlotHost {
  readonly app: Pick<App, 'vault'>;
  readonly membership: TabMembershipView;
  /** The manager's navigation queue; slot requests supersede and are superseded by its opens. */
  readonly navigation: TabConversationNavigation;
  /** Creates and activates a provisional tab; only the slot creates previews. */
  createPreview(conversationId: string | null): Promise<AssembledTabRuntime | null>;
  switchToTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId): Promise<boolean>;
  discardTab(tabId: TabId): Promise<boolean>;
  /** Rebinds `tab`, showing `drafts` in place of the source tab's composer drafts. */
  rebind(
    tab: AssembledTabRuntime,
    conversationId: string,
    isCurrent: NavigationRequestCheck,
    drafts: ComposerDrafts,
  ): Promise<AssembledTabRuntime | null>;
}

export interface ViewerSlotRequest {
  /** The tab whose command issued the request; the request lapses once it stops being live. */
  sourceTab?: AssembledTabRuntime | null;
}

const EMPTY_DRAFTS: ComposerDrafts = {
  main: { content: '', images: [] },
  side: { content: '', images: [] },
};

/**
 * The wide layout's single replaceable preview: the only creator of provisional tabs. Wide
 * navigation never retains a preview; leaving wide turns the shown one into a tab. Unsent
 * composer text stays with its session (or the new-session draft) while the slot shows another.
 */
export class ViewerSlot {
  /** Unsent drafts keyed by conversation; null keys the new-session draft. Wide-only memory. */
  readonly #drafts = new Map<string | null, ComposerDrafts>();

  constructor(private readonly host: ViewerSlotHost) {}

  /** Shows a session: its live owner when one exists, otherwise the preview. */
  async show(conversationId: string, request: ViewerSlotRequest = {}): Promise<void> {
    await this.host.navigation.enqueue(request.sourceTab ?? null, async (isCurrent) => {
      await this.#show(conversationId, isCurrent);
    });
  }

  /**
   * Replaces the preview with a blank draft, optionally linked to `linkedContentPath`. The
   * new-session draft's unsent text returns with it.
   */
  async startDraft(options: ViewerSlotRequest & { linkedContentPath?: string } = {}): Promise<void> {
    const { membership } = this.host;
    const { linkedContentPath, sourceTab = null } = options;
    if (sourceTab && !membership.isTabAlive(sourceTab)) return;
    this.#assertLinkedContentExists(linkedContentPath);

    await this.host.navigation.enqueue(null, async (isCurrent) => {
      this.#assertLinkedContentExists(linkedContentPath);
      for (const preview of this.#livePreviews()) this.#stash(preview);
      const tab = await this.host.createPreview(null);
      if (!tab) throw new Error('Failed to create a provisional chat tab');
      if (!isCurrent()) {
        await this.#discardUnowned(tab, null);
        return;
      }
      try {
        this.#unstashInto(tab);
        if (linkedContentPath !== undefined) {
          this.#assertLinkedContentExists(linkedContentPath);
          tab.linkedContent.selectExplicit(linkedContentPath);
        }
        if (membership.getActiveTabId() === tab.id) tab.composer.focus();
      } catch (error) {
        await this.host.closeTab(tab.id).catch(() => false);
        throw error;
      }
      // One preview per view: the draft replaces every earlier one.
      await this.#closePreviews(tab.id);
    });
  }

  /**
   * Leaves the wide layout: the shown preview becomes a tab, other previews close, and held
   * drafts are dropped. Overlapping calls share one cleanup, which fences navigation.
   */
  async release(): Promise<void> {
    if (this.host.membership.isDestroyed()) return;
    await this.host.navigation.fence(async () => {
      const { membership } = this.host;
      const activeId = membership.getActiveTabId();
      const active = activeId ? membership.getTab(activeId) : null;
      if (active && membership.isTabAlive(active) && active.lifecycleState === 'provisional') {
        commitProvisionalTab(active);
      }
      this.#drafts.clear();
      await this.#closePreviews(null);
    });
  }

  async #show(conversationId: string, isCurrent: NavigationRequestCheck): Promise<void> {
    const { host } = this;
    const { membership } = host;
    if (await host.navigation.focusOwner(conversationId, isCurrent) || !isCurrent()) return;

    const preview = this.#livePreviews()[0];
    if (preview) {
      this.#stash(preview);
      const switched = await host.rebind(preview, conversationId, isCurrent, this.#drafts.get(conversationId) ?? EMPTY_DRAFTS);
      if (switched && membership.isTabAlive(switched)) {
        this.#drafts.delete(conversationId);
        await host.switchToTab(switched.id);
        return;
      }
      if (!isCurrent()) return;
    }

    // Selections never rebind a retained tab: when no preview can show the session, create one.
    const createdTab = await host.createPreview(conversationId);
    if (!isCurrent() && createdTab) {
      await this.#discardUnowned(createdTab, conversationId);
      return;
    }
    if (createdTab) this.#unstashInto(createdTab);
  }

  #livePreviews(): AssembledTabRuntime[] {
    const { membership } = this.host;
    return membership.getAllTabs()
      .filter(tab => membership.isTabAlive(tab) && tab.lifecycleState === 'provisional');
  }

  /** Holds the preview's unsent text under the session it shows. */
  #stash(tab: AssembledTabRuntime): void {
    const { drafts } = tab.controllers;
    const held: ComposerDrafts = { main: drafts.capture('main'), side: drafts.capture('side') };
    if (Object.values(held).some(draft => draft.content.trim() || draft.images.length > 0)) {
      this.#drafts.set(tab.conversationId, held);
    } else {
      this.#drafts.delete(tab.conversationId);
    }
  }

  #unstashInto(tab: AssembledTabRuntime): void {
    const held = this.#drafts.get(tab.conversationId);
    if (!held) return;
    this.#drafts.delete(tab.conversationId);
    for (const destination of ['main', 'side'] as const) {
      tab.controllers.drafts.restore(destination, held[destination], { merge: true });
    }
  }

  async #closePreviews(keptTabId: TabId | null): Promise<void> {
    const { membership } = this.host;
    const previewIds = membership.getAllTabs()
      .filter(tab => tab.lifecycleState === 'provisional' && tab.id !== keptTabId)
      .map(tab => tab.id);
    for (const tabId of previewIds) {
      const tab = membership.getTab(tabId);
      if (!tab || !membership.isTabAlive(tab) || tab.lifecycleState !== 'provisional') continue;
      if (await this.host.closeTab(tabId)) continue;
      const refused = membership.getTab(tabId);
      if (refused && membership.isTabAlive(refused)) commitProvisionalTab(refused);
    }
  }

  /** Removes a preview a superseded request created, unless the user already claimed it. */
  async #discardUnowned(tab: AssembledTabRuntime, conversationId: string | null): Promise<void> {
    if (
      this.host.membership.getTab(tab.id) === tab
      && tab.conversationId === conversationId
      && !tab.session.isUserClaimed
    ) {
      await this.host.discardTab(tab.id);
    }
  }

  #assertLinkedContentExists(contentPath: string | undefined): void {
    if (contentPath !== undefined && !linkedContentExists(this.host.app, contentPath)) {
      throw new Error('Linked content is no longer available');
    }
  }
}
