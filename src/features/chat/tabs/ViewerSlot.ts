import type { App } from 'obsidian';

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
  /** Sessions whose previews are retained rather than released (pinned sessions). */
  shouldRetain(conversationId: string): boolean;
  rebind(tab: AssembledTabRuntime, conversationId: string, isCurrent: NavigationRequestCheck): Promise<AssembledTabRuntime | null>;
}

export interface ViewerSlotRequest {
  /** The tab whose command issued the request; the request lapses once it stops being live. */
  sourceTab?: AssembledTabRuntime | null;
}

/**
 * The view's single replaceable preview: the only creator of provisional tabs. Rebinding
 * detaches the prior session while its work continues. Requests share the navigation queue.
 */
export class ViewerSlot {
  constructor(private readonly host: ViewerSlotHost) {}

  /** Shows a session: its live owner when one exists, otherwise the preview. */
  async show(conversationId: string, request: ViewerSlotRequest = {}): Promise<void> {
    await this.host.navigation.enqueue(request.sourceTab ?? null, async (isCurrent) => {
      await this.#show(conversationId, isCurrent);
    });
    this.#retainWhere(id => id === conversationId && this.host.shouldRetain(id));
  }

  /**
   * Replaces the preview with a blank draft, optionally linked to `linkedContentPath`. The draft
   * becomes a retained tab once the user types or sends.
   */
  async startDraft(options: ViewerSlotRequest & { linkedContentPath?: string } = {}): Promise<void> {
    const { membership } = this.host;
    const { linkedContentPath, sourceTab = null } = options;
    if (sourceTab && !membership.isTabAlive(sourceTab)) return;
    this.#assertLinkedContentExists(linkedContentPath);

    await this.host.navigation.enqueue(null, async (isCurrent) => {
      this.#assertLinkedContentExists(linkedContentPath);
      // Retention is decided before the draft exists; the replaced preview closes only after the
      // draft is active, so closing it never shows the retained tab in between.
      this.#retainWhere(conversationId => this.host.shouldRetain(conversationId));
      this.#protectPreviews();
      const tab = await this.host.createPreview(null);
      if (!tab) throw new Error('Failed to create a provisional chat tab');
      if (!isCurrent()) {
        await this.#discardUnowned(tab, null);
        return;
      }
      try {
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
   * Closes previews and retains pinned ones, so none stays provisional. Overlapping
   * calls share one cleanup, which fences navigation until it finishes.
   */
  async release(): Promise<void> {
    if (this.host.membership.isDestroyed()) return;
    // Pinned previews are retained synchronously, before the cleanup can close them.
    this.#retainWhere(conversationId => this.host.shouldRetain(conversationId));
    await this.host.navigation.fence(async () => {
      this.#protectPreviews();
      await this.#closePreviews(null);
    });
  }

  async #show(conversationId: string, isCurrent: NavigationRequestCheck): Promise<void> {
    const { host } = this;
    const { membership } = host;
    if (await host.navigation.focusOwner(conversationId, isCurrent) || !isCurrent()) return;

    const preview = membership.getAllTabs()
      .find(tab => membership.isTabAlive(tab) && tab.lifecycleState === 'provisional');
    if (preview) {
      const switched = await host.rebind(preview, conversationId, isCurrent);
      if (switched && membership.isTabAlive(switched)) {
        await host.switchToTab(switched.id);
        return;
      }
      if (!isCurrent()) return;
    }

    // Selections never rebind a retained tab: when no preview can show the session, create one.
    const createdTab = await host.createPreview(conversationId);
    if (!isCurrent() && createdTab) await this.#discardUnowned(createdTab, conversationId);
  }

  /** Retains the active preview when no retained tab would remain. */
  #protectPreviews(): void {
    const { membership } = this.host;
    const hasRetainedTab = membership.getTabIdentities().some(
      tab => tab.lifecycleState !== 'provisional' && tab.lifecycleState !== 'closing',
    );
    if (!hasRetainedTab) {
      const activeTabId = membership.getActiveTabId();
      const activeTab = activeTabId ? membership.getTab(activeTabId) : null;
      if (activeTab?.lifecycleState === 'provisional') commitProvisionalTab(activeTab);
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

  #retainWhere(predicate: (conversationId: string) => boolean): void {
    const { membership } = this.host;
    for (const tab of membership.getAllTabs()) {
      if (
        tab.conversationId !== null
        && membership.isTabAlive(tab)
        && predicate(tab.conversationId)
      ) {
        commitProvisionalTab(tab);
      }
    }
  }

  #assertLinkedContentExists(contentPath: string | undefined): void {
    if (contentPath !== undefined && !linkedContentExists(this.host.app, contentPath)) {
      throw new Error('Linked content is no longer available');
    }
  }
}
