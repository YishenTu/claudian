import { createMockEl } from '@test/helpers/MockElement';
import { Platform, Scope } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ClaudianView } from '@/features/chat/ClaudianView';

const mockTabManagerConstructor = jest.fn();
jest.mock('@/features/chat/tabs/TabManager', () => ({
  TabManager: jest.fn().mockImplementation((...args: unknown[]) =>
    mockTabManagerConstructor(...args)),
}));

const MockScope = Scope as typeof Scope & { instances: Scope[] };

function createModelRefreshTab(providerId: 'codex' | 'grok') {
  return {
    conversationId: `${providerId}-conversation`,
    dom: {
      inputWrapper: {
        toggleClass: jest.fn(),
      },
    },
    lifecycleState: 'cold',
    providerId,
    service: null,
    state: { usage: null },
    ui: {
      modeSelector: {
        renderOptions: jest.fn(),
        updateDisplay: jest.fn(),
      },
      modelSelector: {
        renderOptions: jest.fn(),
        updateDisplay: jest.fn(),
      },
      permissionToggle: { updateDisplay: jest.fn() },
      serviceTierToggle: { updateDisplay: jest.fn() },
      thinkingBudgetSelector: { updateDisplay: jest.fn() },
    },
  };
}

function createBlankModelRefreshTab(providerId: 'codex' | 'grok') {
  return {
    ...createModelRefreshTab(providerId),
    conversationId: null,
    draftModel: null,
    lifecycleState: 'cold',
    services: {
      instructionRefineService: null,
      subagentManager: {
        setTaskResultInterpreter: jest.fn(),
      },
    },
    ui: {
      ...createModelRefreshTab(providerId).ui,
      permissionToggle: {
        setVisible: jest.fn(),
        updateDisplay: jest.fn(),
      },
    },
  };
}

describe('ClaudianView model refresh routing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refreshes matching bound tabs and all blank tabs without priming runtimes', () => {
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation((_settings, providerId) => ({
        customContextLimits: {},
        model: `${providerId}-model`,
        permissionMode: 'normal',
      }));
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getContextWindowSize: jest.fn().mockReturnValue(200_000),
      getPermissionModeToggle: jest.fn().mockReturnValue(null),
    } as any);
    jest.spyOn(ProviderRegistry, 'getCapabilities').mockImplementation(providerId => ({
      providerId,
      supportsImageAttachments: false,
      supportsMcpTools: false,
      supportsPlanMode: false,
    } as any));
    jest.spyOn(ProviderRegistry, 'getEnabledProviderIds').mockReturnValue(['codex', 'grok']);
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService')
      .mockReturnValue(null as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter')
      .mockReturnValue(null as any);

    const codexTab = createModelRefreshTab('codex');
    const grokTab = createModelRefreshTab('grok');
    const blankGrokTab = createBlankModelRefreshTab('grok');
    const primeProviderExecution = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    view.plugin = {
      getConversationSync: jest.fn().mockReturnValue(null),
      providerHost: {},
      settings: {},
    };
    view.tabManager = {
      getAllTabs: jest.fn().mockReturnValue([codexTab, grokTab, blankGrokTab]),
      primeProviderExecution,
      reconcileProviderAvailability: jest.fn(),
    };

    view.refreshModelSelector('codex');

    expect(codexTab.ui.modelSelector.updateDisplay).toHaveBeenCalledTimes(1);
    expect(codexTab.ui.modelSelector.renderOptions).toHaveBeenCalledTimes(1);
    expect(grokTab.ui.modelSelector.updateDisplay).not.toHaveBeenCalled();
    expect(grokTab.ui.modelSelector.renderOptions).not.toHaveBeenCalled();
    expect(blankGrokTab.ui.modelSelector.updateDisplay).toHaveBeenCalled();
    expect(blankGrokTab.ui.modelSelector.renderOptions).toHaveBeenCalled();
    expect(view.tabManager.reconcileProviderAvailability).toHaveBeenCalledTimes(1);
    expect(primeProviderExecution).not.toHaveBeenCalled();
  });
});

function createViewHarness(options: {
  canCreateTab: boolean;
  tabCount?: number;
  tabs?: Array<{ conversationId: string | null }>;
}): {
  newTabButtonEl: ReturnType<typeof createMockEl>;
  sessionNewButtonEl: ReturnType<typeof createMockEl>;
  view: any;
} {
  const newTabButtonEl = createMockEl();
  const sessionNewButtonEl = createMockEl();
  const view = Object.create(ClaudianView.prototype) as any;

  view.plugin = {
    settings: {},
  };
  view.tabManager = {
    canCreateTab: jest.fn().mockReturnValue(options.canCreateTab),
    getAllTabs: jest.fn().mockReturnValue(options.tabs ?? []),
    getTabCount: jest.fn().mockReturnValue(options.tabCount ?? 1),
  };
  view.tabBarContainerEl = createMockEl();
  view.newTabButtonEl = newTabButtonEl;
  view.sessionNewButtonEl = sessionNewButtonEl;

  return { newTabButtonEl, sessionNewButtonEl, view };
}

describe('ClaudianView tab controls', () => {
  it('focuses the composer after creating a new tab', async () => {
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    inputEl.focus = jest.fn();
    const tab = { dom: { inputEl } };
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = { settings: {} };
    view.tabManager = {
      createTab: jest.fn().mockResolvedValue(tab),
    };
    view.updateTabBarVisibility = jest.fn();

    await view.createNewTab();

    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('hides the new-tab button when the tab manager is at capacity', () => {
    const { newTabButtonEl, sessionNewButtonEl, view } = createViewHarness({ canCreateTab: false });

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('claudian-hidden')).toBe(true);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBe('true');
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBe('true');
    expect(sessionNewButtonEl.hasClass('claudian-hidden')).toBe(true);
    expect(sessionNewButtonEl.getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the new-tab button when another tab can be created', () => {
    const { newTabButtonEl, sessionNewButtonEl, view } = createViewHarness({ canCreateTab: true });
    newTabButtonEl.addClass('claudian-hidden');
    newTabButtonEl.setAttribute('aria-disabled', 'true');
    newTabButtonEl.setAttribute('aria-hidden', 'true');
    sessionNewButtonEl.addClass('claudian-hidden');
    sessionNewButtonEl.setAttribute('aria-disabled', 'true');
    sessionNewButtonEl.setAttribute('aria-hidden', 'true');

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('claudian-hidden')).toBe(false);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBeNull();
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBeNull();
    expect(sessionNewButtonEl.hasClass('claudian-hidden')).toBe(false);
    expect(sessionNewButtonEl.getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps the dual-mode New control available to resume an unbound draft at capacity', () => {
    const { newTabButtonEl, sessionNewButtonEl, view } = createViewHarness({
      canCreateTab: false,
      tabs: [{ conversationId: 'conversation-1' }, { conversationId: null }],
    });

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('claudian-hidden')).toBe(true);
    expect(sessionNewButtonEl.hasClass('claudian-hidden')).toBe(false);
    expect(sessionNewButtonEl.getAttribute('aria-disabled')).toBeNull();
    expect(sessionNewButtonEl.getAttribute('aria-hidden')).toBeNull();
  });

  it('renders one New control in the persistent header', () => {
    const container = createMockEl();
    const header = container.createDiv({ cls: 'claudian-history-header' });
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      requestDualNew: jest.fn(),
      tabManager: {
        canCreateTab: jest.fn().mockReturnValue(true),
        getAllTabs: jest.fn().mockReturnValue([]),
      },
    });

    view.buildSessionHeaderActions(container);

    const actions = header.querySelector('.claudian-session-header-actions');
    const newButton = actions?.children[0];
    expect(actions?.children).toHaveLength(1);
    expect(newButton?.tagName).toBe('DIV');
    expect(newButton?.getAttribute('role')).toBe('button');
    expect(newButton?.getAttribute('tabindex')).toBe('0');
    expect(newButton?.getAttribute('aria-label')).toBe('New');

    newButton?.click();
    expect(view.requestDualNew).toHaveBeenCalledTimes(1);
  });

  it('focuses the current unbound draft when New is clicked again in dual mode', async () => {
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    inputEl.focus = jest.fn();
    const draftTab = { id: 'draft-1', conversationId: null, dom: { inputEl } };
    const view = Object.create(ClaudianView.prototype) as any;

    view.createNewTab = jest.fn();
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(draftTab),
      getAllTabs: jest.fn().mockReturnValue([draftTab]),
      switchToTab: jest.fn(),
    };

    await view.activateOrCreateDraftTab();

    expect(inputEl.focus).toHaveBeenCalledTimes(1);
    expect(view.tabManager.switchToTab).not.toHaveBeenCalled();
    expect(view.createNewTab).not.toHaveBeenCalled();
  });

  it('resumes the most recent unbound draft instead of creating another one', async () => {
    const firstInputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    const latestInputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    firstInputEl.focus = jest.fn();
    latestInputEl.focus = jest.fn();
    const activeTab = { id: 'tab-1', conversationId: 'conversation-1' };
    const firstDraft = { id: 'draft-1', conversationId: null, dom: { inputEl: firstInputEl } };
    const latestDraft = { id: 'draft-2', conversationId: null, dom: { inputEl: latestInputEl } };
    const view = Object.create(ClaudianView.prototype) as any;

    view.createNewTab = jest.fn();
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(activeTab),
      getAllTabs: jest.fn().mockReturnValue([activeTab, firstDraft, latestDraft]),
      switchToTab: jest.fn().mockResolvedValue(undefined),
    };

    await view.activateOrCreateDraftTab();

    expect(view.tabManager.switchToTab).toHaveBeenCalledWith('draft-2');
    expect(latestInputEl.focus).toHaveBeenCalledTimes(1);
    expect(firstInputEl.focus).not.toHaveBeenCalled();
    expect(view.createNewTab).not.toHaveBeenCalled();
  });

  it('creates an unbound tab when dual mode has no draft to resume', async () => {
    const activeTab = { id: 'tab-1', conversationId: 'conversation-1' };
    const view = Object.create(ClaudianView.prototype) as any;

    view.createNewTab = jest.fn().mockResolvedValue(undefined);
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(activeTab),
      getAllTabs: jest.fn().mockReturnValue([activeTab]),
    };

    await view.activateOrCreateDraftTab();

    expect(view.createNewTab).toHaveBeenCalledTimes(1);
  });

  it('handles a New conversation command with the dual-mode New action', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.activateOrCreateDraftTab = jest.fn().mockResolvedValue(undefined);
    view.isWideSessionLayout = true;

    await expect(view.handleNewConversationCommand()).resolves.toBe(true);

    expect(view.activateOrCreateDraftTab).toHaveBeenCalledTimes(1);
  });

  it('leaves a New conversation command to the current tab in single mode', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.activateOrCreateDraftTab = jest.fn().mockResolvedValue(undefined);
    view.isWideSessionLayout = false;

    await expect(view.handleNewConversationCommand()).resolves.toBe(false);

    expect(view.activateOrCreateDraftTab).not.toHaveBeenCalled();
  });

  it('keeps tab controls in the view-owned input row', () => {
    const navRowContent = createMockEl();
    const inputNavRowHostEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    view.containerEl = createMockEl();
    view.navRowContent = navRowContent;
    view.inputNavRowHostEl = inputNavRowHostEl;
    view.tabBar = {
      captureScrollPosition: jest.fn(),
      restoreScrollPosition: jest.fn(),
    };

    view.attachNavRowContentToInputFooter();

    expect(inputNavRowHostEl.children).toContain(navRowContent);
    expect(view.tabBar.captureScrollPosition).toHaveBeenCalledTimes(1);
    expect(view.tabBar.restoreScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('moves only the active tab input into the stable input slot', () => {
    const activeInputSlotEl = createMockEl();
    const tab1 = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const tab2 = {
      id: 'tab-2',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const view = Object.create(ClaudianView.prototype) as any;

    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn()
        .mockReturnValueOnce(tab1)
        .mockReturnValueOnce(tab2),
      getTab: jest.fn((id: string) => id === 'tab-1' ? tab1 : tab2),
    };

    view.updateInputLocation();
    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(tab2.dom.inputComposerEl);
    expect(activeInputSlotEl.children).not.toContain(tab1.dom.inputComposerEl);
    expect(tab1.dom.contentEl.children).toContain(tab1.dom.inputComposerEl);
  });

  it('preserves active pending prompt siblings during same-tab input updates', () => {
    const activeInputSlotEl = createMockEl();
    const inputComposerEl = activeInputSlotEl.createDiv();
    const pendingPromptEl = inputComposerEl.createDiv({ cls: 'claudian-ask-question-inline' });
    const tab = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl,
        inputContainerEl: inputComposerEl.createDiv({ cls: 'claudian-input-container' }),
      },
    };
    const view = Object.create(ClaudianView.prototype) as any;

    Object.defineProperty(inputComposerEl, 'parentElement', {
      configurable: true,
      get: () => activeInputSlotEl,
    });
    view.activeInputTabId = 'tab-1';
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(tab),
      getTab: jest.fn().mockReturnValue(tab),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(inputComposerEl);
    expect(inputComposerEl.children).toContain(pendingPromptEl);
  });

  it('clears the stable input slot when no tab is active', () => {
    const activeInputSlotEl = createMockEl();
    const staleInputEl = activeInputSlotEl.createDiv();
    const view = Object.create(ClaudianView.prototype) as any;

    view.activeInputTabId = 'tab-1';
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).not.toContain(staleInputEl);
    expect(view.activeInputTabId).toBeNull();
  });

  it('toggles the history dropdown when the history button is clicked', () => {
    const historyDropdown = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(true);

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(false);
  });

  it('defers hidden history rendering and coalesces invalidations until the dropdown opens', () => {
    const historyDropdown = createMockEl();
    const renderHistoryDropdown = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.historyDropdownDirty = true;
    view.historySurfaceRendered = false;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        controllers: {
          conversationController: { renderHistoryDropdown },
        },
      }),
    };

    view.updateHistoryDropdown();
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).not.toHaveBeenCalled();

    view.toggleHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(1);
    const firstRenderSignal = renderHistoryDropdown.mock.calls[0][1].signal as AbortSignal;
    expect(firstRenderSignal.aborted).toBe(false);

    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);

    view.toggleHistoryDropdown();
    expect(firstRenderSignal.aborted).toBe(true);
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);
  });

  it('builds the persistent session column to the right of the chat panel', () => {
    const viewContainerEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    view.viewContainerEl = viewContainerEl;

    view.buildViewLayout();

    expect(viewContainerEl.children).toHaveLength(3);
    expect(viewContainerEl.children[0].hasClass('claudian-chat-panel')).toBe(true);
    expect(viewContainerEl.children[1].hasClass('claudian-session-resizer')).toBe(true);
    expect(viewContainerEl.children[2].hasClass('claudian-session-sidebar')).toBe(true);
    expect(viewContainerEl.children[1].getAttribute('role')).toBe('separator');
    expect(viewContainerEl.children[0].children).toContain(view.tabContentEl);
    expect(viewContainerEl.children[0].children).toContain(view.inputFooterEl);
  });

  it('shows and renders the persistent session column when the view becomes wide', () => {
    const viewContainerEl = createMockEl();
    const historyDropdown = createMockEl();
    historyDropdown.addClass('visible');
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      historyDropdown,
      isWideSessionLayout: false,
      renderSessionSidebar: jest.fn(),
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(600);

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(view.isWideSessionLayout).toBe(true);
    expect(historyDropdown.hasClass('visible')).toBe(false);
    expect(view.cancelHistoryRendering).toHaveBeenCalledTimes(1);
    expect(view.renderSessionSidebar).toHaveBeenCalledTimes(1);
  });

  it('returns to the history dropdown layout below the wide breakpoint', () => {
    const viewContainerEl = createMockEl();
    viewContainerEl.addClass('claudian-wide-session-layout');
    const view = Object.create(ClaudianView.prototype) as any;
    const discardProvisionalTabs = jest.fn().mockResolvedValue(undefined);

    Object.assign(view, {
      cancelSessionSidebarRendering: jest.fn(),
      isWideSessionLayout: true,
      tabManager: { discardProvisionalTabs },
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(599);

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(false);
    expect(view.isWideSessionLayout).toBe(false);
    expect(view.cancelSessionSidebarRendering).toHaveBeenCalledTimes(1);
    expect(discardProvisionalTabs).toHaveBeenCalledTimes(1);
  });

  it('resizes chat and session columns without changing the total view width', () => {
    const viewContainerEl = createMockEl();
    viewContainerEl.getBoundingClientRect = jest.fn().mockReturnValue({ width: 800 });
    viewContainerEl.style.setProperty = jest.fn();
    const sessionSidebarEl = createMockEl();
    sessionSidebarEl.getBoundingClientRect = jest.fn().mockReturnValue({ width: 240 });
    const documentListeners = new Map<string, EventListener>();
    const ownerDocument = {
      addEventListener: jest.fn((event: string, listener: EventListener) => {
        documentListeners.set(event, listener);
      }),
      removeEventListener: jest.fn((event: string) => {
        documentListeners.delete(event);
      }),
    };
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      isWideSessionLayout: true,
      sessionSidebarEl,
      viewContainerEl,
    });

    view.startSessionSidebarResize({
      button: 0,
      clientX: 500,
      currentTarget: { ownerDocument },
      preventDefault: jest.fn(),
    });
    documentListeners.get('pointermove')?.({ clientX: 450 } as unknown as Event);

    expect(viewContainerEl.style.setProperty).toHaveBeenLastCalledWith(
      '--claudian-session-sidebar-width',
      '290px',
    );
    expect(viewContainerEl.hasClass('claudian-resizing-session-sidebar')).toBe(true);

    documentListeners.get('pointerup')?.({} as Event);
    expect(viewContainerEl.hasClass('claudian-resizing-session-sidebar')).toBe(false);
    expect(ownerDocument.removeEventListener).toHaveBeenCalledWith(
      'pointermove',
      expect.any(Function),
    );
  });

  it('clamps the resized session column to preserve the minimum chat width', () => {
    const viewContainerEl = createMockEl();
    viewContainerEl.getBoundingClientRect = jest.fn().mockReturnValue({ width: 700 });
    viewContainerEl.style.setProperty = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      viewContainerEl,
    });

    view.setSessionSidebarWidth(600);

    expect(viewContainerEl.style.setProperty).toHaveBeenCalledWith(
      '--claudian-session-sidebar-width',
      '375px',
    );
  });

  it('refreshes the persistent session column while wide', () => {
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      historyDropdown: createMockEl(),
      isWideSessionLayout: true,
      renderSessionSidebar: jest.fn(),
      sessionSidebarDirty: false,
    });

    view.updateHistoryDropdown();

    expect(view.sessionSidebarDirty).toBe(true);
    expect(view.renderSessionSidebar).toHaveBeenCalledTimes(1);
  });

  it('renders the existing history content into the persistent session column', () => {
    const sessionSidebarEl = createMockEl();
    const renderHistoryDropdown = jest.fn();
    const updateHistoryDropdown = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      cancelSessionSidebarRendering: jest.fn(),
      historySurfaceRendered: true,
      isWideSessionLayout: true,
      sessionSidebarDirty: true,
      sessionSidebarEl,
      updateHistoryDropdown,
      tabManager: {
        getActiveTab: jest.fn().mockReturnValue({
          controllers: { conversationController: { renderHistoryDropdown } },
        }),
      },
    });

    view.renderSessionSidebar();

    expect(renderHistoryDropdown).toHaveBeenCalledWith(
      sessionSidebarEl,
      expect.objectContaining({
        getConversationStatus: expect.any(Function),
        onRerender: expect.any(Function),
        onSelectConversation: expect.any(Function),
        showOpenStateLabels: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(renderHistoryDropdown.mock.calls[0][1])
      .not.toHaveProperty('onOpenConversationInNewTab');
    expect(view.sessionSidebarDirty).toBe(false);

    renderHistoryDropdown.mock.calls[0][1].onRerender();
    expect(updateHistoryDropdown).toHaveBeenCalledTimes(1);
  });

  it('opens a closed session in a new container from the dual-mode session column', async () => {
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
    };
    view.tabManager = {
      canCreateTab: jest.fn().mockReturnValue(true),
      getAllTabs: jest.fn().mockReturnValue([
        { id: 'draft-1', conversationId: null },
      ]),
      openConversation,
    };

    await view.openSessionConversation('conversation-2');

    expect(openConversation).toHaveBeenCalledWith('conversation-2', {
      preferNewTab: true,
      activate: true,
      provisional: true,
    });
  });

  it('opens a provisional session even when the former tab limit is reached', async () => {
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
    };
    view.tabManager = {
      canCreateTab: jest.fn().mockReturnValue(false),
      getAllTabs: jest.fn().mockReturnValue([
        { id: 'tab-1', conversationId: 'conversation-1' },
        { id: 'draft-1', conversationId: null },
      ]),
      openConversation,
    };

    await view.openSessionConversation('conversation-2');

    expect(openConversation).toHaveBeenCalledWith('conversation-2', {
      preferNewTab: true,
      activate: true,
      provisional: true,
    });
  });

  it('switches to an already-open dual-mode session even at container capacity', async () => {
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
    };
    view.tabManager = {
      canCreateTab: jest.fn().mockReturnValue(false),
      getAllTabs: jest.fn().mockReturnValue([
        { id: 'tab-1', conversationId: 'conversation-1' },
        { id: 'tab-2', conversationId: 'conversation-2' },
      ]),
      openConversation,
    };

    await view.openSessionConversation('conversation-2');

    expect(openConversation).toHaveBeenCalledWith('conversation-2');
  });

  it('observes the Claudian view width and disconnects the observer on teardown', () => {
    const viewContainerEl = createMockEl();
    viewContainerEl.getBoundingClientRect = jest.fn().mockReturnValue({ width: 640 });
    const observe = jest.fn();
    const disconnect = jest.fn();
    let resizeCallback: ResizeObserverCallback = () => {};
    viewContainerEl.ownerDocument.defaultView.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe = observe;
      disconnect = disconnect;
    };
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      updateSessionSidebarLayout: jest.fn(),
      viewContainerEl,
    });

    view.startSessionSidebarLayoutObserver();

    expect(observe).toHaveBeenCalledWith(viewContainerEl);
    expect(view.updateSessionSidebarLayout).toHaveBeenCalledWith(640);

    resizeCallback([
      { contentRect: { width: 900 } } as ResizeObserverEntry,
    ], {} as ResizeObserver);
    expect(view.updateSessionSidebarLayout).toHaveBeenLastCalledWith(900);

    view.disconnectSessionSidebarLayoutObserver();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

});

describe('ClaudianView runtime tab initialization', () => {
  it('creates one fresh runtime tab when no current tab was persisted', async () => {
    let tabManagerCallbacks: any;
    const createTab = jest.fn().mockResolvedValue({});
    mockTabManagerConstructor.mockReset();
    mockTabManagerConstructor.mockImplementation(
      (_plugin, _containerEl, _view, callbacks) => {
        tabManagerCallbacks = callbacks;
        return {
          createTab,
          discardProvisionalTabs: jest.fn().mockResolvedValue(undefined),
          getAllTabs: jest.fn().mockReturnValue([]),
        };
      },
    );

    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      attachNavRowContentToInputFooter: jest.fn(),
      buildInputFooter: jest.fn(),
      buildNavRowContent: jest.fn().mockReturnValue(createMockEl()),
      containerEl: createMockEl(),
      contentEl: createMockEl(),
      plugin: {
        storage: {
          getTabManagerState: jest.fn().mockResolvedValue(null),
        },
      },
      syncProviderBrandColor: jest.fn(),
      updateInputLocation: jest.fn(),
      updateTabBarVisibility: jest.fn(),
      wireEventHandlers: jest.fn(),
    });

    await view.onOpenImpl();

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(tabManagerCallbacks).not.toHaveProperty('onPersistedStateChanged');
  });
});

describe('ClaudianView current tab persistence', () => {
  it('serializes only the active tab identity without draft state', () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        conversationId: 'conversation-2',
        draftModel: 'ignored-draft-model',
        id: 'tab-2',
      }),
    };

    expect(view.getPersistedCurrentTabState()).toEqual({
      activeTabId: 'tab-2',
      openTabs: [{ conversationId: 'conversation-2', tabId: 'tab-2' }],
    });
  });

  it('restores only the active entry from an older multi-tab snapshot', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    const createTab = jest.fn().mockResolvedValue({});
    view.plugin = {
      storage: {
        getTabManagerState: jest.fn().mockResolvedValue({
          activeTabId: 'tab-2',
          openTabs: [
            { conversationId: 'conversation-1', tabId: 'tab-1' },
            { conversationId: 'conversation-2', tabId: 'tab-2' },
          ],
        }),
      },
    };
    view.tabManager = { createTab };

    await view.restoreCurrentTab();

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith('conversation-2', 'tab-2');
  });

  it('restores an unbound current tab as empty and ignores its legacy draft', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    const createTab = jest.fn().mockResolvedValue({});
    view.plugin = {
      storage: {
        getTabManagerState: jest.fn().mockResolvedValue({
          activeTabId: 'tab-1',
          openTabs: [{
            conversationId: null,
            draftModel: 'do-not-restore',
            tabId: 'tab-1',
          }],
        }),
      },
    };
    view.tabManager = { createTab };

    await view.restoreCurrentTab();

    expect(createTab).toHaveBeenCalledWith(null, 'tab-1');
  });
});

describe('ClaudianView composer input', () => {
  function createComposerHarness(existingContent: string): {
    inputEl: HTMLTextAreaElement;
    inputHandler: jest.Mock;
    view: any;
  } {
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    const inputHandler = jest.fn();
    inputEl.value = existingContent;
    inputEl.selectionStart = 0;
    inputEl.selectionEnd = 0;
    inputEl.focus = jest.fn();
    inputEl.addEventListener('input', inputHandler);

    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({ dom: { inputEl } }),
    };

    return { inputEl, inputHandler, view };
  }

  it('focuses the active composer', () => {
    const { inputEl, view } = createComposerHarness('');

    view.focusActiveInput();

    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('appends text after existing composer content', () => {
    const { inputEl, inputHandler, view } = createComposerHarness('Review this note');

    const appended = view.appendToActiveInput('@projects/plan.md ');

    expect(appended).toBe(true);
    expect(inputEl.value).toBe('Review this note @projects/plan.md ');
    expect(inputEl.selectionStart).toBe(inputEl.value.length);
    expect(inputEl.selectionEnd).toBe(inputEl.value.length);
    expect(inputHandler).toHaveBeenCalledTimes(1);
    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('does not add another separator when existing content ends in whitespace', () => {
    const { inputEl, view } = createComposerHarness('Review this note\n');

    view.appendToActiveInput('@projects/plan.md ');

    expect(inputEl.value).toBe('Review this note\n@projects/plan.md ');
  });

  it('returns false when there is no active composer', () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    expect(view.appendToActiveInput('@projects/plan.md ')).toBe(false);
  });
});

describe('ClaudianView shutdown', () => {
  it('flushes the current tab identity before disposing view resources', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    const destroy = jest.fn().mockResolvedValue(undefined);
    const disposePersistence = jest.fn();
    const flushPersistence = jest.fn().mockResolvedValue(undefined);
    const updatePersistence = jest.fn();
    const tabBarDestroy = jest.fn();

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: tabBarDestroy },
      tabManager: {
        destroy,
        getActiveTab: jest.fn().mockReturnValue({
          conversationId: 'conversation-1',
          id: 'tab-1',
        }),
      },
      tabStatePersistence: {
        dispose: disposePersistence,
        flush: flushPersistence,
        update: updatePersistence,
      },
    });

    await expect(view.onClose()).resolves.toBeUndefined();

    expect(view.restoreActiveInputToTabContent).toHaveBeenCalledTimes(1);
    expect(updatePersistence).toHaveBeenCalledWith({
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: 'conversation-1', tabId: 'tab-1' }],
    });
    expect(flushPersistence).toHaveBeenCalledTimes(1);
    expect(disposePersistence).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(tabBarDestroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
    expect(view.scope).toBeNull();
  });

  it('still disposes view resources when the current-tab flush fails', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    const destroy = jest.fn().mockResolvedValue(undefined);
    const disposePersistence = jest.fn();

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: jest.fn() },
      tabManager: {
        destroy,
        getActiveTab: jest.fn().mockReturnValue({
          conversationId: null,
          id: 'tab-1',
        }),
      },
      tabStatePersistence: {
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
});

describe('ClaudianView Escape handling', () => {
  beforeEach(() => {
    MockScope.instances.length = 0;
  });

  function createEscapeHarness(options: {
    isStreaming: boolean;
  }): {
    cancelStreaming: jest.Mock;
    eventRefs: unknown[];
    view: any;
  } {
    const cancelStreaming = jest.fn();
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(ClaudianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: options.isStreaming },
        controllers: {
          inputController: { cancelStreaming },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { cancelStreaming, eventRefs, view };
  }

  function createScopedSendHarness(options: {
    inputFocused: boolean;
  }): {
    inputEl: HTMLTextAreaElement;
    sendMessage: jest.Mock;
    view: any;
  } {
    const sendMessage = jest.fn();
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    Object.defineProperty(inputEl.ownerDocument, 'activeElement', {
      configurable: true,
      get: () => options.inputFocused ? inputEl : null,
    });
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(ClaudianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: false },
        dom: { inputEl },
        controllers: {
          inputController: { sendMessage },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { inputEl, sendMessage, view };
  }

  it('registers Escape on the Obsidian view scope instead of document keydown capture', () => {
    const { view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();

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
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('consumes scoped Escape without cancelling when not streaming', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: false });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('consumes already handled scoped Escape without cancelling again', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({
      key: 'Escape',
      isComposing: false,
      defaultPrevented: true,
    } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('commits a provisional preview before the Shift+Tab plan-mode action', () => {
    const { view } = createEscapeHarness({ isStreaming: false });
    const activeTab = {
      conversationId: null,
      lifecycleState: 'provisional',
      providerId: 'claude',
      state: { prePlanPermissionMode: null },
    };
    view.tabManager.getActiveTab.mockReturnValue(activeTab);
    view.plugin.settings = {};
    jest.spyOn(ProviderRegistry, 'getCapabilities').mockReturnValue({
      providerId: 'claude',
      supportsPlanMode: true,
    } as any);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockReturnValue({ permissionMode: 'normal' } as any);

    view.wireEventHandlers();
    const keydownHandler = view.registerDomEvent.mock.calls.find(
      ([target, event]: [unknown, string]) => target === view.containerEl && event === 'keydown',
    )?.[2] as (event: KeyboardEvent) => void;
    keydownHandler({
      isComposing: false,
      key: 'Tab',
      preventDefault: jest.fn(),
      shiftKey: true,
    } as unknown as KeyboardEvent);

    expect(activeTab.lifecycleState).toBe('cold');
  });

  it('sends from focused composer through scoped Mod+Enter', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: true });

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

    expect(event.preventDefault).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('ignores scoped Mod+Enter when composer is not focused', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: false });

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

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
