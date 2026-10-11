import type { ChatFeatureHost, ChatViewHost } from '@/features/chat/ChatFeatureHost';
import type { HistoryConversationStatus } from '@/features/chat/session-manager/SessionStatusPresentation';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { TabManager } from '@/features/chat/tabs/TabManager';
import { linkedContentExists } from '@/features/chat/tabs/ViewerSlot';

export interface SessionNavigationDeps {
  plugin: ChatFeatureHost;
  /** The view whose tabs this navigation targets; other views count as cross-view. */
  view: ChatViewHost;
  getTabManager(): TabManager | null;
}

/** How history entries project one view's tab state; opening sessions belongs to the tabs. */
export class SessionNavigation {
  constructor(private readonly deps: SessionNavigationDeps) {}

  getConversationStatus(conversationId: string): HistoryConversationStatus {
    const tabManager = this.deps.getTabManager();
    const isRunning = this.deps.plugin.conversationLifecycle.isRunning(conversationId);
    const attention = this.deps.plugin.sessionRuntimes.get(conversationId)?.statusAttention;
    const activeTab = tabManager?.getActiveTab();
    if (activeTab?.conversationId === conversationId) {
      return {
        attention,
        openState: 'current',
        isRunning,
        location: 'current-view',
        tabIndex: this.getTabIndex(activeTab),
      };
    }

    const localTab = this.findTabWithConversation(conversationId);
    if (localTab) {
      return {
        attention,
        openState: 'open',
        isRunning,
        location: 'current-view',
        tabIndex: this.getTabIndex(localTab),
      };
    }

    const crossViewResult = this.deps.plugin.findConversationAcrossViews(conversationId);
    if (crossViewResult && crossViewResult.view !== this.deps.view) {
      return {
        attention,
        openState: 'open',
        isRunning,
        location: 'other-view',
      };
    }

    return {
      attention,
      openState: 'closed',
      isRunning,
      location: 'current-view',
    };
  }

  contentExists(contentPath: string): boolean {
    return linkedContentExists(this.deps.plugin.app, contentPath);
  }

  private findTabWithConversation(conversationId: string): Readonly<TabIdentity> | null {
    const tabs = this.deps.getTabManager()?.getTabIdentities() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  private getTabIndex(tab: Readonly<TabIdentity>): number | undefined {
    const index = this.deps.getTabManager()?.getTabIdentities()
      .findIndex(candidate => candidate.id === tab.id) ?? -1;
    return index >= 0 ? index + 1 : undefined;
  }
}
