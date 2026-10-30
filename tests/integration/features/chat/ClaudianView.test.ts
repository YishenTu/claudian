/** @vitest-environment jsdom */
import { triggerResize } from '@test/helpers/dom/ResizeObserver';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { Platform, Scope } from 'obsidian';
import type { Mock } from 'vitest';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { SessionBrowser } from '@/features/chat/session-manager/SessionBrowser';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { createTabComposerPort, createTabPlacementPort } from '@/features/chat/tabs/runtime/TabRuntimePorts';
import { TabBar } from '@/features/chat/tabs/TabBar';
import { ChatPresentationPlacement } from '@/features/chat/view/ChatPresentationPlacement';
import { createChatTabCommands } from '@/features/chat/workspace/ChatTabCommands';
import type { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';



const mockTabManagerConstructor = vi.fn();
vi.mock('@/features/chat/tabs/TabManager', () => ({
  TabManager: vi.fn().mockImplementation(function (...args: unknown[]) { return mockTabManagerConstructor(...args); }),
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

/** A tab manager fake with the surface the view and its owners read; tests override what they assert. */
function createFakeTabManager(overrides: Record<string, unknown> = {}): any {
  const manager: any = {
    callbacks: null,
    beginShutdown: vi.fn(),
    canCreateTab: vi.fn().mockReturnValue(true),
    createNewConversation: vi.fn().mockResolvedValue(undefined),
    createTab: vi.fn().mockResolvedValue(null),
    destroy: vi.fn().mockResolvedValue(undefined),
    drainForShutdownSnapshot: vi.fn().mockResolvedValue(undefined),
    getActiveTab: vi.fn().mockReturnValue(null),
    getAllTabs: vi.fn().mockReturnValue([]),
    getPersistedState: vi.fn().mockReturnValue({ activeTabId: null, openTabs: [] }),
    getTab: vi.fn().mockReturnValue(null),
    getTabBarItems: vi.fn().mockReturnValue([]),
    getTabCount: vi.fn().mockReturnValue(1),
    getTabIdentities: vi.fn().mockReturnValue([]),
    restoreState: vi.fn().mockResolvedValue(undefined),
    sealShutdownSnapshot: vi.fn(),
    setTabLabel: vi.fn(),
    viewerSlot: {
      enter: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      startDraft: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
  return manager;
}

/** Makes the next view open construct `manager`, capturing the callbacks the view wires into it. */
function installTabManager(manager: any): void {
  mockTabManagerConstructor.mockReset();
  mockTabManagerConstructor.mockImplementation((_plugin, _containerEl, _view, callbacks, _mentions, layoutPolicy) => {
    manager.callbacks = callbacks;
    manager.layoutPolicy = layoutPolicy;
    return manager;
  });
}

function createOpenablePlugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ensureConversationMetadataLoaded: vi.fn().mockResolvedValue(undefined),
    settings: { restoreTabsOnStartup: true },
    ...overrides,
  };
}

function createSizedContentEl(width: number) {
  const contentEl = document.createElement('div');
  contentEl.getBoundingClientRect = vi.fn(() => new DOMRect(0, 0, width, 0));
  contentEl.style.setProperty = vi.fn();
  return contentEl;
}

/** Reports width changes through the shared observer boundary. */
function captureResizeObserver(contentEl: HTMLElement): (width: number) => void {
  return (width: number) => {
    const contentRect = new DOMRect(0, 0, width, 0);
    contentEl.getBoundingClientRect = vi.fn(() => contentRect);
    triggerResize(contentEl, { contentRect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] });
  };
}

const openedViews: any[] = [];

/** Opens a real view over `manager` and delivers Obsidian state so the workspace initializes. */
async function openView(options: {
  manager?: any;
  plugin?: Record<string, unknown>;
  width?: number;
  contentEl?: HTMLElement;
} = {}) {
  const manager = options.manager ?? createFakeTabManager();
  installTabManager(manager);
  const contentEl = options.contentEl ?? createSizedContentEl(options.width ?? 400);
  const view = await createClaudianView({ plugin: createOpenablePlugin(options.plugin), contentEl });
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
    refreshProviderControls: vi.fn(),
  };
}

afterEach(async () => {
  // Closing cancels scheduled tab bar renders before the next test replaces the fakes.
  for (const view of openedViews.splice(0)) await view.onClose();
  vi.restoreAllMocks();
});

describe('ClaudianView model refresh routing', () => {
  it('refreshes provider controls only for tabs the changed provider can affect', async () => {
    vi.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation((_settings, providerId) => ({
        customContextLimits: {},
        model: `${providerId}-model`,
        permissionMode: 'normal',
      }));
    const codexTab = createModelRefreshTab('codex', 'codex-conversation');
    const grokTab = createModelRefreshTab('grok', 'grok-conversation');
    const blankGrokTab = createModelRefreshTab('grok', null);
    const tabManager = {
      getAllTabs: vi.fn().mockReturnValue([codexTab, grokTab, blankGrokTab]),
      reconcileProviderAvailability: vi.fn(),
    };
    const view = await createClaudianView({ tabManager });

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

    const newTabButton = contentEl.querySelector<HTMLElement>('.claudian-new-tab-btn')!;
    const newConversationButton = contentEl.querySelector<HTMLElement>('.claudian-new-conversation-btn')!;
    const historyContainer = contentEl.querySelector<HTMLElement>('.claudian-history-container')!;
    const historyButton = historyContainer.querySelector<HTMLButtonElement>('button')!;
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
    expect(historyContainer.querySelector<HTMLElement>('.claudian-history-menu')?.hasClass('visible')).toBe(true);
  });

  it('keeps tab controls in the view-owned input row', async () => {
    const captureScrollPosition = vi.spyOn(TabBar.prototype, 'captureScrollPosition');
    const restoreScrollPosition = vi.spyOn(TabBar.prototype, 'restoreScrollPosition');

    const { contentEl, view } = await openView();

    const navRowHost = contentEl.querySelector<HTMLElement>('.claudian-view-input-nav-row');
    const navRowContent = contentEl.querySelector<HTMLElement>('.claudian-input-nav-content');
    expect(navRowHost?.children).toContain(navRowContent);
    expect(navRowContent?.querySelector<HTMLElement>('.claudian-tab-bar-container')).toBeTruthy();
    expect(view.getSharedSelectionFocusScopeEls!()).toEqual([navRowHost]);
    expect(captureScrollPosition).toHaveBeenCalledTimes(1);
    expect(restoreScrollPosition).toHaveBeenCalledTimes(1);
    expect(captureScrollPosition.mock.invocationCallOrder[0])
      .toBeLessThan(restoreScrollPosition.mock.invocationCallOrder[0]);
  });

  it('focuses the composer after creating a new tab', async () => {
    const focus = vi.fn();
    const tab = { composer: { focus } };
    const view = await createClaudianView({
      tabManager: { createTab: vi.fn().mockResolvedValue(tab), getActiveTab: () => null },
    });

    await expect(view.createNewTab()).resolves.toBe(tab);

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('routes active-file changes only to the active tab Linked content owner', async () => {
    const handleActiveFileChanged = vi.fn();
    const view = await createClaudianView({
      tabManager: {
        getActiveTab: vi.fn().mockReturnValue({ linkedContent: { handleActiveFileChanged } }),
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

  it('hides the new-tab button at capacity and shows it when another tab fits', async () => {
    const { contentEl, manager, view } = await openView();
    const newTabButton = contentEl.querySelector<HTMLElement>('.claudian-new-tab-btn')!;

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

  it('offers tab renaming exactly while the compact tab bar is shown, restored shells included', async () => {
    const manager = createFakeTabManager({
      getActiveTabId: vi.fn().mockReturnValue('tab-1'),
      // One assembled runtime and one restored shell that has not been activated yet.
      getAllTabs: vi.fn().mockReturnValue([{ id: 'tab-1' }]),
      getTabCount: vi.fn().mockReturnValue(2),
    });
    const { contentEl, view } = await openView({ manager, width: 400 });
    const rename = createChatTabCommands({
      workspace: { getLeavesOfType: () => [] },
      views: { getView: () => view, activateView: vi.fn() },
    }).find(command => command.id === 'rename-current-tab')!;
    view.refreshTabControls();

    expect(contentEl.querySelector<HTMLElement>('.claudian-tab-bar-container')!.hasClass('claudian-hidden')).toBe(false);
    expect(rename.checkCallback!(true)).toBe(true);

    manager.getTabCount.mockReturnValue(1);
    view.refreshTabControls();

    expect(contentEl.querySelector<HTMLElement>('.claudian-tab-bar-container')!.hasClass('claudian-hidden')).toBe(true);
    expect(rename.checkCallback!(true)).toBe(false);
  });

  it('lends the footer chip slot to the active tab only while the view is compact', async () => {
    const setSideChatChipHost = vi.fn();
    const dom = {
      contentEl: document.createElement('div'),
      inputComposerEl: document.createElement('div'),
      inputEl: document.createElement('div'),
      messagesWrapperEl: document.createElement('div'),
    };
    const tab = {
      id: 'tab-1',
      conversationId: null,
      dom,
      placement: createTabPlacementPort(dom as never, setSideChatChipHost, () => {}),
    };
    const manager = createFakeTabManager({
      getActiveTab: vi.fn().mockReturnValue(tab),
      getTab: vi.fn().mockReturnValue(tab),
    });
    const contentEl = createSizedContentEl(400);
    const resize = captureResizeObserver(contentEl);
    await openView({ contentEl, manager });
    const chipSlot = contentEl.querySelector<HTMLElement>('.claudian-side-chat-chip-slot');
    expect(contentEl.querySelector<HTMLElement>('.claudian-active-input-slot')?.children)
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

  it('hides the dual-mode New control at capacity', async () => {
    const manager = createFakeTabManager();
    const { contentEl, view } = await openView({ manager, width: 640 });
    const sessionNewButton = contentEl.querySelector<HTMLElement>('.claudian-session-new-control')!;
    expect(sessionNewButton).toBeTruthy();

    manager.canCreateTab.mockReturnValue(false);
    view.refreshTabControls();

    expect(contentEl.querySelector<HTMLElement>('.claudian-new-tab-btn')!.hasClass('claudian-hidden')).toBe(true);
    expect(sessionNewButton.hasClass('claudian-hidden')).toBe(true);
    expect(sessionNewButton.getAttribute('aria-disabled')).toBe('true');
    expect(sessionNewButton.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['wide', 640, true],
    ['compact', 400, false],
  ])('starts New the %s layout way', async (_label, width, wide) => {
    const tab = { id: 'new-tab', composer: { focus: vi.fn() } };
    const manager = createFakeTabManager({ createTab: vi.fn().mockResolvedValue(tab) });
    const { view } = await openView({ manager, width });

    await view.startNewConversation();

    expect(manager.viewerSlot.startDraft).toHaveBeenCalledTimes(wide ? 1 : 0);
    expect(manager.createTab).toHaveBeenCalledTimes(wide ? 0 : 1);
    expect(view.getCompactTabManager()).toBe(wide ? null : manager);
  });

  it('routes tab command picks, /new, and forks through the viewer slot only while wide', async () => {
    const source = { id: 'source-tab' };
    const manager = createFakeTabManager();
    const contentEl = createSizedContentEl(640);
    const resize = captureResizeObserver(contentEl);
    await openView({
      contentEl,
      manager,
    });
    const policy = manager.layoutPolicy;

    await expect(policy.openPicked('conversation-2', source)).resolves.toBe(true);
    await expect(policy.startNew(source)).resolves.toBe(true);
    expect(policy.forkTarget()).toBe('viewer');
    expect(manager.viewerSlot.show).toHaveBeenCalledWith('conversation-2', { sourceTab: source });
    expect(manager.viewerSlot.startDraft).toHaveBeenCalledWith({ sourceTab: source });

    resize(400);
    await Promise.resolve();
    await Promise.resolve();
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(false);
    manager.viewerSlot.show.mockClear();
    manager.viewerSlot.startDraft.mockClear();

    await expect(policy.openPicked('conversation-2', source)).resolves.toBe(false);
    await expect(policy.startNew(source)).resolves.toBe(false);
    expect(policy.forkTarget()).toBe('ask');
    expect(manager.viewerSlot.show).not.toHaveBeenCalled();
    expect(manager.viewerSlot.startDraft).not.toHaveBeenCalled();
  });

  it('stores a tab rename on the tab manager', async () => {
    const manager = createFakeTabManager();
    const { view } = await openView({ manager });

    view.tabBar.callbacks.onTabLabelChange('tab-1', 'Research');

    expect(manager.setTabLabel).toHaveBeenCalledWith('tab-1', 'Research');
  });
});

describe('ClaudianView dual-pane wiring', () => {
  it('releases the viewer slot before compact controls return', async () => {
    const cleanup = deferred<void>();
    const manager = createFakeTabManager();
    manager.viewerSlot.release.mockImplementation(() => cleanup.promise);
    const contentEl = createSizedContentEl(640);
    const resize = captureResizeObserver(contentEl);
    await openView({ contentEl, manager });
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);

    resize(599);

    expect(manager.viewerSlot.release).toHaveBeenCalledTimes(1);
    // Compact controls return only after preview cleanup finishes.
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);

    cleanup.resolve(undefined);
    await cleanup.promise;
    await Promise.resolve();

    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(false);
  });

  it('unloads narrow tabs through the viewer slot only when entering wide after restore', async () => {
    const manager = createFakeTabManager();
    const contentEl = createSizedContentEl(640);
    const resize = captureResizeObserver(contentEl);
    await openView({ contentEl, manager });
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(manager.viewerSlot.enter).not.toHaveBeenCalled();

    resize(400);
    await Promise.resolve();
    await Promise.resolve();
    resize(640);

    expect(manager.viewerSlot.enter).toHaveBeenCalledTimes(1);
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
    const manager = createFakeTabManager();
    manager.viewerSlot.release.mockImplementation(() => cleanup.promise);
    const contentEl = createSizedContentEl(400);
    const resize = captureResizeObserver(contentEl);
    await openView({ contentEl, manager });
    const historyMenu = contentEl.querySelector<HTMLElement>('.claudian-history-menu')!;
    contentEl.querySelector<HTMLElement>('.claudian-history-container button')!.click();
    expect(historyMenu.hasClass('visible')).toBe(true);

    resize(640);

    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(historyMenu.hasClass('visible')).toBe(false);

    contentEl.querySelector<HTMLElement>('.claudian-session-search-control')!.click();
    expect(contentEl.querySelector<HTMLElement>('.claudian-session-search-input')).not.toBeNull();

    resize(599);

    // The layout stays wide until preview cleanup finishes, but search ends immediately.
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(contentEl.querySelector<HTMLElement>('.claudian-session-search-input')).toBeNull();
    expect(contentEl.querySelector<HTMLElement>('.claudian-session-search-control')).not.toBeNull();

    cleanup.resolve(undefined);
    await cleanup.promise;
  });

  it('notifies other open views when runtime session navigation changes', async () => {
    const otherView = { notifyConversationListChanged: vi.fn() };
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
    const markFilesDirty = vi.spyOn(tabProvider, 'markFilesDirty');
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
    const createTab = vi.fn().mockResolvedValue({});
    const manager = createFakeTabManager({
      createTab,
      getPersistedState: vi.fn().mockReturnValue({
        activeTabId: 'restored-2',
        openTabs: [
          { conversationId: null, tabId: 'restored-1' },
          { conversationId: null, tabId: 'restored-2' },
        ],
      }),
      restoreState: vi.fn(async () => {
        manager.callbacks.onTabCreated({ id: 'restored-1' });
        await Promise.resolve();
        manager.callbacks.onTabCreated({ id: 'restored-2' });
        await createTab();
      }),
    });
    installTabManager(manager);
    const contentEl = createSizedContentEl(640);
    const view = await createClaudianView({ plugin: createOpenablePlugin(), contentEl });
    openedViews.push(view);
    // Restoration plans and the nav row see the measured wide layout before the tab manager exists.
    const attachNavRow = vi.spyOn(ChatPresentationPlacement.prototype, 'attachNavRow')
      .mockImplementation(() => {
        expect(view.layout.isWide).toBe(true);
        expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);
      });
    const updateTabBar = vi.spyOn(view, 'updateTabBar');
    const notifyNavigation = vi.spyOn(view, 'notifyConversationNavigationChanged');
    const syncProviderBrandColor = vi.spyOn(view, 'syncProviderBrandColor');

    await view.onOpen();

    expect(createTab).not.toHaveBeenCalled();
    expect(attachNavRow).toHaveBeenCalledTimes(1);
    expect(contentEl.hasClass('claudian-wide-session-layout')).toBe(true);

    await view.setState({}, { history: false });

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(attachNavRow).toHaveBeenCalledTimes(1);
    expect(manager.callbacks).not.toHaveProperty('onPersistedStateChanged');
    expect(updateTabBar).toHaveBeenCalledTimes(1);

    view.tabWorkspace.persist = vi.fn();
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
    const metadataLoad = deferred<void>();
    const manager = createFakeTabManager();
    installTabManager(manager);
    const unregisterZen = vi.fn();
    const plugin = createOpenablePlugin({
      ensureConversationMetadataLoaded: vi.fn(() => metadataLoad.promise),
      registerZenModeSource: vi.fn(() => unregisterZen),
    });
    const contentEl = createSizedContentEl(400);
    const resizeObserverConstructed = vi.spyOn(contentEl.ownerDocument.defaultView!, 'ResizeObserver');
    const view = await createClaudianView({ plugin, contentEl });
    const syncProviderBrandColor = vi.spyOn(view, 'syncProviderBrandColor');
    const restoreAll = vi.spyOn(ChatPresentationPlacement.prototype, 'restoreAll');

    await view.onOpen();
    expect(plugin.registerZenModeSource).toHaveBeenCalledWith(view);
    expect(view.getZenPresentation()).toBeNull();
    // Mention caches follow the vault while open.
    expect(view.plugin.app.vault.on).toHaveBeenCalledTimes(4);

    const restoring = view.setState({ tabWorkspace: {
      version: 1,
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
    } }, { history: false });
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
    metadataLoad.resolve(undefined);
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

  it('reuses closing persistence and restores the whole workspace when reopening wide', async () => {
    const pendingFlush = deferred<void>();
    const persistence = {
      dispose: vi.fn(),
      flush: vi.fn(() => pendingFlush.promise),
      update: vi.fn(),
    };
    const createTab = vi.fn().mockResolvedValue({});
    const manager = createFakeTabManager({
      createTab,
      getPersistedState: vi.fn().mockReturnValue({
        activeTabId: 'closing-tab-2',
        openTabs: [{ conversationId: null, tabId: 'closing-tab-2' }],
      }),
      restoreState: vi.fn(async () => {
        await createTab();
      }),
    });
    installTabManager(manager);
    const view = await createClaudianView({
      contentEl: createSizedContentEl(640),
      plugin: createOpenablePlugin(),
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

    pendingFlush.resolve(undefined);
    await opening;

    expect(persistence.dispose).not.toHaveBeenCalled();
    expect(view.tabWorkspace.persistence).toBe(persistence);
    expect(manager.restoreState).toHaveBeenCalledWith({
      activeTabId: 'closing-tab-2',
      openTabs: [
        { conversationId: null, tabId: 'closing-tab-1' },
        { conversationId: null, tabId: 'closing-tab-2' },
      ],
    });
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  it('waits for the closing shutdown snapshot before restoring a reopened view', async () => {
    const shutdownSnapshot = deferred<void>();
    const persistence = {
      dispose: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    };
    const createTab = vi.fn().mockResolvedValue({});
    const manager = createFakeTabManager({
      createTab,
      getPersistedState: vi.fn().mockReturnValue({
        activeTabId: 'finalized-tab-2',
        openTabs: [
          { conversationId: 'conversation-1', tabId: 'finalized-tab-1' },
          { conversationId: null, tabId: 'finalized-tab-2' },
        ],
      }),
      restoreState: vi.fn(async () => {
        await createTab();
      }),
    });
    installTabManager(manager);
    const view = await createClaudianView({
      plugin: createOpenablePlugin({ settings: { restoreTabsOnStartup: false } }),
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

    view.tabWorkspace.finalizedState = {
      activeTabId: 'finalized-tab-2',
      openTabs: [
        { conversationId: 'conversation-1', tabId: 'finalized-tab-1' },
        { conversationId: null, tabId: 'finalized-tab-2' },
      ],
    };
    shutdownSnapshot.resolve(undefined);
    await opening;

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
  async function createComposerHarness(existingContent: string): Promise<{
    inputEl: HTMLTextAreaElement;
    inputHandler: Mock;
    view: any;
  }> {
    const inputEl = document.createElement('textarea') as unknown as HTMLTextAreaElement;
    const inputHandler = vi.fn();
    inputEl.value = existingContent;
    inputEl.selectionStart = 0;
    inputEl.selectionEnd = 0;
    inputEl.focus = vi.fn();
    inputEl.addEventListener('input', inputHandler);

    const tabManager = {
      getActiveTab: vi.fn().mockReturnValue({
        id: 'active-tab',
        composer: createTabComposerPort(inputEl as never, {} as never),
      }),
    };
    const view = await createClaudianView({ tabManager });

    return { inputEl, inputHandler, view };
  }

  it('focuses the active composer', async () => {
    const { inputEl, view } = await createComposerHarness('');

    view.focusActiveInput();

    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('appends text after existing composer content', async () => {
    const { inputEl, inputHandler, view } = await createComposerHarness('Review this note');

    const appended = view.appendToActiveInput('@projects/plan.md ');

    expect(appended).toBe(true);
    expect(inputEl.value).toBe('Review this note @projects/plan.md ');
    expect(inputEl.selectionStart).toBe(inputEl.value.length);
    expect(inputEl.selectionEnd).toBe(inputEl.value.length);
    expect(inputHandler).toHaveBeenCalledTimes(1);
    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('does not add another separator when existing content ends in whitespace', async () => {
    const { inputEl, view } = await createComposerHarness('Review this note\n');

    view.appendToActiveInput('@projects/plan.md ');

    expect(inputEl.value).toBe('Review this note\n@projects/plan.md ');
  });

  it('returns false when there is no active composer', async () => {
    const view = await createClaudianView({
      tabManager: { getActiveTab: vi.fn().mockReturnValue(null) },
    });

    expect(view.appendToActiveInput('@projects/plan.md ')).toBe(false);
  });
});

describe('ClaudianView shutdown', () => {
  function createClosingTabBar() {
    return {
      destroy: vi.fn(),
      getExpandedTitleTabIds: vi.fn().mockReturnValue([]),
      getTabLabels: vi.fn().mockReturnValue({}),
    };
  }

  it('prepares plugin unload through one shared drained snapshot', async () => {
    const drain = deferred<void>();
    const flush = vi.fn().mockResolvedValue(undefined);
    const manager = {
      beginShutdown: vi.fn(),
      drainForShutdownSnapshot: vi.fn(() => drain.promise),
      getPersistedState: vi.fn().mockReturnValue({
        activeTabId: 'tab-1',
        openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
      }),
      sealShutdownSnapshot: vi.fn(),
    };
    const persistence = {
      flush,
      update: vi.fn(),
    };
    const view = await createClaudianView({ tabManager: manager });
    Object.assign(view.tabWorkspace, { persistence });

    const first = view.prepareForPluginUnload();
    const second = view.prepareForPluginUnload();

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

  it('drains active turns before sealing and flushing the final tab identity', async () => {
    const drain = deferred<void>();
    const activeTab = { conversationId: null as string | null, id: 'tab-1' };
    const update = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const sealShutdownSnapshot = vi.fn();
    const manager = {
      beginShutdown: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      drainForShutdownSnapshot: vi.fn(() => drain.promise),
      getPersistedState: vi.fn(() => ({
        activeTabId: activeTab.id,
        openTabs: [{ conversationId: activeTab.conversationId, tabId: activeTab.id }],
      })),
      sealShutdownSnapshot,
    };
    const view = await createClaudianView({ tabManager: manager });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, {
      persistence: { dispose: vi.fn(), flush, update },
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
    expect(sealShutdownSnapshot.mock.invocationCallOrder[0])
      .toBeLessThan(flush.mock.invocationCallOrder[0]);
  });

  it('publishes the finalized snapshot while the old manager is being destroyed', async () => {
    const destruction = deferred<void>();
    let teardownStarted = false;
    const finalState = {
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
    };
    const manager = {
      beginShutdown: vi.fn(),
      destroy: vi.fn(() => {
        teardownStarted = true;
        return destruction.promise;
      }),
      drainForShutdownSnapshot: vi.fn().mockResolvedValue(undefined),
      getPersistedState: vi.fn(() => teardownStarted
        ? { activeTabId: null, openTabs: [] }
        : finalState),
      sealShutdownSnapshot: vi.fn(),
    };
    const view = await createClaudianView({ tabManager: manager });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, {
      pendingState: null,
      persistence: {
        dispose: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        update: vi.fn(),
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
    const beginShutdown = vi.fn();
    const destroy = vi.fn().mockResolvedValue(undefined);
    const sealShutdownSnapshot = vi.fn();
    const disposePersistence = vi.fn();
    let resolveFlush!: () => void;
    const flushPersistence = vi.fn(() => new Promise<void>(resolve => {
      resolveFlush = resolve;
    }));
    const updatePersistence = vi.fn();
    const tabBar = createClosingTabBar();
    const view = await createClaudianView({
      tabManager: {
        beginShutdown,
        destroy,
        getPersistedState: vi.fn().mockReturnValue({
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
    const restoreAll = vi.spyOn(ChatPresentationPlacement.prototype, 'restoreAll');

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
    const destroy = vi.fn().mockResolvedValue(undefined);
    const disposePersistence = vi.fn();
    const view = await createClaudianView({
      tabManager: {
        beginShutdown: vi.fn(),
        destroy,
        getPersistedState: vi.fn().mockReturnValue({
          activeTabId: 'tab-1',
          openTabs: [{ conversationId: null, tabId: 'tab-1' }],
        }),
        sealShutdownSnapshot: vi.fn(),
      },
    });
    Object.assign(view, { scope: {}, tabBar: createClosingTabBar() });
    Object.assign(view.tabWorkspace, {
      persistence: {
        dispose: disposePersistence,
        flush: vi.fn().mockRejectedValue(new Error('disk full')),
        update: vi.fn(),
      },
    });

    await expect(view.onClose()).resolves.toBeUndefined();

    expect(disposePersistence).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
  });

  it('does not let an older close finalizer clear resources from a newer open', async () => {
    const flush = deferred<void>();
    const oldManager = {
      beginShutdown: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      getPersistedState: vi.fn().mockReturnValue({
        activeTabId: 'old-tab',
        openTabs: [{ conversationId: null, tabId: 'old-tab' }],
      }),
      sealShutdownSnapshot: vi.fn(),
    };
    const oldPersistence = {
      dispose: vi.fn(),
      flush: vi.fn(() => flush.promise),
      update: vi.fn(),
    };
    const oldTabBar = createClosingTabBar();
    const oldReleaseMentionCacheEvents = vi.fn();
    const view = await createClaudianView({ tabManager: oldManager });
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
    const newTabBar = { destroy: vi.fn() };
    const newReleaseMentionCacheEvents = vi.fn();
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
      dispose: vi.fn(),
      flush: vi.fn(() => flush.promise),
      update: vi.fn(),
    };
    const oldManager = {
      beginShutdown: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      getPersistedState: vi.fn().mockReturnValue({
        activeTabId: 'old-tab',
        openTabs: [{ conversationId: null, tabId: 'old-tab' }],
      }),
      sealShutdownSnapshot: vi.fn(),
    };
    const view = await createClaudianView({ tabManager: oldManager });
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

type EscapeConsumer = 'resume dropdown' | 'prompt suggestion' | 'composer dropdown';

describe('ClaudianView Escape handling', () => {
  beforeEach(() => {
    MockScope.instances.length = 0;
  });

  async function createEscapeHarness(options: {
    isStreaming: boolean;
    toolbarMenuOpen?: boolean;
    backgroundWork?: boolean;
    escapeConsumer?: EscapeConsumer;
  }): Promise<{
    cancelStreaming: Mock;
    closeOpenMenu: Mock;
    escape: (event?: Partial<KeyboardEvent>) => unknown;
    view: any;
  }> {
    const cancelStreaming = vi.fn();
    let toolbarMenuOpen = options.toolbarMenuOpen ?? false;
    const closeOpenMenu = vi.fn(() => {
      const wasOpen = toolbarMenuOpen;
      toolbarMenuOpen = false;
      return wasOpen;
    });
    const view = await createClaudianView({
      tabManager: {
        getActiveTab: vi.fn().mockReturnValue({
          state: { isStreaming: options.isStreaming },
          session: { hasMainBackgroundWork: options.backgroundWork ?? false, runtime: { mailbox: null } },
          ui: {
            composerDropdown: { handleKeydown: () => options.escapeConsumer === 'composer dropdown' },
            promptSuggestion: { handleKeydown: () => options.escapeConsumer === 'prompt suggestion' },
          },
          controllers: {
            inputController: { cancelStreaming },
            builtInCommandController: { handleResumeKeydown: () => options.escapeConsumer === 'resume dropdown' },
            sideChatController: { destination: 'main', runtime: null },
            promptHistoryNavigation: { handleKeydown: () => false },
          },
          composer: { closeOpenMenu },
          linkedContent: { handleActiveFileMetadataChanged: vi.fn() },
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

  async function createScopedSendHarness(options: {
    inputFocused: boolean;
  }): Promise<{
    sendMessage: Mock;
    view: any;
  }> {
    const sendMessage = vi.fn();
    const inputEl = document.createElement('textarea') as unknown as HTMLTextAreaElement;
    Object.defineProperty(inputEl.ownerDocument, 'activeElement', {
      configurable: true,
      get: () => options.inputFocused ? inputEl : null,
    });
    const view = await createClaudianView({
      tabManager: {
        getActiveTab: vi.fn().mockReturnValue({
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

  it('registers Escape on the Obsidian view scope instead of document keydown capture', async () => {
    const { view } = await createEscapeHarness({ isStreaming: true });

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

  it('cancels streaming and consumes scoped Escape', async () => {
    const { cancelStreaming, escape } = await createEscapeHarness({ isStreaming: true });

    expect(escape()).toBe(false);
    expect(cancelStreaming).toHaveBeenCalledTimes(1);
  });

  it('closes an open toolbar menu instead of cancelling the turn when the scope sees Escape first', async () => {
    const { cancelStreaming, closeOpenMenu, escape } = await createEscapeHarness({
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

  it('consumes scoped Escape without cancelling when not streaming', async () => {
    const { cancelStreaming, escape } = await createEscapeHarness({ isStreaming: false });

    expect(escape()).toBe(false);
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('routes published background work through scoped Escape', async () => {
    const { cancelStreaming, escape } = await createEscapeHarness({ isStreaming: false, backgroundWork: true });
    expect(escape()).toBe(false);
    expect(cancelStreaming).toHaveBeenCalledTimes(1);
  });

  it.each<EscapeConsumer>(['resume dropdown', 'prompt suggestion', 'composer dropdown'])(
    'lets an open %s consume scoped Escape before background Stop',
    async (escapeConsumer) => {
      const { cancelStreaming, escape } = await createEscapeHarness({ isStreaming: false, backgroundWork: true, escapeConsumer });
      expect(escape()).toBe(false);
      expect(cancelStreaming).not.toHaveBeenCalled();
    },
  );

  it('exits session inline rename before handling other scoped Escape actions', async () => {
    const cancelInlineRename = vi.spyOn(SessionBrowser.prototype, 'cancelInlineRename')
      .mockReturnValue(true);
    const { cancelStreaming, closeOpenMenu, escape } = await createEscapeHarness({
      isStreaming: true,
      toolbarMenuOpen: true,
    });

    expect(escape()).toBe(false);
    expect(cancelInlineRename).toHaveBeenCalledTimes(1);
    expect(closeOpenMenu).not.toHaveBeenCalled();
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('lets the session surface consume scoped Escape before cancelling the turn', async () => {
    const handleEscape = vi.spyOn(SessionManagerSurface.prototype, 'handleEscape')
      .mockReturnValue(true);
    const { cancelStreaming, escape } = await createEscapeHarness({ isStreaming: true });

    expect(escape()).toBe(false);
    expect(handleEscape).toHaveBeenCalledTimes(1);
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('lets an open tab rename consume scoped Escape before cancelling the turn', async () => {
    const { cancelStreaming, closeOpenMenu, escape, view } = await createEscapeHarness({
      isStreaming: true,
      toolbarMenuOpen: true,
    });
    let renaming = true;
    view.tabBar = { handleEscape: vi.fn(() => { const was = renaming; renaming = false; return was; }) };

    expect(escape()).toBe(false);
    expect(view.tabBar.handleEscape).toHaveBeenCalledTimes(1);
    expect(closeOpenMenu).not.toHaveBeenCalled();
    expect(cancelStreaming).not.toHaveBeenCalled();

    // With the rename closed, Escape resumes its usual chain.
    escape();
    expect(closeOpenMenu).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to session search IME composition', async () => {
    vi.spyOn(SessionManagerSurface.prototype, 'isComposing', 'get').mockReturnValue(true);
    const handleEscape = vi.spyOn(SessionManagerSurface.prototype, 'handleEscape');
    const { cancelStreaming, escape } = await createEscapeHarness({ isStreaming: true });

    expect(escape()).toBeUndefined();
    expect(handleEscape).not.toHaveBeenCalled();
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('consumes already handled scoped Escape without cancelling again', async () => {
    const { cancelStreaming, escape } = await createEscapeHarness({ isStreaming: true });

    expect(escape({ defaultPrevented: true })).toBe(false);
    expect(cancelStreaming).not.toHaveBeenCalled();
  });

  it('routes metadata cache refreshes to the active tab Linked content owner', async () => {
    const { view } = await createEscapeHarness({ isStreaming: false });
    const handleActiveFileMetadataChanged = vi.fn();
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
  ])('scoped Mod+Enter %s', async (_label, inputFocused) => {
    Platform.isMacOS = true;
    const { sendMessage, view } = await createScopedSendHarness({ inputFocused });

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
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(inputFocused ? 1 : 0);
    expect(sendMessage).toHaveBeenCalledTimes(inputFocused ? 1 : 0);
    expect(result).toBe(inputFocused ? false : undefined);
  });
});
