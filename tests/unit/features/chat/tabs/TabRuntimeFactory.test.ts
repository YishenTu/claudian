import { createMockEl } from '@test/helpers/MockElement';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ConversationController } from '@/features/chat/controllers/ConversationController';
import { NavigationController } from '@/features/chat/controllers/NavigationController';
import type {
  ChatExecutionCoordinatorDeps,
  ChatExecutionEventContext,
} from '@/features/chat/execution/ChatExecutionCoordinator';
import {
  destroyTab,
  drainTabForShutdownSnapshot,
  registerTabRuntimeResourceOwner,
  TabRuntimeTeardownError,
} from '@/features/chat/tabs/TabLifecycle';
import { TabManager } from '@/features/chat/tabs/TabManager';
import {
  initializeTabExecution,
  onProviderAvailabilityChanged,
  updatePlanModeUI,
} from '@/features/chat/tabs/TabProviderState';
import {
  createTabRuntime,
  TabRuntimeConstructionError,
  type TabRuntimeFactoryOptions,
} from '@/features/chat/tabs/TabRuntimeFactory';

const coordinatorInstances: MockCoordinator[] = [];
const coordinatorDeps: ChatExecutionCoordinatorDeps[] = [];
const titleServiceInstances: Array<{ cancel: jest.Mock }> = [];
let coordinatorDisposeError: Error | null = null;

interface MockCoordinator {
  bindConversation: jest.Mock;
  cancel: jest.Mock;
  dispose: jest.Mock;
  isEventContextCurrent: jest.Mock;
  notifyMayCool: jest.Mock;
  prepare: jest.Mock;
  resolveForkSource: jest.Mock;
  setMode: jest.Mock;
  snapshot: { providerSessionId?: string } | null;
  state: 'absent' | 'idle' | 'active' | 'stale' | 'disposed';
}

jest.mock('@/features/chat/execution/ChatExecutionCoordinator', () => ({
  ChatExecutionCoordinator: jest.fn().mockImplementation((deps) => {
    const coordinator: MockCoordinator = {
      bindConversation: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
      dispose: jest.fn().mockImplementation(() => coordinatorDisposeError
        ? Promise.reject(coordinatorDisposeError)
        : Promise.resolve()),
      isEventContextCurrent: jest.fn().mockReturnValue(true),
      notifyMayCool: jest.fn(),
      prepare: jest.fn().mockResolvedValue(undefined),
      resolveForkSource: jest.fn().mockResolvedValue({ sessionId: 'native-session' }),
      setMode: jest.fn().mockResolvedValue(true),
      snapshot: null,
      state: 'absent',
    };
    coordinatorDeps.push(deps);
    coordinatorInstances.push(coordinator);
    return coordinator;
  }),
}));

const ensureInitialized = jest.fn().mockResolvedValue(undefined);
jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => ({
  ProviderWorkspaceRegistry: {
    ensureInitialized: (...args: unknown[]) => ensureInitialized(...args),
    getAgentMentionProvider: jest.fn().mockReturnValue(null),
    getCommandCatalog: jest.fn().mockReturnValue(null),
    getIfInitialized: jest.fn().mockReturnValue(null),
    getCommandLoader: jest.fn().mockReturnValue(null),
    getTabWarmupPolicy: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    createExecutionBackend: jest.fn(),
    createInstructionRefineService: jest.fn().mockReturnValue(null),
    createSubagentHistoryService: jest.fn().mockReturnValue(null),
    createTitleGenerationService: jest.fn().mockImplementation(() => {
      const service = {
        cancel: jest.fn(),
        generateTitle: jest.fn().mockResolvedValue(undefined),
      };
      titleServiceInstances.push(service);
      return service;
    }),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsImageAttachments: true,
      supportsPlanMode: true,
    }),
    getChatUIConfig: jest.fn().mockReturnValue({
      applyPermissionMode: (_mode: string, settings: Record<string, unknown>) => {
        settings.permissionMode = _mode;
      },
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      getDefaultModel: jest.fn().mockReturnValue('claude-default'),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getModelOptions: jest.fn().mockReturnValue([
        { label: 'Claude Default', value: 'claude-default' },
        { label: 'Claude Alternate', value: 'claude-alternate' },
      ]),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      isDefaultModel: jest.fn().mockReturnValue(true),
      normalizeModelVariant: jest.fn((model: string) => model),
      ownsModel: jest.fn().mockReturnValue(true),
    }),
    getConversationHistoryService: jest.fn().mockReturnValue({
      resolveSessionIdForConversation: jest.fn().mockReturnValue(null),
    }),
    getBlankTabProviderIds: jest.fn().mockReturnValue(['claude']),
    getEnabledProviderIds: jest.fn().mockReturnValue(['claude']),
    getRegisteredProviderIds: jest.fn().mockReturnValue(['claude']),
    getProviderDisplayName: jest.fn().mockReturnValue('Claude'),
    getTaskResultInterpreter: jest.fn(),
    isEnabled: jest.fn().mockReturnValue(true),
    resolveProviderForModel: jest.fn().mockReturnValue('claude'),
    resolveSettingsProviderId: jest.fn().mockReturnValue('claude'),
  },
}));

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    commitProviderSettingsSnapshot: (
      settings: Record<string, unknown>,
      _providerId: string,
      snapshot: Record<string, unknown>,
    ) => Object.assign(settings, snapshot),
    getProviderSettingsSnapshot: (settings: Record<string, unknown>) => ({
      effortLevel: '',
      model: 'claude-default',
      permissionMode: 'normal',
      serviceTier: 'standard',
      thinkingBudget: '',
      ...settings,
    }),
    projectModelSelection: (
      settings: Record<string, unknown>,
      _providerId: string,
      model: string,
    ) => {
      settings.model = model;
    },
  },
}));

function createPlugin(overrides: Record<string, unknown> = {}) {
  const settings: Record<string, unknown> = {
    model: 'claude-default',
    permissionMode: 'normal',
    persistentExternalContextPaths: [],
  };
  let nextModelSelectionIntent = 0;
  return {
    app: {
      vault: {
        adapter: { basePath: '/vault' },
        getAbstractFileByPath: jest.fn().mockReturnValue(null),
        getFiles: jest.fn().mockReturnValue([]),
        on: jest.fn().mockReturnValue({}),
        offref: jest.fn(),
      },
      workspace: {
        getActiveFile: jest.fn().mockReturnValue(null),
        getLeaf: jest.fn().mockReturnValue({ openFile: jest.fn() }),
        on: jest.fn().mockReturnValue({}),
      },
    },
    providerHost: {
      executionLifecycleRegistry: {},
    },
    chatModelSelection: {
      beginIntent: jest.fn(() => {
        nextModelSelectionIntent += 1;
        return nextModelSelectionIntent;
      }),
      commitIntent: jest.fn(async (_intent, selection) => {
        settings.lastSelectedChatModel = selection;
        return true;
      }),
    },
    settings,
    getActiveEnvironmentVariables: jest.fn().mockReturnValue({}),
    mutateSettings: jest.fn(async (mutation) => {
      await mutation(settings);
    }),
    getConversationById: jest.fn().mockResolvedValue(null),
    getCachedConversation: jest.fn().mockReturnValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    getConversationSync: jest.fn().mockReturnValue(null),
    findConversationAcrossViews: jest.fn().mockReturnValue(null),
    handleMissingProviderSession: jest.fn(),
    ...overrides,
  } as any;
}

function createTabManager(
  plugin: ReturnType<typeof createPlugin>,
  containerEl = createMockEl(),
  callbacks: Record<string, unknown> = {},
  viewOverrides: Record<string, unknown> = {},
) {
  const view = {
    addChild: jest.fn(),
    getTabManager: jest.fn(),
    leaf: {},
    registerDomEvent: jest.fn(),
    registerEvent: jest.fn(),
    ...viewOverrides,
  } as any;
  return new TabManager(plugin, containerEl as any, view, callbacks);
}

function expectTabManagerMetadataReleased(manager: TabManager, tabId: string): void {
  const internals = manager as any;
  expect(internals.providerRuntimeCommandWarmups.has(tabId)).toBe(false);
  expect(internals.providerRuntimeCommandCache.has(tabId)).toBe(false);
  expect(internals.providerCommandDiscoveryStores.has(tabId)).toBe(false);
  expect(internals.tabCommandContextRevisions.has(tabId)).toBe(false);
  expect(internals.tabActivationRevisions.has(tabId)).toBe(false);
}

function createTrackedTabContainer(): {
  containerEl: ReturnType<typeof createMockEl>;
  removeTabRoot: jest.Mock;
  tabRoot: ReturnType<typeof createMockEl>;
} {
  const containerEl = createMockEl();
  const tabRoot = createMockEl();
  const removeTabRoot = jest.fn();
  tabRoot.remove = removeTabRoot;
  containerEl.createDiv = jest.fn().mockReturnValue(tabRoot);
  return { containerEl, removeTabRoot, tabRoot };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, reject, resolve };
}

const directlyCreatedTabs: any[] = [];

async function createTestTab(
  options: Pick<TabRuntimeFactoryOptions, 'containerEl' | 'plugin'> &
    Partial<Omit<
      TabRuntimeFactoryOptions,
      'component' | 'containerEl' | 'getProviderCatalogConfig' | 'plugin'
    >>,
  assembly: {
    component?: Record<string, unknown>;
    forkRequestCallback?: (forkContext: any) => Promise<void>;
    getProviderCatalogConfig?: TabRuntimeFactoryOptions['getProviderCatalogConfig'];
    onProviderChanged?: (providerId: string) => void | Promise<void>;
    openConversation?: (conversationId: string) => Promise<void>;
  } = {},
): Promise<any> {
  const component = {
    addChild: jest.fn(),
    registerDomEvent: jest.fn(),
    registerEvent: jest.fn(),
    ...assembly.component,
  } as any;
  const tab = await createTabRuntime({
    ...options,
    component,
    getProviderCatalogConfig: assembly.getProviderCatalogConfig ?? (() => null),
    isRuntimeLive: options.isRuntimeLive
      ?? (runtime => runtime.lifecycleState !== 'closing'),
    forkRequestCallback: assembly.forkRequestCallback,
    onProviderChanged: assembly.onProviderChanged
      ? (_tab, providerId) => assembly.onProviderChanged!(providerId)
      : undefined,
    openConversation: assembly.openConversation,
  });
  directlyCreatedTabs.push(tab);
  return tab;
}

function createConversation() {
  return {
    id: 'conversation-1',
    providerId: 'claude',
    sessionId: 'native-session',
    providerState: { threadId: 'thread-1' },
    resumeAtMessageId: 'checkpoint-1',
    selectedModel: 'claude-default',
    title: 'Conversation',
    messages: [],
    createdAt: 1,
    lastActivityAt: 1,
  } as any;
}

function createEventContext(
  overrides: Partial<ChatExecutionEventContext> = {},
): ChatExecutionEventContext {
  return {
    bindingId: 'binding-1',
    conversationId: 'conversation-1',
    providerGeneration: 0,
    session: { sessionInstanceId: 'session-instance-1' } as any,
    ...overrides,
  };
}

function installTransitionController(
  tab: any,
  plugin: ReturnType<typeof createPlugin>,
): ConversationController {
  const controller = new ConversationController({
    plugin,
    state: tab.state,
    renderer: tab.renderer!,
    subagentManager: tab.services.subagentManager,
    getHistoryDropdown: () => null,
    getWelcomeEl: () => tab.dom.welcomeEl,
    setWelcomeEl: (element) => { tab.dom.welcomeEl = element; },
    getMessagesEl: () => tab.dom.messagesEl,
    getInputEl: () => tab.dom.inputEl,
    getFileContextManager: () => null,
    getImageContextManager: () => null,
    getExternalContextSelector: () => null,
    clearQueuedMessage: jest.fn(),
    getTitleGenerationService: () => null,
    getStatusPanel: () => null,
    getExecutionCoordinator: () => tab.executionCoordinator,
    awaitBackgroundWork: () => tab.session.awaitBackgroundWork(),
    ensureExecutionForConversation: async (conversation) => {
      tab.conversationId = conversation?.id ?? null;
      await tab.executionCoordinator?.bindConversation(conversation
        ? {
          conversationId: conversation.id,
          providerId: conversation.providerId,
          resumeSeed: conversation.sessionId
            ? { providerSessionId: conversation.sessionId }
            : undefined,
        }
        : null);
    },
  });
  tab.controllers.conversationController = controller;
  return controller;
}

describe('Tab provider execution ownership', () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    coordinatorInstances.length = 0;
    coordinatorDeps.length = 0;
    titleServiceInstances.length = 0;
    coordinatorDisposeError = null;
    jest.clearAllMocks();
    const uiConfig = ProviderRegistry.getChatUIConfig('claude');
    (uiConfig.getDefaultModel as jest.Mock).mockReturnValue('claude-default');
    (uiConfig.getModelOptions as jest.Mock).mockReturnValue([
      { label: 'Claude Default', value: 'claude-default' },
      { label: 'Claude Alternate', value: 'claude-alternate' },
    ]);
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
  });

  afterEach(async () => {
    const tabs = directlyCreatedTabs.splice(0);
    await Promise.allSettled(tabs.map(tab => destroyTab(tab)));
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('creates exactly one tab-owned execution coordinator', async () => {
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    });

    expect(tab.executionCoordinator).toBe(coordinatorInstances[0]);
    expect(coordinatorInstances).toHaveLength(1);
  });

  it('publishes work changes from turn, provider-background, and async-subagent owners', async () => {
    const onWorkChanged = jest.fn();
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
      onWorkChanged,
    });

    tab.session.activeTurn = Promise.resolve();
    tab.session.activeTurn = null;
    coordinatorDeps[0].onBackgroundWorkChanged?.(true);
    tab.services.subagentManager.refreshAsyncSubagent({
      asyncStatus: 'running',
      description: 'Background',
      id: 'task-1',
      isExpanded: false,
      mode: 'async',
      prompt: '',
      status: 'running',
      toolCalls: [],
    });

    expect(onWorkChanged).toHaveBeenCalledTimes(4);
    expect(onWorkChanged).toHaveBeenCalledWith(tab);
  });

  it('lets later navigation override bottom auto-scroll intent', async () => {
    const plugin = createPlugin();
    plugin.settings.keyboardNavigation = {
      focusInputKey: 'i',
      scrollDownKey: 's',
      scrollUpKey: 'w',
    };
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
    });
    tab.dom.messagesEl.scrollHeight = 1_000;
    tab.dom.messagesEl.clientHeight = 500;
    tab.dom.messagesEl.scrollTop = 100;
    tab.state.autoScrollEnabled = false;
    tab.dom.messagesEl.scrollTo = jest.fn();

    const bottomButton = tab.dom.messagesWrapperEl.querySelector(
      '.claudian-nav-btn-bottom',
    );
    bottomButton?.click();

    expect(bottomButton).not.toBeNull();
    expect(tab.state.autoScrollEnabled).toBe(true);

    tab.dom.messagesEl.dispatchEvent('scroll');

    expect(tab.state.autoScrollEnabled).toBe(true);

    tab.dom.messagesEl.scrollTop = 500;
    tab.dom.messagesEl.dispatchEvent('scroll');
    tab.dom.messagesEl.scrollHeight = 1_200;
    tab.dom.messagesEl.dispatchEvent('scroll');

    expect(tab.state.autoScrollEnabled).toBe(true);

    const sidebar = tab.dom.messagesWrapperEl.querySelector('.claudian-nav-sidebar');
    for (const buttonIndex of [0, 1, 3]) {
      bottomButton?.click();
      sidebar?.children[buttonIndex]?.click();
      expect(tab.state.autoScrollEnabled).toBe(false);
    }

    const userMessage = tab.dom.messagesEl.createDiv({ cls: 'claudian-message-user' });
    userMessage.setAttribute('data-toc-title', 'Prompt');
    const queryMessages = tab.dom.messagesEl.querySelectorAll.bind(tab.dom.messagesEl);
    tab.dom.messagesEl.querySelectorAll = jest.fn((selector: string) => (
      selector === '.claudian-message-user, [data-role="user"]'
        ? [userMessage]
        : queryMessages(selector)
    ));
    const messageControl = userMessage.createEl('button');
    bottomButton?.click();
    sidebar?.children[2]?.click();
    tab.dom.messagesWrapperEl.querySelector('.claudian-nav-toc-item')?.click();
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    tab.dom.messagesEl.dispatchEvent({
      type: 'keydown',
      key: 'w',
      target: messageControl,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: jest.fn(),
    });
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    tab.dom.messagesEl.dispatchEvent({
      type: 'keydown',
      key: 'PageUp',
      target: messageControl,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: jest.fn(),
    });
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    tab.dom.messagesEl.dispatchEvent({
      type: 'pointerdown',
      target: tab.dom.messagesEl,
      clientX: 250,
    });
    expect(tab.state.autoScrollEnabled).toBe(true);

    tab.dom.messagesEl.dispatchEvent({
      type: 'touchstart',
      target: userMessage,
    });
    expect(tab.state.autoScrollEnabled).toBe(true);

    tab.dom.messagesEl.dispatchEvent({
      type: 'touchmove',
      target: userMessage,
    });
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    tab.dom.messagesEl.dispatchEvent({
      type: 'keydown',
      key: ' ',
      target: messageControl,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: jest.fn(),
    });
    expect(tab.state.autoScrollEnabled).toBe(true);

    tab.dom.messagesEl.dispatchEvent({
      type: 'pointermove',
      target: tab.dom.messagesEl,
      buttons: 1,
    });
    expect(tab.state.autoScrollEnabled).toBe(true);

    bottomButton?.click();
    tab.dom.messagesEl.offsetWidth = 506;
    tab.dom.messagesEl.clientWidth = 500;
    tab.dom.messagesEl.getBoundingClientRect = jest.fn().mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 506,
      top: 0,
      width: 506,
      x: 0,
      y: 0,
      toJSON: jest.fn(),
    });
    tab.dom.messagesEl.dispatchEvent({
      type: 'pointerdown',
      target: tab.dom.messagesEl,
      clientX: 503,
    });
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    tab.dom.messagesEl.dispatchEvent({
      type: 'keydown',
      key: 'Home',
      target: messageControl,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      preventDefault: jest.fn(),
    });
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    tab.dom.messagesEl.dispatchEvent({ type: 'wheel' });

    expect(tab.state.autoScrollEnabled).toBe(false);
  });

  it('keeps auto-scroll disabled when bottom navigation is used with the setting off', async () => {
    const plugin = createPlugin();
    plugin.settings.enableAutoScroll = false;
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
    });
    tab.state.autoScrollEnabled = false;
    tab.dom.messagesEl.scrollTo = jest.fn();

    tab.dom.messagesWrapperEl.querySelector('.claudian-nav-btn-bottom')?.click();

    expect(tab.state.autoScrollEnabled).toBe(false);
  });

  it('re-arms auto-scroll when a streaming user manually returns to the bottom', async () => {
    jest.useFakeTimers();
    try {
      const tab = await createTestTab({
        plugin: createPlugin(),
        containerEl: createMockEl() as any,
      });
      tab.state.isStreaming = true;
      tab.dom.messagesEl.scrollHeight = 1_000;
      tab.dom.messagesEl.clientHeight = 500;
      tab.dom.messagesEl.scrollTop = 500;

      tab.dom.messagesEl.dispatchEvent({ type: 'wheel' });
      tab.dom.messagesEl.scrollTop = 250;
      tab.dom.messagesEl.dispatchEvent('scroll');

      expect(tab.state.autoScrollEnabled).toBe(false);

      tab.dom.messagesEl.scrollTop = 500;
      tab.dom.messagesEl.dispatchEvent('scroll');

      expect(tab.state.autoScrollEnabled).toBe(true);

      tab.dom.messagesEl.scrollHeight = 1_200;
      await tab.controllers.streamController.handleStreamChunk(
        { type: 'text', content: 'continued' },
        { content: '', role: 'assistant' },
      );
      jest.advanceTimersByTime(16);

      expect(tab.dom.messagesEl.scrollTop).toBe(1_200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps auto-scroll armed during downward wheel momentum at the bottom', async () => {
    jest.useFakeTimers();
    try {
      const tab = await createTestTab({
        plugin: createPlugin(),
        containerEl: createMockEl() as any,
      });
      tab.state.isStreaming = true;
      tab.dom.messagesEl.scrollHeight = 1_000;
      tab.dom.messagesEl.clientHeight = 500;
      tab.dom.messagesEl.scrollTop = 250;
      tab.state.autoScrollEnabled = false;

      tab.dom.messagesEl.dispatchEvent({ type: 'wheel', deltaY: 120 });
      tab.dom.messagesEl.scrollTop = 500;
      tab.dom.messagesEl.dispatchEvent('scroll');

      expect(tab.state.autoScrollEnabled).toBe(true);

      for (let index = 0; index < 3; index++) {
        tab.dom.messagesEl.dispatchEvent({ type: 'wheel', deltaY: 120 });
      }

      expect(tab.state.autoScrollEnabled).toBe(true);

      tab.dom.messagesEl.scrollHeight = 1_200;
      await tab.controllers.streamController.handleStreamChunk(
        { type: 'text', content: 'continued' },
        { content: '', role: 'assistant' },
      );
      jest.advanceTimersByTime(16);

      expect(tab.dom.messagesEl.scrollTop).toBe(1_200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let a pending bottom re-arm override newer navigation', async () => {
    jest.useFakeTimers();
    try {
      const tab = await createTestTab({
        plugin: createPlugin(),
        containerEl: createMockEl() as any,
      });
      tab.dom.messagesEl.scrollHeight = 1_000;
      tab.dom.messagesEl.clientHeight = 500;
      tab.dom.messagesEl.scrollTop = 500;
      tab.dom.messagesEl.scrollTo = jest.fn();
      tab.state.autoScrollEnabled = false;

      tab.dom.messagesEl.dispatchEvent('scroll');
      tab.dom.messagesWrapperEl.querySelector('.claudian-nav-btn-top')?.click();
      tab.dom.messagesEl.dispatchEvent({ type: 'wheel', deltaY: 120 });
      jest.advanceTimersByTime(150);

      expect(tab.state.autoScrollEnabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases the renderer file-link listener during tab teardown', async () => {
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    }, {
      component: {
        registerDomEvent: (
          element: HTMLElement,
          event: string,
          handler: EventListener,
        ) => element.addEventListener(event, handler),
      },
    });
    const messagesEl = tab.dom.messagesEl as any;

    expect(messagesEl.getEventListenerCount('click')).toBe(1);
    await destroyTab(tab);
    expect(messagesEl.getEventListenerCount('click')).toBe(0);
  });

  it('exposes only stable session fields to provider catalog callbacks', async () => {
    const getProviderCatalogConfig = jest.fn((_context: unknown) => null);
    const tab = await createTestTab(
      {
        plugin: createPlugin(),
        containerEl: createMockEl() as any,
      },
      { getProviderCatalogConfig },
    );

    expect(getProviderCatalogConfig).toHaveBeenCalled();
    const constructionContext = getProviderCatalogConfig.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(constructionContext).sort()).toEqual([
      'conversationId',
      'draftModel',
      'id',
      'lifecycleState',
      'providerId',
    ]);
    expect(constructionContext).not.toBe(tab);
    expect(constructionContext).not.toHaveProperty('controllers');
    expect(constructionContext).not.toHaveProperty('dom');
    expect(constructionContext).not.toHaveProperty('session');
    expect(constructionContext).not.toHaveProperty('state');

    tab.draftModel = 'claude-alternate';
    tab.lifecycleState = 'warm';
    tab.providerCatalogResolver();

    const currentContext = getProviderCatalogConfig.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(currentContext).toBe(constructionContext);
    expect(currentContext.draftModel).toBe('claude-alternate');
    expect(currentContext.lifecycleState).toBe('warm');
  });

  it('publishes only a structurally ready runtime from TabManager', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const plugin = createPlugin();
    const onTabCreated = jest.fn();
    const manager = createTabManager(plugin, createMockEl(), { onTabCreated });

    try {
      const tab = await manager.createTab();

      expect(tab).not.toBeNull();
      expect(tab?.executionCoordinator).not.toBeNull();
      expect(tab?.renderer).not.toBeNull();
      expect(Object.values(tab?.controllers ?? {})).not.toContain(null);
      expect(tab?.services.titleGenerationService).not.toBeNull();
      expect(tab?.providerCatalogResolver).not.toBeNull();
      expect(tab?.ui.contextTray).not.toBeNull();
      expect(tab?.ui.fileContextManager).not.toBeNull();
      expect(tab?.ui.imageContextManager).not.toBeNull();
      expect(tab?.ui.modelSelector).not.toBeNull();
      expect(tab?.ui.modeSelector).not.toBeNull();
      expect(tab?.ui.thinkingBudgetSelector).not.toBeNull();
      expect(tab?.ui.externalContextSelector).not.toBeNull();
      expect(tab?.ui.permissionToggle).not.toBeNull();
      expect(tab?.ui.serviceTierToggle).not.toBeNull();
      expect(tab?.ui.slashCommandDropdown).not.toBeNull();
      expect(tab?.ui.instructionModeManager).not.toBeNull();
      expect(tab?.ui.contextUsageMeter).not.toBeNull();
      expect(tab?.ui.statusPanel).not.toBeNull();
      expect(tab?.hydrationState).toBe('ready');
      expect(tab?.lifecycleState).toBe('cold');
      expect(onTabCreated).toHaveBeenCalledWith(tab);
      expect(coordinatorInstances[0].prepare).not.toHaveBeenCalled();
    } finally {
      await manager.destroy();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('hydrates a restored ready runtime without preparing provider execution', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const conversation = createConversation();
    const plugin = createPlugin({
      getCachedConversation: jest.fn().mockReturnValue(conversation),
      getConversationSync: jest.fn().mockReturnValue(conversation),
      switchConversation: jest.fn().mockResolvedValue(conversation),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    const manager = createTabManager(plugin);

    try {
      const tab = await manager.createTab(conversation.id);

      expect(tab?.conversationId).toBe(conversation.id);
      expect(tab?.state.currentConversationId).toBe(conversation.id);
      expect(tab?.hydrationState).toBe('ready');
      expect(tab?.lifecycleState).toBe('cold');
      expect(coordinatorInstances[0].bindConversation).toHaveBeenCalledWith({
        conversationId: conversation.id,
        providerId: conversation.providerId,
        resumeSeed: {
          providerSessionId: conversation.sessionId,
          providerState: conversation.providerState,
          resumeCheckpoint: conversation.resumeAtMessageId,
        },
      });
      expect(coordinatorInstances[0].prepare).not.toHaveBeenCalled();
    } finally {
      await manager.destroy();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('rolls back DOM ownership when shell construction fails', async () => {
    const shellError = new Error('shell DOM construction failed');
    const tabId = 'shell-failure';
    const { containerEl, removeTabRoot, tabRoot } = createTrackedTabContainer();
    tabRoot.createDiv = jest.fn().mockImplementation(() => {
      throw shellError;
    });
    const onTabCreated = jest.fn();
    const manager = createTabManager(createPlugin(), containerEl, { onTabCreated });

    await expect(manager.createTab(null, tabId)).rejects.toBe(shellError);

    expect(manager.getAllTabs()).toEqual([]);
    expect(onTabCreated).not.toHaveBeenCalled();
    expect(removeTabRoot).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances).toHaveLength(0);
    expectTabManagerMetadataReleased(manager, tabId);
    await manager.destroy();
  });

  it('rolls back an unpublished runtime when UI construction fails', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const assemblyError = new Error('resize observer failed');
    const tabId = 'ui-failure';
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => {
      throw assemblyError;
    }) as unknown as typeof ResizeObserver;
    const plugin = createPlugin();
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const onTabCreated = jest.fn();
    const manager = createTabManager(plugin, containerEl, { onTabCreated });

    try {
      await expect(manager.createTab(null, tabId)).rejects.toBe(assemblyError);

      expect(manager.getAllTabs()).toEqual([]);
      expect(onTabCreated).not.toHaveBeenCalled();
      expect(removeTabRoot).toHaveBeenCalledTimes(1);
      expect(coordinatorInstances).toHaveLength(1);
      expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
      expect(titleServiceInstances[0].cancel).toHaveBeenCalledTimes(1);
      expectTabManagerMetadataReleased(manager, tabId);
    } finally {
      await manager.destroy();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('rolls back UI and shell ownership when controller construction fails', async () => {
    const controllerError = new Error('controller construction failed');
    const tabId = 'controller-failure';
    const disconnect = jest.fn();
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect,
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const onTabCreated = jest.fn();
    const manager = createTabManager(createPlugin(), containerEl, { onTabCreated }, {
      getSharedSelectionFocusScopeEls: () => {
        throw controllerError;
      },
    });

    await expect(manager.createTab(null, tabId)).rejects.toBe(controllerError);

    expect(manager.getAllTabs()).toEqual([]);
    expect(onTabCreated).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(titleServiceInstances[0].cancel).toHaveBeenCalledTimes(1);
    expect(removeTabRoot).toHaveBeenCalledTimes(1);
    expectTabManagerMetadataReleased(manager, tabId);
    await manager.destroy();
  });

  it('rolls back controllers, UI, and shell ownership when input wiring fails', async () => {
    const wiringError = new Error('input wiring failed');
    const tabId = 'input-failure';
    const disconnect = jest.fn();
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect,
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const originalInitialize = NavigationController.prototype.initialize;
    const initializeSpy = jest
      .spyOn(NavigationController.prototype, 'initialize')
      .mockImplementation(function(this: NavigationController) {
        originalInitialize.call(this);
        const inputEl = (this as any).deps.getInputEl();
        const addEventListener = inputEl.addEventListener.bind(inputEl);
        inputEl.addEventListener = jest.fn((event: string, ...args: unknown[]) => {
          if (event === 'keydown') throw wiringError;
          return addEventListener(event, ...args);
        });
      });
    const disposeSpy = jest.spyOn(NavigationController.prototype, 'dispose');
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const onTabCreated = jest.fn();
    const manager = createTabManager(createPlugin(), containerEl, { onTabCreated });

    try {
      await expect(manager.createTab(null, tabId)).rejects.toBe(wiringError);

      expect(manager.getAllTabs()).toEqual([]);
      expect(onTabCreated).not.toHaveBeenCalled();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
      expect(titleServiceInstances[0].cancel).toHaveBeenCalledTimes(1);
      expect(removeTabRoot).toHaveBeenCalledTimes(1);
      expectTabManagerMetadataReleased(manager, tabId);
    } finally {
      initializeSpy.mockRestore();
      disposeSpy.mockRestore();
      await manager.destroy();
    }
  });

  it('preserves the construction cause when rollback also fails', async () => {
    const assemblyError = new Error('UI construction failed');
    const rollbackError = new Error('coordinator disposal failed');
    const tabId = 'rollback-failure';
    coordinatorDisposeError = rollbackError;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => {
      throw assemblyError;
    }) as unknown as typeof ResizeObserver;
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const manager = createTabManager(createPlugin(), containerEl);

    const error = await manager.createTab(null, tabId).catch(cause => cause);

    expect(error).toBeInstanceOf(TabRuntimeConstructionError);
    expect(error.cause).toBe(assemblyError);
    expect(error.rollbackFailures).toEqual([
      { error: rollbackError, resource: 'tab execution coordinator' },
    ]);
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(titleServiceInstances[0].cancel).toHaveBeenCalledTimes(1);
    expect(removeTabRoot).toHaveBeenCalledTimes(1);
    expect(manager.getAllTabs()).toEqual([]);
    expectTabManagerMetadataReleased(manager, tabId);
    await manager.destroy();
  });

  it('snapshots the global provider-qualified model without changing an existing blank tab', async () => {
    const plugin = createPlugin();
    plugin.settings.lastSelectedChatModel = {
      providerId: 'claude',
      model: 'claude-default',
    };
    const existing = await createTestTab({ plugin, containerEl: createMockEl() as any });

    plugin.settings.lastSelectedChatModel = {
      providerId: 'claude',
      model: 'claude-alternate',
    };
    const next = await createTestTab({ plugin, containerEl: createMockEl() as any });

    expect(existing.draftModel).toBe('claude-default');
    expect(next.draftModel).toBe('claude-alternate');
    expect(next.providerId).toBe('claude');
  });

  it('adopts a provider default when a model-less blank tab gains available options', async () => {
    const plugin = createPlugin();
    const uiConfig = ProviderRegistry.getChatUIConfig('claude');
    (uiConfig.getDefaultModel as jest.Mock).mockReturnValue(null);
    (uiConfig.getModelOptions as jest.Mock).mockReturnValue([]);
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });

    expect(tab.draftModel).toBeNull();

    (uiConfig.getDefaultModel as jest.Mock).mockReturnValue('claude-default');
    (uiConfig.getModelOptions as jest.Mock).mockReturnValue([
      { label: 'Claude Default', value: 'claude-default' },
    ]);

    expect(onProviderAvailabilityChanged(tab, plugin)).toBe(true);
    expect(tab.draftModel).toBe('claude-default');
    expect(tab.providerId).toBe('claude');
  });

  it('records an explicit blank-tab model choice as the future-tab seed', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const plugin = createPlugin();
    const onDraftModelChanged = jest.fn();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      onDraftModelChanged,
    });
    const modelOptions = Array.from(
      tab.dom.inputWrapper.querySelectorAll(
        '.claudian-model-option',
      ) as NodeListOf<HTMLElement>,
    );
    const alternate = modelOptions.find(option =>
      Array.from(option.children).some(child => child.textContent === 'Claude Alternate')
    );

    (alternate as HTMLElement | undefined)?.click();
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(tab.draftModel).toBe('claude-alternate');
    expect(plugin.settings.lastSelectedChatModel).toEqual({
      providerId: 'claude',
      model: 'claude-alternate',
    });
    expect(onDraftModelChanged).toHaveBeenCalledWith(tab, 'claude-alternate');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('does not seed a model choice whose tab closes during provider initialization', async () => {
    const getChatUIConfig = ProviderRegistry.getChatUIConfig as jest.Mock;
    const getEnabledProviderIds = ProviderRegistry.getEnabledProviderIds as jest.Mock;
    const resolveProviderForModel = ProviderRegistry.resolveProviderForModel as jest.Mock;
    const claudeConfig = getChatUIConfig('claude');
    const codexConfig = {
      ...claudeConfig,
      getModelOptions: jest.fn().mockReturnValue([
        { label: 'Codex', value: 'codex-default' },
      ]),
    };
    getChatUIConfig.mockImplementation((providerId: string) => (
      providerId === 'codex' ? codexConfig : claudeConfig
    ));
    getEnabledProviderIds.mockReturnValue(['claude', 'codex']);
    resolveProviderForModel.mockImplementation((model: string) => (
      model.startsWith('codex-') ? 'codex' : 'claude'
    ));
    const initialization = deferred<void>();
    const onProviderChanged = jest.fn(() => initialization.promise);

    try {
      const plugin = createPlugin();
      const tab = await createTestTab({ plugin, containerEl: createMockEl() as any }, {
        onProviderChanged,
      });
      const modelOptions = Array.from(
        tab.dom.inputWrapper.querySelectorAll(
          '.claudian-model-option',
        ) as NodeListOf<HTMLElement>,
      );
      const codex = modelOptions.find(option =>
        Array.from(option.children).some(child => child.textContent === 'Codex')
      );

      (codex as HTMLElement | undefined)?.click();
      for (let attempt = 0;
        attempt < 10 && onProviderChanged.mock.calls.length === 0;
        attempt += 1) {
        await Promise.resolve();
      }
      tab.lifecycleState = 'closing';
      initialization.resolve(undefined);
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
    } finally {
      getChatUIConfig.mockReturnValue(claudeConfig);
      getEnabledProviderIds.mockReturnValue(['claude']);
      resolveProviderForModel.mockReturnValue('claude');
    }
  });

  it('does not rebuild provider services when failed selection settles after teardown', async () => {
    const getChatUIConfig = ProviderRegistry.getChatUIConfig as jest.Mock;
    const getEnabledProviderIds = ProviderRegistry.getEnabledProviderIds as jest.Mock;
    const resolveProviderForModel = ProviderRegistry.resolveProviderForModel as jest.Mock;
    const createInstructionRefineService = ProviderRegistry
      .createInstructionRefineService as jest.Mock;
    const getIfInitialized = ProviderWorkspaceRegistry.getIfInitialized as jest.Mock;
    const claudeConfig = getChatUIConfig('claude');
    const codexConfig = {
      ...claudeConfig,
      getModelOptions: jest.fn().mockReturnValue([
        { label: 'Codex', value: 'codex-default' },
      ]),
    };
    getChatUIConfig.mockImplementation((providerId: string) => (
      providerId === 'codex' ? codexConfig : claudeConfig
    ));
    getEnabledProviderIds.mockReturnValue(['claude', 'codex']);
    resolveProviderForModel.mockImplementation((model: string) => (
      model.startsWith('codex-') ? 'codex' : 'claude'
    ));
    getIfInitialized.mockReturnValue({});
    createInstructionRefineService.mockImplementation(() => ({
      cancel: jest.fn(),
      resetConversation: jest.fn(),
    }));
    const initialization = deferred<void>();
    const onProviderChanged = jest.fn(() => initialization.promise);

    try {
      const plugin = createPlugin();
      const tab = await createTestTab({ plugin, containerEl: createMockEl() as any }, {
        onProviderChanged,
      });
      const modelOptions = Array.from(
        tab.dom.inputWrapper.querySelectorAll(
          '.claudian-model-option',
        ) as NodeListOf<HTMLElement>,
      );
      const codex = modelOptions.find(option =>
        Array.from(option.children).some(child => child.textContent === 'Codex')
      );

      (codex as HTMLElement | undefined)?.click();
      for (let attempt = 0;
        attempt < 10 && onProviderChanged.mock.calls.length === 0;
        attempt += 1) {
        await Promise.resolve();
      }
      await destroyTab(tab);
      const serviceCreationsAtTeardown = createInstructionRefineService.mock.calls.length;
      initialization.reject(new Error('Codex initialization failed'));
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(createInstructionRefineService).toHaveBeenCalledTimes(
        serviceCreationsAtTeardown,
      );
    } finally {
      createInstructionRefineService.mockReturnValue(null);
      getIfInitialized.mockReturnValue(null);
      getChatUIConfig.mockReturnValue(claudeConfig);
      getEnabledProviderIds.mockReturnValue(['claude']);
      resolveProviderForModel.mockReturnValue('claude');
    }
  });

  it('does not seed a blank-tab model choice after its commit loses runtime ownership', async () => {
    const commitGate = deferred<void>();
    const plugin = createPlugin();
    plugin.chatModelSelection.commitIntent = jest.fn(async (
      _intent: number,
      selection: Record<string, unknown>,
      isStillValid?: () => boolean,
    ) => {
      await commitGate.promise;
      if (isStillValid && !isStillValid()) return false;
      plugin.settings.lastSelectedChatModel = selection;
      return true;
    });
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const modelOptions = Array.from(
      tab.dom.inputWrapper.querySelectorAll(
        '.claudian-model-option',
      ) as NodeListOf<HTMLElement>,
    );
    const alternate = modelOptions.find(option =>
      Array.from(option.children).some(child => child.textContent === 'Claude Alternate')
    );

    (alternate as HTMLElement | undefined)?.click();
    for (let attempt = 0;
      attempt < 10 && plugin.chatModelSelection.commitIntent.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    tab.lifecycleState = 'closing';
    commitGate.resolve(undefined);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
  });

  it('does not seed an uninitialized provider after overlapping same-provider choices fail', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const getChatUIConfig = ProviderRegistry.getChatUIConfig as jest.Mock;
    const getEnabledProviderIds = ProviderRegistry.getEnabledProviderIds as jest.Mock;
    const resolveProviderForModel = ProviderRegistry.resolveProviderForModel as jest.Mock;
    const claudeConfig = getChatUIConfig('claude');
    const codexConfig = {
      ...claudeConfig,
      getModelOptions: jest.fn().mockReturnValue([
        { label: 'Codex First', value: 'codex-first' },
        { label: 'Codex Latest', value: 'codex-latest' },
      ]),
    };
    getChatUIConfig.mockImplementation((providerId: string) => (
      providerId === 'codex' ? codexConfig : claudeConfig
    ));
    getEnabledProviderIds.mockReturnValue(['claude', 'codex']);
    resolveProviderForModel.mockImplementation((model: string) => (
      model.startsWith('codex-') ? 'codex' : 'claude'
    ));
    let rejectCodexSwitch!: (error: Error) => void;
    const codexSwitch = new Promise<void>((_resolve, reject) => {
      rejectCodexSwitch = reject;
    });

    try {
      const plugin = createPlugin();
      const tab = await createTestTab({ plugin, containerEl: createMockEl() as any }, {
        onProviderChanged: () => codexSwitch,
      });
      const modelOptions = Array.from(
        tab.dom.inputWrapper.querySelectorAll(
          '.claudian-model-option',
        ) as NodeListOf<HTMLElement>,
      );
      const first = modelOptions.find(option =>
        Array.from(option.children).some(child => child.textContent === 'Codex First')
      );
      const latest = modelOptions.find(option =>
        Array.from(option.children).some(child => child.textContent === 'Codex Latest')
      );

      (first as HTMLElement | undefined)?.click();
      (latest as HTMLElement | undefined)?.click();
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(tab.providerId).toBe('codex');
      expect(tab.draftModel).toBe('codex-latest');

      rejectCodexSwitch(new Error('Codex initialization failed'));
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(tab.providerId).toBe('claude');
      expect(tab.draftModel).toBe('claude-default');
      expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
    } finally {
      getChatUIConfig.mockReturnValue(claudeConfig);
      getEnabledProviderIds.mockReturnValue(['claude']);
      resolveProviderForModel.mockReturnValue('claude');
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('records an explicit bound-conversation model choice without changing its provider', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const conversation = createConversation();
    const plugin = createPlugin({
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    });
    const modelOptions = Array.from(
      tab.dom.inputWrapper.querySelectorAll(
        '.claudian-model-option',
      ) as NodeListOf<HTMLElement>,
    );
    const alternate = modelOptions.find(option =>
      Array.from(option.children).some(child => child.textContent === 'Claude Alternate')
    );

    (alternate as HTMLElement | undefined)?.click();
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(plugin.updateConversation).toHaveBeenCalledWith(conversation.id, {
      selectedModel: 'claude-alternate',
    });
    expect(plugin.settings.lastSelectedChatModel).toEqual({
      providerId: 'claude',
      model: 'claude-alternate',
    });
    expect(tab.providerId).toBe('claude');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('does not seed a bound model choice after its commit loses runtime ownership', async () => {
    const commitGate = deferred<void>();
    const conversation = createConversation();
    const plugin = createPlugin({
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    plugin.chatModelSelection.commitIntent = jest.fn(async (
      _intent: number,
      selection: Record<string, unknown>,
      isStillValid?: () => boolean,
    ) => {
      await commitGate.promise;
      if (isStillValid && !isStillValid()) return false;
      plugin.settings.lastSelectedChatModel = selection;
      return true;
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    });
    const modelOptions = Array.from(
      tab.dom.inputWrapper.querySelectorAll(
        '.claudian-model-option',
      ) as NodeListOf<HTMLElement>,
    );
    const alternate = modelOptions.find(option =>
      Array.from(option.children).some(child => child.textContent === 'Claude Alternate')
    );

    (alternate as HTMLElement | undefined)?.click();
    for (let attempt = 0;
      attempt < 10 && plugin.chatModelSelection.commitIntent.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    tab.lifecycleState = 'closing';
    commitGate.resolve(undefined);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
  });

  it('does not apply a bound model choice to a conversation rebound during persistence', async () => {
    const persistence = deferred<void>();
    const conversation = createConversation();
    const plugin = createPlugin({
      updateConversation: jest.fn(() => persistence.promise),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    });
    const modelOptions = Array.from(
      tab.dom.inputWrapper.querySelectorAll(
        '.claudian-model-option',
      ) as NodeListOf<HTMLElement>,
    );
    const alternate = modelOptions.find(option =>
      Array.from(option.children).some(child => child.textContent === 'Claude Alternate')
    );

    (alternate as HTMLElement | undefined)?.click();
    for (let attempt = 0;
      attempt < 10 && plugin.updateConversation.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    tab.conversationId = 'conversation-2';
    persistence.resolve(undefined);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(plugin.updateConversation).toHaveBeenCalledWith(conversation.id, {
      selectedModel: 'claude-alternate',
    });
    expect(plugin.chatModelSelection.commitIntent).not.toHaveBeenCalled();
    expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
  });

  it('binds persisted native state and prepares only for a bound conversation', async () => {
    const conversation = createConversation();
    const plugin = createPlugin({
      getConversationById: jest.fn().mockResolvedValue(conversation),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    });
    const coordinator = coordinatorInstances[0];

    await initializeTabExecution(tab, plugin);

    expect(ensureInitialized).toHaveBeenCalledWith(
      plugin.providerHost,
      'claude',
      'tab-execution',
    );
    expect(coordinator.bindConversation).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      providerId: 'claude',
      resumeSeed: {
        providerSessionId: 'native-session',
        providerState: { threadId: 'thread-1' },
        resumeCheckpoint: 'checkpoint-1',
      },
    });
    expect(coordinator.prepare).toHaveBeenCalledTimes(1);
    expect(tab.lifecycleState).toBe('warm');
  });

  it('keeps blank-tab initialization session-free', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
    });
    const coordinator = coordinatorInstances[0];

    await initializeTabExecution(tab, plugin, null);

    expect(coordinator.bindConversation).toHaveBeenCalledWith(null);
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it('routes /clear through the view layout before resetting the current tab', async () => {
    const conversation = createConversation();
    const plugin = createPlugin();
    const handleNewConversationCommand = jest.fn().mockResolvedValue(true);
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    }, { component: { handleNewConversationCommand } });
    tab.dom.inputEl.value = '/clear';

    await tab.controllers.inputController!.sendMessage();

    expect(handleNewConversationCommand).toHaveBeenCalledTimes(1);
    expect(tab.conversationId).toBe(conversation.id);
  });

  it('does not route view-owned commands from a closing runtime', async () => {
    const handleNewConversationCommand = jest.fn().mockResolvedValue(true);
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
      conversation: createConversation(),
    }, { component: { handleNewConversationCommand } });
    tab.lifecycleState = 'closing';
    tab.dom.inputEl.value = '/clear';

    await tab.controllers.inputController.sendMessage();

    expect(handleNewConversationCommand).not.toHaveBeenCalled();
  });

  it('commits a provisional preview to cold state when the user types', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      lifecycleState: 'provisional',
    });
    expect(tab.session.userOwnershipRevision).toBe(0);

    tab.dom.inputEl.value = 'Keep this draft';
    (tab.dom.inputEl as any).dispatchEvent('input');

    expect(tab.lifecycleState).toBe('cold');
    expect(tab.session.userOwnershipRevision).toBe(1);
  });

  it('records user ownership when a retained cold tab is edited', async () => {
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    });

    tab.dom.inputEl.value = 'Keep this runtime';
    (tab.dom.inputEl as any).dispatchEvent('input');

    expect(tab.lifecycleState).toBe('cold');
    expect(tab.session.userOwnershipRevision).toBe(1);
  });

  it('commits a provisional preview to cold state when the user attaches an image', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      lifecycleState: 'provisional',
    });
    const attached = await (tab.ui.imageContextManager as any).addImageFromFile({
      arrayBuffer: async () => new Uint8Array([1]).buffer,
      name: 'draft.png',
      size: 1,
      type: 'image/png',
    }, 'paste');

    expect(attached).toBe(true);
    expect(tab.lifecycleState).toBe('cold');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('commits a provisional preview when the user removes captured editor context', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      lifecycleState: 'provisional',
    });
    const selectionController = tab.controllers.selectionController as any;
    selectionController.storedSelection = {
      lineCount: 1,
      notePath: 'note.md',
      selectedText: 'draft context',
    };
    selectionController.updateIndicator();

    const removeButton = tab.dom.contextRowEl.querySelector(
      '.claudian-context-chip-remove',
    ) as any;
    removeButton.dispatchEvent('click');

    expect(tab.lifecycleState).toBe('cold');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('keeps a browsed conversation provisional after hydration', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const conversation = createConversation();
    const plugin = createPlugin({
      getConversationSync: jest.fn().mockReturnValue(conversation),
      switchConversation: jest.fn().mockResolvedValue(conversation),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
      lifecycleState: 'provisional',
    });
    await tab.controllers.conversationController!.switchTo(conversation.id);

    expect(tab.lifecycleState).toBe('provisional');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('activates conversation-owned input after the real tab switch callback settles', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const oldConversation = createConversation();
    const nextConversation = {
      ...createConversation(),
      id: 'conversation-2',
      sessionId: 'native-session-2',
    };
    const plugin = createPlugin({
      getConversationSync: jest.fn((id) => (
        id === oldConversation.id ? oldConversation : nextConversation
      )),
      switchConversation: jest.fn().mockResolvedValue(nextConversation),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation: oldConversation,
    });
    tab.state.currentConversationId = oldConversation.id;
    const onConversationActivated = jest.spyOn(
      tab.controllers.inputController!,
      'onConversationActivated',
    ).mockImplementation(() => {
      expect(tab.state.isSwitchingConversation).toBe(false);
    });

    await tab.controllers.conversationController!.switchTo(nextConversation.id);

    expect(onConversationActivated).toHaveBeenCalledTimes(1);
    expect(tab.state.currentConversationId).toBe(nextConversation.id);
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('invalidates command context before publishing a conversation rebind', async () => {
    const oldConversation = createConversation();
    const nextConversation = {
      ...createConversation(),
      id: 'conversation-2',
      sessionId: 'native-session-2',
    };
    const onCommandContextChanged = jest.fn();
    const plugin = createPlugin({
      getConversationSync: jest.fn().mockReturnValue(oldConversation),
      switchConversation: jest.fn().mockResolvedValue(nextConversation),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation: oldConversation,
      onCommandContextChanged,
    });
    tab.state.currentConversationId = oldConversation.id;
    onCommandContextChanged.mockClear();
    const binding = deferred<void>();
    coordinatorInstances[0].bindConversation.mockImplementationOnce(() => binding.promise);

    const transition = tab.controllers.conversationController.switchTo(nextConversation.id);
    for (let attempt = 0;
      attempt < 10 && coordinatorInstances[0].bindConversation.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }

    expect(onCommandContextChanged).toHaveBeenCalledTimes(1);
    expect(onCommandContextChanged.mock.invocationCallOrder[0])
      .toBeLessThan(coordinatorInstances[0].bindConversation.mock.invocationCallOrder[0]);
    binding.resolve(undefined);
    await transition;
  });

  it('routes requested events through the current input controller', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const handleExecutionEvent = jest.fn();
    tab.controllers.inputController = { handleExecutionEvent } as any;
    const event = { type: 'text_delta' } as any;

    await coordinatorDeps[0].onRequestedEvent?.(event, {} as any);

    expect(handleExecutionEvent).toHaveBeenCalledWith(event);
  });

  it('routes provider interactions through the current input controller', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const handleApprovalRequest = jest.fn().mockResolvedValue('allow');
    tab.controllers.inputController = {
      handleApprovalRequest,
    } as any;

    await expect(coordinatorDeps[0].interactionPort.requestApproval({
      description: 'Read note',
      input: { path: 'note.md' },
      interactionId: 'interaction-1',
      kind: 'approval',
      sessionInstanceId: 'session-instance-1',
      toolName: 'Read',
      turnId: 'turn-1',
    }, new AbortController().signal)).resolves.toEqual({
      decision: 'allow',
      interactionId: 'interaction-1',
    });
    expect(handleApprovalRequest).toHaveBeenCalledWith(
      'Read',
      { path: 'note.md' },
      'Read note',
      {},
    );
    expect(tab.state.attention).toBeNull();
  });

  it('keeps provider interactions action-required until they settle', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    let resolveApproval!: (decision: string) => void;
    const handleApprovalRequest = jest.fn().mockReturnValue(new Promise((resolve) => {
      resolveApproval = resolve;
    }));
    tab.controllers.inputController = { handleApprovalRequest } as any;

    const request = coordinatorDeps[0].interactionPort.requestApproval({
      description: 'Read note',
      input: {},
      interactionId: 'interaction-1',
      kind: 'approval',
      sessionInstanceId: 'session-instance-1',
      toolName: 'Read',
      turnId: 'turn-1',
    }, new AbortController().signal);

    await Promise.resolve();
    expect(tab.state.requiresAction).toBe(true);
    expect(coordinatorDeps[0].warmExecution?.canCool()).toBe(false);

    resolveApproval('allow');
    await request;

    expect(tab.state.attention).toBeNull();
  });

  it('allows review-only tabs to cool', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });

    tab.state.markReviewRequired();

    expect(coordinatorDeps[0].warmExecution?.canCool()).toBe(true);
  });

  it('buffers normalized background output and persists it on completion', async () => {
    const plugin = createPlugin();
    const onReviewableSettlement = jest.fn();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      captureReviewableSettlement: () => onReviewableSettlement,
    });
    Object.defineProperty(tab.dom.contentEl, 'isConnected', { value: true });
    const assistantEl = createMockEl();
    assistantEl.querySelector = jest.fn().mockReturnValue(createMockEl());
    tab.renderer = {
      addMessage: jest.fn().mockReturnValue(assistantEl),
      scrollToBottom: jest.fn(),
    } as any;
    tab.controllers.streamController = {
      appendText: jest.fn(),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      handleStreamChunk: jest.fn(),
      hideThinkingIndicator: jest.fn(),
    } as any;
    tab.controllers.conversationController = {
      save: jest.fn().mockResolvedValue(undefined),
    } as any;
    const backgroundScope = {
      kind: 'background' as const,
      sequence: 1,
      sessionInstanceId: 'session-instance-1',
      turnId: 'background-turn-1',
    };

    const context = createEventContext();
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_started',
      scope: backgroundScope,
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'text_delta',
      text: 'background result',
      scope: { ...backgroundScope, sequence: 2 },
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_completed',
      reason: 'completed',
      scope: { ...backgroundScope, sequence: 3 },
    }, context);

    expect(tab.controllers.streamController!.handleStreamChunk).toHaveBeenCalledWith(
      { content: 'background result', type: 'text' },
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(tab.controllers.conversationController!.save).toHaveBeenCalledWith(true);
    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('captures background review activity before persistence completes', async () => {
    const plugin = createPlugin();
    const reportReviewableSettlement = jest.fn();
    let resolveCapture!: () => void;
    const captureReached = new Promise<void>((resolve) => {
      resolveCapture = resolve;
    });
    const captureReviewableSettlement = jest.fn(() => {
      resolveCapture();
      return reportReviewableSettlement;
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      captureReviewableSettlement,
    });
    Object.defineProperty(tab.dom.contentEl, 'isConnected', { value: true });
    const assistantEl = createMockEl();
    assistantEl.querySelector = jest.fn().mockReturnValue(createMockEl());
    tab.renderer = {
      addMessage: jest.fn().mockReturnValue(assistantEl),
      scrollToBottom: jest.fn(),
    } as any;
    tab.controllers.streamController = {
      appendText: jest.fn(),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      handleStreamChunk: jest.fn(),
      hideThinkingIndicator: jest.fn(),
    } as any;
    let resolveSave!: () => void;
    const save = jest.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    tab.controllers.conversationController = { save } as any;
    const backgroundScope = {
      kind: 'background' as const,
      sequence: 1,
      sessionInstanceId: 'session-instance-1',
      turnId: 'background-turn-slow-save',
    };
    const context = createEventContext();

    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_started',
      scope: backgroundScope,
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'text_delta',
      text: 'background result',
      scope: { ...backgroundScope, sequence: 2 },
    }, context);
    const completion = coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_completed',
      reason: 'completed',
      scope: { ...backgroundScope, sequence: 3 },
    }, context);

    await captureReached;
    expect(captureReviewableSettlement).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(true);
    expect(reportReviewableSettlement).not.toHaveBeenCalled();

    resolveSave();
    await completion;

    expect(reportReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('records background completion activity without renderable output', async () => {
    const plugin = createPlugin();
    const onReviewableSettlement = jest.fn();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      captureReviewableSettlement: () => onReviewableSettlement,
    });
    Object.defineProperty(tab.dom.contentEl, 'isConnected', { value: true });
    const save = jest.fn().mockResolvedValue(undefined);
    tab.controllers.conversationController = {
      save,
    } as any;
    const backgroundScope = {
      kind: 'background' as const,
      sequence: 1,
      sessionInstanceId: 'session-instance-1',
      turnId: 'background-turn-empty',
    };
    const context = createEventContext();

    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_started',
      scope: backgroundScope,
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_completed',
      reason: 'completed',
      scope: { ...backgroundScope, sequence: 2 },
    }, context);

    expect(save).toHaveBeenCalledWith(true);
    expect(onReviewableSettlement).not.toHaveBeenCalled();
  });

  it('does not request review for metadata-only background output', async () => {
    const plugin = createPlugin();
    const onReviewableSettlement = jest.fn();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      captureReviewableSettlement: () => onReviewableSettlement,
    });
    Object.defineProperty(tab.dom.contentEl, 'isConnected', { value: true });
    const handleStreamChunk = jest.fn();
    const save = jest.fn().mockResolvedValue(undefined);
    tab.controllers.streamController = { handleStreamChunk } as any;
    tab.controllers.conversationController = { save } as any;
    const backgroundScope = {
      kind: 'background' as const,
      sequence: 1,
      sessionInstanceId: 'session-instance-1',
      turnId: 'background-turn-metadata',
    };
    const context = createEventContext();

    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_started',
      scope: backgroundScope,
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'usage_updated',
      usage: {
        contextTokens: 10,
        contextWindow: 100,
        inputTokens: 10,
        percentage: 10,
      },
      scope: { ...backgroundScope, sequence: 2 },
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_completed',
      reason: 'completed',
      scope: { ...backgroundScope, sequence: 3 },
    }, context);

    expect(handleStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'usage' }),
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(save).toHaveBeenCalledWith(true);
    expect(onReviewableSettlement).not.toHaveBeenCalled();
  });

  it('discards binding output when a transition rejects session-event admission', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    Object.defineProperty(tab.dom.contentEl, 'isConnected', { value: true });
    const assistantEl = createMockEl();
    assistantEl.querySelector = jest.fn().mockReturnValue(createMockEl());
    tab.renderer = {
      addMessage: jest.fn().mockReturnValue(assistantEl),
      scrollToBottom: jest.fn(),
    } as any;
    const handleStreamChunk = jest.fn();
    tab.controllers.streamController = {
      appendText: jest.fn(),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      handleStreamChunk,
      hideThinkingIndicator: jest.fn(),
    } as any;
    const save = jest.fn().mockResolvedValue(undefined);
    tab.controllers.conversationController = { save } as any;
    const context = createEventContext();
    const backgroundScope = {
      kind: 'background' as const,
      sequence: 1,
      sessionInstanceId: 'session-instance-1',
      turnId: 'reused-background-turn',
    };

    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_started',
      scope: backgroundScope,
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'text_delta',
      text: 'discarded old output',
      scope: { ...backgroundScope, sequence: 2 },
    }, context);

    tab.state.isSwitchingConversation = true;
    await coordinatorDeps[0].onSessionEvent?.({
      category: 'provider',
      message: 'transition boundary',
      recoverable: true,
      scope: {
        kind: 'session',
        sequence: 1,
        sessionInstanceId: 'session-instance-1',
      },
      type: 'session_error',
    }, context);
    tab.state.isSwitchingConversation = false;

    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_completed',
      reason: 'completed',
      scope: { ...backgroundScope, sequence: 3 },
    }, context);

    expect(handleStreamChunk).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('routes async subagent completion without transcript mutation', async () => {
    const plugin = createPlugin();
    const onReviewableSettlement = jest.fn();
    const captureReviewableSettlement = jest.fn(() => onReviewableSettlement);
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      captureReviewableSettlement,
    });
    const handleAsyncSubagentCompletion = jest.fn().mockResolvedValue(true);
    tab.controllers.streamController = { handleAsyncSubagentCompletion } as any;
    tab.controllers.conversationController = {
      save: jest.fn().mockResolvedValue(undefined),
    } as any;
    coordinatorInstances[0].snapshot = { providerSessionId: 'native-session' };

    await coordinatorDeps[0].onSessionEvent?.({
      originatingTurnId: 'turn-1',
      result: 'done',
      scope: {
        kind: 'session',
        sequence: 1,
        sessionInstanceId: 'session-instance-1',
      },
      status: 'completed',
      subagentId: 'subagent-1',
      type: 'async_subagent_completed',
    }, createEventContext());

    expect(handleAsyncSubagentCompletion).toHaveBeenCalledWith({
      providerSessionId: 'native-session',
      result: 'done',
      status: 'completed',
      taskId: 'subagent-1',
      type: 'async_subagent_completion',
    });
    expect(tab.controllers.conversationController!.save).toHaveBeenCalledWith(true);
    expect(captureReviewableSettlement).toHaveBeenCalledWith(tab, 'completed');
    expect(onReviewableSettlement).toHaveBeenCalledTimes(1);
  });

  it('drains deferred background rendering before a conversation transition can proceed', async () => {
    const oldConversation = createConversation();
    const nextConversation = {
      ...createConversation(),
      id: 'conversation-2',
      sessionId: 'native-session-2',
      title: 'Next conversation',
    };
    const updateConversation = jest.fn().mockResolvedValue(undefined);
    const switchConversation = jest.fn().mockResolvedValue(nextConversation);
    const plugin = createPlugin({
      getConversationSync: jest.fn((id) => (
        id === oldConversation.id ? oldConversation : nextConversation
      )),
      switchConversation,
      updateConversation,
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation: oldConversation,
    });
    tab.state.currentConversationId = oldConversation.id;
    Object.defineProperty(tab.dom.contentEl, 'isConnected', { value: true });
    const assistantEl = createMockEl();
    assistantEl.querySelector = jest.fn().mockReturnValue(createMockEl());
    tab.renderer = {
      addMessage: jest.fn().mockReturnValue(assistantEl),
      renderMessages: jest.fn().mockReturnValue(createMockEl()),
      scrollToBottom: jest.fn(),
    } as any;
    let releaseRender!: () => void;
    const renderBlocked = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const handleStreamChunk = jest.fn().mockReturnValue(renderBlocked);
    tab.controllers.streamController = {
      appendText: jest.fn(),
      finalizeCurrentTextBlock: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn(),
      handleStreamChunk,
      hideThinkingIndicator: jest.fn(),
    } as any;
    const conversationController = installTransitionController(tab, plugin);
    const context = createEventContext();
    const backgroundScope = {
      kind: 'background' as const,
      sequence: 1,
      sessionInstanceId: 'session-instance-1',
      turnId: 'background-turn-race',
    };

    await coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_started',
      scope: backgroundScope,
    }, context);
    await coordinatorDeps[0].onSessionEvent?.({
      type: 'text_delta',
      text: 'old conversation result',
      scope: { ...backgroundScope, sequence: 2 },
    }, context);
    const completion = coordinatorDeps[0].onSessionEvent?.({
      type: 'background_turn_completed',
      reason: 'completed',
      scope: { ...backgroundScope, sequence: 3 },
    }, context);
    for (let attempt = 0; attempt < 10 && handleStreamChunk.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(handleStreamChunk).toHaveBeenCalledTimes(1);

    const transition = conversationController.switchTo('conversation-2');
    const earlyTransition = await Promise.race([
      transition.then(() => 'completed' as const),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 0)),
    ]);
    expect(earlyTransition).toBe('blocked');
    expect(switchConversation).not.toHaveBeenCalled();

    releaseRender();
    await completion;
    await transition;

    expect(updateConversation).toHaveBeenCalled();
    expect(updateConversation.mock.calls.every(([id]) => id === oldConversation.id)).toBe(true);
    expect(tab.state.currentConversationId).toBe('conversation-2');
  });

  it('fences async-subagent recovery while a conversation switch waits for it', async () => {
    const oldConversation = createConversation();
    const nextConversation = {
      ...createConversation(),
      id: 'conversation-2',
      sessionId: 'native-session-2',
      title: 'Next conversation',
    };
    const updateConversation = jest.fn().mockResolvedValue(undefined);
    const switchConversation = jest.fn().mockResolvedValue(nextConversation);
    const plugin = createPlugin({
      getConversationSync: jest.fn((id) => (
        id === oldConversation.id ? oldConversation : nextConversation
      )),
      switchConversation,
      updateConversation,
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation: oldConversation,
    });
    tab.state.currentConversationId = oldConversation.id;
    tab.renderer = {
      renderMessages: jest.fn().mockReturnValue(createMockEl()),
    } as any;
    let releaseRecovery!: (applied: boolean) => void;
    const recoveryBlocked = new Promise<boolean>((resolve) => {
      releaseRecovery = resolve;
    });
    const handleAsyncSubagentCompletion = jest.fn().mockReturnValue(recoveryBlocked);
    tab.controllers.streamController = { handleAsyncSubagentCompletion } as any;
    const conversationController = installTransitionController(tab, plugin);
    const save = jest.spyOn(conversationController, 'save');
    coordinatorInstances[0].snapshot = { providerSessionId: 'native-session' };
    const context = createEventContext();

    const completion = coordinatorDeps[0].onSessionEvent?.({
      originatingTurnId: 'turn-1',
      scope: {
        kind: 'session',
        sequence: 1,
        sessionInstanceId: 'session-instance-1',
      },
      status: 'completed',
      subagentId: 'subagent-1',
      type: 'async_subagent_completed',
    }, context);
    for (
      let attempt = 0;
      attempt < 10 && handleAsyncSubagentCompletion.mock.calls.length === 0;
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(handleAsyncSubagentCompletion).toHaveBeenCalledTimes(1);

    const transition = conversationController.switchTo(nextConversation.id);
    const earlyTransition = await Promise.race([
      transition.then(() => 'completed' as const),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 0)),
    ]);
    expect(earlyTransition).toBe('blocked');
    expect(switchConversation).not.toHaveBeenCalled();

    coordinatorInstances[0].isEventContextCurrent.mockReturnValue(false);
    releaseRecovery(true);
    await completion;
    await transition;

    expect(save).toHaveBeenCalledTimes(1);
    expect(updateConversation.mock.calls.every(([id]) => id === oldConversation.id)).toBe(true);
    expect(tab.state.currentConversationId).toBe(nextConversation.id);
  });

  it('keeps assembled references structurally stable across idempotent teardown', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const manager = createTabManager(createPlugin());

    try {
      const tab = await manager.createTab();
      const coordinator = tab!.executionCoordinator;
      const renderer = tab!.renderer;
      const controllers = tab!.controllers;
      const titleGenerationService = tab!.services.titleGenerationService;
      const contextTray = tab!.ui.contextTray;
      const statusPanel = tab!.ui.statusPanel;

      await destroyTab(tab!);
      await destroyTab(tab!);

      expect(tab!.lifecycleState).toBe('closing');
      expect(tab!.executionCoordinator).toBe(coordinator);
      expect(tab!.renderer).toBe(renderer);
      expect(tab!.controllers).toBe(controllers);
      expect(tab!.services.titleGenerationService).toBe(titleGenerationService);
      expect(tab!.ui.contextTray).toBe(contextTray);
      expect(tab!.ui.statusPanel).toBe(statusPanel);
      expect(coordinator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await manager.destroy();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('rejects replacing the factory-owned runtime resource owner', async () => {
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    });
    const replacementOwner = {
      isDisposed: false,
      dispose: jest.fn().mockResolvedValue([]),
    };

    expect(() => registerTabRuntimeResourceOwner(tab, replacementOwner))
      .toThrow('Tab runtime already has a registered resource owner');

    await destroyTab(tab);

    expect(replacementOwner.dispose).not.toHaveBeenCalled();
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(tab.resources.isDisposed).toBe(true);
  });

  it('continues teardown after a cleanup failure without reacquiring or retrying resources', async () => {
    const cleanupError = new Error('navigation cleanup failed');
    const disconnect = jest.fn();
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect,
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const tab = await createTestTab({ plugin: createPlugin(), containerEl: containerEl as any });
    const failedDispose = jest.fn(() => {
      throw cleanupError;
    });
    tab.controllers.navigationController.dispose = failedDispose;

    const firstError = await destroyTab(tab).catch(error => error);
    const secondError = await destroyTab(tab).catch(error => error);

    expect(firstError).toBeInstanceOf(TabRuntimeTeardownError);
    expect(secondError).toBe(firstError);
    expect(firstError.cleanupFailures).toEqual([
      { error: cleanupError, resource: 'tab navigation controller' },
    ]);
    expect(failedDispose).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(removeTabRoot).toHaveBeenCalledTimes(1);
    expect(tab.resources.isDisposed).toBe(true);
    expect('dispose' in tab.resources).toBe(false);
  });

  it('cancels and awaits an active turn before disposing coordinator ownership', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const coordinator = coordinatorInstances[0];
    let resolveTurn!: () => void;
    tab.session.activeTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    tab.state.currentConversationId = 'active-conversation';
    const save = jest.fn().mockResolvedValue(undefined);
    tab.controllers.conversationController = { save } as any;
    coordinator.cancel.mockImplementation(() => resolveTurn());

    await destroyTab(tab);

    expect(coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(true);
    expect(coordinator.dispose).toHaveBeenCalledTimes(1);
  });

  it('drains an active turn without closing the runtime before its final snapshot', async () => {
    const tab = await createTestTab({ plugin: createPlugin(), containerEl: createMockEl() as any });
    const coordinator = coordinatorInstances[0];
    let resolveTurn!: () => void;
    tab.session.activeTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });

    const drain = drainTabForShutdownSnapshot(tab);
    for (let attempt = 0; attempt < 10 && coordinator.cancel.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(tab.lifecycleState).toBe('cold');
    expect(coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(coordinator.dispose).not.toHaveBeenCalled();

    resolveTurn();
    await expect(drain).resolves.toEqual({
      cancelledActiveTurn: true,
      cleanupFailures: [],
    });
    expect(tab.lifecycleState).toBe('cold');
  });

  it('numbers a fork from canonical user turns while retaining non-canonical history', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => ({
      disconnect: jest.fn(),
      observe: jest.fn(),
    })) as unknown as typeof ResizeObserver;
    const conversation = createConversation();
    const plugin = createPlugin({
      getConversationSync: jest.fn().mockReturnValue(conversation),
    });
    const forkRequest = jest.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    }, {
      component: {
        addChild: jest.fn(),
        registerDomEvent: jest.fn(),
        registerEvent: jest.fn(),
      },
      forkRequestCallback: forkRequest,
    });
    tab.state.messages = [
      {
        content: 'A',
        id: 'user-a',
        role: 'user',
        timestamp: 1,
        userMessageId: 'native-user-a',
      },
      {
        assistantMessageId: 'assistant-a',
        content: 'reply A',
        id: 'assistant-a',
        role: 'assistant',
        timestamp: 2,
      },
      {
        content: 'interrupt marker',
        id: 'interrupt-a',
        isInterrupt: true,
        role: 'user',
        timestamp: 3,
      },
      {
        content: 'rebuilt context',
        id: 'rebuilt-a',
        isRebuiltContext: true,
        role: 'user',
        timestamp: 4,
      },
      {
        content: 'B',
        id: 'user-b',
        role: 'user',
        timestamp: 5,
        userMessageId: 'native-user-b',
      },
      {
        assistantMessageId: 'assistant-b',
        content: 'reply B',
        id: 'assistant-b',
        role: 'assistant',
        timestamp: 6,
      },
    ];

    await (tab.renderer as any).forkCallback('user-b');

    expect(coordinatorInstances[0].resolveForkSource).toHaveBeenCalledWith(
      'assistant-a',
      expect.any(Function),
    );
    expect(forkRequest).toHaveBeenCalledWith(expect.objectContaining({
      forkAtUserMessage: 2,
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'interrupt-a', isInterrupt: true }),
        expect.objectContaining({ id: 'rebuilt-a', isRebuiltContext: true }),
      ]),
      resumeAt: 'assistant-a',
      sourceConversationId: conversation.id,
      sourceSessionId: 'native-session',
    }));
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('drops a fork resolved after its source runtime begins closing', async () => {
    const forkSource = deferred<any>();
    const forkRequest = jest.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
      conversation: createConversation(),
    }, { forkRequestCallback: forkRequest });
    coordinatorInstances[0].resolveForkSource.mockReturnValueOnce(forkSource.promise);
    tab.state.messages = [
      {
        content: 'A',
        id: 'user-a',
        role: 'user',
        timestamp: 1,
        userMessageId: 'native-user-a',
      },
      {
        assistantMessageId: 'assistant-a',
        content: 'reply A',
        id: 'assistant-a',
        role: 'assistant',
        timestamp: 2,
      },
      {
        content: 'B',
        id: 'user-b',
        role: 'user',
        timestamp: 3,
        userMessageId: 'native-user-b',
      },
      {
        assistantMessageId: 'assistant-b',
        content: 'reply B',
        id: 'assistant-b',
        role: 'assistant',
        timestamp: 4,
      },
    ];

    const fork = (tab.renderer as any).forkCallback('user-b');
    for (let attempt = 0;
      attempt < 10 && coordinatorInstances[0].resolveForkSource.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(coordinatorInstances[0].resolveForkSource).toHaveBeenCalled();
    tab.lifecycleState = 'closing';
    forkSource.resolve({
      sessionId: 'native-session',
    });
    await fork;

    expect(forkRequest).not.toHaveBeenCalled();
  });

  it('drops a fork when its source conversation rebinds during source resolution', async () => {
    const conversation = createConversation();
    const forkSource = deferred<any>();
    const forkRequest = jest.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
      conversation,
    }, { forkRequestCallback: forkRequest });
    coordinatorInstances[0].resolveForkSource.mockReturnValueOnce(forkSource.promise);
    tab.state.messages = [
      {
        content: 'A',
        id: 'user-a',
        role: 'user',
        timestamp: 1,
        userMessageId: 'native-user-a',
      },
      {
        assistantMessageId: 'assistant-a',
        content: 'reply A',
        id: 'assistant-a',
        role: 'assistant',
        timestamp: 2,
      },
      {
        content: 'B',
        id: 'user-b',
        role: 'user',
        timestamp: 3,
        userMessageId: 'native-user-b',
      },
    ];

    const fork = (tab.renderer as any).forkCallback('user-b');
    for (let attempt = 0;
      attempt < 10 && coordinatorInstances[0].resolveForkSource.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    tab.conversationId = 'conversation-b';
    forkSource.resolve({ sessionId: 'native-session' });
    await fork;

    expect(forkRequest).not.toHaveBeenCalled();
  });

  it('synchronizes explicit mode changes through the coordinator', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation: createConversation(),
    });
    const coordinator = coordinatorInstances[0];

    await updatePlanModeUI(tab, plugin, 'plan', { syncExecution: true });

    expect(plugin.settings.permissionMode).toBe('plan');
    expect(coordinator.setMode).toHaveBeenCalledWith('plan');
  });

  it('keeps plan mode as draft state when a blank tab has no execution conversation', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const coordinator = coordinatorInstances[0];

    await updatePlanModeUI(tab, plugin, 'plan', { syncExecution: true });

    expect(plugin.settings.permissionMode).toBe('plan');
    expect(coordinator.setMode).not.toHaveBeenCalled();
  });
});
