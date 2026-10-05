import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';
import { TabWorkspaceLifecycle } from '@/features/chat/tabs/persistence/TabWorkspaceLifecycle';

function readyDelivery() {
  return { declarationsReady: true, waitUntilDeclarationsReady: Promise.resolve() };
}

function createHarness(options: {
  manager?: Record<string, unknown> | null;
  tabBar?: Record<string, unknown> | null;
  plugin?: Record<string, unknown>;
  isWide?: boolean;
} = {}) {
  const plugin = {
    claimLegacyTabManagerState: jest.fn().mockResolvedValue(null),
    completeLegacyTabManagerStateMigration: jest.fn().mockResolvedValue(undefined),
    ensureConversationMetadataLoaded: jest.fn().mockResolvedValue(undefined),
    registerTabWorkspaceStateDelivery: jest.fn().mockReturnValue(readyDelivery()),
    settings: { restoreTabsOnStartup: true },
    ...options.plugin,
  };
  const host = {
    manager: options.manager ?? null,
    tabBar: options.tabBar ?? null,
    onInitialized: jest.fn(),
  };
  const lifecycle = new TabWorkspaceLifecycle({
    getPlugin: () => plugin as never,
    view: {} as never,
    getTabManager: () => host.manager as never,
    getTabBar: () => host.tabBar as never,
    isWideLayout: () => options.isWide ?? false,
    onInitialized: host.onInitialized,
  });
  return { host, lifecycle, plugin };
}

const viewState = (state: AppTabManagerState) => ({ tabWorkspace: { version: 1, ...state } });

describe('TabWorkspaceLifecycle', () => {
  describe('delivered view state', () => {
    it('keeps a valid delivered plan authoritative until shells are admitted', async () => {
      const state = {
        activeTabId: 'tab-2',
        openTabs: [
          { conversationId: 'conversation-1', tabId: 'tab-1' },
          { conversationId: 'conversation-2', tabId: 'tab-2' },
        ],
      };
      const { host, lifecycle } = createHarness();

      await lifecycle.setState(viewState(state));
      host.manager = { getPersistedState: () => ({ activeTabId: null, openTabs: [] }) };

      expect(lifecycle.getState()).toEqual(viewState(state));
    });

    it.each([
      ['an unsupported version', { version: 2, activeTabId: 'future-tab', openTabs: [{ conversationId: null, tabId: 'future-tab' }] }],
      ['a malformed entry', {
        version: 1,
        activeTabId: 'tab-1',
        openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }, { conversationId: 42, tabId: 'tab-2' }],
      }],
    ])('starts fresh from %s without falling back to the legacy snapshot', async (_label, tabWorkspace) => {
      const restoreState = jest.fn().mockResolvedValue(undefined);
      const { lifecycle, plugin } = createHarness({
        manager: { restoreState, getPersistedState: () => ({ activeTabId: null, openTabs: [] }) },
      });

      await lifecycle.setState({ tabWorkspace });

      expect(plugin.registerTabWorkspaceStateDelivery).toHaveBeenCalledWith(expect.anything(), true);
      expect(plugin.claimLegacyTabManagerState).not.toHaveBeenCalled();
      expect(restoreState).toHaveBeenCalledWith({ activeTabId: null, openTabs: [] });
    });

    it('publishes the open working set with only the expanded titles still open', () => {
      const state = {
        activeTabId: 'tab-2',
        openTabs: [
          { conversationId: 'conversation-1', tabId: 'tab-1' },
          { conversationId: null, draftModel: 'codex:gpt-5', tabId: 'tab-2' },
        ],
      };
      const { lifecycle } = createHarness({
        manager: { getPersistedState: () => state },
        tabBar: { getExpandedTitleTabIds: () => ['tab-2', 'preview-tab'] },
      });

      expect(lifecycle.getState()).toEqual(viewState({ ...state, expandedTitleTabIds: ['tab-2'] }));
    });

    it('keeps live persistence authoritative after another delivery to an initialized view', async () => {
      const live = { activeTabId: 'live-tab', openTabs: [{ conversationId: null, tabId: 'live-tab' }] };
      const restoreState = jest.fn().mockResolvedValue(undefined);
      const { lifecycle } = createHarness({ manager: { restoreState, getPersistedState: () => live } });
      await lifecycle.setState({});
      const update = jest.fn();

      await lifecycle.setState(viewState({
        activeTabId: 'old-tab',
        openTabs: [{ conversationId: 'old-conversation', tabId: 'old-tab' }],
      }));
      lifecycle.persist(undefined, { update });

      expect(restoreState).toHaveBeenCalledTimes(1);
      expect(lifecycle.getState()).toEqual(viewState(live));
      expect(update).toHaveBeenCalledWith(live);
    });
  });

  describe('restore', () => {
    it('restores every open tab and prepares every bound conversation in single-pane mode', async () => {
      const restoreState = jest.fn().mockResolvedValue(undefined);
      const setExpandedTitleTabIds = jest.fn();
      const state = {
        activeTabId: 'tab-2',
        openTabs: [
          { conversationId: 'conversation-1', tabId: 'tab-1' },
          { conversationId: 'conversation-2', tabId: 'tab-2' },
          { conversationId: null, draftModel: 'codex:gpt-5', tabId: 'tab-3' },
        ],
        expandedTitleTabIds: ['tab-1'],
      };
      const { host, lifecycle, plugin } = createHarness({
        manager: { restoreState, getPersistedState: () => state },
        tabBar: { getExpandedTitleTabIds: () => [], setExpandedTitleTabIds },
      });

      await lifecycle.setState(viewState(state));

      expect(plugin.ensureConversationMetadataLoaded).toHaveBeenCalledWith(['conversation-1', 'conversation-2']);
      expect(restoreState).toHaveBeenCalledWith(state);
      expect(setExpandedTitleTabIds).toHaveBeenCalledWith(['tab-1']);
      expect(host.onInitialized).toHaveBeenCalledTimes(1);
      expect(plugin.ensureConversationMetadataLoaded.mock.invocationCallOrder[0])
        .toBeLessThan(restoreState.mock.invocationCallOrder[0]);
    });

    it('restores and prepares only the last active tab in dual-pane mode', async () => {
      const restoreState = jest.fn().mockResolvedValue(undefined);
      const { lifecycle, plugin } = createHarness({
        isWide: true,
        manager: { restoreState, getPersistedState: () => ({ activeTabId: null, openTabs: [] }) },
      });

      await lifecycle.setState(viewState({
        activeTabId: 'preview-tab',
        openTabs: [
          { conversationId: 'conversation-1', tabId: 'tab-1' },
          { conversationId: 'conversation-preview', tabId: 'preview-tab' },
        ],
      }));

      expect(plugin.ensureConversationMetadataLoaded).toHaveBeenCalledWith(['conversation-preview']);
      expect(restoreState).toHaveBeenCalledWith({
        activeTabId: 'preview-tab',
        openTabs: [{ conversationId: 'conversation-preview', tabId: 'preview-tab' }],
      });
    });

    it('starts fresh without preparing saved conversations when restore is off', async () => {
      const restoreState = jest.fn().mockResolvedValue(undefined);
      const { lifecycle, plugin } = createHarness({
        plugin: { settings: { restoreTabsOnStartup: false } },
        manager: { restoreState, getPersistedState: () => ({ activeTabId: null, openTabs: [] }) },
      });

      await lifecycle.setState(viewState({
        activeTabId: 'tab-1',
        openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
      }));

      expect(plugin.ensureConversationMetadataLoaded).not.toHaveBeenCalled();
      expect(restoreState).toHaveBeenCalledWith({ activeTabId: null, openTabs: [] });
    });

    it('claims the legacy global snapshot only when view state is absent', async () => {
      const legacyState = {
        activeTabId: 'tab-1',
        openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
      };
      const restoreState = jest.fn().mockResolvedValue(undefined);
      const { lifecycle, plugin } = createHarness({
        plugin: { claimLegacyTabManagerState: jest.fn().mockResolvedValue(legacyState) },
        manager: { restoreState, getPersistedState: () => legacyState },
      });

      await lifecycle.setState({});

      expect(plugin.claimLegacyTabManagerState).toHaveBeenCalledTimes(1);
      expect(restoreState).toHaveBeenCalledWith(legacyState);
      expect(plugin.completeLegacyTabManagerStateMigration).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown snapshot', () => {
    const pendingState = {
      activeTabId: 'restored-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'restored-1' },
        { conversationId: 'conversation-2', tabId: 'restored-2' },
      ],
    };

    it.each([
      ['zero admitted tabs', { activeTabId: null, openTabs: [] }],
      ['partially admitted inactive tabs', {
        activeTabId: null,
        openTabs: [{ conversationId: 'conversation-1', tabId: 'restored-1' }],
      }],
    ])('keeps the complete pending restore plan over %s', async (_label, admitted) => {
      const { host, lifecycle } = createHarness();
      await lifecycle.setState(viewState(pendingState));
      const manager = {
        drainForShutdownSnapshot: jest.fn().mockResolvedValue(undefined),
        getPersistedState: jest.fn().mockReturnValue(admitted),
        sealShutdownSnapshot: jest.fn(),
      };
      host.manager = manager;
      const persistence = { flush: jest.fn().mockResolvedValue(undefined), update: jest.fn() };

      await lifecycle.snapshotForShutdown(manager as never, persistence);
      host.manager = null;

      expect(persistence.update).toHaveBeenCalledWith(pendingState);
      expect(persistence.flush).toHaveBeenCalledTimes(1);
      expect(manager.sealShutdownSnapshot).toHaveBeenCalledTimes(1);
      expect(lifecycle.getState()).toEqual(viewState(pendingState));
    });
  });
});
