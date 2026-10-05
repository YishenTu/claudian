import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { createMockEl } from '@test/helpers/MockElement';
import { Platform, Scope } from 'obsidian';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { createTabComposerPort, createTabPlacementPort } from '@/features/chat/tabs/runtime/TabRuntimePorts';
import { TabBar } from '@/features/chat/tabs/TabBar';
import { ChatPresentationPlacement } from '@/features/chat/view/ChatPresentationPlacement';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const mockTabManagerConstructor = jest.fn();
jest.mock('@/features/chat/tabs/TabManager', () => ({
  TabManager: jest.fn().mockImplementation((...args: unknown[]) =>
    mockTabManagerConstructor(...args)),
}));

const MockScope = Scope as typeof Scope & { instances: Scope[] };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function readyTabWorkspaceStateDelivery() {
  return {
    declarationsReady: true,
    waitUntilDeclarationsReady: Promise.resolve(),
  };
}

/** A tab manager fake with the surface the view and its owners read; tests override what they assert. */
function createFakeTabManager(overrides: Record<string, unknown> = {}): any {
  const manager: any = {
    callbacks: null,
    beginShutdown: jest.fn(),
    canCreateTab: jest.fn().mockReturnValue(true),
    createNewConversation: jest.fn().mockResolvedValue(undefined),
    createTab: jest.fn().mockResolvedValue(null),
    destroy: jest.fn().mockResolvedValue(undefined),
    discardProvisionalTabs: jest.fn().mockResolvedValue(undefined),
    drainForShutdownSnapshot: jest.fn().mockResolvedValue(undefined),
    getActiveTab: jest.fn().mockReturnValue(null),
    getAllTabs: jest.fn().mockReturnValue([]),
    getPersistedState: jest.fn().mockReturnValue({ activeTabId: null, openTabs: [] }),
    getTab: jest.fn().mockReturnValue(null),
    getTabBarItems: jest.fn().mockReturnValue([]),
    getTabCount: jest.fn().mockReturnValue(1),
    getTabIdentities: jest.fn().mockReturnValue([]),
    restoreState: jest.fn().mockResolvedValue(undefined),
    retainTabs: jest.fn(),
    sealShutdownSnapshot: jest.fn(),
    ...overrides,
  };
  return manager;
}

/** Makes the next view open construct `manager`, capturing the callbacks the view wires into it. */
function installTabManager(manager: any): void {
  mockTabManagerConstructor.mockReset();
  mockTabManagerConstructor.mockImplementation((_plugin, _containerEl, _view, callbacks) => {
    manager.callbacks = callbacks;
    return manager;
  });
}

function createOpenablePlugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimLegacyTabManagerState: jest.fn().mockResolvedValue(null),
    completeLegacyTabManagerStateMigration: jest.fn().mockResolvedValue(undefined),
    ensureConversationMetadataLoaded: jest.fn().mockResolvedValue(undefined),
    registerTabWorkspaceStateDelivery: jest.fn().mockReturnValue(readyTabWorkspaceStateDelivery()),
    settings: { restoreTabsOnStartup: true },
    ...overrides,
  };
}

function createSizedContentEl(width: number) {
  const contentEl = createMockEl();
  contentEl.getBoundingClientRect = jest.fn(() => ({ width }));
  contentEl.style.setProperty = jest.fn();
  return contentEl;
}

/** Captures the view's width observer so tests can report later container widths. */
function captureResizeObserver(contentEl: any): (width: number) => void {
  let resizeCallback: ResizeObserverCallback = () => {};
  contentEl.ownerDocument.defaultView.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    observe = jest.fn();
    disconnect = jest.fn();
  };
  return (width: number) => {
    contentEl.getBoundingClientRect = jest.fn(() => ({ width }));
    resizeCallback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  };
}

const openedViews: any[] = [];

/** Opens a real view over `manager` and delivers Obsidian state so the workspace initializes. */
async function openView(options: {
  manager?: any;
  plugin?: Record<string, unknown>;
  width?: number;
  contentEl?: any;
} = {}) {
  const manager = options.manager ?? createFakeTabManager();
  installTabManager(manager);
  const contentEl = options.contentEl ?? createSizedContentEl(options.width ?? 400);
  const view = createClaudianView({ plugin: createOpenablePlugin(options.plugin), contentEl });
  openedViews.push(view);
  await view.onOpen();
  await view.setState({}, { history: false });
  return { contentEl, manager, view };
}

function createModelRefreshTab(providerId: 'codex' | 'grok', conversationId: string | null) {
  return {
    conversationId,
    draftModel: null,
    lifecycleState: 'open',
    providerId,
    refreshProviderControls: jest.fn(),
  };
}

afterEach(async () => {
  // Closing cancels scheduled tab bar renders before the next test replaces the fakes.
  for (const view of openedViews.splice(0)) await view.onClose();
  jest.restoreAllMocks();
});

describe('ClaudianView model refresh routing', () => {
  it('refreshes provider controls only for tabs the changed provider can affect', () => {
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation((_settings, providerId) => ({
        customContextLimits: {},
        model: `${providerId}-model`,
        permissionMode: 'normal',
      }));
    const codexTab = createModelRefreshTab('codex', 'codex-conversation');
    const grokTab = createModelRefreshTab('grok', 'grok-conversation');
    const blankGrokTab = createModelRefreshTab('grok', null);
    const tabManager = {
      getAllTabs: jest.fn().mockReturnValue([codexTab, grokTab, blankGrokTab]),
      reconcileProviderAvailability: jest.fn(),
    };
    const view = createClaudianView({ tabManager });

    view.refreshModelSelector('codex');

    expect(codexTab.refreshProviderControls).toHaveBeenCalledTimes(1);
    expect(grokTab.refreshProviderControls).not.toHaveBeenCalled();
    // A blank tab may switch to the changed provider, so it always refreshes.
    expect(blankGrokTab.refreshProviderControls).toHaveBeenCalledTimes(1);
    expect(tabManager.reconcileProviderAvailability).toHaveBeenCalledTimes(1);

    view.refreshModelSelector();

    expect(grokTab.refreshProviderControls).toHaveBeenCalledTimes(1);
    expect(tabManager.reconcileProviderAvailability).toHaveBeenCalledTimes(2);
  });
});

describe('ClaudianView tab controls', () => {
  it('builds chat navigation actions as native buttons that reach their owners', async () => {
    const { contentEl, manager } = await openView();

    const newTabButton = contentEl.querySelector('.claudian-new-tab-btn')!;
    const newConversationButton = contentEl.querySelector('.claudian-new-conversation-btn')!;
    const historyContainer = contentEl.querySelector('.claudian-history-container')!;
    const historyButton = historyContainer.children[0];
    const buttons = [newTabButton, newConversationButton, historyButton];

    expect(buttons.map(button => button.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(buttons.map(button => button.getAttribute('type'))).toEqual([
      'button',
      'button',
      'button',
    ]);
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      'New tab',
      'New conversation',
      'Chat history',
    ]);

    buttons.forEach(button => button.click());
    await Promise.resolve();

    expect(manager.createTab).toHaveBeenCalledTimes(1);
    expect(manager.createNewConversation).toHaveBeenCalledTimes(1);
    expect(historyContainer.querySelector('.claudian-history-menu')?.hasClass('visible')).toBe(true);
  });

  it('keeps tab controls in the view-owned input row', async () => {
    const captureScrollPosition = jest.spyOn(TabBar.prototype, 'captureScrollPosition');
    const restoreScrollPosition = jest.spyOn(TabBar.prototype, 'restoreScrollPosition');

    const { contentEl, view } = await openView();

    const navRowHost = contentEl.querySelector('.claudian-view-input-nav-row');
    const navRowContent = contentEl.querySelector('.claudian-input-nav-content');
    expect(navRowHost?.children).toContain(navRowContent);
    expect(navRowContent?.querySelector('.claudian-tab-bar-container')).toBeTruthy();
    expect(view.getSharedSelectionFocusScopeEls()).toEqual([navRowHost]);
    expect(captureScrollPosition).toHaveBeenCalledTimes(1);
    expect(restoreScrollPosition).toHaveBeenCalledTimes(1);
    expect(captureScrollPosition.mock.invocationCallOrder[0])
      .toBeLessThan(restoreScrollPosition.mock.invocationCallOrder[0]);
  });

  it('focuses the composer after creating a new tab', async () => {
    const focus = jest.fn();
    const tab = { composer: { focus } };
    const view = createClaudianView({
      tabManager: { createTab: jest.fn().mockResolvedValue(tab) },
    });

    await expect(view.createNewTab()).resolves.toBe(tab);

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('routes active-file changes only to the active tab Linked content owner', () => {
    const handleActiveFileChanged = jest.fn();
    const view = createClaudianView({
      tabManager: {
        getActiveTab: jest.fn().mockReturnValue({ linkedContent: { handleActiveFileChanged } }),
      },
    });
    view.wireEventHandlers();
    const fileOpenHandler = view.plugin.app.workspace.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'file-open',
    )?.[1] as (file: unknown) => void;
    const file = { path: 'Projects/Plan.md' };

    fileOpenHandler(file);
    expect(handleActiveFileChanged).toHaveBeenCalledWith(file, true);

    fileOpenHandler(null);
    expect(handleActiveFileChanged).toHaveBeenLastCalledWith(null, true);
  });

  it('fans Vault path events to every tab Linked content owner', () => {
    const first = {
      handleCreated: jest.fn(),
      handleDeleted: jest.fn(),
      handleRenamed: jest.fn(),
    };
    const second = {
      handleCreated: jest.fn(),
      handleDeleted: jest.fn(),
      handleRenamed: jest.fn(),
    };
    const view = createClaudianView({
      tabManager: {
        getAllTabs: jest.fn().mockReturnValue([
          { linkedContent: first },
          { linkedContent: second },
        ]),
      },
    });

    view.handleLinkedContentRenamed('Projects/Old', 'Projects/New', true);
    view.handleLinkedContentDeleted('Projects/New', true);
    view.handleLinkedContentCreated('Projects/New');

    for (const controller of [first, second]) {
      expect(controller.handleRenamed).toHaveBeenCalledWith(
        'Projects/Old',
        'Projects/New',
        true,
      );
      expect(controller.handleDeleted).toHaveBeenCalledWith('Projects/New', true);
      expect(controller.handleCreated).toHaveBeenCalledWith('Projects/New');
    }
  });

  it('hides the new-tab button at capacity and shows it when another tab fits', async () => {
    const { contentEl, manager, view } = await openView();
    const newTabButton = contentEl.querySelector('.claudian-new-tab-btn')!;

    manager.canCreateTab.mockReturnValue(false);
    view.refreshTabControls();

    expect(newTabButton.hasClass('claudian-hidden')).toBe(true);
    expect(newTabButton.getAttribute('aria-disabled')).toBe('true');
    expect(newTabButton.getAttribute('aria-hidden')).toBe('true');

    manager.canCreateTab.mockReturnValue(true);
    view.refreshTabControls();

    expect(newTabButton.hasClass('claudian-hidden')).toBe(false);
    expect(newTabButton.getAttribute('aria-disabled')).toBeNull();
    expect(newTabButton.getAttribute('aria-hidden')).toBeNull();
  });

  it('lends the footer chip slot to the active tab only while the view is compact', async () => {
    const setSideChatChipHost = jest.fn();
    const dom = {
      contentEl: createMockEl(),
      inputComposerEl: createMockEl(),
      inputEl: createMockEl(),
      messagesWrapperEl: createMockEl(),
    };
    const tab = {
      id: 'tab-1',
      conversationId: null,
      dom,
      placement: createTabPlacementPort(dom as never, setSideChatChipHost),
    };
    const manager = createFakeTabManager({
      getActiveTab: jest.fn().mockReturnValue(tab),
      getTab: jest.fn().mockReturnValue(tab),
    });
    const contentEl = createSizedContentEl(400);
    const resize = captureResizeObserver(contentEl);
    await openView({ contentEl, manager });
    const chipSlot = contentEl.querySelector('.claudian-side-chat-chip-slot');
    expect(contentEl.querySelector('.claudian-active-input-slot')?.children)
      .toContain(dom.inputComposerEl);
    expect(setSideChatChipHost).toHaveBeenLastCalledWith(chipSlot);

    resize(640);
    // The wide layout keeps the chip inside the composer.
    expect(setSideChatChipHost).toHaveBeenLastCalledWith(null);

    resize(400);
    await Promise.resolve();
    await Promise.resolve();
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(false);
    expect(setSideChatChipHost).toHaveBeenLastCalledWith(chipSlot);
  });

  it.each([
    ['hides', [{ id: 'tab-1', conversationId: 'conversation-1' }], true],
    ['keeps available to resume an unbound draft', [
      { id: 'tab-1', conversationId: 'conversation-1' },
      { id: 'tab-2', conversationId: null },
    ], false],
  ])('at capacity, %s the dual-mode New control', async (_label, tabs, hidden) => {
    const manager = createFakeTabManager({
      getTabIdentities: jest.fn().mockReturnValue(tabs),
    });
    const { contentEl, view } = await openView({ manager, width: 640 });
    const sessionNewButton = contentEl.querySelector('.claudian-session-new-control')!;
    expect(sessionNewButton).toBeTruthy();

    manager.canCreateTab.mockReturnValue(false);
    view.refreshTabControls();

    expect(contentEl.querySelector('.claudian-new-tab-btn')!.hasClass('claudian-hidden')).toBe(true);
    expect(sessionNewButton.hasClass('claudian-hidden')).toBe(hidden);
    expect(sessionNewButton.getAttribute('aria-disabled')).toBe(hidden ? 'true' : null);
    expect(sessionNewButton.getAttribute('aria-hidden')).toBe(hidden ? 'true' : null);
  });

  it('handles a New conversation command with the dual-mode New action', async () => {
    const focus = jest.fn();
    const draftTab = { id: 'draft-tab', conversationId: null, composer: { focus } };
    const manager = createFakeTabManager({ getActiveTab: jest.fn().mockReturnValue(null) });
    const { view } = await openView({ manager, width: 640 });
    manager.getActiveTab.mockReturnValue(draftTab);

    await expect(view.handleNewConversationCommand()).resolves.toBe(true);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(manager.createTab).not.toHaveBeenCalled();
  });

  it('leaves a New conversation command to the current tab in single mode', async () => {
    const focus = jest.fn();
    const manager = createFakeTabManager();
    const { view } = await openView({ manager, width: 400 });
    manager.getActiveTab.mockReturnValue({ id: 'draft-tab', conversationId: null, composer: { focus } });

    await expect(view.handleNewConversationCommand()).resolves.toBe(false);

    expect(focus).not.toHaveBeenCalled();
    expect(manager.createTab).not.toHaveBeenCalled();
  });
});

describe('ClaudianView dual-pane wiring', () => {
  it('retains pinned provisional sessions synchronously before discarding previews', async () => {
    const tabs = [
      { id: 'pinned-tab', conversationId: 'pinned-conversation', lifecycleState: 'provisional' },
      { id: 'preview-tab', conversationId: 'preview-conversation', lifecycleState: 'provisional' },
      { id: 'draft-tab', conversationId: null, lifecycleState: 'provisional' },
    ];
    const cleanup = deferred<void>();
    const manager = createFakeTabManager({
      discardProvisionalTabs: jest.fn(() => cleanup.promise),
      getTabIdentities: jest.fn().mockReturnValue(tabs),
    });
    const contentEl = createSizedContentEl(640);
    const resize = captureResizeObserver(contentEl);
    await openView({
      contentEl,
      manager,
      plugin: {
        getConversationSummary: (id: string) => ({ isPinned: id === 'pinned-conversation' }),
      },
    });
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);

    resize(599);

    expect(manager.retainTabs).toHaveBeenCalledTimes(1);
    expect(manager.retainTabs).toHaveBeenCalledWith(['pinned-tab']);
    expect(manager.discardProvisionalTabs).toHaveBeenCalledTimes(1);
    expect(manager.retainTabs.mock.invocationCallOrder[0])
      .toBeLessThan(manager.discardProvisionalTabs.mock.invocationCallOrder[0]);
    // Compact controls return only after preview cleanup finishes.
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);

    cleanup.resolve(undefined);
    await cleanup.promise;
    await Promise.resolve();

    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(false);
  });

  it('builds the persistent session column to the right of the chat panel', async () => {
    const { contentEl, view } = await openView();

    // CSS positions the column by this order: chat panel, resizer, then the sidebar.
    expect(contentEl.children).toHaveLength(3);
    const [chatPanel, resizer, sidebar] = contentEl.children;
    expect(chatPanel.hasClass('claudian-chat-panel')).toBe(true);
    expect(resizer.hasClass('claudian-session-resizer')).toBe(true);
    expect(resizer.getAttribute('role')).toBe('separator');
    expect(sidebar.hasClass('claudian-session-sidebar')).toBe(true);
    expect(sidebar.getAttribute('aria-label')).toBeNull();
    // The sidebar holds one track that holds the one session surface.
    expect(sidebar.children).toHaveLength(1);
    const track = sidebar.children[0];
    expect(track.hasClass('claudian-sidebar-surface-track')).toBe(true);
    expect(track.children).toHaveLength(1);
    expect(track.children[0].hasClass('claudian-session-surface')).toBe(true);
    expect(chatPanel.children).toContain(view.tabContentEl);
    expect(chatPanel.children).toContain(view.presentation.inputFooterEl);
  });

  it('closes the history dropdown on entering wide and ends session search on leaving it', async () => {
    const cleanup = deferred<void>();
    const manager = createFakeTabManager({
      discardProvisionalTabs: jest.fn(() => cleanup.promise),
    });
    const contentEl = createSizedContentEl(400);
    const resize = captureResizeObserver(contentEl);
    await openView({ contentEl, manager });
    const historyMenu = contentEl.querySelector('.claudian-history-menu')!;
    contentEl.querySelector('.claudian-history-container')!.children[0].click();
    expect(historyMenu.hasClass('visible')).toBe(true);

    resize(640);

    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(historyMenu.hasClass('visible')).toBe(false);

    contentEl.querySelector('.claudian-session-search-control')!.click();
    expect(contentEl.querySelector('.claudian-session-search-input')).not.toBeNull();

    resize(599);

    // The layout stays wide until preview cleanup finishes, but search ends immediately.
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(contentEl.querySelector('.claudian-session-search-input')).toBeNull();
    expect(contentEl.querySelector('.claudian-session-search-control')).not.toBeNull();

    cleanup.resolve(undefined);
    await cleanup.promise;
  });

  it('notifies other open views when runtime session navigation changes', async () => {
    const otherView = { notifyConversationListChanged: jest.fn() };
    let view: any = null;
    const opened = await openView({
      plugin: { getAllViews: () => (view ? [view, otherView] : []) },
    });
    view = opened.view;
    otherView.notifyConversationListChanged.mockClear();

    opened.manager.callbacks.onTabWorkChanged('tab-1');

    expect(otherView.notifyConversationListChanged).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudianView mention data provider', () => {
  it('registers vault listeners for the view on open and releases them on close', async () => {
    const { view } = await openView();
    const { vault } = view.plugin.app;

    const registered = vault.on.mock.calls.map((call: unknown[]) => call[0]);
    expect([...registered].sort()).toEqual(['create', 'delete', 'modify', 'rename']);
    expect(vault.offref).not.toHaveBeenCalled();
    // Vault events invalidate the same provider the tab manager hands to every tab.
    const tabProvider = mockTabManagerConstructor.mock.calls[0][4] as VaultMentionDataProvider;
    const markFilesDirty = jest.spyOn(tabProvider, 'markFilesDirty');
    const onCreate = vault.on.mock.calls.find((call: unknown[]) => call[0] === 'create')[1];
    onCreate();
    expect(markFilesDirty).toHaveBeenCalledTimes(1);

    openedViews.splice(openedViews.indexOf(view), 1);
    await view.onClose();

    const released = vault.offref.mock.calls.map((call: unknown[]) => (call[0] as { name: string }).name);
    expect([...released].sort()).toEqual(['create', 'delete', 'modify', 'rename']);
  });

  it('releases the previous registration when the view opens again', async () => {
    const { view } = await openView();
    const { vault } = view.plugin.app;

    await view.onOpen();

    expect(vault.on).toHaveBeenCalledTimes(8);
    expect(vault.offref).toHaveBeenCalledTimes(4);
  });
});

describe('ClaudianView runtime tab initialization', () => {
  it('waits for Obsidian state delivery before creating a fresh runtime tab', async () => {
    const createTab = jest.fn().mockResolvedValue({});
    const manager = createFakeTabManager({
      createTab,
      getPersistedState: jest.fn().mockReturnValue({
        activeTabId: 'restored-2',
        openTabs: [
          { conversationId: null, tabId: 'restored-1' },
          { conversationId: null, tabId: 'restored-2' },
        ],
      }),
      restoreState: jest.fn(async () => {
        manager.callbacks.onTabCreated({ id: 'restored-1' });
        await Promise.resolve();
        manager.callbacks.onTabCreated({ id: 'restored-2' });
        await createTab();
      }),
    });
    installTabManager(manager);
    const contentEl = createSizedContentEl(640);
    const view = createClaudianView({ plugin: createOpenablePlugin(), contentEl });
    // Restoration plans and the nav row see the measured wide layout before the tab manager exists.
    const attachNavRow = jest.spyOn(ChatPresentationPlacement.prototype, 'attachNavRow')
      .mockImplementation(() => {
        expect(view.isDualPaneMode()).toBe(true);
        expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);
      });
    const updateTabBar = jest.spyOn(view, 'updateTabBar');
    const notifyNavigation = jest.spyOn(view, 'notifyConversationNavigationChanged');
    const syncProviderBrandColor = jest.spyOn(view, 'syncProviderBrandColor');

    await view.onOpen();

    expect(createTab).not.toHaveBeenCalled();
    expect(attachNavRow).toHaveBeenCalledTimes(1);
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);

    await view.setState({}, { history: false });

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(attachNavRow).toHaveBeenCalledTimes(1);
    expect(manager.callbacks).not.toHaveProperty('onPersistedStateChanged');
    expect(updateTabBar).toHaveBeenCalledTimes(1);

    view.tabWorkspace.persist = jest.fn();
    updateTabBar.mockClear();
    manager.callbacks.onActiveTabChanged('restored-1', 'restored-2');
    expect(view.tabWorkspace.persist).not.toHaveBeenCalled();
    expect(updateTabBar).toHaveBeenCalledTimes(1);

    manager.callbacks.onActiveTabCommitted('restored-1', 'restored-2');
    expect(view.tabWorkspace.persist).toHaveBeenCalledTimes(1);

    view.tabWorkspace.persist.mockClear();
    manager.callbacks.onTabCreated({ id: 'background-tab' });
    expect(view.tabWorkspace.persist).toHaveBeenCalledTimes(1);

    updateTabBar.mockClear();
    notifyNavigation.mockClear();
    manager.callbacks.onTabAttentionChanged('tab-1', {
      kind: 'review',
      outcome: 'completed',
      since: 1,
    });
    manager.callbacks.onTabWorkChanged('tab-1');

    expect(updateTabBar).toHaveBeenCalledTimes(2);
    expect(notifyNavigation).toHaveBeenCalledTimes(2);

    // A provider switch on the same tab recolours the view, which also notifies zen.
    syncProviderBrandColor.mockClear();
    manager.callbacks.onTabProviderChanged('restored-1', 'codex');
    expect(syncProviderBrandColor).toHaveBeenCalledTimes(1);
  });

  it('abandons deferred restoration when view shutdown begins', async () => {
    const persistedState = deferred<any>();
    const manager = createFakeTabManager();
    installTabManager(manager);
    const unregisterZen = jest.fn();
    const plugin = createOpenablePlugin({
      claimLegacyTabManagerState: jest.fn(() => persistedState.promise),
      registerZenModeSource: jest.fn(() => unregisterZen),
    });
    const contentEl = createSizedContentEl(400);
    const resizeObserverConstructed = jest.fn();
    contentEl.ownerDocument.defaultView.ResizeObserver = class {
      constructor() {
        resizeObserverConstructed();
      }

      observe = jest.fn();
      disconnect = jest.fn();
    };
    const view = createClaudianView({ plugin, contentEl });
    const syncProviderBrandColor = jest.spyOn(view, 'syncProviderBrandColor');
    const restoreAll = jest.spyOn(ChatPresentationPlacement.prototype, 'restoreAll');

    await view.onOpen();
    expect(plugin.registerZenModeSource).toHaveBeenCalledWith(view);
    expect(view.getZenPresentation()).toBeNull();
    // Mention caches follow the vault while open.
    expect(view.plugin.app.vault.on).toHaveBeenCalledTimes(4);

    const restoring = view.setState({}, { history: false });
    await Promise.resolve();
    const closing = view.onClose();
    // Zen presentation returns synchronously, before asynchronous shutdown begins,
    // and composer placement returns before the shutdown snapshot drains.
    expect(unregisterZen).toHaveBeenCalledTimes(1);
    expect(unregisterZen.mock.invocationCallOrder[0])
      .toBeLessThan(manager.beginShutdown.mock.invocationCallOrder[0]);
    expect(restoreAll).toHaveBeenCalledTimes(1);
    expect(restoreAll.mock.invocationCallOrder[0])
      .toBeLessThan(manager.drainForShutdownSnapshot.mock.invocationCallOrder[0]);
    expect(view.plugin.app.vault.offref).toHaveBeenCalledTimes(4);
    persistedState.resolve({ activeTabId: null, openTabs: [] });
    await expect(Promise.all([restoring, closing])).resolves.toEqual([undefined, undefined]);

    expect(manager.beginShutdown).toHaveBeenCalledTimes(1);
    expect(manager.sealShutdownSnapshot).toHaveBeenCalledTimes(1);
    expect(manager.destroy).toHaveBeenCalledTimes(1);
    expect(manager.createTab).not.toHaveBeenCalled();
    expect(manager.restoreState).not.toHaveBeenCalled();
    expect(syncProviderBrandColor).not.toHaveBeenCalled();
    expect(resizeObserverConstructed).not.toHaveBeenCalled();
    expect(view.tabManager).toBeNull();
  });

  it('reuses closing persistence and restores only the active tab when reopening wide', async () => {
    const pendingFlush = deferred<void>();
    const persistence = {
      dispose: jest.fn(),
      flush: jest.fn(() => pendingFlush.promise),
      update: jest.fn(),
    };
    const claimLegacyTabManagerState = jest.fn().mockResolvedValue(null);
    const createTab = jest.fn().mockResolvedValue({});
    const manager = createFakeTabManager({
      createTab,
      getPersistedState: jest.fn().mockReturnValue({
        activeTabId: 'closing-tab-2',
        openTabs: [{ conversationId: null, tabId: 'closing-tab-2' }],
      }),
      restoreState: jest.fn(async () => {
        await createTab();
      }),
    });
    installTabManager(manager);
    const view = createClaudianView({
      contentEl: createSizedContentEl(640),
      plugin: createOpenablePlugin({ claimLegacyTabManagerState }),
    });
    Object.assign(view.tabWorkspace, {
      finalizedState: {
        activeTabId: 'closing-tab-2',
        openTabs: [
          { conversationId: null, tabId: 'closing-tab-1' },
          { conversationId: null, tabId: 'closing-tab-2' },
        ],
      },
      persistence,
      lifecycleRevision: 1,
      shutdownStarted: true,
    });

    const opening = view.onOpen();
    await Promise.resolve();

    expect(persistence.flush).toHaveBeenCalledTimes(1);
    expect(mockTabManagerConstructor).not.toHaveBeenCalled();
    expect(claimLegacyTabManagerState).not.toHaveBeenCalled();

    pendingFlush.resolve(undefined);
    await opening;

    expect(persistence.dispose).not.toHaveBeenCalled();
    expect(view.tabWorkspace.persistence).toBe(persistence);
    expect(claimLegacyTabManagerState).not.toHaveBeenCalled();
    expect(manager.restoreState).toHaveBeenCalledWith({
      activeTabId: 'closing-tab-2',
      openTabs: [
        { conversationId: null, tabId: 'closing-tab-2' },
      ],
    });
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  it('waits for the closing shutdown snapshot before restoring a reopened view', async () => {
    const shutdownSnapshot = deferred<void>();
    const persistence = {
      dispose: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      update: jest.fn(),
    };
    const claimLegacyTabManagerState = jest.fn().mockResolvedValue(null);
    const createTab = jest.fn().mockResolvedValue({});
    const manager = createFakeTabManager({
      createTab,
      getPersistedState: jest.fn().mockReturnValue({
        activeTabId: 'finalized-tab-2',
        openTabs: [
          { conversationId: 'conversation-1', tabId: 'finalized-tab-1' },
          { conversationId: null, tabId: 'finalized-tab-2' },
        ],
      }),
      restoreState: jest.fn(async () => {
        await createTab();
      }),
    });
    installTabManager(manager);
    const view = createClaudianView({
      plugin: createOpenablePlugin({
        claimLegacyTabManagerState,
        settings: { restoreTabsOnStartup: false },
      }),
    });
    Object.assign(view.tabWorkspace, {
      shutdownSnapshotPromise: shutdownSnapshot.promise,
      persistence,
      lifecycleRevision: 1,
      shutdownStarted: true,
    });

    const opening = view.onOpen();
    await Promise.resolve();

    expect(mockTabManagerConstructor).not.toHaveBeenCalled();
    expect(claimLegacyTabManagerState).not.toHaveBeenCalled();

    view.tabWorkspace.finalizedState = {
      activeTabId: 'finalized-tab-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'finalized-tab-1' },
        { conversationId: null, tabId: 'finalized-tab-2' },
      ],
    };
    shutdownSnapshot.resolve(undefined);
    await opening;

    expect(claimLegacyTabManagerState).not.toHaveBeenCalled();
    expect(manager.restoreState).toHaveBeenCalledWith({
      activeTabId: 'finalized-tab-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'finalized-tab-1' },
        { conversationId: null, tabId: 'finalized-tab-2' },
      ],
    });
    expect(createTab).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudianView composer input', () => {
  function createComposerHarness(existingContent: string): {
    inputEl: HTMLTextAreaElement;
    inputHandler: jest.Mock;
    tabManager: { retainTabs: jest.Mock };
    view: any;
  } {
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    const inputHandler = jest.fn();
    inputEl.value = existingContent;
    inputEl.selectionStart = 0;
    inputEl.selectionEnd = 0;
    inputEl.focus = jest.fn();
    inputEl.addEventListener('input', inputHandler);

    const tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        id: 'active-tab',
        composer: createTabComposerPort(inputEl as never, {} as never),
      }),
      retainTabs: jest.fn(),
    };
    const view = createClaudianView({ tabManager });

    return { inputEl, inputHandler, tabManager, view };
  }

  it('focuses the active composer', () => {
    const { inputEl, view } = createComposerHarness('');

    view.focusActiveInput();

    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('appends text after existing composer content', () => {
    const { inputEl, inputHandler, tabManager, view } = createComposerHarness('Review this note');

    const appended = view.appendToActiveInput('@projects/plan.md ');

    expect(appended).toBe(true);
    expect(inputEl.value).toBe('Review this note @projects/plan.md ');
    expect(inputEl.selectionStart).toBe(inputEl.value.length);
    expect(inputEl.selectionEnd).toBe(inputEl.value.length);
    expect(inputHandler).toHaveBeenCalledTimes(1);
    expect(inputEl.focus).toHaveBeenCalledTimes(1);
    // Appending is user input, so the preview is retained through the tab manager first.
    expect(tabManager.retainTabs).toHaveBeenCalledWith(['active-tab']);
  });

  it('does not add another separator when existing content ends in whitespace', () => {
    const { inputEl, view } = createComposerHarness('Review this note\n');

    view.appendToActiveInput('@projects/plan.md ');

    expect(inputEl.value).toBe('Review this note\n@projects/plan.md ');
  });

  it('returns false when there is no active composer', () => {
    const view = createClaudianView({
      tabManager: { getActiveTab: jest.fn().mockReturnValue(null) },
    });

    expect(view.appendToActiveInput('@projects/plan.md ')).toBe(false);
  });
});

describe('ClaudianView shutdown', () => {
  function createClosingTabBar() {
    return { destroy: jest.fn(), getExpandedTitleTabIds: jest.fn().mockReturnValue([]) };
  }

  it('prepares plugin unload through one shared drained snapshot', async () => {
    const drain = deferred<void>();
    const flush = jest.fn().mockResolvedValue(undefined);
    const manager = {
      beginShutdown: jest.fn(),
      drainForShutdownSnapshot: jest.fn(() => drain.promise),
      getPersistedState: jest.fn().mockReturnValue({
        activeTabId: 'tab-1',
        openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
      }),
      sealShutdownSnapshot: jest.fn(),
    };
    const persistence = {
      flush,
      update: jest.fn(),
    };
    const view = createClaudianView({ tabManager: manager });
    Object.assign(view.tabWorkspace, { persistence });

    const first = view.prepareForPluginUnload();
    const second = view.prepareForPluginUnload();

    expect(manager.beginShutdown).toHaveBeenCalledTimes(2);
    expect(manager.drainForShutdownSnapshot).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();

    drain.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    expect(persistence.update).toHaveBeenCalledWith({
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(manager.sealShutdownSnapshot).toHaveBeenCalledTimes(1);
  });

  it('drains active turns before flushing and sealing the final tab identity', async () => {
    const drain = deferred<void>();
    const activeTab = { conversationId: null as string | null, id: 'tab-1' };
    const update = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    const sealShutdownSnapshot = jest.fn();
    const manager = {
      beginShutdown: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      drainForShutdownSnapshot: jest.fn(() => drain.promise),
      getPersistedState: jest.fn(() => ({
        activeTabId: activeTab.id,
        openTabs: [{ conversationId: activeTab.conversationId, tabId: activeTab.id }],
      })),
      sealShutdownSnapshot,
    };
    const view = createClaudianView({ tabManager: manager });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, {
      persistence: { dispose: jest.fn(), flush, update },
    });

    const closing = view.onClose();

    expect(manager.drainForShutdownSnapshot).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(sealShutdownSnapshot).not.toHaveBeenCalled();

    activeTab.conversationId = 'conversation-created-during-drain';
    drain.resolve(undefined);
    await closing;

    expect(update).toHaveBeenCalledWith({
      activeTabId: 'tab-1',
      openTabs: [{
        conversationId: 'conversation-created-during-drain',
        tabId: 'tab-1',
      }],
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(sealShutdownSnapshot).toHaveBeenCalledTimes(1);
    expect(flush.mock.invocationCallOrder[0])
      .toBeLessThan(sealShutdownSnapshot.mock.invocationCallOrder[0]);
  });

  it('publishes the finalized snapshot while the old manager is being destroyed', async () => {
    const destruction = deferred<void>();
    let teardownStarted = false;
    const finalState = {
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
    };
    const manager = {
      beginShutdown: jest.fn(),
      destroy: jest.fn(() => {
        teardownStarted = true;
        return destruction.promise;
      }),
      drainForShutdownSnapshot: jest.fn().mockResolvedValue(undefined),
      getPersistedState: jest.fn(() => teardownStarted
        ? { activeTabId: null, openTabs: [] }
        : finalState),
      sealShutdownSnapshot: jest.fn(),
    };
    const view = createClaudianView({ tabManager: manager });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, {
      pendingState: null,
      persistence: {
        dispose: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
        update: jest.fn(),
      },
    });

    const closing = view.onClose();
    for (let attempt = 0;
      attempt < 10 && manager.destroy.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }

    expect(manager.destroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
    expect(view.getState()).toEqual({
      tabWorkspace: { version: 1, ...finalState },
    });

    destruction.resolve(undefined);
    await closing;
  });

  it('flushes the current tab identity before disposing view resources', async () => {
    const beginShutdown = jest.fn();
    const destroy = jest.fn().mockResolvedValue(undefined);
    const sealShutdownSnapshot = jest.fn();
    const disposePersistence = jest.fn();
    let resolveFlush!: () => void;
    const flushPersistence = jest.fn(() => new Promise<void>(resolve => {
      resolveFlush = resolve;
    }));
    const updatePersistence = jest.fn();
    const tabBar = createClosingTabBar();
    const view = createClaudianView({
      tabManager: {
        beginShutdown,
        destroy,
        getPersistedState: jest.fn().mockReturnValue({
          activeTabId: 'tab-1',
          openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
        }),
        sealShutdownSnapshot,
      },
    });
    Object.assign(view, { scope: {}, tabBar });
    Object.assign(view.tabWorkspace, {
      persistence: {
        dispose: disposePersistence,
        flush: flushPersistence,
        update: updatePersistence,
      },
    });
    const restoreAll = jest.spyOn(ChatPresentationPlacement.prototype, 'restoreAll');

    const closing = view.onClose();

    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(restoreAll).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    resolveFlush();
    await expect(closing).resolves.toBeUndefined();

    expect(updatePersistence).toHaveBeenCalledWith({
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
    });
    expect(flushPersistence).toHaveBeenCalledTimes(1);
    expect(disposePersistence).toHaveBeenCalledTimes(1);
    expect(sealShutdownSnapshot).toHaveBeenCalledTimes(1);
    expect(sealShutdownSnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(disposePersistence.mock.invocationCallOrder[0]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(tabBar.destroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
    expect(view.scope).toBeNull();
  });

  it('still disposes view resources when the current-tab flush fails', async () => {
    const destroy = jest.fn().mockResolvedValue(undefined);
    const disposePersistence = jest.fn();
    const view = createClaudianView({
      tabManager: {
        beginShutdown: jest.fn(),
        destroy,
        getPersistedState: jest.fn().mockReturnValue({
          activeTabId: 'tab-1',
          openTabs: [{ conversationId: null, tabId: 'tab-1' }],
        }),
        sealShutdownSnapshot: jest.fn(),
      },
    });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, {
      persistence: {
        dispose: disposePersistence,
        flush: jest.fn().mockRejectedValue(new Error('disk full')),
        update: jest.fn(),
      },
    });

    await expect(view.onClose()).resolves.toBeUndefined();

    expect(disposePersistence).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
  });

  it('keeps the closing manager snapshot current until its shutdown seal', async () => {
    const flush = deferred<void>();
    const activeTab = { conversationId: null as string | null, id: 'tab-1' };
    const update = jest.fn();
    const sealShutdownSnapshot = jest.fn();
    const manager = {
      beginShutdown: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      getPersistedState: jest.fn(() => ({
        activeTabId: activeTab.id,
        openTabs: [{ conversationId: activeTab.conversationId, tabId: activeTab.id }],
      })),
      sealShutdownSnapshot,
    };
    const persistence = {
      dispose: jest.fn(),
      flush: jest.fn(() => flush.promise),
      update,
    };
    const view = createClaudianView({ tabManager: manager });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, { persistence });

    const closing = view.onClose();
    expect(update).toHaveBeenLastCalledWith({
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: null, tabId: 'tab-1' }],
    });

    activeTab.conversationId = 'conversation-created-during-close';
    view.tabWorkspace.persist(manager, persistence);
    expect(update).toHaveBeenLastCalledWith({
      activeTabId: 'tab-1',
      openTabs: [{
        conversationId: 'conversation-created-during-close',
        tabId: 'tab-1',
      }],
    });
    expect(sealShutdownSnapshot).not.toHaveBeenCalled();

    flush.resolve(undefined);
    await closing;
    expect(view.tabWorkspace.finalizedState).toEqual({
      activeTabId: 'tab-1',
      openTabs: [{
        conversationId: 'conversation-created-during-close',
        tabId: 'tab-1',
      }],
    });
    expect(view.getState()).toEqual({
      tabWorkspace: {
        version: 1,
        activeTabId: 'tab-1',
        openTabs: [{
          conversationId: 'conversation-created-during-close',
          tabId: 'tab-1',
        }],
      },
    });
    expect(sealShutdownSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not let an older close finalizer clear resources from a newer open', async () => {
    const flush = deferred<void>();
    const oldManager = {
      beginShutdown: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      getPersistedState: jest.fn().mockReturnValue({
        activeTabId: 'old-tab',
        openTabs: [{ conversationId: null, tabId: 'old-tab' }],
      }),
      sealShutdownSnapshot: jest.fn(),
    };
    const oldPersistence = {
      dispose: jest.fn(),
      flush: jest.fn(() => flush.promise),
      update: jest.fn(),
    };
    const oldTabBar = createClosingTabBar();
    const oldReleaseMentionCacheEvents = jest.fn();
    const view = createClaudianView({ tabManager: oldManager });
    Object.assign(view, {
      releaseMentionCacheEvents: oldReleaseMentionCacheEvents,
      scope: {},
      tabBar: oldTabBar,
    });
    Object.assign(view.tabWorkspace, { persistence: oldPersistence });

    const closing = view.onClose();
    expect(oldReleaseMentionCacheEvents).toHaveBeenCalledTimes(1);
    const newManager = {};
    const newPersistence = {};
    const newTabBar = { destroy: jest.fn() };
    const newReleaseMentionCacheEvents = jest.fn();
    const newScope = {};
    Object.assign(view, {
      releaseMentionCacheEvents: newReleaseMentionCacheEvents,
      scope: newScope,
      tabBar: newTabBar,
      tabManager: newManager,
    });
    Object.assign(view.tabWorkspace, { persistence: newPersistence });
    flush.resolve(undefined);
    await expect(closing).resolves.toBeUndefined();

    expect(oldManager.destroy).toHaveBeenCalledTimes(1);
    expect(oldPersistence.dispose).toHaveBeenCalledTimes(1);
    expect(oldTabBar.destroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBe(newManager);
    expect(view.tabWorkspace.persistence).toBe(newPersistence);
    expect(view.tabBar).toBe(newTabBar);
    expect(view.releaseMentionCacheEvents).toBe(newReleaseMentionCacheEvents);
    expect(newReleaseMentionCacheEvents).not.toHaveBeenCalled();
    expect(view.scope).toBe(newScope);
    expect(newTabBar.destroy).not.toHaveBeenCalled();
  });

  it('does not dispose persistence retained by a newer open lifecycle', async () => {
    const flush = deferred<void>();
    const persistence = {
      dispose: jest.fn(),
      flush: jest.fn(() => flush.promise),
      update: jest.fn(),
    };
    const oldManager = {
      beginShutdown: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      getPersistedState: jest.fn().mockReturnValue({
        activeTabId: 'old-tab',
        openTabs: [{ conversationId: null, tabId: 'old-tab' }],
      }),
      sealShutdownSnapshot: jest.fn(),
    };
    const view = createClaudianView({ tabManager: oldManager });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, { persistence });

    const closing = view.onClose();
    const newManager = {};
    view.tabWorkspace.shutdownStarted = false;
    view.tabWorkspace.lifecycleRevision += 1;
    view.tabManager = newManager;
    view.tabWorkspace.persistence = persistence;
    flush.resolve(undefined);
    await closing;

    expect(persistence.dispose).not.toHaveBeenCalled();
    expect(view.tabWorkspace.persistence).toBe(persistence);
    expect(view.tabManager).toBe(newManager);
  });
});

describe('ClaudianView Escape handling', () => {
  beforeEach(() => {
    MockScope.instances.length = 0;
  });

  function createEscapeHarness(options: {
    isStreaming: boolean;
    toolbarMenuOpen?: boolean;
  }): {
    cancelStreaming: jest.Mock;
    closeOpenMenu: jest.Mock;
    escape: (event?: Partial<KeyboardEvent>) => unknown;
    view: any;
  } {
    const cancelStreaming = jest.fn();
    let toolbarMenuOpen = options.toolbarMenuOpen ?? false;
    const closeOpenMenu = jest.fn(() => {
      const wasOpen = toolbarMenuOpen;
      toolbarMenuOpen = false;
      return wasOpen;
    });
    const view = createClaudianView({
      tabManager: {
        getActiveTab: jest.fn().mockReturnValue({
          state: { isStreaming: options.isStreaming },
          controllers: {
            inputController: { cancelStreaming },
            sideChatController: { destination: 'main', runtime: null },
          },
          composer: { closeOpenMenu },
          linkedContent: { handleActiveFileMetadataChanged: jest.fn() },
        }),
      },
    });
    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const escape = (event: Partial<KeyboardEvent> = {}) => escapeHandler.func({
      key: 'Escape',
      isComposing: false,
      ...event,
    } as KeyboardEvent);
    return { cancelStreaming, closeOpenMenu, escape, view };
  }

  function createScopedSendHarness(options: {
    inputFocused: boolean;
  }): {
    sendMessage: jest.Mock;
    view: any;
  } {
    const sendMessage = jest.fn();
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    Object.defineProperty(inputEl.ownerDocument, 'activeElement', {
      configurable: true,
      get: () => options.inputFocused ? inputEl : null,
    });
    const view = createClaudianView({
      tabManager: {
        getActiveTab: jest.fn().mockReturnValue({
          state: { isStreaming: false },
          dom: { inputEl },
          controllers: {
            inputController: { sendMessage },
          },
        }),
      },
    });

    return { sendMessage, view };
  }

  it('registers Escape on the Obsidian view scope instead of document keydown capture', () => {
    const { view } = createEscapeHarness({ isStreaming: true });

    expect(view.scope).toBeInstanceOf(Scope);
    expect(view.scope.parent).toBe(view.app.scope);
    expect(view.scope.register).toHaveBeenCalledWith([], 'Escape', expect.any(Function));
    expect(view.registerDomEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      'keydown',
      expect.any(Function),
      { capture: true }
    );
  });

  it('cancels streaming and consumes scoped Escape', () => {
    const { cancelStreaming, escape } = createEscapeHarness({ isStreaming: true });

    expect(escape()).toBe(false);
    expect(cancelStreaming).toHaveBeenCalledTimes(1);
  });

  it('closes an open toolbar menu instead of cancelling the turn when the scope sees Escape first', () => {
    const { cancelStreaming, closeOpenMenu, escape } = createEscapeHarness({
      isStreaming: true,
      toolbarMenuOpen: true,
    });

    expect(escape()).toBe(false);
    expect(closeOpenMenu).toHaveBeenCalledTimes(1);
    expect(cancelStreaming).not.toHaveBeenCalled();

    // With the menu closed, the next Escape cancels as before.
    escape();
    expect(cancelStreaming).toHaveBeenCalledTimes(1);
  });

  it('consumes scoped Escape without cancelling when not streaming', () => {
    const { cancelStreaming, escape } = createEscapeHarness({ isStreaming: false });

    expect(escape()).toBe(false);
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('exits session inline rename before handling other scoped Escape actions', () => {
    const cancelInlineRename = jest.spyOn(SessionBrowser.prototype, 'cancelInlineRename')
      .mockReturnValue(true);
    const { cancelStreaming, closeOpenMenu, escape } = createEscapeHarness({
      isStreaming: true,
      toolbarMenuOpen: true,
    });

    expect(escape()).toBe(false);
    expect(cancelInlineRename).toHaveBeenCalledTimes(1);
    expect(closeOpenMenu).not.toHaveBeenCalled();
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('lets the session surface consume scoped Escape before cancelling the turn', () => {
    const handleEscape = jest.spyOn(SessionManagerSurface.prototype, 'handleEscape')
      .mockReturnValue(true);
    const { cancelStreaming, escape } = createEscapeHarness({ isStreaming: true });

    expect(escape()).toBe(false);
    expect(handleEscape).toHaveBeenCalledTimes(1);
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('leaves Escape to session search IME composition', () => {
    jest.spyOn(SessionManagerSurface.prototype, 'isComposing', 'get').mockReturnValue(true);
    const handleEscape = jest.spyOn(SessionManagerSurface.prototype, 'handleEscape');
    const { cancelStreaming, escape } = createEscapeHarness({ isStreaming: true });

    expect(escape()).toBeUndefined();
    expect(handleEscape).not.toHaveBeenCalled();
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('consumes already handled scoped Escape without cancelling again', () => {
    const { cancelStreaming, escape } = createEscapeHarness({ isStreaming: true });

    expect(escape({ defaultPrevented: true })).toBe(false);
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('routes metadata cache refreshes to the active tab Linked content owner', () => {
    const { view } = createEscapeHarness({ isStreaming: false });
    const handleActiveFileMetadataChanged = jest.fn();
    view.tabManager.getActiveTab.mockReturnValue({
      linkedContent: { handleActiveFileMetadataChanged },
    });
    const file = { path: 'Notes/Current.md' };
    const handlerFor = (name: string) => view.plugin.app.metadataCache.on.mock.calls.find(
      (call: unknown[]) => call[0] === name,
    )?.[1] as (changedFile?: unknown) => void;

    handlerFor('changed')(file);
    handlerFor('resolve')(file);
    handlerFor('resolved')();

    expect(handleActiveFileMetadataChanged).toHaveBeenNthCalledWith(1, file);
    expect(handleActiveFileMetadataChanged).toHaveBeenNthCalledWith(2, file);
    expect(handleActiveFileMetadataChanged).toHaveBeenNthCalledWith(3, null);
  });

  it.each([
    ['sends from focused composer', true],
    ['ignores the shortcut when the composer is not focused', false],
  ])('scoped Mod+Enter %s', (_label, inputFocused) => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused });

    view.wireEventHandlers();
    const sendHandler = view.scope.handlers.find(
      (handler: any) => handler.key === 'Enter' && handler.modifiers?.includes('Mod')
    );
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(inputFocused ? 1 : 0);
    expect(sendMessage).toHaveBeenCalledTimes(inputFocused ? 1 : 0);
    expect(result).toBe(inputFocused ? false : undefined);
  });
});
