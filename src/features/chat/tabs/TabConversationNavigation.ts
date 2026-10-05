import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import type { TabId, TabLifecycleState, TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import { commitProvisionalTab } from '@/features/chat/tabs/TabLifecycle';
import type { AssembledTabRuntime, TabMembershipView } from '@/features/chat/tabs/types';
import { revealWorkspaceLeaf } from '@/utils/obsidianCompat';

export type OpenConversationOptions = {
  preferNewTab?: boolean;
  activate?: boolean;
  provisional?: boolean;
};

/** Manager-owned membership operations that navigation drives and revalidates after every await. */
export interface TabConversationNavigationHost {
  readonly plugin: ChatFeatureHost;
  readonly view: TabManagerViewHost;
  readonly membership: TabMembershipView;
  switchToTab(tabId: TabId): Promise<void>;
  createTab(
    conversationId: string,
    options: { activate: boolean; lifecycleState: Extract<TabLifecycleState, 'provisional' | 'open'> },
  ): Promise<AssembledTabRuntime | null>;
  closeTab(tabId: TabId): Promise<boolean>;
  discardTab(tabId: TabId): Promise<boolean>;
}

/**
 * Serializes conversation navigation for one manager. Only the newest request may act, a
 * runtime-originated request stays bound to its source tab, and preview cleanup fences new
 * navigation until provisional tabs are gone.
 */
export class TabConversationNavigation {
  #requestRevision = 0;
  #tail: Promise<void> = Promise.resolve();
  #provisionalCleanupPromise: Promise<void> | null = null;

  constructor(private readonly host: TabConversationNavigationHost) {}

  /** Opens a conversation, reusing an existing owner before creating or rebinding a tab. */
  async open(
    conversationId: string,
    options: OpenConversationOptions,
    sourceTab: AssembledTabRuntime | null,
  ): Promise<void> {
    const { preferNewTab = false, activate = true, provisional = false } = options;
    const { membership } = this.host;
    if (
      membership.isDestroyed()
      || this.#provisionalCleanupPromise
      || (sourceTab && !membership.isTabAlive(sourceTab))
    ) return;
    const requestRevision = ++this.#requestRevision;
    const pending = this.#tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.#isCurrent(requestRevision, sourceTab)) return;
        await this.#openImmediately(
          conversationId,
          preferNewTab,
          activate,
          provisional,
          sourceTab,
          requestRevision,
        );
      });
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  /** Supersedes every queued request and waits for the in-flight one to settle. */
  async invalidateAndDrain(): Promise<void> {
    this.#requestRevision += 1;
    await this.#tail;
  }

  /** Removes replaceable dual-mode previews while retaining open work. */
  async discardProvisionalTabs(): Promise<void> {
    if (this.host.membership.isDestroyed()) return;
    if (this.#provisionalCleanupPromise) {
      await this.#provisionalCleanupPromise;
      return;
    }

    const cleanup = this.#discardProvisionalTabsProtected();
    this.#provisionalCleanupPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.#provisionalCleanupPromise === cleanup) {
        this.#provisionalCleanupPromise = null;
      }
    }
  }

  /** Joins in-flight preview cleanup, propagating its failure. */
  async awaitPreviewCleanup(): Promise<void> {
    await this.#provisionalCleanupPromise;
  }

  async #discardProvisionalTabsProtected(): Promise<void> {
    const { membership } = this.host;
    await this.invalidateAndDrain();
    const hasRetainedTab = membership.getTabIdentities().some(
      tab => tab.lifecycleState !== 'provisional' && tab.lifecycleState !== 'closing',
    );
    if (!hasRetainedTab) {
      const activeTab = this.#getActiveTab();
      if (activeTab?.lifecycleState === 'provisional') {
        commitProvisionalTab(activeTab);
      }
    }

    const provisionalTabIds = membership.getAllTabs()
      .filter(tab => tab.lifecycleState === 'provisional')
      .map(tab => tab.id);
    for (const tabId of provisionalTabIds) {
      await this.host.closeTab(tabId);
    }
  }

  #getActiveTab(): AssembledTabRuntime | null {
    const activeTabId = this.host.membership.getActiveTabId();
    return activeTabId ? this.host.membership.getTab(activeTabId) : null;
  }

  #isCurrent(
    requestRevision: number,
    sourceTab: AssembledTabRuntime | null,
  ): boolean {
    const { membership } = this.host;
    return !membership.isDestroyed()
      && requestRevision === this.#requestRevision
      && (!sourceTab || membership.isTabAlive(sourceTab));
  }

  async #openImmediately(
    conversationId: string,
    preferNewTab: boolean,
    activate: boolean,
    provisional: boolean,
    sourceTab: AssembledTabRuntime | null,
    requestRevision: number,
  ): Promise<void> {
    const { host } = this;
    const { membership } = host;
    if (!this.#isCurrent(requestRevision, sourceTab)) return;

    // Check if conversation is already open in this view's tabs.
    const localTarget = membership.getTabIdentities()
      .find(tab => membership.isTabAlive(tab) && tab.conversationId === conversationId);
    if (localTarget) {
      await host.switchToTab(localTarget.id);
      if (!this.#isCurrent(requestRevision, sourceTab)) return;
      // Activation may replace a restored shell with its assembled runtime under the same ID.
      const currentTarget = membership.getTabIdentities().find(tab => tab.id === localTarget.id);
      if (
        currentTarget?.conversationId === conversationId
        && !membership.isCloseClaimed(currentTarget.id)
      ) {
        return;
      }
    }

    // Check if conversation is open in another view (split workspace scenario)
    // Compare view references directly (more robust than leaf comparison)
    const crossViewResult = host.plugin.findConversationAcrossViews(conversationId);
    const isSameView = crossViewResult?.view === host.view;
    if (crossViewResult && !isSameView) {
      // Focus the other view and switch to its tab instead of opening duplicate
      await revealWorkspaceLeaf(host.plugin.app.workspace, crossViewResult.view.leaf);
      if (!this.#isCurrent(requestRevision, sourceTab)) return;
      const refreshedTarget = host.plugin.findConversationAcrossViews(conversationId);
      const targetManager = refreshedTarget?.view.getTabManager() ?? null;
      const targetTab = targetManager?.getTabIdentities().find(tab => tab.id === refreshedTarget?.tabId) ?? null;
      if (
        refreshedTarget?.view === crossViewResult.view
        && refreshedTarget.tabId === crossViewResult.tabId
        && targetManager?.canCreateTab()
        && targetTab?.lifecycleState !== 'closing'
        && targetTab?.conversationId === conversationId
      ) {
        await targetManager.switchToTab(refreshedTarget.tabId);
        if (!this.#isCurrent(requestRevision, sourceTab)) return;
        const completedTarget = targetManager.getTab(refreshedTarget.tabId);
        if (
          completedTarget?.id === targetTab.id
          && targetManager.canCreateTab()
          && completedTarget.lifecycleState !== 'closing'
          && completedTarget.conversationId === conversationId
        ) {
          return;
        }
      }
    }

    // Open in current tab or new tab
    if (preferNewTab) {
      if (provisional) {
        const previewTab = membership.getAllTabs()
          .find(tab => membership.isTabAlive(tab) && tab.lifecycleState === 'provisional');
        if (previewTab) {
          await previewTab.controllers.conversationController.switchTo(conversationId);
          if (!this.#isCurrent(requestRevision, sourceTab)) return;
          if (
            membership.isTabAlive(previewTab)
            && previewTab.conversationId === conversationId
          ) {
            if (activate) {
              await host.switchToTab(previewTab.id);
            }
            if (
              this.#isCurrent(requestRevision, sourceTab)
              && membership.isTabAlive(previewTab)
              && previewTab.conversationId === conversationId
            ) {
              return;
            }
          }
        }
      }
      const createdTab = await host.createTab(conversationId, {
        activate,
        lifecycleState: provisional ? 'provisional' : 'open',
      });
      if (!this.#isCurrent(requestRevision, sourceTab)) {
        if (
          createdTab
          && membership.getTab(createdTab.id) === createdTab
          && createdTab.conversationId === conversationId
          && createdTab.session.userOwnershipRevision === 0
        ) {
          await host.discardTab(createdTab.id);
        }
        return;
      }
      if (
        createdTab
        && membership.isTabAlive(createdTab)
        && createdTab.conversationId === conversationId
      ) {
        return;
      }
    }

    // Fall back to a live local owner when an awaited target disappears.
    // Don't set tab.conversationId here: the controller callback commits it only
    // after a successful switch.
    const preferredTab = sourceTab ?? this.#getActiveTab();
    const activeTab = preferredTab && membership.isTabAlive(preferredTab)
      ? preferredTab
      : membership.getAllTabs().find(tab => membership.isTabAlive(tab)) ?? null;
    if (activeTab) {
      await activeTab.controllers.conversationController.switchTo(conversationId);
      if (
        this.#isCurrent(requestRevision, sourceTab)
        && membership.isTabAlive(activeTab)
        && activeTab.conversationId === conversationId
      ) {
        commitProvisionalTab(activeTab);
        if (membership.getActiveTabId() !== activeTab.id) {
          await host.switchToTab(activeTab.id);
        }
      }
    }
  }
}
