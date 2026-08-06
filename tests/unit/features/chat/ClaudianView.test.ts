import { createMockEl } from '@test/helpers/MockElement';
import { Menu, Notice, Platform, Scope, setIcon, TFile } from 'obsidian';

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

  it('reveals an open linked note and creates a provisional note chat', async () => {
    const note = Object.assign(new TFile(), {
      basename: 'Plan',
      extension: 'md',
      name: 'Plan.md',
      path: 'Projects/Plan.md',
    });
    const existingLeaf = { view: { file: note } };
    const previousDraftHandleFileOpen = jest.fn();
    const linkedDraftHandleFileOpen = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    const revealLeaf = jest.fn().mockImplementation(async () => {
      view.handleWorkspaceFileOpen(note);
    });
    const getLeaf = jest.fn();
    const resetForNewConversation = jest.fn();
    const setCurrentNote = jest.fn();
    const focus = jest.fn();
    let activeTabId = 'initial-tab';
    const createTab = jest.fn().mockImplementation(async () => {
      activeTabId = 'linked-note-tab';
      return {
        id: 'linked-note-tab',
        dom: { inputEl: { focus } },
        ui: {
          fileContextManager: {
            handleFileOpen: linkedDraftHandleFileOpen,
            resetForNewConversation,
            setCurrentNote,
          },
        },
      };
    });
    Object.assign(view, {
      isArchiveSessionView: false,
      linkedNoteNavigationDepth: 0,
      plugin: {
        app: {
          vault: { getAbstractFileByPath: jest.fn().mockReturnValue(note) },
          workspace: {
            getLeaf,
            getLeavesOfType: jest.fn().mockReturnValue([existingLeaf]),
            revealLeaf,
          },
        },
      },
      tabManager: {
        closeTab: jest.fn().mockResolvedValue(true),
        createTab,
        getActiveTabId: jest.fn(() => activeTabId),
        getTabSwitchRequestRevision: jest.fn().mockReturnValue(0),
        getActiveTab: jest.fn().mockReturnValue({
          ui: {
            fileContextManager: {
              handleFileOpen: previousDraftHandleFileOpen,
            },
          },
        }),
        waitForTabSwitchIdle: jest.fn().mockResolvedValue(undefined),
      },
      updateTabBarVisibility: jest.fn(),
    });

    await view.startLinkedNoteConversation(note.path);

    expect(revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(getLeaf).not.toHaveBeenCalled();
    expect(previousDraftHandleFileOpen).not.toHaveBeenCalled();
    expect(linkedDraftHandleFileOpen).not.toHaveBeenCalled();
    expect(revealLeaf.mock.invocationCallOrder[0])
      .toBeLessThan(createTab.mock.invocationCallOrder[0]);
    expect(createTab).toHaveBeenCalledWith(null, undefined, {
      activate: true,
      lifecycleState: 'provisional',
    });
    expect(resetForNewConversation).toHaveBeenCalledTimes(1);
    expect(setCurrentNote).toHaveBeenCalledWith(note.path);
    expect(resetForNewConversation.mock.invocationCallOrder[0])
      .toBeLessThan(setCurrentNote.mock.invocationCallOrder[0]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('opens a closed linked note in a new workspace tab before creating chat', async () => {
    const note = Object.assign(new TFile(), {
      basename: 'Plan',
      extension: 'md',
      name: 'Plan.md',
      path: 'Projects/Plan.md',
    });
    const noteLeaf = { openFile: jest.fn().mockResolvedValue(undefined), view: {} };
    const revealLeaf = jest.fn().mockResolvedValue(undefined);
    const resetForNewConversation = jest.fn();
    const setCurrentNote = jest.fn();
    let activeTabId = 'initial-tab';
    const createTab = jest.fn().mockImplementation(async () => {
      activeTabId = 'linked-note-tab';
      return {
        id: 'linked-note-tab',
        dom: { inputEl: { focus: jest.fn() } },
        ui: { fileContextManager: { resetForNewConversation, setCurrentNote } },
      };
    });
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      isArchiveSessionView: false,
      plugin: {
        app: {
          vault: { getAbstractFileByPath: jest.fn().mockReturnValue(note) },
          workspace: {
            getLeaf: jest.fn().mockReturnValue(noteLeaf),
            getLeavesOfType: jest.fn().mockReturnValue([]),
            revealLeaf,
          },
        },
      },
      tabManager: {
        createTab,
        getActiveTabId: jest.fn(() => activeTabId),
        getTabSwitchRequestRevision: jest.fn().mockReturnValue(0),
        waitForTabSwitchIdle: jest.fn().mockResolvedValue(undefined),
      },
      updateTabBarVisibility: jest.fn(),
    });

    await view.startLinkedNoteConversation(note.path);

    expect(view.plugin.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(noteLeaf.openFile).toHaveBeenCalledWith(note);
    expect(revealLeaf).toHaveBeenCalledWith(noteLeaf);
    expect(createTab).toHaveBeenCalledWith(null, undefined, {
      activate: true,
      lifecycleState: 'provisional',
    });
    expect(resetForNewConversation).toHaveBeenCalledTimes(1);
    expect(setCurrentNote).toHaveBeenCalledWith(note.path);
  });

  it('does not steal chat focus after a user switches tabs during note navigation', async () => {
    const note = Object.assign(new TFile(), {
      basename: 'Plan',
      extension: 'md',
      name: 'Plan.md',
      path: 'Projects/Plan.md',
    });
    let resolveReveal!: () => void;
    const revealLeaf = jest.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveReveal = resolve;
    }));
    const focus = jest.fn();
    const resetForNewConversation = jest.fn();
    const setCurrentNote = jest.fn();
    const createTab = jest.fn().mockResolvedValue({
      id: 'linked-note-tab',
      dom: { inputEl: { focus } },
      ui: { fileContextManager: { resetForNewConversation, setCurrentNote } },
    });
    const activeTabId = 'initial-tab';
    let tabSwitchRequestRevision = 0;
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      isArchiveSessionView: false,
      linkedNoteNavigationDepth: 0,
      plugin: {
        app: {
          vault: { getAbstractFileByPath: jest.fn().mockReturnValue(note) },
          workspace: {
            getLeaf: jest.fn(),
            getLeavesOfType: jest.fn().mockReturnValue([{ view: { file: note } }]),
            revealLeaf,
          },
        },
      },
      tabManager: {
        closeTab: jest.fn().mockResolvedValue(true),
        createTab,
        getActiveTabId: jest.fn(() => activeTabId),
        getTabSwitchRequestRevision: jest.fn(() => tabSwitchRequestRevision),
        waitForTabSwitchIdle: jest.fn().mockResolvedValue(undefined),
      },
      updateTabBarVisibility: jest.fn(),
    });

    const startLinkedChat = view.startLinkedNoteConversation(note.path);
    await Promise.resolve();
    tabSwitchRequestRevision += 1;
    resolveReveal();
    await startLinkedChat;

    expect(createTab).toHaveBeenCalledWith(null, undefined, {
      activate: false,
      lifecycleState: 'provisional',
    });
    expect(resetForNewConversation).toHaveBeenCalledTimes(1);
    expect(setCurrentNote).toHaveBeenCalledWith(note.path);
    expect(focus).not.toHaveBeenCalled();
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

  it('renders New, Search, and Archive navigation above the Sessions header', () => {
    const container = createMockEl();
    const list = container.createDiv({ cls: 'claudian-history-list' });
    const header = list.createDiv({
      cls: 'claudian-history-header claudian-session-list-header',
    });
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      plugin: { settings: {} },
      activateSessionSearch: jest.fn(),
      isArchiveSessionView: false,
      requestDualNew: jest.fn(),
      tabManager: {
        canCreateTab: jest.fn().mockReturnValue(true),
        getAllTabs: jest.fn().mockReturnValue([]),
      },
    });

    view.buildSessionHeaderActions(container);

    const actions = header.querySelector('.claudian-session-header-actions');
    const optionsButton = actions?.children[0];
    const newButton = container.querySelector('.claudian-session-new-control');
    const searchButton = container.querySelector('.claudian-session-search-control');
    const archiveButton = container.querySelector('.claudian-session-archive-control');
    expect(actions?.children).toHaveLength(1);
    expect(optionsButton?.getAttribute('aria-label')).toBe('Session options');
    expect(newButton?.tagName).toBe('DIV');
    expect(newButton?.getAttribute('role')).toBe('button');
    expect(newButton?.getAttribute('tabindex')).toBe('0');
    expect(newButton?.getAttribute('aria-label')).toBe('New');
    expect(newButton?.querySelector('.claudian-session-new-label')?.textContent).toBe('New');
    expect(setIcon).toHaveBeenCalledWith(
      newButton?.querySelector('.claudian-session-new-icon'),
      'square-pen',
    );
    expect(searchButton?.getAttribute('aria-label')).toBe('Search');
    expect(searchButton?.querySelector('.claudian-session-nav-label')?.textContent)
      .toBe('Search');
    expect(archiveButton?.getAttribute('aria-label')).toBe('Archive');
    expect(container.querySelector('.claudian-history-list')).toBe(list);

    newButton?.click();
    expect(view.requestDualNew).toHaveBeenCalledTimes(1);
    searchButton?.click();
    expect(view.activateSessionSearch).toHaveBeenCalledTimes(1);
  });

  it('switches between active and archived session manager views', () => {
    const createContainer = () => {
      const container = createMockEl();
      const list = container.createDiv({ cls: 'claudian-history-list' });
      list.createDiv({
        cls: 'claudian-history-header claudian-session-list-header',
      });
      return container;
    };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      isArchiveSessionView: false,
      isWideSessionLayout: true,
      plugin: { settings: {} },
      renderSessionSidebar: jest.fn(),
      requestDualNew: jest.fn(),
      tabManager: {
        canCreateTab: jest.fn().mockReturnValue(true),
        getAllTabs: jest.fn().mockReturnValue([]),
      },
    });

    const activeContainer = createContainer();
    view.buildSessionHeaderActions(activeContainer);
    const archiveControl = activeContainer.querySelector('.claudian-session-archive-control')!;
    expect(archiveControl.querySelector('.claudian-session-nav-label')?.textContent)
      .toBe('Archive');

    archiveControl.click();

    expect(view.isArchiveSessionView).toBe(true);
    expect(view.renderSessionSidebar).toHaveBeenCalledTimes(1);

    const archiveContainer = createContainer();
    view.buildSessionHeaderActions(archiveContainer);
    const sessionsControl = archiveContainer.querySelector('.claudian-session-archive-control')!;
    expect(sessionsControl.querySelector('.claudian-session-nav-label')?.textContent)
      .toBe('Sessions');

    sessionsControl.click();

    expect(view.isArchiveSessionView).toBe(false);
    expect(view.renderSessionSidebar).toHaveBeenCalledTimes(2);
  });

  it('renders an inline search field and routes query and close interactions', () => {
    const container = createMockEl();
    const list = container.createDiv({ cls: 'claudian-history-list' });
    list.createDiv({
      cls: 'claudian-history-header claudian-session-list-header',
    });
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      closeSessionSearch: jest.fn(),
      isArchiveSessionView: false,
      isSessionSearchActive: true,
      plugin: { settings: {} },
      sessionSearchQuery: 'roadmap',
      tabManager: {
        canCreateTab: jest.fn().mockReturnValue(true),
        getAllTabs: jest.fn().mockReturnValue([]),
      },
      updateSessionSearchQuery: jest.fn(),
    });

    view.buildSessionHeaderActions(container);

    const input = container.querySelector('.claudian-session-search-input')!;
    expect(input.value).toBe('roadmap');
    expect(input.getAttribute('placeholder')).toBe('Search sessions');
    expect(container.querySelector('.claudian-session-search-close')).toBeNull();
    input.value = 'roadmap review';
    input.dispatchEvent('input');
    expect(view.updateSessionSearchQuery).toHaveBeenCalledWith('roadmap review');

    view.updateSessionSearchQuery.mockClear();
    input.dispatchEvent('compositionstart');
    input.value = '项目计划';
    input.dispatchEvent({ type: 'input', isComposing: true });
    expect(view.updateSessionSearchQuery).not.toHaveBeenCalled();
    const composingEscape = {
      type: 'keydown',
      key: 'Escape',
      isComposing: true,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    input.dispatchEvent(composingEscape);
    expect(view.closeSessionSearch).not.toHaveBeenCalled();
    expect(composingEscape.preventDefault).not.toHaveBeenCalled();
    expect(composingEscape.stopPropagation).toHaveBeenCalledTimes(1);
    input.dispatchEvent('compositionend');
    expect(view.updateSessionSearchQuery).toHaveBeenCalledWith('项目计划');
    input.dispatchEvent({ type: 'input', isComposing: false });
    expect(view.updateSessionSearchQuery).toHaveBeenCalledTimes(1);

    input.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      isComposing: false,
      preventDefault: jest.fn(),
    });
    expect(view.closeSessionSearch).toHaveBeenCalledTimes(1);
  });

  it('restores session and pinned scroll positions after search', () => {
    const sessionSidebarEl = createMockEl();
    const list = sessionSidebarEl.createDiv({ cls: 'claudian-history-list' });
    const pinnedSection = list.createDiv({ cls: 'claudian-history-section--pinned' });
    const pinnedList = pinnedSection.createDiv({ cls: 'claudian-history-section-items' });
    const sessionList = list.createDiv({ cls: 'claudian-session-list-items' });
    pinnedList.scrollTop = 40;
    sessionList.scrollTop = 160;
    const view = Object.create(ClaudianView.prototype) as any;
    view.sessionSidebarEl = sessionSidebarEl;

    view.sessionSearchRestoreState = view.captureSessionSearchScrollState();
    pinnedList.scrollTop = 0;
    sessionList.scrollTop = 0;
    view.restoreSessionSearchScrollState();

    expect(pinnedList.scrollTop).toBe(40);
    expect(sessionList.scrollTop).toBe(160);
  });

  it('dismisses search after outside pointer and keyboard focus interactions', async () => {
    const container = createMockEl();
    const list = container.createDiv({ cls: 'claudian-history-list' });
    list.createDiv({
      cls: 'claudian-history-header claudian-session-list-header',
    });
    const documentListeners = new Map<string, (event: Event) => void>();
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      closeSessionSearch: jest.fn(),
      isArchiveSessionView: false,
      isSessionSearchActive: true,
      plugin: { settings: {} },
      sessionSearchQuery: '',
      tabManager: {
        canCreateTab: jest.fn().mockReturnValue(true),
        getAllTabs: jest.fn().mockReturnValue([]),
      },
    });

    view.buildSessionHeaderActions(container);
    const input = container.querySelector('.claudian-session-search-input')!;
    input.ownerDocument.addEventListener = jest.fn((type, listener) => {
      documentListeners.set(type, listener as (event: Event) => void);
    });
    input.ownerDocument.removeEventListener = jest.fn();
    input.ownerDocument.defaultView.addEventListener = jest.fn();
    input.ownerDocument.defaultView.removeEventListener = jest.fn();
    view.scheduleSessionSearchDismissHandlers();
    await Promise.resolve();

    const outsideTarget = container.querySelector('.claudian-history-list')!;
    documentListeners.get('pointerdown')?.({ target: outsideTarget } as unknown as Event);
    documentListeners.get('focusin')?.({ target: outsideTarget } as unknown as Event);
    expect(view.closeSessionSearch).not.toHaveBeenCalled();

    documentListeners.get('click')?.({ target: outsideTarget } as unknown as Event);
    expect(view.closeSessionSearch).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(view.closeSessionSearch).toHaveBeenCalledTimes(1);

    view.closeSessionSearch.mockClear();
    documentListeners.get('keydown')?.({ target: outsideTarget } as unknown as Event);
    documentListeners.get('focusin')?.({ target: outsideTarget } as unknown as Event);
    expect(view.closeSessionSearch).toHaveBeenCalledTimes(1);
  });

  it('keeps archive navigation at the top of the single-mode history list', () => {
    const container = createMockEl();
    const list = container.createDiv({ cls: 'claudian-history-list' });
    list.createDiv({ cls: 'claudian-history-item' });
    const setArchiveSessionView = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      isArchiveSessionView: false,
      setArchiveSessionView,
    });

    view.buildHistoryArchiveNavigation(container);

    const archiveControl = list.querySelector('.claudian-history-archive-control')!;
    expect(list.children[0]).toBe(archiveControl);
    expect(archiveControl.querySelector('.claudian-session-nav-label')?.textContent)
      .toBe('Archive');
    const stopPropagation = jest.fn();
    archiveControl.dispatchEvent({
      type: 'click',
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(setArchiveSessionView).toHaveBeenCalledWith(true);
  });

  it('keeps tab-aware navigation on the single-mode history surface', () => {
    const container = createMockEl();
    const renderHistoryDropdown = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      isArchiveSessionView: false,
      openHistoryConversation: jest.fn(),
      openHistoryConversationInNewTab: jest.fn(),
      getHistoryConversationStatus: jest.fn(),
      setConversationPinned: jest.fn(),
      setConversationArchived: jest.fn(),
      updateHistoryDropdown: jest.fn(),
      buildHistoryArchiveNavigation: jest.fn(),
      tabManager: {
        getActiveTab: jest.fn().mockReturnValue({
          controllers: { conversationController: { renderHistoryDropdown } },
        }),
      },
    });

    view.renderHistorySurface(container, new AbortController().signal);

    const options = renderHistoryDropdown.mock.calls[0]?.[1];
    expect(options.showOpenStateLabels).toBe(true);
    expect(options.showOpenStateActions).toBe(true);
    expect(options.onOpenConversationInNewTab).toEqual(expect.any(Function));
    expect(options.onBeforeRestoreListState).toEqual(expect.any(Function));
    expect(options).not.toHaveProperty('organization');
    expect(options).not.toHaveProperty('showMetadataPopover');
  });

  it('collapses and expands every linked-note group from the session header', () => {
    const container = createMockEl();
    const list = container.createDiv({ cls: 'claudian-history-list' });
    list.createDiv({
      cls: 'claudian-history-header claudian-session-list-header',
    });
    const view = Object.create(ClaudianView.prototype) as any;
    const renderSessionSidebar = jest.fn();
    Object.assign(view, {
      collapsedSessionGroupKeys: new Set<string>(),
      plugin: {
        settings: { sessionManagerOrganization: 'linked-note' },
        getAllViews: jest.fn().mockReturnValue([]),
      },
      renderSessionSidebar,
      requestDualNew: jest.fn(),
      sessionGroupKeys: new Set(['note:Projects/Plan.md', 'ungrouped']),
      sessionSidebarDirty: false,
      tabManager: {
        canCreateTab: jest.fn().mockReturnValue(true),
        getAllTabs: jest.fn().mockReturnValue([]),
      },
    });

    view.buildSessionHeaderActions(container);

    const actions = container.querySelector('.claudian-session-header-actions')!;
    expect(actions.children).toHaveLength(2);
    const collapseButton = actions.children[0];
    const collapseIcon = collapseButton.querySelector('.claudian-session-header-icon')!;
    expect(collapseButton.getAttribute('aria-label')).toBe('Collapse all groups');
    expect(collapseIcon.dataset.iconState).toBe('collapse');
    expect(collapseIcon.children[0]?.tagName).toBe('SVG');

    view.collapsedSessionGroupKeys = new Set([
      'note:Projects/Plan.md',
      'ungrouped',
    ]);
    view.updateSessionGroupToggleButton();

    expect(collapseButton.getAttribute('aria-label')).toBe('Expand all groups');
    expect(collapseIcon.dataset.iconState).toBe('expand');

    view.collapsedSessionGroupKeys.clear();

    collapseButton.click();

    expect(view.collapsedSessionGroupKeys).toEqual(
      new Set(['note:Projects/Plan.md', 'ungrouped']),
    );
    expect(view.sessionSidebarDirty).toBe(true);
    expect(renderSessionSidebar).toHaveBeenCalledTimes(1);

    const collapsedContainer = createMockEl();
    const collapsedList = collapsedContainer.createDiv({ cls: 'claudian-history-list' });
    collapsedList.createDiv({
      cls: 'claudian-history-header claudian-session-list-header',
    });
    view.buildSessionHeaderActions(collapsedContainer);
    const expandButton = collapsedContainer
      .querySelector('.claudian-session-header-actions')!.children[0];
    expect(expandButton.getAttribute('aria-label')).toBe('Expand all groups');
    expect(expandButton.querySelector('.claudian-session-header-icon')?.dataset.iconState)
      .toBe('expand');

    view.toggleAllSessionGroups();
    expect(view.collapsedSessionGroupKeys).toEqual(new Set());
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

  it('starts an approved plan in a fresh dual-mode runtime tab', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const targetTab = {
      controllers: { inputController: { sendMessage } },
    };
    const view = Object.create(ClaudianView.prototype) as any;
    view.isWideSessionLayout = true;
    view.createNewTab = jest.fn().mockResolvedValue(undefined);
    view.tabManager = { getActiveTab: jest.fn().mockReturnValue(targetTab) };

    await expect(view.handleNewSessionPlan('Implement the plan')).resolves.toBe(true);

    expect(view.createNewTab).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ content: 'Implement the plan' });
  });

  it('leaves approved-plan session replacement unchanged in single mode', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.isWideSessionLayout = false;
    view.createNewTab = jest.fn().mockResolvedValue(undefined);

    await expect(view.handleNewSessionPlan('Implement the plan')).resolves.toBe(false);

    expect(view.createNewTab).not.toHaveBeenCalled();
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

  it('switches the single-mode history menu between Sessions and Archived', () => {
    const historyDropdown = createMockEl();
    historyDropdown.addClass('visible');
    const renderHistoryDropdown = jest.fn((container, _options?: unknown) => {
      container.empty();
      container.createDiv({ cls: 'claudian-history-header' });
      container.createDiv({ cls: 'claudian-history-list' });
      (_options as { onBeforeRestoreListState?: (target: HTMLElement) => void })
        ?.onBeforeRestoreListState?.(container);
    });
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      historyDropdown,
      historyDropdownDirty: true,
      historySurfaceRendered: true,
      isArchiveSessionView: false,
      isWideSessionLayout: false,
      plugin: {},
      tabManager: {
        getActiveTab: jest.fn().mockReturnValue({
          controllers: { conversationController: { renderHistoryDropdown } },
        }),
      },
    });

    view.renderHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenLastCalledWith(
      historyDropdown,
      expect.objectContaining({
        preserveListState: true,
        sessionScope: 'active',
        sessionActionMode: 'active',
        allowConversationSelection: true,
        onOpenConversationInNewTab: expect.any(Function),
        onBeforeRestoreListState: expect.any(Function),
      }),
    );
    historyDropdown.querySelector('.claudian-history-archive-control')!.click();

    expect(view.isArchiveSessionView).toBe(true);
    expect(renderHistoryDropdown).toHaveBeenLastCalledWith(
      historyDropdown,
      expect.objectContaining({
        preserveListState: true,
        sessionScope: 'archived',
        sessionActionMode: 'archived',
        allowConversationSelection: false,
      }),
    );
    expect(renderHistoryDropdown.mock.calls.at(-1)?.[1])
      .not.toHaveProperty('onOpenConversationInNewTab');
    expect(historyDropdown.querySelector('.claudian-session-nav-label')?.textContent)
      .toBe('Sessions');
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
    expect(viewContainerEl.children[2].getAttribute('aria-label')).toBeNull();
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

  it('keeps the single-panel layout when dual-pane mode is disabled', () => {
    const viewContainerEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      isWideSessionLayout: false,
      plugin: { settings: { enableDualPane: false, dualPaneSide: 'right' } },
      renderSessionSidebar: jest.fn(),
      requestedWideSessionLayout: false,
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(900);

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(false);
    expect(view.isWideSessionLayout).toBe(false);
    expect(view.renderSessionSidebar).not.toHaveBeenCalled();
  });

  it('attaches the persistent session column to the configured left side', () => {
    const viewContainerEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      historyDropdown: createMockEl(),
      isWideSessionLayout: false,
      plugin: { settings: { enableDualPane: true, dualPaneSide: 'left' } },
      renderSessionSidebar: jest.fn(),
      requestedWideSessionLayout: false,
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(900);

    expect(viewContainerEl.hasClass('claudian-session-sidebar-left')).toBe(true);
    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(true);
  });

  it('keeps dual-mode controls in place until provisional cleanup finishes', async () => {
    const viewContainerEl = createMockEl();
    viewContainerEl.addClass('claudian-wide-session-layout');
    const view = Object.create(ClaudianView.prototype) as any;
    let finishDiscard!: () => void;
    const discardProvisionalTabs = jest.fn().mockReturnValue(new Promise<void>((resolve) => {
      finishDiscard = resolve;
    }));

    Object.assign(view, {
      cancelSessionSidebarRendering: jest.fn(),
      isSessionSearchActive: true,
      isSessionSearchComposing: false,
      sessionSearchQuery: 'roadmap',
      isWideSessionLayout: true,
      requestedWideSessionLayout: true,
      sessionLayoutRequestRevision: 0,
      plugin: { getConversationSync: jest.fn() },
      tabManager: {
        discardProvisionalTabs,
        getAllTabs: jest.fn().mockReturnValue([]),
      },
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(599);

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(view.isWideSessionLayout).toBe(true);
    expect(view.isSessionSearchActive).toBe(false);
    expect(view.sessionSearchQuery).toBe('');
    expect(view.cancelSessionSidebarRendering).toHaveBeenCalledTimes(1);
    expect(discardProvisionalTabs).toHaveBeenCalledTimes(1);

    finishDiscard();
    await view.pendingSessionLayoutTransition;

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(false);
    expect(view.isWideSessionLayout).toBe(false);
  });

  it('cancels a pending compact transition when the view becomes wide again', async () => {
    const viewContainerEl = createMockEl();
    viewContainerEl.addClass('claudian-wide-session-layout');
    let finishDiscard!: () => void;
    const discardProvisionalTabs = jest.fn().mockReturnValue(new Promise<void>((resolve) => {
      finishDiscard = resolve;
    }));
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      cancelSessionSidebarRendering: jest.fn(),
      isWideSessionLayout: true,
      plugin: { getConversationSync: jest.fn() },
      renderSessionSidebar: jest.fn(),
      requestedWideSessionLayout: true,
      sessionLayoutRequestRevision: 0,
      sessionSidebarWidth: null,
      tabManager: {
        discardProvisionalTabs,
        getAllTabs: jest.fn().mockReturnValue([]),
      },
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(599);
    const compactTransition = view.pendingSessionLayoutTransition;
    view.updateSessionSidebarLayout(600);
    finishDiscard();
    await compactTransition;

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(view.isWideSessionLayout).toBe(true);
    expect(view.renderSessionSidebar).toHaveBeenCalledTimes(1);
  });

  it('retains pinned provisional sessions when returning to single mode', () => {
    const viewContainerEl = createMockEl();
    viewContainerEl.addClass('claudian-wide-session-layout');
    const view = Object.create(ClaudianView.prototype) as any;
    const pinnedTab = {
      id: 'pinned-tab',
      conversationId: 'pinned-conversation',
      lifecycleState: 'provisional',
    };
    const previewTab = {
      id: 'preview-tab',
      conversationId: 'preview-conversation',
      lifecycleState: 'provisional',
    };
    const discardProvisionalTabs = jest.fn().mockImplementation(async () => {
      expect(pinnedTab.lifecycleState).toBe('cold');
      expect(previewTab.lifecycleState).toBe('provisional');
    });

    Object.assign(view, {
      cancelSessionSidebarRendering: jest.fn(),
      isWideSessionLayout: true,
      plugin: {
        getConversationSync: jest.fn((id: string) => (
          id === 'pinned-conversation' ? { isPinned: true } : { isPinned: false }
        )),
      },
      tabManager: {
        discardProvisionalTabs,
        getAllTabs: jest.fn().mockReturnValue([pinnedTab, previewTab]),
      },
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(599);

    expect(discardProvisionalTabs).toHaveBeenCalledTimes(1);
  });

  it('promotes an open provisional session when it is pinned without opening closed sessions', async () => {
    const openTab = {
      conversationId: 'open-conversation',
      lifecycleState: 'provisional',
    };
    const setConversationPinned = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: { setConversationPinned },
      tabManager: { getAllTabs: jest.fn().mockReturnValue([openTab]) },
    });

    await view.setConversationPinned('open-conversation', true);
    await view.setConversationPinned('open-conversation', false);
    await view.setConversationPinned('closed-conversation', true);

    expect(setConversationPinned).toHaveBeenNthCalledWith(1, 'open-conversation', true);
    expect(setConversationPinned).toHaveBeenNthCalledWith(2, 'open-conversation', false);
    expect(setConversationPinned).toHaveBeenNthCalledWith(3, 'closed-conversation', true);
    expect(openTab.lifecycleState).toBe('cold');
    expect(view.tabManager.getAllTabs).toHaveBeenCalledTimes(2);
  });

  it('closes every open idle container before archiving a session', async () => {
    const localTab = {
      id: 'local-tab',
      conversationId: 'conversation-1',
      state: { isStreaming: false },
    };
    const otherTab = {
      id: 'other-tab',
      conversationId: 'conversation-1',
      state: { isStreaming: false },
    };
    const localManager = {
      closeTab: jest.fn().mockResolvedValue(true),
      getAllTabs: jest.fn().mockReturnValue([localTab]),
    };
    const otherManager = {
      closeTab: jest.fn().mockResolvedValue(true),
      getAllTabs: jest.fn().mockReturnValue([otherTab]),
    };
    const otherView = { getTabManager: jest.fn().mockReturnValue(otherManager) };
    const setConversationArchived = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        getAllViews: jest.fn().mockReturnValue([view, otherView]),
        setConversationArchived,
      },
      tabManager: localManager,
    });
    view.getTabManager = jest.fn().mockReturnValue(localManager);

    await view.setConversationArchived('conversation-1', true);

    expect(localManager.closeTab).toHaveBeenCalledWith('local-tab');
    expect(otherManager.closeTab).toHaveBeenCalledWith('other-tab');
    expect(setConversationArchived).toHaveBeenCalledWith('conversation-1', true);
    expect(localManager.closeTab.mock.invocationCallOrder[0])
      .toBeLessThan(setConversationArchived.mock.invocationCallOrder[0]);
  });

  it('does not archive a running session', async () => {
    const runningTab = {
      id: 'running-tab',
      conversationId: 'conversation-1',
      state: { isStreaming: true },
    };
    const manager = {
      closeTab: jest.fn().mockResolvedValue(true),
      getAllTabs: jest.fn().mockReturnValue([runningTab]),
    };
    const setConversationArchived = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        getAllViews: jest.fn().mockReturnValue([view]),
        setConversationArchived,
      },
      tabManager: manager,
    });
    view.getTabManager = jest.fn().mockReturnValue(manager);

    await view.setConversationArchived('conversation-1', true);

    expect(manager.closeTab).not.toHaveBeenCalled();
    expect(setConversationArchived).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith('Running sessions cannot be archived');
  });

  it('restores an archived session without opening a container', async () => {
    const setConversationArchived = jest.fn().mockResolvedValue(undefined);
    const manager = {
      closeTab: jest.fn(),
      getAllTabs: jest.fn().mockReturnValue([]),
      openConversation: jest.fn(),
    };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: { setConversationArchived },
      tabManager: manager,
    });

    await view.setConversationArchived('conversation-1', false);

    expect(setConversationArchived).toHaveBeenCalledWith('conversation-1', false);
    expect(manager.closeTab).not.toHaveBeenCalled();
    expect(manager.openConversation).not.toHaveBeenCalled();
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
      plugin: {
        app: { vault: {} },
        settings: {},
      },
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

  it('uses the opposite drag direction when the session column is on the left', () => {
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
      plugin: {
        app: { vault: {} },
        settings: { dualPaneSide: 'left' },
      },
      viewContainerEl,
    });

    view.startSessionSidebarResize({
      button: 0,
      clientX: 500,
      currentTarget: { ownerDocument },
      preventDefault: jest.fn(),
    });
    documentListeners.get('pointermove')?.({ clientX: 550 } as unknown as Event);

    expect(viewContainerEl.style.setProperty).toHaveBeenLastCalledWith(
      '--claudian-session-sidebar-width',
      '290px',
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

  it('defers persistent session column refresh while search IME composition is active', () => {
    const view = Object.create(ClaudianView.prototype) as any;
    const sessionSidebarEl = createMockEl();

    Object.assign(view, {
      cancelSessionSidebarRendering: jest.fn(),
      isSessionSearchComposing: true,
      isWideSessionLayout: true,
      renderHistorySurface: jest.fn(),
      sessionSidebarDirty: true,
      sessionSidebarEl,
    });

    view.renderSessionSidebar();

    expect(view.renderHistorySurface).not.toHaveBeenCalled();
    expect(view.sessionSidebarDirty).toBe(true);
  });

  it('renders the existing history content into the persistent session column', () => {
    const sessionSidebarEl = createMockEl();
    const previousList = sessionSidebarEl.createDiv({ cls: 'claudian-history-list' });
    const renderHistoryDropdown = jest.fn((container, _options) => {
      expect(container.querySelector('.claudian-history-list')).toBe(previousList);
    });
    const updateHistoryDropdown = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      cancelSessionSidebarRendering: jest.fn(),
      historySurfaceRendered: true,
      isArchiveSessionView: false,
      isSessionSearchActive: true,
      isWideSessionLayout: true,
      sessionSearchQuery: 'roadmap',
      sessionSidebarDirty: true,
      sessionSidebarEl,
      updateHistoryDropdown,
      plugin: {
        app: { vault: {} },
        settings: {},
      },
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
        collapsedGroupKeys: expect.any(Set),
        onGroupCollapseChange: expect.any(Function),
        onSetConversationsArchived: expect.any(Function),
        onSetLinkedNotePinned: expect.any(Function),
        onStartLinkedNoteConversation: expect.any(Function),
        getProviderIcon: expect.any(Function),
        getModelLabel: expect.any(Function),
        onRerender: expect.any(Function),
        onSelectConversation: expect.any(Function),
        preserveListState: true,
        searchQuery: 'roadmap',
        showAttentionState: true,
        showOpenStateActions: false,
        showOpenStateLabels: false,
        showMetadataPopover: true,
        showPinnedSection: true,
        pinnedLinkedNotePaths: expect.any(Set),
        showArchivedSection: false,
        sessionScope: 'active',
        sessionActionMode: 'active',
        allowConversationSelection: true,
        onSetConversationPinned: expect.any(Function),
        onSetConversationArchived: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(renderHistoryDropdown.mock.calls[0][1])
      .not.toHaveProperty('onOpenConversationInNewTab');
    expect(view.sessionSidebarDirty).toBe(false);

    const sessionOptions = renderHistoryDropdown.mock.calls[0][1];
    const historicalProviderConversation = {
      id: 'historical-provider-conversation',
      providerId: 'removed-provider',
      selectedModel: 'removed-provider/opaque-model',
    };
    expect(sessionOptions.getProviderIcon(historicalProviderConversation)).toBeUndefined();
    expect(sessionOptions.getModelLabel(historicalProviderConversation))
      .toBe('removed-provider/opaque-model');
    sessionOptions.onGroupCollapseChange('note:Projects/Plan.md', true);
    expect(sessionOptions.collapsedGroupKeys.has('note:Projects/Plan.md')).toBe(true);

    renderHistoryDropdown.mock.calls[0][1].onRerender();
    expect(updateHistoryDropdown).toHaveBeenCalledTimes(1);

    view.isArchiveSessionView = true;
    view.sessionSidebarDirty = true;
    view.renderSessionSidebar();

    expect(renderHistoryDropdown).toHaveBeenLastCalledWith(
      sessionSidebarEl,
      expect.objectContaining({
        organization: 'list',
        sort: 'last-updated',
        showAttentionState: false,
        showPinnedSection: false,
        showArchivedSection: true,
        sessionScope: 'archived',
        sessionActionMode: 'archived',
        allowConversationSelection: false,
        collapsedGroupKeys: expect.any(Set),
      }),
    );
  });

  it('projects local and cross-view runtime attention into session status', () => {
    const activeTab = {
      conversationId: 'active',
      id: 'tab-active',
      state: {
        attention: { kind: 'action-required', since: 20 },
        isStreaming: true,
      },
    };
    const localTab = {
      conversationId: 'local',
      id: 'tab-local',
      state: {
        attention: { kind: 'review', since: 10 },
        isStreaming: false,
      },
    };
    const crossViewTab = {
      state: {
        attention: { kind: 'review', since: 5 },
        isStreaming: false,
      },
    };
    const otherView = {
      getTabManager: () => ({ getTab: () => crossViewTab }),
    };
    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: () => activeTab,
      getAllTabs: () => [activeTab, localTab],
    };
    view.plugin = {
      findConversationAcrossViews: (id: string) => id === 'cross'
        ? { tabId: 'tab-cross', view: otherView }
        : null,
    };

    expect(view.getHistoryConversationStatus('active').attention)
      .toEqual({ kind: 'action-required', since: 20 });
    expect(view.getHistoryConversationStatus('local').attention)
      .toEqual({ kind: 'review', since: 10 });
    expect(view.getHistoryConversationStatus('cross').attention)
      .toEqual({ kind: 'review', since: 5 });
    expect(view.getHistoryConversationStatus('closed').attention).toBeUndefined();
  });

  it('notifies other open views when runtime session navigation changes', () => {
    const otherView = { notifyConversationListChanged: jest.fn() };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: { getAllViews: jest.fn().mockReturnValue([view, otherView]) },
      updateHistoryDropdown: jest.fn(),
    });

    view.notifyConversationNavigationChanged();

    expect(view.updateHistoryDropdown).toHaveBeenCalledTimes(1);
    expect(otherView.notifyConversationListChanged).toHaveBeenCalledTimes(1);
  });

  it('persists linked-note pins through the feature host', async () => {
    const setLinkedNotePinned = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: { setLinkedNotePinned },
    });

    await view.setLinkedNotePinned('Projects/Plan.md', true);

    expect(setLinkedNotePinned).toHaveBeenCalledWith('Projects/Plan.md', true);
  });

  it('archives linked-note sessions through the existing guarded archive flow', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.setConversationArchived = jest.fn().mockResolvedValue(undefined);

    await view.archiveConversations(['conversation-1', 'conversation-2']);

    expect(view.setConversationArchived.mock.calls).toEqual([
      ['conversation-1', true],
      ['conversation-2', true],
    ]);
  });

  it('formats persisted model metadata for the session hover card', () => {
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getModelOptions: jest.fn().mockReturnValue([
        { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      ]),
    } as any);
    const view = Object.create(ClaudianView.prototype) as any;
    view.plugin = { settings: {} };

    expect(view.getConversationModelLabel({
      providerId: 'codex',
      selectedModel: 'gpt-5.1-codex',
    })).toBe('GPT-5.1 Codex');
  });

  it('ignores malformed persisted model metadata in the session hover card', () => {
    const getChatUIConfig = jest.spyOn(ProviderRegistry, 'getChatUIConfig');
    getChatUIConfig.mockClear();
    const view = Object.create(ClaudianView.prototype) as any;
    view.plugin = { settings: {} };

    expect(view.getConversationModelLabel({
      providerId: 'claude',
      selectedModel: 42,
    })).toBe('');
    expect(getChatUIConfig).not.toHaveBeenCalled();
  });

  it('adds an organization menu beside New and persists both menu choices', async () => {
    (Menu as typeof Menu & { instances: unknown[] }).instances.length = 0;
    const container = createMockEl();
    const list = container.createDiv({ cls: 'claudian-history-list' });
    list.createDiv({
      cls: 'claudian-history-header claudian-session-list-header',
    });
    const settings = {
      sessionManagerOrganization: 'list',
      sessionManagerSort: 'last-updated',
    };
    const mutateSettings = jest.fn(async (mutation) => mutation(settings));
    const view = Object.create(ClaudianView.prototype) as any;
    const otherView = { notifyConversationListChanged: jest.fn() };
    Object.assign(view, {
      plugin: {
        settings,
        mutateSettings,
        getAllViews: jest.fn().mockReturnValue([view, otherView]),
      },
      requestDualNew: jest.fn(),
      renderSessionSidebar: jest.fn(),
      sessionSidebarDirty: false,
      tabManager: {
        canCreateTab: jest.fn().mockReturnValue(true),
        getAllTabs: jest.fn().mockReturnValue([]),
      },
    });

    view.buildSessionHeaderActions(container);

    const actions = container.querySelector('.claudian-session-header-actions');
    expect(actions?.children).toHaveLength(1);
    const optionsButton = actions?.children[0];
    expect(optionsButton?.getAttribute('aria-label')).toBe('Session options');
    optionsButton?.click();

    const menu = (Menu as typeof Menu & { instances: any[] }).instances.at(-1);
    expect(menu.items.map((item: any) => item.title)).toEqual([
      'Organize sessions',
      'In one list',
      'By linked note',
      'Sort sessions by',
      'Last activity',
      'Created',
    ]);
    expect(menu.items.find((item: any) => item.title === 'In one list').checked).toBe(true);
    expect(menu.items.find((item: any) => item.title === 'Last activity').checked).toBe(true);

    menu.items.find((item: any) => item.title === 'By linked note').clickHandler();
    await Promise.resolve();

    expect(settings.sessionManagerOrganization).toBe('linked-note');
    expect(mutateSettings).toHaveBeenCalledTimes(1);
    expect(view.sessionSidebarDirty).toBe(true);
    expect(view.renderSessionSidebar).toHaveBeenCalledTimes(1);
    expect(otherView.notifyConversationListChanged).toHaveBeenCalledTimes(1);
  });

  it('falls back to last activity when a legacy title sort setting is present', () => {
    (Menu as typeof Menu & { instances: unknown[] }).instances.length = 0;
    const container = createMockEl();
    const list = container.createDiv({ cls: 'claudian-history-list' });
    list.createDiv({
      cls: 'claudian-history-header claudian-session-list-header',
    });
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        settings: { sessionManagerSort: 'title' },
      },
    });

    view.buildSessionHeaderActions(container);
    container.querySelector('.claudian-session-header-actions')?.children[0]?.click();

    const menu = (Menu as typeof Menu & { instances: any[] }).instances.at(-1);
    expect(menu.items.some((item: any) => item.title === 'Title')).toBe(false);
    expect(menu.items.find((item: any) => item.title === 'Last activity').checked).toBe(true);
  });

  it('opens a closed session in a new container from the dual-mode session column', async () => {
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
      getConversationSync: jest.fn().mockReturnValue(null),
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

  it('immediately retains a pinned session opened from the dual-mode session column', async () => {
    const tabs: Array<{ conversationId: string; lifecycleState: string }> = [];
    const openConversation = jest.fn().mockImplementation(async (conversationId: string) => {
      tabs.push({ conversationId, lifecycleState: 'provisional' });
    });
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
      getConversationSync: jest.fn().mockReturnValue({ isPinned: true }),
    };
    view.tabManager = {
      getAllTabs: jest.fn(() => tabs),
      openConversation,
    };

    await view.openSessionConversation('pinned-conversation');

    expect(tabs[0].lifecycleState).toBe('cold');
  });

  it('opens a provisional session even when the former tab limit is reached', async () => {
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      findConversationAcrossViews: jest.fn().mockReturnValue(null),
      getConversationSync: jest.fn().mockReturnValue(null),
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
      getConversationSync: jest.fn().mockReturnValue(null),
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
      notifyConversationNavigationChanged: jest.fn(),
      updateTabBar: jest.fn(),
      updateInputLocation: jest.fn(),
      updateTabBarVisibility: jest.fn(),
      wireEventHandlers: jest.fn(),
    });

    await view.onOpenImpl();

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(tabManagerCallbacks).not.toHaveProperty('onPersistedStateChanged');

    tabManagerCallbacks.onTabAttentionChanged('tab-1', { kind: 'review', since: 1 });

    expect(view.updateTabBar).toHaveBeenCalledTimes(1);
    expect(view.notifyConversationNavigationChanged).toHaveBeenCalledTimes(1);
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

  it('closes session search from the scoped Escape handler', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });
    view.closeSessionSearch = jest.fn();
    view.isSessionSearchActive = true;
    view.isSessionSearchComposing = false;

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(view.closeSessionSearch).toHaveBeenCalledTimes(1);
    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('does not close session search from scoped Escape during IME composition', () => {
    const { view } = createEscapeHarness({ isStreaming: false });
    view.closeSessionSearch = jest.fn();
    view.isSessionSearchActive = true;
    view.isSessionSearchComposing = true;

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(view.closeSessionSearch).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
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
