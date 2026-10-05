import type { Command, Workspace } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import type { ChatViewHost } from '@/features/chat/ChatFeatureHost';

export interface ChatTabCommandsDeps {
  readonly workspace: Pick<Workspace, 'getLeavesOfType'>;
  readonly views: {
    getView(): ChatViewHost | null;
    activateView(): Promise<void>;
  };
}

/** Palette commands that act on the focused chat view's tabs. */
export function createChatTabCommands(deps: ChatTabCommandsDeps): Command[] {
  const { views } = deps;

  const canCreateNewTab = (): boolean => {
    if (views.getView()?.getTabManager()) return true;
    // A mounted leaf whose view has not initialized its tabs cannot take the command yet.
    return deps.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).length === 0;
  };

  const openNewTab = async (): Promise<void> => {
    const existingView = views.getView();
    if (existingView) {
      if (await existingView.handleNewConversationCommand()) return;
      await existingView.createNewTab();
      return;
    }
    await views.activateView();
    views.getView()?.focusActiveInput();
  };

  /** The focused view's tab manager, unless dual-pane navigation owns the tab commands. */
  const getCompactTabManager = () => {
    const view = views.getView();
    if (!view || view.isDualPaneMode()) return null;
    return view.getTabManager();
  };

  return [
    {
      id: 'new-tab',
      name: 'New',
      checkCallback: (checking: boolean) => {
        if (!canCreateNewTab()) return false;
        if (!checking) void openNewTab();
        return true;
      },
    },
    {
      id: 'new-session',
      name: 'Replace current conversation',
      checkCallback: (checking: boolean) => {
        const tabManager = getCompactTabManager();
        const activeTab = tabManager?.getActiveTab();
        if (!tabManager || !activeTab || activeTab.state.isStreaming) return false;
        if (!checking) void tabManager.createNewConversation();
        return true;
      },
    },
    {
      id: 'close-current-tab',
      name: 'Close current tab',
      checkCallback: (checking: boolean) => {
        const tabManager = getCompactTabManager();
        if (!tabManager) return false;
        if (!checking) {
          const activeTabId = tabManager.getActiveTabId();
          if (activeTabId) void tabManager.closeTab(activeTabId);
        }
        return true;
      },
    },
  ];
}
