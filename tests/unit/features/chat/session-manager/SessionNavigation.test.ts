import type { ChatFeatureHost, ChatViewHost } from '@/features/chat/ChatFeatureHost';
import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import { resolveRowActions } from '@/features/chat/session-manager/SessionActions';
import { SessionNavigation } from '@/features/chat/session-manager/SessionNavigation';
import type { TabManager } from '@/features/chat/tabs/TabManager';

interface FakeTab {
  id: string;
  conversationId: string | null;
  composer?: { focus: () => void };
  state?: { attention?: unknown };
}

function createFakeTabManager(tabs: FakeTab[], overrides: Record<string, unknown> = {}) {
  return {
    getTabIdentities: () => tabs,
    getTab: (id: string) => tabs.find(tab => tab.id === id) ?? null,
    getActiveTab: () => null,
    isTabWorking: () => false,
    ...overrides,
  };
}

function createVault(paths: string[]) {
  const files = new Set(paths);
  return {
    files,
    getAbstractFileByPath: (path: string) => (files.has(path) ? { path } : null),
  };
}

function createNavigation(options: {
  tabManager: unknown;
  plugin?: Record<string, unknown>;
  vault?: ReturnType<typeof createVault>;
  view?: unknown;
}) {
  const view = options.view ?? {};
  const navigation = new SessionNavigation({
    plugin: {
      sessionRuntimes: { get: () => null },
      app: { vault: options.vault ?? createVault([]) },
      findConversationAcrossViews: () => null,
      getConversationSummary: () => null,
      conversationLifecycle: { isRunning: (id: string) => id === 'active' },
      ...options.plugin,
    } as unknown as ChatFeatureHost,
    view: view as ChatViewHost,
    getTabManager: () => options.tabManager as TabManager,
  });
  return { navigation };
}

describe('SessionNavigation conversation status', () => {
  it.each(['same-view', 'other-view'])('disables archive when another bound tab in %s is running', (location) => {
    const first = { id: 'idle-tab', conversationId: 'shared', state: {} };
    const running = { id: 'running-tab', conversationId: 'shared', state: {} };
    const manager = createFakeTabManager(location === 'same-view' ? [first, running] : [first], {
      getActiveTab: () => first,
      isTabWorking: (id: string) => id === running.id,
    });
    const otherManager = createFakeTabManager([running], { isTabWorking: () => true });
    const views = [
      { getTabManager: () => manager },
      ...(location === 'other-view' ? [{ getTabManager: () => otherManager }] : []),
    ];
    const conversationLifecycle = new ConversationLifecycle({
      conversations: {} as never,
      sessions: { get: () => null, isRunning: id => id === 'shared', retire: async () => undefined, whenSettled: async () => true },
      views: { getAllViews: () => views as never },
    });
    const { navigation } = createNavigation({ tabManager: manager, plugin: { conversationLifecycle } });
    const status = navigation.getConversationStatus('shared');
    const actions = resolveRowActions('menu', {
      conversation: { id: 'shared' } as never, status, attention: null,
    }, { sessionActionMode: 'active', onSelectConversation: jest.fn(), onRerender: jest.fn() });
    expect(status.openState).toBe('current');
    expect(actions.find(action => action.kind === 'archive')).toEqual({ kind: 'archive', disabled: true });
  });

  it('projects local and cross-view runtime attention into session status', () => {
    const activeTab = {
      conversationId: 'active',
      id: 'tab-active',
      state: { attention: { kind: 'action-required', since: 20 } },
    };
    const localTab = {
      conversationId: 'local',
      id: 'tab-local',
      state: { attention: { kind: 'review', outcome: 'completed', since: 10 } },
    };
    const crossViewTab = {
      state: { attention: { kind: 'review', outcome: 'error', since: 5 } },
    };
    const otherView = {
      getTabManager: () => ({
        getTab: (tabId: string) => (tabId === 'tab-cross' ? crossViewTab : null),
        isTabWorking: () => false,
      }),
    };
    const tabManager = createFakeTabManager([activeTab, localTab], {
      getActiveTab: () => activeTab,
      isTabWorking: (tabId: string) => tabId === 'tab-active',
    });
    const ownView = {
      getTabManager: () => ({
        getTab: () => crossViewTab,
        isTabWorking: () => true,
      }),
    };
    const { navigation } = createNavigation({
      tabManager,
      view: ownView,
      plugin: {
        sessionRuntimes: { get: (id: string) => ({ statusAttention: ({ active: activeTab.state.attention, local: localTab.state.attention, cross: crossViewTab.state.attention } as Record<string, unknown>)[id] }) },
        findConversationAcrossViews: (id: string) => {
          if (id === 'cross') return { tabId: 'tab-cross', view: otherView };
          // A lookup resolving to this navigation's own view is not cross-view.
          if (id === 'own-view') return { tabId: 'tab-stale', view: ownView };
          return null;
        },
      },
    });

    expect(navigation.getConversationStatus('active').attention)
      .toEqual({ kind: 'action-required', since: 20 });
    expect(navigation.getConversationStatus('local').attention)
      .toEqual({ kind: 'review', outcome: 'completed', since: 10 });
    expect(navigation.getConversationStatus('cross').attention)
      .toEqual({ kind: 'review', outcome: 'error', since: 5 });
    expect(navigation.getConversationStatus('active').isRunning).toBe(true);
    expect(navigation.getConversationStatus('local').isRunning).toBe(false);
    expect(navigation.getConversationStatus('cross').isRunning).toBe(false);
    expect(navigation.getConversationStatus('closed').attention).toBeUndefined();
    expect(navigation.getConversationStatus('cross').location).toBe('other-view');
    expect(navigation.getConversationStatus('own-view')).toEqual({
      openState: 'closed',
      isRunning: false,
      location: 'current-view',
    });
  });
});
