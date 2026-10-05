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
    openConversation: jest.fn().mockResolvedValue(undefined),
    retainTabs: jest.fn(),
    switchToTab: jest.fn().mockResolvedValue(undefined),
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
  const createNewTab = jest.fn().mockResolvedValue(undefined);
  const onTabsChanged = jest.fn();
  const view = options.view ?? {};
  const navigation = new SessionNavigation({
    plugin: {
      app: { vault: options.vault ?? createVault([]) },
      findConversationAcrossViews: () => null,
      getConversationSummary: () => null,
      conversationLifecycle: { isRunning: (id: string) => id === 'active' },
      ...options.plugin,
    } as unknown as ChatFeatureHost,
    view: view as ChatViewHost,
    getTabManager: () => options.tabManager as TabManager,
    createNewTab,
    onTabsChanged,
  });
  return { createNewTab, navigation, onTabsChanged };
}

describe('SessionNavigation Linked content start', () => {
  function createLinkedTabManager(overrides: Record<string, unknown> = {}) {
    return {
      closeTab: jest.fn().mockResolvedValue(true),
      createTab: jest.fn(),
      getActiveTabId: jest.fn().mockReturnValue('initial-tab'),
      getTabSwitchRequestRevision: jest.fn().mockReturnValue(0),
      waitForTabSwitchIdle: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('creates a provisional chat with the selected Linked content without opening it', async () => {
    const selectExplicit = jest.fn();
    const focus = jest.fn();
    let activeTabId = 'initial-tab';
    const createTab = jest.fn().mockImplementation(async () => {
      activeTabId = 'linked-content-tab';
      return {
        id: 'linked-content-tab',
        composer: { focus },
        linkedContent: { selectExplicit },
      };
    });
    const tabManager = createLinkedTabManager({
      createTab,
      getActiveTabId: jest.fn(() => activeTabId),
    });
    const { navigation, onTabsChanged } = createNavigation({
      tabManager,
      vault: createVault(['Projects/Plan.md']),
    });

    await navigation.startLinkedContentConversation('Projects/Plan.md');

    expect(createTab).toHaveBeenCalledWith(null, undefined, {
      activate: true,
      lifecycleState: 'provisional',
    });
    expect(selectExplicit).toHaveBeenCalledWith('Projects/Plan.md');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onTabsChanged).toHaveBeenCalledTimes(1);
    expect(tabManager.closeTab).not.toHaveBeenCalled();
  });

  it('selects directory Linked content without focusing an inactive created tab', async () => {
    const selectExplicit = jest.fn();
    const focus = jest.fn();
    const tabManager = createLinkedTabManager({
      createTab: jest.fn().mockResolvedValue({
        id: 'linked-content-tab',
        composer: { focus },
        linkedContent: { selectExplicit },
      }),
    });
    const { navigation } = createNavigation({
      tabManager,
      vault: createVault(['Projects']),
    });

    await navigation.startLinkedContentConversation('Projects');

    expect(selectExplicit).toHaveBeenCalledWith('Projects');
    expect(focus).not.toHaveBeenCalled();
  });

  it('closes the provisional chat when selecting Linked content fails', async () => {
    const tabManager = createLinkedTabManager({
      createTab: jest.fn().mockResolvedValue({
        id: 'linked-content-tab',
        composer: { focus: jest.fn() },
        linkedContent: {
          selectExplicit: jest.fn(() => {
            throw new Error('invalid Linked content');
          }),
        },
      }),
    });
    const { navigation } = createNavigation({
      tabManager,
      vault: createVault(['Projects']),
    });

    await expect(navigation.startLinkedContentConversation('Projects')).rejects.toThrow(
      'invalid Linked content',
    );
    expect(tabManager.closeTab).toHaveBeenCalledWith('linked-content-tab');
  });

  it('does not create a linked chat after its Vault target becomes missing', async () => {
    const vault = createVault(['Gone/Plan.md']);
    const tabManager = createLinkedTabManager({
      // The target disappears while a pending tab switch settles.
      waitForTabSwitchIdle: jest.fn(async () => {
        vault.files.delete('Gone/Plan.md');
      }),
    });
    const { navigation } = createNavigation({ tabManager, vault });

    await expect(navigation.startLinkedContentConversation('Gone/Plan.md')).rejects.toThrow(
      'Linked content is no longer available',
    );
    expect(tabManager.createTab).not.toHaveBeenCalled();
  });

  it('closes a provisional chat when its Linked content disappears during activation', async () => {
    const vault = createVault(['Projects/Plan.md']);
    const selectExplicit = jest.fn();
    const tabManager = createLinkedTabManager({
      createTab: jest.fn(async () => {
        vault.files.delete('Projects/Plan.md');
        return {
          id: 'linked-content-tab',
          composer: { focus: jest.fn() },
          linkedContent: { selectExplicit },
        };
      }),
    });
    const { navigation } = createNavigation({ tabManager, vault });

    await expect(navigation.startLinkedContentConversation('Projects/Plan.md')).rejects.toThrow(
      'Linked content is no longer available',
    );
    expect(tabManager.createTab).toHaveBeenCalledTimes(1);
    expect(selectExplicit).not.toHaveBeenCalled();
    expect(tabManager.closeTab).toHaveBeenCalledWith('linked-content-tab');
  });
});

describe('SessionNavigation dual-mode New', () => {
  it('focuses the current unbound draft when New is clicked again in dual mode', async () => {
    const focus = jest.fn();
    const draftTab = { id: 'draft-1', conversationId: null, composer: { focus } };
    const tabManager = createFakeTabManager([draftTab], {
      getActiveTab: () => draftTab,
    });
    const { createNewTab, navigation } = createNavigation({ tabManager });

    await navigation.activateOrCreateDraftTab();

    expect(focus).toHaveBeenCalledTimes(1);
    expect(tabManager.switchToTab).not.toHaveBeenCalled();
    expect(createNewTab).not.toHaveBeenCalled();
  });

  it('resumes the most recent unbound draft instead of creating another one', async () => {
    const firstFocus = jest.fn();
    const latestFocus = jest.fn();
    const activeTab = { id: 'tab-1', conversationId: 'conversation-1' };
    const firstDraft = { id: 'draft-1', conversationId: null, composer: { focus: firstFocus } };
    const latestDraft = { id: 'draft-2', conversationId: null, composer: { focus: latestFocus } };
    const tabManager = createFakeTabManager([activeTab, firstDraft, latestDraft], {
      getActiveTab: () => activeTab,
    });
    const { createNewTab, navigation } = createNavigation({ tabManager });

    await navigation.activateOrCreateDraftTab();

    expect(tabManager.switchToTab).toHaveBeenCalledWith('draft-2');
    expect(latestFocus).toHaveBeenCalledTimes(1);
    expect(firstFocus).not.toHaveBeenCalled();
    expect(createNewTab).not.toHaveBeenCalled();
  });

  it('creates an unbound tab when dual mode has no draft to resume', async () => {
    const activeTab = { id: 'tab-1', conversationId: 'conversation-1' };
    const tabManager = createFakeTabManager([activeTab], {
      getActiveTab: () => activeTab,
    });
    const { createNewTab, navigation } = createNavigation({ tabManager });

    await navigation.activateOrCreateDraftTab();

    expect(createNewTab).toHaveBeenCalledTimes(1);
    expect(tabManager.switchToTab).not.toHaveBeenCalled();
  });

  it('reports an unbound draft that the dual-mode New control can resume', () => {
    const withDraft = createNavigation({
      tabManager: createFakeTabManager([
        { id: 'tab-1', conversationId: 'conversation-1' },
        { id: 'draft-1', conversationId: null },
      ]),
    });
    const withoutDraft = createNavigation({
      tabManager: createFakeTabManager([
        { id: 'tab-1', conversationId: 'conversation-1' },
      ]),
    });

    expect(withDraft.navigation.hasUnboundDraft()).toBe(true);
    expect(withoutDraft.navigation.hasUnboundDraft()).toBe(false);
  });
});

describe('SessionNavigation pinned retention', () => {
  it('retains pinned provisional sessions through the tab manager', () => {
    const tabManager = createFakeTabManager([
      { id: 'pinned-tab', conversationId: 'pinned-conversation' },
      { id: 'preview-tab', conversationId: 'preview-conversation' },
      { id: 'draft-tab', conversationId: null },
    ]);
    const { navigation } = createNavigation({
      tabManager,
      plugin: {
        getConversationSummary: (id: string) => ({ isPinned: id === 'pinned-conversation' }),
      },
    });

    navigation.retainPinnedProvisionalTabs();

    expect(tabManager.retainTabs).toHaveBeenCalledTimes(1);
    expect(tabManager.retainTabs).toHaveBeenCalledWith(['pinned-tab']);
  });
});

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
      views: { getAllViews: () => views as never },
    });
    const { navigation } = createNavigation({ tabManager: manager, plugin: { conversationLifecycle } });
    const status = navigation.getConversationStatus('shared');
    const actions = resolveRowActions('menu', {
      conversation: { id: 'shared' } as never, status, hasAttention: false,
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

describe('SessionNavigation dual-mode session opening', () => {
  it('opens a closed session in a new container from the dual-mode session column', async () => {
    const tabManager = createFakeTabManager([{ id: 'draft-1', conversationId: null }]);
    const { navigation } = createNavigation({ tabManager });

    await navigation.openSessionConversation('conversation-2');

    expect(tabManager.openConversation).toHaveBeenCalledWith('conversation-2', {
      preferNewTab: true,
      activate: true,
      provisional: true,
    });
  });

  it('immediately retains a pinned session opened from the dual-mode session column', async () => {
    const tabs: FakeTab[] = [];
    const tabManager = createFakeTabManager(tabs, {
      openConversation: jest.fn(async (conversationId: string) => {
        tabs.push({ id: `tab-${conversationId}`, conversationId });
      }),
    });
    const { navigation } = createNavigation({
      tabManager,
      plugin: { getConversationSummary: () => ({ isPinned: true }) },
    });

    await navigation.openSessionConversation('pinned-conversation');

    expect(tabManager.openConversation).toHaveBeenCalledWith(
      'pinned-conversation',
      expect.objectContaining({ provisional: true }),
    );
    expect(tabManager.retainTabs).toHaveBeenCalledWith(['tab-pinned-conversation']);
  });

  it('opens a provisional session even when the former tab limit is reached', async () => {
    const tabManager = createFakeTabManager([
      { id: 'tab-1', conversationId: 'conversation-1' },
      { id: 'draft-1', conversationId: null },
    ], {
      canCreateTab: jest.fn().mockReturnValue(false),
    });
    const { navigation } = createNavigation({ tabManager });

    await navigation.openSessionConversation('conversation-2');

    expect(tabManager.openConversation).toHaveBeenCalledWith('conversation-2', {
      preferNewTab: true,
      activate: true,
      provisional: true,
    });
  });

  it('switches to an already-open dual-mode session even at container capacity', async () => {
    const tabManager = createFakeTabManager([
      { id: 'tab-1', conversationId: 'conversation-1' },
      { id: 'tab-2', conversationId: 'conversation-2' },
    ], {
      canCreateTab: jest.fn().mockReturnValue(false),
    });
    const { navigation } = createNavigation({ tabManager });

    await navigation.openSessionConversation('conversation-2');

    expect(tabManager.openConversation).toHaveBeenCalledWith('conversation-2');
  });
});
