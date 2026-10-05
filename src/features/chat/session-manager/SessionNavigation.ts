import type { ChatFeatureHost, ChatViewHost } from '@/features/chat/ChatFeatureHost';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import type { TabProviderCatalogContext } from '@/features/chat/tabs/ChatTab';
import type { TabManager } from '@/features/chat/tabs/TabManager';

export interface SessionNavigationDeps {
  plugin: ChatFeatureHost;
  /** The view whose tabs this navigation targets; other views count as cross-view. */
  view: ChatViewHost;
  getTabManager(): TabManager | null;
  createNewTab(): Promise<unknown>;
  /** Tab membership changed outside the tab manager callbacks. */
  onTabsChanged(): void;
}

/**
 * Session-manager policy over one view's tabs: how history entries project tab
 * state, how sessions open (provisional previews, pinned retention), and how
 * New and Linked content starts reuse or create tabs.
 */
export class SessionNavigation {
  constructor(private readonly deps: SessionNavigationDeps) {}

  getConversationStatus(conversationId: string): HistoryConversationStatus {
    const tabManager = this.deps.getTabManager();
    const isRunning = this.deps.plugin.conversationLifecycle.isRunning(conversationId);
    const activeTab = tabManager?.getActiveTab();
    if (activeTab?.conversationId === conversationId) {
      return {
        attention: activeTab.state.attention,
        openState: 'current',
        isRunning,
        location: 'current-view',
        tabIndex: this.getTabIndex(activeTab),
      };
    }

    const localTab = this.findTabWithConversation(conversationId);
    if (localTab) {
      return {
        attention: tabManager?.getTab(localTab.id)?.state.attention,
        openState: 'open',
        isRunning,
        location: 'current-view',
        tabIndex: this.getTabIndex(localTab),
      };
    }

    const crossViewResult = this.deps.plugin.findConversationAcrossViews(conversationId);
    if (crossViewResult && crossViewResult.view !== this.deps.view) {
      const crossViewManager = crossViewResult.view.getTabManager();
      const crossViewTab = crossViewManager?.getTab(crossViewResult.tabId);
      return {
        attention: crossViewTab?.state.attention,
        openState: 'open',
        isRunning,
        location: 'other-view',
      };
    }

    return {
      openState: 'closed',
      isRunning,
      location: 'current-view',
    };
  }

  /** Opens a history entry with tab-aware single-pane semantics. */
  async openConversation(
    conversationId: string,
    options?: { preferNewTab: true; activate: boolean },
  ): Promise<void> {
    const tabManager = this.deps.getTabManager();
    if (options) {
      await tabManager?.openConversation(conversationId, options);
    } else {
      await tabManager?.openConversation(conversationId);
    }
  }

  /** Opens a dual-pane session: switches to an open tab, otherwise previews it provisionally. */
  async openSessionConversation(conversationId: string, activate = true): Promise<void> {
    const tabManager = this.deps.getTabManager();
    if (!tabManager) return;

    const localTab = this.findTabWithConversation(conversationId);
    const crossViewResult = localTab
      ? null
      : this.deps.plugin.findConversationAcrossViews(conversationId);
    if (localTab || (crossViewResult && crossViewResult.view !== this.deps.view)) {
      await tabManager.openConversation(conversationId);
      this.retainPinnedConversationTab(conversationId);
      return;
    }

    await tabManager.openConversation(conversationId, {
      preferNewTab: true,
      activate,
      provisional: true,
    });
    this.retainPinnedConversationTab(conversationId);
  }

  /** Creates a provisional chat for Linked content, closing it again if selection fails. */
  async startLinkedContentConversation(contentPath: string): Promise<void> {
    const tabManager = this.deps.getTabManager();
    if (!tabManager) {
      throw new Error('Chat tabs are unavailable');
    }

    await tabManager.waitForTabSwitchIdle();
    if (!this.contentExists(contentPath)) {
      throw new Error('Linked content is no longer available');
    }
    const initialTabId = tabManager.getActiveTabId();
    const initialSwitchRevision = tabManager.getTabSwitchRequestRevision();

    const shouldActivate = tabManager.getActiveTabId() === initialTabId
      && tabManager.getTabSwitchRequestRevision() === initialSwitchRevision;
    const tab = await tabManager.createTab(null, undefined, {
      activate: shouldActivate,
      lifecycleState: 'provisional',
    });
    if (!tab) {
      throw new Error('Failed to create a provisional chat tab');
    }

    try {
      if (!this.contentExists(contentPath)) {
        throw new Error('Linked content is no longer available');
      }
      tab.linkedContent.selectExplicit(contentPath);
      this.deps.onTabsChanged();
      if (tabManager.getActiveTabId() === tab.id) {
        tab.composer.focus();
      }
    } catch (error) {
      await tabManager.closeTab(tab.id).catch(() => false);
      throw error;
    }
  }

  /** Focuses the current draft, resumes the most recent one, or creates a tab. */
  async activateOrCreateDraftTab(): Promise<void> {
    const tabManager = this.deps.getTabManager();
    const activeTab = tabManager?.getActiveTab();
    if (activeTab?.conversationId === null) {
      activeTab.composer.focus();
      return;
    }

    const draftTab = this.findMostRecentUnboundTab();
    if (draftTab) {
      await tabManager?.switchToTab(draftTab.id);
      tabManager?.getTab(draftTab.id)?.composer.focus();
      return;
    }

    await this.deps.createNewTab();
  }

  hasUnboundDraft(): boolean {
    return this.findMostRecentUnboundTab() !== null;
  }

  /** Retains pinned sessions so leaving the dual pane does not discard them as previews. */
  retainPinnedProvisionalTabs(): void {
    this.retainTabsWhere(conversationId => (
      this.deps.plugin.getConversationSummary(conversationId)?.isPinned === true
    ));
  }

  contentExists(contentPath: string): boolean {
    const { vault } = this.deps.plugin.app;
    return typeof vault.getAbstractFileByPath !== 'function'
      || vault.getAbstractFileByPath(contentPath) !== null;
  }

  private retainPinnedConversationTab(conversationId: string): void {
    if (!this.deps.plugin.getConversationSummary(conversationId)?.isPinned) return;
    this.retainTabsWhere(id => id === conversationId);
  }

  /** Retains, through the tab manager, every tab bound to a session matching `predicate`. */
  private retainTabsWhere(predicate: (conversationId: string) => boolean): void {
    const tabManager = this.deps.getTabManager();
    if (!tabManager) return;
    const tabIds = tabManager.getTabIdentities()
      .filter(tab => tab.conversationId !== null && predicate(tab.conversationId))
      .map(tab => tab.id);
    if (tabIds.length > 0) tabManager.retainTabs(tabIds);
  }

  private findMostRecentUnboundTab(): TabProviderCatalogContext | null {
    const tabs = this.deps.getTabManager()?.getTabIdentities() ?? [];
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      if (tabs[index].conversationId === null) {
        return tabs[index];
      }
    }
    return null;
  }

  private findTabWithConversation(conversationId: string): TabProviderCatalogContext | null {
    const tabs = this.deps.getTabManager()?.getTabIdentities() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  private getTabIndex(tab: TabProviderCatalogContext): number | undefined {
    const index = this.deps.getTabManager()?.getTabIdentities()
      .findIndex(candidate => candidate.id === tab.id) ?? -1;
    return index >= 0 ? index + 1 : undefined;
  }
}
