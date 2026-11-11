import type { Command, Workspace } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import type { ChatViewHost } from '@/features/chat/ChatFeatureHost';
import { t } from '@/i18n/i18n';

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

  const startNew = async (): Promise<void> => {
    const existingView = views.getView();
    if (existingView) {
      await existingView.startNewConversation();
      return;
    }
    await views.activateView();
    views.getView()?.focusActiveInput();
  };

  const getCompactTabManager = () => views.getView()?.getCompactTabManager() ?? null;

  return [
    {
      id: 'new-tab',
      name: t('chat.tabNavigation.commandNew'),
      checkCallback: (checking: boolean) => {
        if (!canCreateNewTab()) return false;
        if (!checking) void startNew();
        return true;
      },
    },
    {
      id: 'new-session',
      name: t('chat.tabNavigation.commandReplace'),
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
      name: t('chat.tabNavigation.commandClose'),
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
    {
      id: 'rename-current-tab',
      name: t('chat.tabNavigation.commandRename'),
      checkCallback: (checking: boolean) => {
        const view = views.getView();
        if (!view?.isTabBarVisible()) return false;
        if (!checking) view.renameActiveTab();
        return true;
      },
    },
  ];
}
