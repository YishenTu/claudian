import { createMockEl } from '@test/helpers/MockElement';

import { ConversationController } from '@/features/chat/controllers/ConversationController';
import type {
  ChatExecutionCoordinatorDeps,
  ChatExecutionEventContext,
} from '@/features/chat/execution/ChatExecutionCoordinator';
import {
  createTab,
  destroyTab,
  initializeTabControllers,
  initializeTabExecution,
  initializeTabUI,
  updatePlanModeUI,
} from '@/features/chat/tabs/Tab';

const coordinatorInstances: MockCoordinator[] = [];
const coordinatorDeps: ChatExecutionCoordinatorDeps[] = [];

interface MockCoordinator {
  bindConversation: jest.Mock;
  cancel: jest.Mock;
  dispose: jest.Mock;
  isEventContextCurrent: jest.Mock;
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
      dispose: jest.fn().mockResolvedValue(undefined),
      isEventContextCurrent: jest.fn().mockReturnValue(true),
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
    getMcpServerManager: jest.fn().mockReturnValue(null),
    getMcpManager: jest.fn().mockReturnValue(null),
    getCommandLoader: jest.fn().mockReturnValue(null),
    getTabWarmupPolicy: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    createExecutionBackend: jest.fn(),
    createInstructionRefineService: jest.fn().mockReturnValue(null),
    createSubagentHistoryService: jest.fn().mockReturnValue(null),
    createTitleGenerationService: jest.fn().mockReturnValue(null),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsPlanMode: true,
    }),
    getChatUIConfig: jest.fn().mockReturnValue({
      applyPermissionMode: (_mode: string, settings: Record<string, unknown>) => {
        settings.permissionMode = _mode;
      },
      getContextWindowSize: jest.fn().mockReturnValue(200000),
      getDefaultModel: jest.fn().mockReturnValue('claude-default'),
      getDefaultReasoningValue: jest.fn().mockReturnValue('off'),
      getModelOptions: jest.fn().mockReturnValue([{ label: 'Claude', value: 'claude-default' }]),
      getReasoningOptions: jest.fn().mockReturnValue([]),
      isAdaptiveReasoningModel: jest.fn().mockReturnValue(false),
      isDefaultModel: jest.fn().mockReturnValue(true),
      normalizeModelVariant: jest.fn((model: string) => model),
      ownsModel: jest.fn().mockReturnValue(true),
    }),
    getConversationHistoryService: jest.fn().mockReturnValue({
      resolveSessionIdForConversation: jest.fn().mockReturnValue(null),
    }),
    getEnabledProviderIds: jest.fn().mockReturnValue(['claude']),
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
  const settings = {
    model: 'claude-default',
    permissionMode: 'normal',
    persistentExternalContextPaths: [],
  };
  return {
    app: {
      vault: {
        adapter: { basePath: '/vault' },
        getAbstractFileByPath: jest.fn().mockReturnValue(null),
        getFiles: jest.fn().mockReturnValue([]),
        on: jest.fn().mockReturnValue({}),
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
    settings,
    getActiveEnvironmentVariables: jest.fn().mockReturnValue({}),
    mutateSettings: jest.fn(async (mutation) => {
      await mutation(settings);
    }),
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationSync: jest.fn().mockReturnValue(null),
    handleMissingProviderSession: jest.fn(),
    ...overrides,
  } as any;
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
    updatedAt: 1,
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
  tab: ReturnType<typeof createTab>,
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
    getMcpServerSelector: () => null,
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
  beforeEach(() => {
    coordinatorInstances.length = 0;
    coordinatorDeps.length = 0;
    jest.clearAllMocks();
  });

  it('creates exactly one tab-owned execution coordinator', () => {
    const tab = createTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    });

    expect(tab.executionCoordinator).toBe(coordinatorInstances[0]);
    expect(coordinatorInstances).toHaveLength(1);
  });

  it('binds persisted native state and prepares only for a bound conversation', async () => {
    const conversation = createConversation();
    const plugin = createPlugin({
      getConversationById: jest.fn().mockResolvedValue(conversation),
    });
    const tab = createTab({
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
    expect(tab.lifecycleState).toBe('bound_active');
  });

  it('keeps blank-tab initialization session-free', async () => {
    const plugin = createPlugin();
    const tab = createTab({
      plugin,
      containerEl: createMockEl() as any,
    });
    const coordinator = coordinatorInstances[0];

    await initializeTabExecution(tab, plugin, null);

    expect(coordinator.bindConversation).toHaveBeenCalledWith(null);
    expect(coordinator.prepare).not.toHaveBeenCalled();
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
    const tab = createTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation: oldConversation,
    });
    tab.state.currentConversationId = oldConversation.id;
    initializeTabUI(tab, plugin);
    initializeTabControllers(tab, plugin, {
      addChild: jest.fn(),
      registerDomEvent: jest.fn(),
      registerEvent: jest.fn(),
    } as any);
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

  it('routes requested events through the current input controller', async () => {
    const plugin = createPlugin();
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
    const handleExecutionEvent = jest.fn();
    tab.controllers.inputController = { handleExecutionEvent } as any;
    const event = { type: 'text_delta' } as any;

    await coordinatorDeps[0].onRequestedEvent?.(event, {} as any);

    expect(handleExecutionEvent).toHaveBeenCalledWith(event);
  });

  it('routes provider interactions through the current input controller', async () => {
    const plugin = createPlugin();
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
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
  });

  it('buffers normalized background output and persists it on completion', async () => {
    const plugin = createPlugin();
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
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
    expect(tab.controllers.conversationController!.save).toHaveBeenCalledWith(false);
  });

  it('discards binding output when a transition rejects session-event admission', async () => {
    const plugin = createPlugin();
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
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
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
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
    expect(tab.controllers.conversationController!.save).toHaveBeenCalledWith(false);
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
    const tab = createTab({
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
    const tab = createTab({
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

  it('disposes coordinator ownership on tab close', async () => {
    const plugin = createPlugin();
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
    const coordinator = coordinatorInstances[0];

    await destroyTab(tab);

    expect(coordinator.dispose).toHaveBeenCalledTimes(1);
    expect(tab.executionCoordinator).toBeNull();
  });

  it('cancels and awaits an active turn before disposing coordinator ownership', async () => {
    const plugin = createPlugin();
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
    const coordinator = coordinatorInstances[0];
    let resolveTurn!: () => void;
    tab.session.activeTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    coordinator.cancel.mockImplementation(() => resolveTurn());

    await destroyTab(tab);

    expect(coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(coordinator.dispose).toHaveBeenCalledTimes(1);
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
    const tab = createTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    });
    initializeTabUI(tab, plugin);
    initializeTabControllers(
      tab,
      plugin,
      {
        addChild: jest.fn(),
        registerDomEvent: jest.fn(),
        registerEvent: jest.fn(),
      } as any,
      forkRequest,
    );
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
      sourceSessionId: 'native-session',
    }));
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('synchronizes explicit mode changes through the coordinator', async () => {
    const plugin = createPlugin();
    const tab = createTab({
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
    const tab = createTab({ plugin, containerEl: createMockEl() as any });
    const coordinator = coordinatorInstances[0];

    await updatePlanModeUI(tab, plugin, 'plan', { syncExecution: true });

    expect(plugin.settings.permissionMode).toBe('plan');
    expect(coordinator.setMode).not.toHaveBeenCalled();
  });
});
