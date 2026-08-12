import { createMockEl } from '@test/helpers/MockElement';
import { Menu, Notice, Platform, Scope, setIcon, TFile } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { HorizontalWheelGesture } from '@/features/chat/ui/HorizontalWheelGesture';

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

function createOwnershipSession() {
  return {
    claimUserOwnership: jest.fn(),
    userOwnershipRevision: 0,
  };
}

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
    expect(container.querySelector('.claudian-session-files-control')).toBeNull();
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
    const ownerRequestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container.ownerDocument.defaultView.requestAnimationFrame = ownerRequestAnimationFrame;
    const globalRequestAnimationFrame = jest.spyOn(window, 'requestAnimationFrame');
    const renderHistoryDropdown = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      isArchiveSessionView: false,
      historyDropdown: container,
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
    expect(options.showInlinePinAction).toBe(false);
    expect(options.onRequestInlineRename).toEqual(expect.any(Function));
    expect(options.onOpenConversationInNewTab).toEqual(expect.any(Function));
    expect(options.onBeforeRestoreListState).toEqual(expect.any(Function));
    expect(options).not.toHaveProperty('organization');
    expect(options).not.toHaveProperty('showMetadataPopover');

    const beginRename = jest.fn();
    const targetItem = container.createDiv({ cls: 'claudian-history-item' });
    targetItem.setAttribute('data-conversation-id', 'conversation-1');
    options.onRequestInlineRename({
      beginRename,
      conversationId: 'conversation-1',
    });
    expect(container.hasClass('visible')).toBe(true);
    expect(beginRename).toHaveBeenCalledWith(targetItem);
    expect(ownerRequestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(globalRequestAnimationFrame).not.toHaveBeenCalled();
    globalRequestAnimationFrame.mockRestore();
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
    view.createNewTab = jest.fn().mockResolvedValue(targetTab);
    view.tabManager = { getActiveTab: jest.fn().mockReturnValue(targetTab) };

    await expect(view.handleNewSessionPlan('Implement the plan')).resolves.toBe(true);

    expect(view.createNewTab).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ content: 'Implement the plan' });
  });

  it('does not send an approved plan after its source runtime closes', async () => {
    let resolveTab!: (tab: unknown) => void;
    const tabCreation = new Promise(resolve => {
      resolveTab = resolve;
    });
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const targetTab = {
      id: 'target-tab',
      conversationId: null,
      controllers: { inputController: { sendMessage } },
      session: { userOwnershipRevision: 0 },
    };
    const discardTab = jest.fn().mockResolvedValue(true);
    const view = Object.create(ClaudianView.prototype) as any;
    let sourceIsLive = true;
    view.isWideSessionLayout = true;
    view.createNewTab = jest.fn(() => tabCreation);
    view.tabManager = {
      discardTab,
      getActiveTab: jest.fn().mockReturnValue(targetTab),
    };

    const handling = view.handleNewSessionPlan(
      'Implement the plan',
      () => sourceIsLive,
    );
    sourceIsLive = false;
    resolveTab(targetTab);
    await expect(handling).resolves.toBe(true);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(discardTab).toHaveBeenCalledWith(targetTab.id);
  });

  it('keeps an approved-plan target retained while its source runtime closes', async () => {
    const tabCreation = deferred<any>();
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const targetTab = {
      id: 'target-tab',
      conversationId: null,
      controllers: { inputController: { sendMessage } },
      session: { userOwnershipRevision: 1 },
    };
    const discardTab = jest.fn().mockResolvedValue(true);
    const view = Object.create(ClaudianView.prototype) as any;
    let sourceIsLive = true;
    view.isWideSessionLayout = true;
    view.createNewTab = jest.fn(() => tabCreation.promise);
    view.tabManager = {
      discardTab,
      getActiveTab: jest.fn().mockReturnValue(targetTab),
    };

    const handling = view.handleNewSessionPlan(
      'Implement the plan',
      () => sourceIsLive,
    );
    sourceIsLive = false;
    tabCreation.resolve(targetTab);
    await expect(handling).resolves.toBe(true);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(discardTab).not.toHaveBeenCalled();
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
    const secondRenderSignal = renderHistoryDropdown.mock.calls[1][1].signal as AbortSignal;

    view.toggleHistoryDropdown();
    expect(firstRenderSignal.aborted).toBe(true);
    expect(secondRenderSignal.aborted).toBe(true);
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);

    view.toggleHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(3);
    const reopenedSignal = renderHistoryDropdown.mock.calls[2][1].signal as AbortSignal;
    expect(reopenedSignal.aborted).toBe(false);
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
    expect(viewContainerEl.children[2].children[0].hasClass('claudian-session-surface')).toBe(true);
    expect(viewContainerEl.children[2].children[1].hasClass('claudian-files-surface')).toBe(true);
    expect(viewContainerEl.children[2].children[1].hasClass('claudian-hidden')).toBe(true);
    expect(viewContainerEl.children[2].children[2]
      .hasClass('claudian-sidebar-surface-switcher')).toBe(true);
    expect(view.sidebarSurfaceSwitcherEl.getAttribute('role')).toBe('group');
    expect(view.sidebarSurfaceSwitcherEl.getAttribute('aria-label')).toBe('Sidebar view');
    expect(view.sessionsSurfaceButtonEl.textContent).toBe('');
    expect(view.sessionsSurfaceButtonEl.getAttribute('aria-label')).toBe('Sessions');
    expect(view.sessionsSurfaceButtonEl.getAttribute('aria-pressed')).toBe('true');
    expect(view.filesSurfaceButtonEl.textContent).toBe('');
    expect(view.filesSurfaceButtonEl.getAttribute('aria-label')).toBe('Files');
    expect(view.filesSurfaceButtonEl.getAttribute('aria-pressed')).toBe('false');
    expect(viewContainerEl.children[2].getAttribute('aria-label')).toBeNull();
    expect(viewContainerEl.children[1].getAttribute('role')).toBe('separator');
    expect(viewContainerEl.children[0].children).toContain(view.tabContentEl);
    expect(viewContainerEl.children[0].children).toContain(view.inputFooterEl);
  });

  it('switches the persistent sidebar to Files without remounting the tree', () => {
    const viewContainerEl = createMockEl();
    const mount = jest.fn().mockResolvedValue(undefined);
    const destroy = jest.fn();
    const setActive = jest.fn();
    const renderSessionSidebar = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      activeSidebarSurface: 'sessions',
      createVaultFileTree: jest.fn().mockReturnValue({ destroy, mount, setActive }),
      isWideSessionLayout: true,
      plugin: { app: {} },
      renderSessionSidebar,
      requestedWideSessionLayout: true,
      viewContainerEl,
      vaultFileTree: null,
    });
    view.buildViewLayout();

    view.filesSurfaceButtonEl.click();

    expect(view.sessionSurfaceEl.hasClass('claudian-hidden')).toBe(true);
    expect(view.filesSurfaceEl.hasClass('claudian-hidden')).toBe(false);
    expect(view.filesSurfaceEl.getAttribute('aria-hidden')).toBe('false');
    expect(view.sessionsSurfaceButtonEl.getAttribute('aria-pressed')).toBe('false');
    expect(view.filesSurfaceButtonEl.getAttribute('aria-pressed')).toBe('true');
    expect(view.createVaultFileTree).toHaveBeenCalledWith(view.filesSurfaceEl);
    expect(mount).toHaveBeenCalledTimes(1);

    view.sessionsSurfaceButtonEl.click();
    expect(view.sessionSurfaceEl.hasClass('claudian-hidden')).toBe(false);
    expect(view.filesSurfaceEl.hasClass('claudian-hidden')).toBe(true);
    expect(view.sessionsSurfaceButtonEl.getAttribute('aria-pressed')).toBe('true');
    expect(view.filesSurfaceButtonEl.getAttribute('aria-pressed')).toBe('false');
    expect(setActive).toHaveBeenLastCalledWith(false);
    expect(renderSessionSidebar).toHaveBeenCalledTimes(1);

    view.filesSurfaceButtonEl.click();
    expect(view.createVaultFileTree).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenLastCalledWith(true);
  });

  it('rotates sidebar surfaces on either horizontal wheel direction without intercepting vertical scroll', () => {
    const viewContainerEl = createMockEl();
    const mount = jest.fn().mockResolvedValue(undefined);
    const setActive = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      activeSidebarSurface: 'sessions',
      createVaultFileTree: jest.fn().mockReturnValue({
        destroy: jest.fn(),
        mount,
        setActive,
      }),
      isWideSessionLayout: true,
      plugin: { app: {}, settings: { enableFilePane: true } },
      requestedWideSessionLayout: true,
      sidebarSurfaceWheelGesture: new HorizontalWheelGesture(),
      viewContainerEl,
      vaultFileTree: null,
    });
    view.buildViewLayout();

    expect(view.sessionSidebarEl.getEventListenerCount('wheel')).toBe(1);
    expect(view.chatPanelEl.getEventListenerCount('wheel')).toBe(0);
    Object.defineProperty(view.sessionSidebarEl, 'clientWidth', {
      configurable: true,
      get: () => {
        throw new Error('Wheel handling must not read layout');
      },
    });

    const verticalPreventDefault = jest.fn();
    view.sessionSidebarEl.dispatchEvent({
      type: 'wheel',
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 10,
      deltaY: 60,
      preventDefault: verticalPreventDefault,
      timeStamp: 0,
    });
    expect(view.activeSidebarSurface).toBe('sessions');
    expect(verticalPreventDefault).not.toHaveBeenCalled();

    const switchToFilesPreventDefault = jest.fn();
    view.sessionSidebarEl.dispatchEvent({
      type: 'wheel',
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 28,
      deltaY: 30,
      preventDefault: switchToFilesPreventDefault,
      timeStamp: 10,
    });
    expect(view.activeSidebarSurface).toBe('files');
    expect(switchToFilesPreventDefault).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);

    view.sessionSidebarEl.dispatchEvent({
      type: 'wheel',
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 60,
      deltaY: 0,
      preventDefault: jest.fn(),
      timeStamp: 20,
    });
    expect(view.activeSidebarSurface).toBe('files');

    view.sessionSidebarEl.dispatchEvent({
      type: 'wheel',
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 4,
      deltaY: 0,
      preventDefault: jest.fn(),
      timeStamp: 120,
    });
    view.sessionSidebarEl.dispatchEvent({
      type: 'wheel',
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 18,
      deltaY: 0,
      preventDefault: jest.fn(),
      timeStamp: 220,
    });
    const switchToSessionsPreventDefault = jest.fn();
    view.sessionSidebarEl.dispatchEvent({
      type: 'wheel',
      ctrlKey: false,
      deltaMode: 0,
      deltaX: 12,
      deltaY: 0,
      preventDefault: switchToSessionsPreventDefault,
      timeStamp: 230,
    });
    expect(view.activeSidebarSurface).toBe('sessions');
    expect(switchToSessionsPreventDefault).toHaveBeenCalledTimes(1);

    const rotateLeftPreventDefault = jest.fn();
    view.sessionSidebarEl.dispatchEvent({
      type: 'wheel',
      ctrlKey: false,
      deltaMode: 0,
      deltaX: -28,
      deltaY: 0,
      preventDefault: rotateLeftPreventDefault,
      timeStamp: 500,
    });
    expect(view.activeSidebarSurface).toBe('files');
    expect(rotateLeftPreventDefault).toHaveBeenCalledTimes(1);
  });

  it('hides the surface switcher when the file pane is disabled', () => {
    const viewContainerEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      activeSidebarSurface: 'sessions',
      plugin: { settings: { enableFilePane: false } },
      viewContainerEl,
    });
    view.buildViewLayout();

    expect(view.sidebarSurfaceSwitcherEl.hasClass('claudian-hidden')).toBe(true);
    expect(view.sessionSurfaceEl.hasClass('claudian-hidden')).toBe(false);
    expect(view.filesSurfaceEl.hasClass('claudian-hidden')).toBe(true);
  });

  it('returns to Sessions and tears down the tree when the file pane is disabled', () => {
    const viewContainerEl = createMockEl();
    const destroy = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      activeSidebarSurface: 'files',
      plugin: { settings: { enableFilePane: true } },
      updateSessionSidebarLayout: jest.fn(),
      vaultFileTree: { destroy },
      viewContainerEl,
    });
    view.buildViewLayout();
    view.plugin.settings.enableFilePane = false;

    view.refreshDualPaneLayout();

    expect(view.activeSidebarSurface).toBe('sessions');
    expect(view.sidebarSurfaceSwitcherEl.hasClass('claudian-hidden')).toBe(true);
    expect(view.sessionSurfaceEl.hasClass('claudian-hidden')).toBe(false);
    expect(view.filesSurfaceEl.hasClass('claudian-hidden')).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(view.vaultFileTree).toBeNull();
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
    const setActive = jest.fn();

    Object.assign(view, {
      cancelSessionSidebarRendering: jest.fn(),
      filesSurfaceEl: createMockEl(),
      isSessionSearchActive: true,
      isSessionSearchComposing: false,
      sessionSearchQuery: 'roadmap',
      isWideSessionLayout: true,
      requestedWideSessionLayout: true,
      sessionLayoutRequestRevision: 0,
      plugin: {
        getConversationSync: jest.fn(),
        settings: { enableFilePane: true },
      },
      tabManager: {
        discardProvisionalTabs,
        getAllTabs: jest.fn().mockReturnValue([]),
      },
      vaultFileTree: { setActive },
      viewContainerEl,
    });

    view.updateSessionSidebarLayout(599);

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(true);
    expect(view.isWideSessionLayout).toBe(true);
    expect(view.isSessionSearchActive).toBe(false);
    expect(view.sessionSearchQuery).toBe('');
    expect(view.cancelSessionSidebarRendering).toHaveBeenCalledTimes(1);
    expect(discardProvisionalTabs).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith(false);

    view.showVaultFiles();
    expect(setActive).not.toHaveBeenCalledWith(true);

    finishDiscard();
    await view.pendingSessionLayoutTransition;

    expect(viewContainerEl.hasClass('claudian-wide-session-layout')).toBe(false);
    expect(view.isWideSessionLayout).toBe(false);
    expect(setActive).toHaveBeenLastCalledWith(false);
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
      session: createOwnershipSession(),
    };
    const previewTab = {
      id: 'preview-tab',
      conversationId: 'preview-conversation',
      lifecycleState: 'provisional',
      session: createOwnershipSession(),
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
      session: createOwnershipSession(),
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
      activeSidebarSurface: 'sessions',
      historyDropdown: createMockEl(),
      isWideSessionLayout: true,
      renderSessionSidebar: jest.fn(),
      sessionSidebarDirty: false,
    });

    view.updateHistoryDropdown();

    expect(view.sessionSidebarDirty).toBe(true);
    expect(view.renderSessionSidebar).toHaveBeenCalledTimes(1);
  });

  it('defers persistent session rendering while the Files surface is active', () => {
    const view = Object.create(ClaudianView.prototype) as any;

    Object.assign(view, {
      activeSidebarSurface: 'files',
      historyDropdown: createMockEl(),
      isWideSessionLayout: true,
      renderSessionSidebar: jest.fn(),
      sessionSidebarDirty: false,
    });

    view.updateHistoryDropdown();

    expect(view.sessionSidebarDirty).toBe(true);
    expect(view.renderSessionSidebar).not.toHaveBeenCalled();
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
        onRequestInlineRename: expect.any(Function),
        onSelectConversation: expect.any(Function),
        preserveListState: true,
        searchQuery: 'roadmap',
        showAttentionState: true,
        showInlinePinAction: true,
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

    const ownerRequestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    sessionSidebarEl.ownerDocument.defaultView.requestAnimationFrame = ownerRequestAnimationFrame;
    let replacementItem: ReturnType<typeof createMockEl> | null = null;
    view.isArchiveSessionView = false;
    view.isSessionSearchActive = true;
    view.closeSessionSearch = jest.fn(() => {
      view.isSessionSearchActive = false;
      sessionSidebarEl.empty();
      replacementItem = sessionSidebarEl.createDiv({ cls: 'claudian-history-item' });
      replacementItem.setAttribute('data-conversation-id', 'conversation-1');
    });
    const beginRename = jest.fn();

    sessionOptions.onRequestInlineRename({
      beginRename,
      conversationId: 'conversation-1',
    });

    expect(view.closeSessionSearch).toHaveBeenCalledTimes(1);
    expect(ownerRequestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(beginRename).toHaveBeenCalledWith(replacementItem);
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
    const tabs: Array<{
      conversationId: string;
      lifecycleState: string;
      session: ReturnType<typeof createOwnershipSession>;
    }> = [];
    const openConversation = jest.fn().mockImplementation(async (conversationId: string) => {
      tabs.push({
        conversationId,
        lifecycleState: 'provisional',
        session: createOwnershipSession(),
      });
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

  it('abandons deferred restoration when view shutdown begins', async () => {
    const persistedState = deferred<any>();
    const createTab = jest.fn().mockResolvedValue({});
    const beginShutdown = jest.fn();
    const destroy = jest.fn().mockResolvedValue(undefined);
    const sealShutdownSnapshot = jest.fn();
    mockTabManagerConstructor.mockReset();
    mockTabManagerConstructor.mockImplementation(() => ({
      beginShutdown,
      createTab,
      destroy,
      discardProvisionalTabs: jest.fn().mockResolvedValue(undefined),
      getActiveTab: jest.fn().mockReturnValue(null),
      getAllTabs: jest.fn().mockReturnValue([]),
      sealShutdownSnapshot,
    }));

    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      attachNavRowContentToInputFooter: jest.fn(),
      buildInputFooter: jest.fn(),
      buildNavRowContent: jest.fn().mockReturnValue(createMockEl()),
      cancelHistoryRendering: jest.fn(),
      cancelSessionSidebarRendering: jest.fn(),
      clearSessionSearchDismissHandlers: jest.fn(),
      containerEl: createMockEl(),
      contentEl: createMockEl(),
      disconnectSessionSidebarLayoutObserver: jest.fn(),
      eventRefs: [],
      pendingTabBarUpdate: null,
      plugin: {
        app: { vault: { offref: jest.fn() } },
        storage: {
          getTabManagerState: jest.fn(() => persistedState.promise),
        },
      },
      restoreActiveInputToTabContent: jest.fn(),
      startSessionSidebarLayoutObserver: jest.fn(),
      stopSessionSidebarResize: jest.fn(),
      syncProviderBrandColor: jest.fn(),
      tabStatePersistence: {
        dispose: jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
        update: jest.fn(),
      },
      updateInputLocation: jest.fn(),
      updateTabBar: jest.fn(),
      updateTabBarVisibility: jest.fn(),
      wireEventHandlers: jest.fn(),
    });

    const opening = view.onOpenImpl();
    await Promise.resolve();
    const closing = view.onClose();
    persistedState.resolve({ activeTabId: null, openTabs: [] });
    await expect(Promise.all([opening, closing])).resolves.toEqual([undefined, undefined]);

    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(sealShutdownSnapshot).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(createTab).not.toHaveBeenCalled();
    expect(view.syncProviderBrandColor).not.toHaveBeenCalled();
    expect(view.startSessionSidebarLayoutObserver).not.toHaveBeenCalled();
    expect(view.tabManager).toBeNull();
  });

  it('reuses and drains closing persistence before restoring a reopened view', async () => {
    const pendingFlush = deferred<void>();
    const persistence = {
      dispose: jest.fn(),
      flush: jest.fn(() => pendingFlush.promise),
      update: jest.fn(),
    };
    const getTabManagerState = jest.fn().mockResolvedValue(null);
    const createTab = jest.fn().mockResolvedValue({});
    mockTabManagerConstructor.mockReset();
    mockTabManagerConstructor.mockImplementation(() => ({
      createTab,
      discardProvisionalTabs: jest.fn().mockResolvedValue(undefined),
      getAllTabs: jest.fn().mockReturnValue([]),
    }));
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      attachNavRowContentToInputFooter: jest.fn(),
      buildInputFooter: jest.fn(),
      buildNavRowContent: jest.fn().mockReturnValue(createMockEl()),
      containerEl: createMockEl(),
      contentEl: createMockEl(),
      plugin: {
        storage: {
          getTabManagerState,
          setTabManagerState: jest.fn().mockResolvedValue(undefined),
        },
      },
      startSessionSidebarLayoutObserver: jest.fn(),
      syncProviderBrandColor: jest.fn(),
      tabStatePersistence: persistence,
      updateInputLocation: jest.fn(),
      updateTabBar: jest.fn(),
      updateTabBarVisibility: jest.fn(),
      viewLifecycleRevision: 1,
      viewShutdownStarted: true,
      wireEventHandlers: jest.fn(),
    });

    const opening = view.onOpenImpl();
    await Promise.resolve();

    expect(persistence.flush).toHaveBeenCalledTimes(1);
    expect(mockTabManagerConstructor).not.toHaveBeenCalled();
    expect(getTabManagerState).not.toHaveBeenCalled();

    pendingFlush.resolve(undefined);
    await opening;

    expect(persistence.dispose).not.toHaveBeenCalled();
    expect(view.tabStatePersistence).toBe(persistence);
    expect(getTabManagerState).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  it('waits for the closing shutdown snapshot before restoring a reopened view', async () => {
    const shutdownSnapshot = deferred<void>();
    const persistence = {
      dispose: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      update: jest.fn(),
    };
    const getTabManagerState = jest.fn().mockResolvedValue(null);
    const createTab = jest.fn().mockResolvedValue({});
    mockTabManagerConstructor.mockReset();
    mockTabManagerConstructor.mockImplementation(() => ({
      createTab,
      discardProvisionalTabs: jest.fn().mockResolvedValue(undefined),
      getAllTabs: jest.fn().mockReturnValue([]),
    }));
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      attachNavRowContentToInputFooter: jest.fn(),
      buildInputFooter: jest.fn(),
      buildNavRowContent: jest.fn().mockReturnValue(createMockEl()),
      containerEl: createMockEl(),
      contentEl: createMockEl(),
      plugin: {
        storage: {
          getTabManagerState,
          setTabManagerState: jest.fn().mockResolvedValue(undefined),
        },
      },
      shutdownSnapshotPromise: shutdownSnapshot.promise,
      startSessionSidebarLayoutObserver: jest.fn(),
      syncProviderBrandColor: jest.fn(),
      tabStatePersistence: persistence,
      updateInputLocation: jest.fn(),
      updateTabBar: jest.fn(),
      updateTabBarVisibility: jest.fn(),
      viewLifecycleRevision: 1,
      viewShutdownStarted: true,
      wireEventHandlers: jest.fn(),
    });

    const opening = view.onOpenImpl();
    await Promise.resolve();

    expect(mockTabManagerConstructor).not.toHaveBeenCalled();
    expect(getTabManagerState).not.toHaveBeenCalled();

    shutdownSnapshot.resolve(undefined);
    await opening;

    expect(getTabManagerState).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledTimes(1);
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
      getActiveTab: jest.fn().mockReturnValue({
        dom: { inputEl },
        session: createOwnershipSession(),
      }),
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
  it('prepares plugin unload through one shared drained snapshot', async () => {
    const drain = deferred<void>();
    const flush = jest.fn().mockResolvedValue(undefined);
    const manager = {
      beginShutdown: jest.fn(),
      drainForShutdownSnapshot: jest.fn(() => drain.promise),
      getActiveTab: jest.fn().mockReturnValue({
        conversationId: 'conversation-1',
        id: 'tab-1',
      }),
      sealShutdownSnapshot: jest.fn(),
    };
    const persistence = {
      flush,
      update: jest.fn(),
    };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      tabManager: manager,
      tabStatePersistence: persistence,
    });

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
      getActiveTab: jest.fn().mockReturnValue(activeTab),
      sealShutdownSnapshot,
    };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: jest.fn() },
      tabManager: manager,
      tabStatePersistence: {
        dispose: jest.fn(),
        flush,
        update,
      },
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

  it('flushes the current tab identity before disposing view resources', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    const beginShutdown = jest.fn();
    const destroy = jest.fn().mockResolvedValue(undefined);
    const sealShutdownSnapshot = jest.fn();
    const disposePersistence = jest.fn();
    let resolveFlush!: () => void;
    const flushPersistence = jest.fn(() => new Promise<void>(resolve => {
      resolveFlush = resolve;
    }));
    const updatePersistence = jest.fn();
    const tabBarDestroy = jest.fn();
    const vaultFileTreeDestroy = jest.fn();

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: tabBarDestroy },
      vaultFileTree: { destroy: vaultFileTreeDestroy },
      tabManager: {
        beginShutdown,
        destroy,
        getActiveTab: jest.fn().mockReturnValue({
          conversationId: 'conversation-1',
          id: 'tab-1',
        }),
        sealShutdownSnapshot,
      },
      tabStatePersistence: {
        dispose: disposePersistence,
        flush: flushPersistence,
        update: updatePersistence,
      },
    });

    const closing = view.onClose();

    expect(beginShutdown).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    resolveFlush();
    await expect(closing).resolves.toBeUndefined();

    expect(view.restoreActiveInputToTabContent).toHaveBeenCalledTimes(1);
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
    expect(tabBarDestroy).toHaveBeenCalledTimes(1);
    expect(vaultFileTreeDestroy).toHaveBeenCalledTimes(1);
    expect(view.vaultFileTree).toBeNull();
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
        beginShutdown: jest.fn(),
        destroy,
        getActiveTab: jest.fn().mockReturnValue({
          conversationId: null,
          id: 'tab-1',
        }),
        sealShutdownSnapshot: jest.fn(),
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

  it('keeps the closing manager snapshot current until its shutdown seal', async () => {
    const flush = deferred<void>();
    const activeTab = { conversationId: null as string | null, id: 'tab-1' };
    const update = jest.fn();
    const sealShutdownSnapshot = jest.fn();
    const manager = {
      beginShutdown: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      getActiveTab: jest.fn().mockReturnValue(activeTab),
      sealShutdownSnapshot,
    };
    const persistence = {
      dispose: jest.fn(),
      flush: jest.fn(() => flush.promise),
      update,
    };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: jest.fn() },
      tabManager: manager,
      tabStatePersistence: persistence,
    });

    const closing = view.onClose();
    expect(update).toHaveBeenLastCalledWith({
      activeTabId: 'tab-1',
      openTabs: [{ conversationId: null, tabId: 'tab-1' }],
    });

    activeTab.conversationId = 'conversation-created-during-close';
    view.persistCurrentTabState(manager, persistence);
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
    expect(sealShutdownSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not let an older close finalizer clear resources from a newer open', async () => {
    const flush = deferred<void>();
    const oldManager = {
      beginShutdown: jest.fn(),
      destroy: jest.fn().mockResolvedValue(undefined),
      getActiveTab: jest.fn().mockReturnValue({ conversationId: null, id: 'old-tab' }),
      sealShutdownSnapshot: jest.fn(),
    };
    const oldPersistence = {
      dispose: jest.fn(),
      flush: jest.fn(() => flush.promise),
      update: jest.fn(),
    };
    const oldTabBar = { destroy: jest.fn() };
    const oldMentionCoordinator = {};
    const oldScope = {};
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: oldMentionCoordinator,
      pendingTabBarUpdate: null,
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: oldScope,
      tabBar: oldTabBar,
      tabManager: oldManager,
      tabStatePersistence: oldPersistence,
    });

    const closing = view.onClose();
    const newManager = {};
    const newPersistence = {};
    const newTabBar = { destroy: jest.fn() };
    const newMentionCoordinator = {};
    const newScope = {};
    Object.assign(view, {
      mentionCacheCoordinator: newMentionCoordinator,
      scope: newScope,
      tabBar: newTabBar,
      tabManager: newManager,
      tabStatePersistence: newPersistence,
    });
    flush.resolve(undefined);
    await expect(closing).resolves.toBeUndefined();

    expect(oldManager.destroy).toHaveBeenCalledTimes(1);
    expect(oldPersistence.dispose).toHaveBeenCalledTimes(1);
    expect(oldTabBar.destroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBe(newManager);
    expect(view.tabStatePersistence).toBe(newPersistence);
    expect(view.tabBar).toBe(newTabBar);
    expect(view.mentionCacheCoordinator).toBe(newMentionCoordinator);
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
      getActiveTab: jest.fn().mockReturnValue({ conversationId: null, id: 'old-tab' }),
      sealShutdownSnapshot: jest.fn(),
    };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: jest.fn() },
      tabManager: oldManager,
      tabStatePersistence: persistence,
    });

    const closing = view.onClose();
    const newManager = {};
    view.viewShutdownStarted = false;
    view.viewLifecycleRevision += 1;
    view.tabManager = newManager;
    view.tabStatePersistence = persistence;
    flush.resolve(undefined);
    await closing;

    expect(persistence.dispose).not.toHaveBeenCalled();
    expect(view.tabStatePersistence).toBe(persistence);
    expect(view.tabManager).toBe(newManager);
  });
});

describe('ClaudianView Escape handling', () => {
  beforeEach(() => {
    MockScope.instances.length = 0;
  });

  function createEscapeHarness(options: {
    isStreaming: boolean;
  }): {
    cancelInlineRename: jest.Mock;
    cancelStreaming: jest.Mock;
    eventRefs: unknown[];
    view: any;
  } {
    const cancelInlineRename = jest.fn().mockReturnValue(false);
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
          conversationController: { cancelInlineRename },
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

    return { cancelInlineRename, cancelStreaming, eventRefs, view };
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

  it('exits inline rename before handling other scoped Escape actions', () => {
    const { cancelInlineRename, cancelStreaming, view } = createEscapeHarness({
      isStreaming: true,
    });
    cancelInlineRename.mockReturnValue(true);
    view.closeSessionSearch = jest.fn();
    view.isSessionSearchActive = true;

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelInlineRename).toHaveBeenCalledTimes(1);
    expect(view.closeSessionSearch).not.toHaveBeenCalled();
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

  it('closes file search from the scoped Escape handler', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });
    const handleEscape = jest.fn().mockReturnValue(true);
    view.vaultFileTree = {
      handleEscape,
      isComposingSearch: jest.fn().mockReturnValue(false),
    };

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const event = { key: 'Escape', isComposing: false } as KeyboardEvent;
    const result = escapeHandler.func(event);

    expect(handleEscape).toHaveBeenCalledWith(event);
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
      session: createOwnershipSession(),
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
