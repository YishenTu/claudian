import { holdResponse } from '@test/helpers/ConversationPorts';
import { createMockEl } from '@test/helpers/MockElement';
import { within } from '@testing-library/dom';
import { JSDOM } from 'jsdom';
import { Component } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import type {
  ChatExecutionCoordinatorDeps,
  ChatExecutionEventContext,
} from '@/features/chat/execution/ChatExecutionCoordinator';
import { NavigationController } from '@/features/chat/navigation/NavigationController';
import { createChatSessionRuntime } from '@/features/chat/sessions/createChatSessionRuntime';
import { handleForkRequest } from '@/features/chat/sessions/SessionForkSource';
import { getSessionProviderId } from '@/features/chat/sessions/sessionProvider';
import { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';
import {
  destroyTab,
  drainTabForShutdownSnapshot,
  registerTabRuntimeResourceOwner,
  TabRuntimeTeardownError,
} from '@/features/chat/tabs/TabLifecycle';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { onProviderAvailabilityChanged } from '@/features/chat/tabs/tabProviderLifecycle';
import { updateTabPermissionMode } from '@/features/chat/tabs/tabProviderUI';
import {
  createTabRuntime,
  TabRuntimeConstructionError,
  type TabRuntimeFactoryOptions,
} from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const coordinatorInstances: MockCoordinator[] = [];
const coordinatorDeps: ChatExecutionCoordinatorDeps[] = [];
const titleServiceInstances: Array<{ cancel: jest.Mock }> = [];
const pools: SessionRuntimePool[] = [];
let coordinatorDisposeError: Error | null = null;

interface MockCoordinator {
  execute: jest.Mock;
  getCommandSnapshot: jest.Mock;
  bindConversation: jest.Mock;
  cancel: jest.Mock;
  dispose: jest.Mock;
  isEventContextCurrent: jest.Mock;
  prepare: jest.Mock;
  resolveForkSource: jest.Mock;
  snapshot: { providerSessionId?: string } | null;
  state: 'absent' | 'idle' | 'active' | 'stale' | 'disposed';
}

jest.mock('@/features/chat/execution/ChatExecutionCoordinator', () => ({
  ...jest.requireActual('@/features/chat/execution/ChatExecutionCoordinator'),
  ChatExecutionCoordinator: jest.fn().mockImplementation((deps) => {
    const coordinator: MockCoordinator = {
      execute: jest.fn().mockResolvedValue({ status: 'completed', accepted: true }),
      getCommandSnapshot: jest.fn().mockReturnValue(undefined),
      bindConversation: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
      dispose: jest.fn().mockImplementation(() => coordinatorDisposeError
        ? Promise.reject(coordinatorDisposeError)
        : Promise.resolve()),
      isEventContextCurrent: jest.fn().mockReturnValue(true),
      prepare: jest.fn().mockResolvedValue(undefined),
      resolveForkSource: jest.fn().mockResolvedValue({ sessionId: 'native-session' }),
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
    getCommandCatalog: jest.fn().mockReturnValue(null),
    getIfInitialized: jest.fn().mockReturnValue(null),
    getCommandLoader: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    createExecutionBackend: jest.fn(),
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
    }),
    getModelPolicy: (providerId: string) => ProviderRegistry.getChatUIConfig(providerId),
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
      supportsReasoningEffort: jest.fn().mockReturnValue(false),
      isDefaultModel: jest.fn().mockReturnValue(true),
      normalizeModelVariant: jest.fn((model: string) => model),
      ownsModel: jest.fn().mockReturnValue(true),
    }),
    getConversationHistoryService: jest.fn().mockReturnValue({
      resolveSessionIdForConversation: jest.fn().mockReturnValue(null),
    }),
    getBlankTabProviderIds: jest.fn((settings: Record<string, unknown>) =>
      ProviderRegistry.getEnabledProviderIds(settings)),
    getEnabledProviderIds: jest.fn().mockReturnValue(['claude']),
    getRegisteredProviderIds: jest.fn().mockReturnValue(['claude', 'codex']),
    getProviderDisplayName: jest.fn().mockReturnValue('Claude'),
    getTaskResultInterpreter: jest.fn(),
    isEnabled: jest.fn().mockReturnValue(true),
    resolveProviderForModel: jest.fn().mockReturnValue('claude'),
    resolveSettingsProviderId: jest.fn().mockReturnValue('claude'),
  },
}));

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    commitProviderSettingsChange: (
      settings: Record<string, unknown>,
      _providerId: string,
      _before: Record<string, unknown>,
      snapshot: Record<string, unknown>,
    ) => Object.assign(settings, snapshot),
    getProviderSettingsSnapshot: (settings: Record<string, unknown>) => ({
      effortLevel: '',
      model: 'claude-default',
      permissionMode: 'normal',
      serviceTier: 'standard',
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
  };
  let nextModelSelectionIntent = 0;
  const plugin = {
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
      executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
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
    getCommittedSettings: () => settings,
    getActiveEnvironmentVariables: jest.fn().mockReturnValue({}),
    mutateSettings: jest.fn(async (mutation) => {
      await mutation(settings);
    }),
    getConversationById: jest.fn().mockResolvedValue(null),
    updateConversation: jest.fn().mockResolvedValue(undefined),
    getCachedConversation: jest.fn().mockReturnValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    getConversationSummary(id: string) { return this.getConversationSync(id); },
    getConversationSync: jest.fn().mockReturnValue(null),
    findConversationAcrossViews: jest.fn().mockReturnValue(null),
    handleMissingProviderSession: jest.fn(),
    ...overrides,
  } as any;
  plugin.sessionRuntimes = new SessionRuntimePool({
    createRuntime: identity => createChatSessionRuntime(plugin, identity),
    releaseHistory: async () => true,
    onChanged: () => undefined,
    onError: () => undefined,
  });
  pools.push(plugin.sessionRuntimes);
  return plugin;
}

function createTabManager(
  plugin: ReturnType<typeof createPlugin>,
  containerEl = createMockEl(),
  callbacks: Record<string, unknown> = {},
  viewOverrides: Record<string, unknown> = {},
) {
  const view = Object.assign(new Component(), {
    getTabManager: jest.fn(),
    leaf: {},
    registerDomEvent: jest.fn(),
    registerEvent: jest.fn(),
    ...viewOverrides,
  }) as any;
  return new TabManager(
    plugin,
    containerEl as any,
    view,
    callbacks,
    new VaultMentionDataProvider(plugin.app),
  );
}

function expectTabManagerMetadataReleased(manager: TabManager, tabId: string): void {
  const internals = manager as any;
  // Discovery state can outlive membership, so a released tab must leave no tracked entry.
  expect(internals.commandDiscovery.getTrackedTabIds()).not.toContain(tabId);
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

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
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
    startNewConversation?: () => Promise<void>;
  } = {},
): Promise<any> {
  const component = Object.assign(new Component(), {
    registerDomEvent: jest.fn(),
    registerEvent: jest.fn(),
    ...assembly.component,
  }) as any;
  const tab = await createTabRuntime({
    ...options,
    mentionDataProvider: options.mentionDataProvider ?? new VaultMentionDataProvider(options.plugin.app),
    component,
    getProviderCatalogConfig: assembly.getProviderCatalogConfig ?? (() => null),
    isRuntimeLive: options.isRuntimeLive
      ?? (runtime => runtime.lifecycleState !== 'closing'),
    forkRequestCallback: assembly.forkRequestCallback,
    onProviderChanged: assembly.onProviderChanged
      ? (_tab, providerId) => assembly.onProviderChanged!(providerId)
      : undefined,
    openConversation: assembly.openConversation ?? (async () => {}),
    startNewConversation: assembly.startNewConversation ?? (async () => {}),
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
    await Promise.allSettled(pools.splice(0).map(pool => pool.dispose()));
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('closes a running tab without cancelling its session and reattaches the same owner', async () => {
    const conversation = createConversation();
    const plugin = createPlugin({
      getCachedConversation: jest.fn().mockReturnValue(conversation),
      getConversationById: jest.fn().mockResolvedValue(conversation),
      getConversationSync: jest.fn().mockReturnValue(conversation),
    });
    const manager = createTabManager(plugin);
    const tab = (await manager.createTab(conversation.id))!;
    const held = deferred<void>();
    let signal!: AbortSignal;
    const turn = tab.session.turns.run(async current => { signal = current; await held.promise; });
    try {
      expect(await manager.closeTab(tab.id)).toBe(true);
      expect(signal.aborted).toBe(false);
      expect(plugin.sessionRuntimes.isRunning(conversation.id)).toBe(true);
      const reattached = (await manager.createTab(conversation.id))!;
      expect(reattached.session.runtime).toBe(tab.session.runtime);
      expect(reattached.state).toBe(tab.state);
      expect(coordinatorInstances[0].cancel).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await turn;
      await manager.destroy();
    }
  });

  it('rebinds a running tab while preserving its label and composer draft', async () => {
    const first = createConversation();
    const second = { ...first, id: 'second', messages: [] };
    const byId = (id: string) => id === first.id ? first : second;
    const plugin = createPlugin({
      getCachedConversation: jest.fn(byId), getConversationSync: jest.fn(byId),
      getConversationById: jest.fn(async id => byId(id)), switchConversation: jest.fn(async id => byId(id)),
    });
    const manager = createTabManager(plugin);
    const original = (await manager.createTab(first.id))!;
    manager.setTabLabel(original.id, 'Research');
    original.controllers.drafts.restore('main', { content: 'Unsent draft' });
    const held = deferred<void>();
    let signal!: AbortSignal;
    const turn = original.session.turns.run(async current => { signal = current; await held.promise; });
    try {
      await manager.openConversation(second.id);
      const current = manager.getActiveTab()!;
      expect(current.id).toBe(original.id);
      expect(current.conversationId).toBe(second.id);
      expect(current.label).toBe('Research');
      expect(current.controllers.drafts.capture('main').content).toBe('Unsent draft');
      expect(signal.aborted).toBe(false);
      expect(manager.getTabCount()).toBe(1);
      expect(plugin.sessionRuntimes.get(first.id)).toBe(original.session.runtime);
      await manager.openConversation(first.id);
      expect(manager.getActiveTab()!.session.runtime).toBe(original.session.runtime);
      expect(manager.getActiveTab()!.controllers.drafts.capture('main').content).toBe('Unsent draft');
    } finally { held.resolve(); await turn; await manager.destroy(); }
  });

  it('does not carry a branch preview prompt into the conversation a tab rebinds to', async () => {
    const first = {
      ...createConversation(),
      messages: [
        { id: 'u1', role: 'user', content: 'First prompt', userMessageId: 'native-u1', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'First answer', assistantMessageId: 'native-a1', timestamp: 1 },
        { id: 'u2', role: 'user', content: 'Second prompt', userMessageId: 'native-u2', timestamp: 1 },
        { id: 'a2', role: 'assistant', content: 'Second answer', assistantMessageId: 'native-a2', timestamp: 1 },
      ],
    };
    const second = { ...createConversation(), id: 'second', messages: [] };
    const byId = (id: string) => id === first.id ? first : second;
    const plugin = createPlugin({
      getCachedConversation: jest.fn(byId), getConversationSync: jest.fn(byId),
      getConversationById: jest.fn(async (id: string) => byId(id)), switchConversation: jest.fn(async (id: string) => byId(id)),
    });
    const manager = createTabManager(plugin);
    const original = (await manager.createTab(first.id))!;
    await original.controllers.conversationController.navigateBranch('u2');
    expect(original.controllers.drafts.capture('main').content).toBe('Second prompt');

    await manager.openConversation(second.id);

    const current = manager.getActiveTab()!;
    expect(current.conversationId).toBe(second.id);
    expect(current.controllers.drafts.capture('main').content).toBe('');
    await manager.destroy();
  });

  it('disposes a deleted session once a tab that failed to reset lets it go', async () => {
    const conversation = createConversation();
    let cached: any = conversation;
    const plugin = createPlugin({
      getCachedConversation: jest.fn(() => cached),
      getConversationById: jest.fn(async () => cached),
      getConversationSync: jest.fn(() => cached),
    });
    const manager = createTabManager(plugin);
    const lifecycle = new ConversationLifecycle({
      sessions: plugin.sessionRuntimes,
      conversations: {} as any,
      views: { getAllViews: () => [{ getTabManager: () => manager }] as any },
    });
    const tab = (await manager.createTab(conversation.id))!;
    const runtime = tab.session.runtime;
    jest.spyOn(manager, 'resetConversationTabs').mockRejectedValueOnce(new Error('reset failed'));
    cached = null;

    await expect(lifecycle.resetDeletedConversationTabs(conversation.id)).rejects.toThrow('reset failed');
    expect(plugin.sessionRuntimes.get(conversation.id)).toBe(runtime);

    await manager.closeTab(tab.id);
    await waitForCondition(() => plugin.sessionRuntimes.get(conversation.id) === null);
    expect(runtime.isDisposed).toBe(true);
    await manager.destroy();
  });

  it('resets a tab after native deletion settles its turn, carrying the unsent and queued input', async () => {
    const conversation = createConversation();
    let cached: any = conversation;
    const plugin = createPlugin({
      getCachedConversation: jest.fn(() => cached),
      getConversationById: jest.fn(async () => cached),
      getConversationSync: jest.fn(() => cached),
      renameConversation: jest.fn().mockResolvedValue(undefined),
    });
    const manager = createTabManager(plugin);
    const lifecycle = new ConversationLifecycle({
      sessions: plugin.sessionRuntimes,
      conversations: {} as any,
      views: { getAllViews: () => [{ getTabManager: () => manager }] as any },
    });
    plugin.handleMissingProviderSession.mockImplementation(async (id: string) => {
      // The repository removes the record, then awaits the deletion callback.
      cached = null;
      await lifecycle.resetDeletedConversationTabs(id);
      return 'deleted';
    });
    const tab = (await manager.createTab(conversation.id))!;
    const runtime = tab.session.runtime;
    const coordinator = coordinatorInstances.at(-1)!;
    const deps = coordinatorDeps.at(-1)!;
    const handoff = deferred<void>();
    coordinator.execute.mockImplementationOnce(async () => {
      await handoff.promise;
      return {
        status: 'missing-session',
        accepted: false,
        missingSessionResolution: await deps.resolveMissingProviderSession(conversation.id, 'native-session'),
      };
    });
    tab.dom.inputEl.value = 'Unsent prompt';
    const sending = tab.controllers.inputController.sendMessage();
    try {
      await waitForCondition(() => coordinator.execute.mock.calls.length === 1);
      tab.dom.inputEl.value = 'Queued follow-up';
      await tab.controllers.inputController.sendMessage();
      tab.dom.inputEl.value = 'Composer draft';
    } finally {
      handoff.resolve();
      await sending;
    }
    await waitForCondition(() => plugin.sessionRuntimes.get(conversation.id) === null);

    const current = manager.getActiveTab()!;
    expect(current.id).toBe(tab.id);
    expect(current.conversationId).toBeNull();
    const draft = current.controllers.drafts.capture('main').content;
    expect(draft).toContain('Unsent prompt');
    expect(draft).toContain('Queued follow-up');
    expect(draft).toContain('Composer draft');
    expect(draft.match(/Composer draft/g)).toHaveLength(1);
    expect(runtime.isDisposed).toBe(true);
    await manager.destroy();
  });

  it('waits for persistence before eviction, fences reattachment, and reloads native history after release', async () => {
    const conversation = createConversation();
    const plugin = createPlugin({
      getCachedConversation: jest.fn().mockReturnValue(conversation),
      getConversationById: jest.fn().mockResolvedValue(conversation),
      getConversationSync: jest.fn().mockReturnValue(conversation),
    });
    const manager = createTabManager(plugin);
    const first = (await manager.createTab(conversation.id))!;
    const runtime = first.session.runtime;
    const original = runtime.model;
    runtime.attention.markReviewRequired('error');
    const saving = deferred<void>();
    plugin.updateConversation.mockReturnValueOnce(saving.promise);
    const saved = first.controllers.conversationController.save();
    await manager.closeTab(first.id);
    await new Promise(resolve => setImmediate(resolve));
    expect(runtime.peekModel).toBe(original);
    const reattached = (await manager.createTab(conversation.id))!;
    saving.resolve();
    await saved;
    await new Promise(resolve => setImmediate(resolve));
    expect(runtime.peekModel).toBe(original);
    await manager.closeTab(reattached.id);
    await new Promise(resolve => setImmediate(resolve));
    expect(runtime.peekModel).toBeNull();
    expect(runtime.attention.attention).toMatchObject({ kind: 'review', outcome: 'error' });
    const native = { ...conversation, messages: [{ id: 'native', role: 'assistant', content: 'Native history', timestamp: 1 }] };
    plugin.getConversationById.mockResolvedValue(native);
    const reopened = (await manager.createTab(conversation.id))!;
    expect(reopened.session.runtime).toBe(runtime);
    expect(reopened.state.messages).toEqual(native.messages);
    expect(runtime.peekModel).not.toBe(original);
    await manager.destroy();
  });

  it('refreshes cached picker entries when the owning session publishes command changes', async () => {
    const getCatalog = jest.mocked(ProviderWorkspaceRegistry.getCommandCatalog);
    const getCapabilities = jest.mocked(ProviderRegistry.getCapabilities);
    const previousCapabilities = getCapabilities('claude');
    const catalog = new RuntimeCommandCatalog({
      dropdownConfig: { providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' },
      projectEntry: command => ({
        ...command, providerId: 'claude', kind: 'command', scope: 'runtime', source: 'sdk',
        isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/',
      }),
    });
    getCatalog.mockReturnValue(catalog);
    getCapabilities.mockReturnValue({ ...previousCapabilities, supportsProviderCommands: true });
    const manager = createTabManager(createPlugin());
    try {
      const tab = await manager.createTab();
      coordinatorInstances[0].getCommandSnapshot.mockReturnValue([
        { id: 'before', name: 'before', description: '', content: '' },
      ]);
      const discovery = tab!.providerCatalogResolver!()!.discovery;
      expect(await discovery.load()).toMatchObject({ status: 'ready', items: [{ name: 'before' }] });
      coordinatorInstances[0].getCommandSnapshot.mockReturnValue([
        { id: 'after', name: 'after', description: '', content: '' },
      ]);
      await coordinatorDeps[0].onSessionEvent?.({
        type: 'commands_changed',
        scope: { kind: 'session', sessionInstanceId: 'session-instance-1', sequence: 1 },
      }, createEventContext());
      expect(await discovery.load()).toMatchObject({ status: 'ready', items: [{ name: 'after' }] });
      coordinatorInstances[0].getCommandSnapshot.mockReturnValue(undefined);
      coordinatorDeps[0].onIdleRelease?.();
      expect(await discovery.load()).toEqual({ status: 'empty' });
    } finally {
      await manager.destroy();
      getCatalog.mockReturnValue(null);
      getCapabilities.mockReturnValue(previousCapabilities);
    }
  });

  it('publishes work changes from turn, provider-background, and async-subagent owners', async () => {
    const onWorkChanged = jest.fn();
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
      onWorkChanged,
    });

    await tab.session.turns.run(async () => undefined);
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

  it('refreshes every provider control without starting command discovery', async () => {
    const getProviderCatalogConfig = jest.fn().mockReturnValue(null);
    const tab = await createTestTab(
      { plugin: createPlugin(), containerEl: createMockEl() as any },
      { getProviderCatalogConfig },
    );
    const controls = [
      tab.ui.modelSelector, tab.ui.modeSelector, tab.ui.effortSelector,
      tab.ui.permissionToggle, tab.ui.serviceTierToggle,
    ];
    const updates = controls.map((control: any) => jest.spyOn(control, 'updateDisplay'));
    const optionRenders = [tab.ui.modelSelector, tab.ui.modeSelector]
      .map((control: any) => jest.spyOn(control, 'renderOptions'));
    getProviderCatalogConfig.mockClear();

    tab.refreshProviderControls();

    for (const spy of [...updates, ...optionRenders]) expect(spy).toHaveBeenCalled();
    expect(getProviderCatalogConfig).not.toHaveBeenCalled();
  });

  it('counts detached async subagent work as tab work outside the foreground turn', async () => {
    const tab = await createTestTab({ plugin: createPlugin(), containerEl: createMockEl() as any });
    expect(tab.session.isWorking).toBe(false);

    jest.spyOn(tab.services.subagentManager, 'hasActiveAsyncSubagents').mockReturnValue(true);

    expect(tab.session.hasActiveTurn).toBe(false);
    expect(tab.session.isWorking).toBe(true);
  });

  it('blocks branch admission until the main turn has finished its finalization', async () => {
    const tab = await createTestTab({ plugin: createPlugin(), containerEl: createMockEl() as any });
    tab.state.currentConversationId = 'conversation';
    tab.state.messages = [
      { id: 'first', role: 'user', content: 'First', timestamp: Date.now(), userMessageId: 'native-first' },
      { id: 'second', role: 'user', content: 'Second', timestamp: Date.now(), userMessageId: 'native-second' },
    ];
    const render = jest.spyOn(tab.renderer, 'renderMessages').mockReturnValue(null);
    const refresh = jest.spyOn(tab.renderer, 'refreshBranchButtonState');
    await tab.session.turns.run(async () => {
      tab.session.turns.settle();
      expect(tab.state.isStreaming).toBe(false);
      await tab.controllers.conversationController.navigateBranch('second');
      expect(tab.dom.inputEl.value).toBe('');
      expect(render).not.toHaveBeenCalled();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await tab.controllers.conversationController.navigateBranch('second');
    expect(tab.dom.inputEl.value).toBe('Second');
    expect(render).toHaveBeenCalledTimes(1);
    tab.session.runtime.beginShutdown();
    await expect(tab.session.turns.run(async () => undefined)).rejects.toThrow('admission is closed');
  });

  it('leaves Enter on a composer link available for native link activation', async () => {
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    });
    const dom = new JSDOM('<a href="Notes/A.md">A</a>');
    try {
      const link = within(dom.window.document.body).getByRole('link', { name: 'A' });
      const preventDefault = jest.fn();
      tab.dom.inputEl.dispatchEvent({
        type: 'keydown', key: 'Enter', target: link, preventDefault,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false,
      });
      expect(preventDefault).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
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

  describe('waiting indicator around an earlier turn question', () => {
    const question = {
      id: 'ask',
      name: 'AskUserQuestion',
      status: 'completed',
      input: { replyMode: 'user-message', questions: [{ question: 'Which check?', options: [{ label: 'History' }] }] },
    } as any;

    /** Opens a question in one turn and starts the next turn while it is still pending. */
    async function startLaterTurnUnderQuestion() {
      const tab = await createTestTab({ plugin: createPlugin(), containerEl: createMockEl() as any });
      tab.state.currentContentEl = createMockEl();
      tab.dom.inputContainerEl.parentElement = createMockEl();
      const finishAsking = holdResponse(tab.session.turns);
      tab.controllers.inputController.updateAsyncQuestion(question);
      await finishAsking();
      const finishLater = holdResponse(tab.session.turns);
      tab.controllers.streamController.thinkingIndicator.show();
      await jest.advanceTimersByTimeAsync(500);
      expect(tab.state.requiresAction).toBe(true);
      expect(tab.state.thinkingEl).toBeNull();
      const settleQuestion = async () => {
        tab.controllers.inputController.updateAsyncQuestion({ ...question, resolvedAnswers: { '0': 'History' } });
        await jest.advanceTimersByTimeAsync(0);
        expect(tab.state.requiresAction).toBe(false);
      };
      return { tab, finishLater, settleQuestion };
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('shows the later turn indicator once the earlier turn question settles', async () => {
      const { tab, finishLater, settleQuestion } = await startLaterTurnUnderQuestion();

      await settleQuestion();
      await jest.advanceTimersByTimeAsync(500);

      expect(tab.state.thinkingEl).not.toBeNull();
      await finishLater();
    });

    it('does not resurrect the indicator when the earlier question settles after the later turn produced output', async () => {
      const { tab, finishLater, settleQuestion } = await startLaterTurnUnderQuestion();
      await tab.controllers.streamController.handleStreamChunk(
        { type: 'text', content: 'Working on it' },
        { content: '', role: 'assistant' },
      );

      await settleQuestion();
      await jest.advanceTimersByTimeAsync(500);

      expect(tab.state.thinkingEl).toBeNull();
      await finishLater();
    });
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
      holdResponse(tab.session.turns);
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
      holdResponse(tab.session.turns);
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

  it('releases the renderer file-link and session-link listeners during tab teardown', async () => {
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

    expect(messagesEl.getEventListenerCount('click')).toBe(2);
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

    tab.session.selectDraft(tab.providerId, 'claude-alternate');
    tab.session.beginClose();
    tab.providerCatalogResolver();

    const currentContext = getProviderCatalogConfig.mock.lastCall?.[0] as Record<
      string,
      unknown
    >;
    expect(currentContext).toBe(constructionContext);
    expect(currentContext.draftModel).toBe('claude-alternate');
    expect(currentContext.lifecycleState).toBe('closing');
  });

  it('publishes only a structurally ready runtime from TabManager', async () => {
    const plugin = createPlugin();
    const onTabCreated = jest.fn();
    const manager = createTabManager(plugin, createMockEl(), { onTabCreated });

    try {
      const tab = await manager.createTab();

      expect(tab).not.toBeNull();
      expect(tab?.executionCoordinator).not.toBeNull();
      expect(tab!.executionCoordinator).toBe(coordinatorInstances[0]);
      expect(coordinatorInstances).toHaveLength(1);
      expect(tab?.renderer).not.toBeNull();
      expect(Object.values(tab?.controllers ?? {})).not.toContain(null);
      expect(tab?.services.titleGenerationService).not.toBeNull();
      expect(tab?.providerCatalogResolver).not.toBeNull();
      expect(tab?.ui.contextTray).not.toBeNull();
      expect(tab?.ui.fileContextManager).not.toBeNull();
      expect(tab?.ui.imageContextManager).not.toBeNull();
      expect(tab?.ui.modelSelector).not.toBeNull();
      expect(tab?.ui.modeSelector).not.toBeNull();
      expect(tab?.ui.effortSelector).not.toBeNull();
      expect(tab?.ui.permissionToggle).not.toBeNull();
      expect(tab?.ui.serviceTierToggle).not.toBeNull();
      expect(tab?.ui.composerDropdown).not.toBeNull();
      expect(tab?.ui.contextUsageMeter).not.toBeNull();
      const contentChildren = Array.from(tab!.dom.contentEl.children);
      const messagesIndex = contentChildren.indexOf(tab!.dom.messagesWrapperEl);
      expect(contentChildren[messagesIndex + 1]).toBe(tab!.dom.inputComposerEl);
      expect(tab?.hydrationState).toBe('ready');
      expect(tab?.lifecycleState).toBe('open');
      expect(onTabCreated).toHaveBeenCalledWith(tab);
      expect(coordinatorInstances[0].prepare).not.toHaveBeenCalled();
    } finally {
      await manager.destroy();
    }
  });

  it('hydrates a restored ready runtime without preparing provider execution', async () => {
    const conversation = createConversation();
    const plugin = createPlugin({
      getCachedConversation: jest.fn().mockReturnValue(conversation),
    getConversationSync: jest.fn().mockReturnValue(conversation),
      getConversationById: jest.fn().mockResolvedValue(conversation),
      switchConversation: jest.fn().mockResolvedValue(conversation),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    const manager = createTabManager(plugin);

    try {
      const tab = await manager.createTab(conversation.id);

      expect(tab?.conversationId).toBe(conversation.id);
      expect(tab?.state.currentConversationId).toBe(conversation.id);
      expect(tab?.hydrationState).toBe('ready');
      expect(tab?.lifecycleState).toBe('open');
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
    }
  });

  it('saves a conversation switched into a tab whose earlier hydration failed', async () => {
    const failed = createConversation();
    const next = { ...createConversation(), id: 'conversation-2', messages: [] };
    const updateConversation = jest.fn().mockResolvedValue(undefined);
    const plugin = createPlugin({
      getCachedConversation: jest.fn((id: string) => (id === failed.id ? failed : next)),
      getConversationSync: jest.fn((id: string) => (id === failed.id ? failed : next)),
      getConversationById: jest.fn(async (id: string) => {
        if (id === failed.id) throw new Error('history unavailable');
        return next;
      }),
      updateConversation,
    });
    const manager = createTabManager(plugin);

    try {
      const tab = await manager.createTab(failed.id);
      expect(tab?.hydrationState).toBe('failed');

      await manager.openConversation(next.id);
      const target = manager.getActiveTab()!;
      expect(target.conversationId).toBe(next.id);
      target.state.addMessage({ id: 'user-1', role: 'user', content: 'Hello', timestamp: 1 });
      await target.controllers.conversationController.save();

      expect(updateConversation).toHaveBeenCalledWith(
        next.id,
        expect.objectContaining({ messages: [expect.objectContaining({ id: 'user-1' })] }),
      );
    } finally {
      await manager.destroy();
    }
  });

  it('rolls back DOM ownership when core construction fails', async () => {
    const shellError = new Error('core DOM construction failed');
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

  it('rolls back UI and core ownership when controller construction fails', async () => {
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

  it('rolls back controllers, UI, and core ownership when input wiring fails', async () => {
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
    const rollbackError = new Error('DOM cleanup failed');
    const tabId = 'rollback-failure';
    globalThis.ResizeObserver = jest.fn().mockImplementation(() => {
      throw assemblyError;
    }) as unknown as typeof ResizeObserver;
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    removeTabRoot.mockImplementation(() => { throw rollbackError; });
    const manager = createTabManager(createPlugin(), containerEl);

    const error = await manager.createTab(null, tabId).catch(cause => cause);

    expect(error).toBeInstanceOf(TabRuntimeConstructionError);
    expect(error.cause).toBe(assemblyError);
    expect(error.rollbackFailures).toEqual([
      { error: rollbackError, resource: 'tab DOM root' },
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

  it('keeps an explicit blank-tab selection through loading and changed catalog publications', async () => {
    const plugin = createPlugin();
    const uiConfig = ProviderRegistry.getChatUIConfig('claude');
    plugin.settings.lastSelectedChatModel = { providerId: 'claude', model: 'claude-default' };
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    (uiConfig.getModelOptions as jest.Mock).mockReturnValue([]);
    onProviderAvailabilityChanged(tab, plugin);
    expect(tab.draftModel).toBe('claude-default');
    expect(tab.providerId).toBe('claude');
    (uiConfig.getModelOptions as jest.Mock).mockReturnValue([{ value: 'claude-alternate', label: 'Alternate' }]);
    (uiConfig.getDefaultModel as jest.Mock).mockReturnValue('claude-alternate');
    onProviderAvailabilityChanged(tab, plugin);
    expect(tab.draftModel).toBe('claude-default');
  });

  it('preserves an unavailable last-selected model when creating a blank tab and publishing availability', async () => {
    const plugin = createPlugin();
    plugin.settings.lastSelectedChatModel = { providerId: 'claude', model: 'retired' };
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    onProviderAvailabilityChanged(tab, plugin);
    expect(tab.providerId).toBe('claude');
    expect(tab.draftModel).toBe('retired');
  });

  it('assembles only the active restored tab and preserves inactive identities without resources', async () => {
    const plugin = createPlugin();
    const root = createMockEl();
    const manager = createTabManager(plugin, root);
    const saved = {
      openTabs: Array.from({ length: 20 }, (_, index) => ({ tabId: `saved-${index}`, conversationId: null, draftModel: 'claude-default' })),
      activeTabId: 'saved-0',
    };
    try {
      await manager.restoreState(saved);
      expect(manager.getTabCount()).toBe(20);
      expect(manager.getAllTabs()).toHaveLength(1);
      expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
      expect(coordinatorInstances).toHaveLength(1);
      expect(titleServiceInstances).toHaveLength(1);
      expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(saved.openTabs.map(tab => tab.tabId));
      await manager.closeTab('saved-19');
      expect(coordinatorInstances).toHaveLength(1);
      plugin.settings.lastSelectedChatModel = { model: 'changed-model', providerId: 'codex' };
      await manager.switchToTab('saved-1');
      expect(manager.getActiveTab()?.draftModel).toBe('claude-default');
      expect(coordinatorInstances).toHaveLength(2);
      expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(2);
    } finally { await manager.destroy(); }
    expect(coordinatorInstances.every(coordinator => coordinator.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('restores a draft on its recorded provider even when model ownership is unresolved', async () => {
    const plugin = createPlugin();
    (ProviderRegistry.resolveProviderForModel as jest.Mock).mockReturnValue(null);
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any,
      draftModel: 'retired-endpoint', providerId: 'codex',
    });
    expect(tab.providerId).toBe('codex');
    expect(tab.draftModel).toBe('retired-endpoint');
  });

  it('restores an ownerless legacy draft as a blocked tab', async () => {
    const plugin = createPlugin();
    (ProviderRegistry.resolveProviderForModel as jest.Mock).mockReturnValue(null);
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any, draftModel: 'retired-endpoint' });
    expect(tab.providerId).toBeNull();
    expect(tab.draftModel).toBe('retired-endpoint');
    await expect(tab.session.runtime.model.ensureExecutionInitialized()).resolves.toBe(false);
    expect(ensureInitialized).not.toHaveBeenCalled();
    expect(coordinatorInstances[0].bindConversation).not.toHaveBeenCalled();
  });

  it('persists and reopens an unresolved draft without starting provider services', async () => {
    const plugin = createPlugin();
    (ProviderRegistry.resolveProviderForModel as jest.Mock).mockReturnValue(null);
    plugin.app.workspace.getActiveViewOfType = jest.fn().mockReturnValue(null);
    const manager = createTabManager(plugin, createMockEl() as any);
    await manager.restoreState({
      openTabs: [{ tabId: 'blocked', conversationId: null, draftModel: 'retired-endpoint' }],
      activeTabId: 'blocked',
    });
    const tab = manager.getActiveTab()!;
    expect(tab.providerId).toBeNull();
    // No provider owns the draft, so the composer gets no command catalog or discovery source.
    expect(tab.providerCatalogResolver()).toBeNull();
    expect(ensureInitialized).not.toHaveBeenCalled();
    const saved = manager.getPersistedState();
    expect(saved.openTabs).toEqual([{
      tabId: 'blocked', conversationId: null, draftModel: 'retired-endpoint', providerId: null,
    }]);
    await manager.destroy();
    (ProviderRegistry.resolveProviderForModel as jest.Mock).mockReturnValue('claude');
    const reopened = createTabManager(plugin, createMockEl() as any);
    await reopened.restoreState(saved);
    expect(reopened.getActiveTab()?.providerId).toBeNull();
    expect(ensureInitialized).not.toHaveBeenCalled();
    const active = reopened.getActiveTab()!;
    const option = Array.from(active.dom.inputWrapper.querySelectorAll('.claudian-model-option'))
      .find(el => Array.from(el.children).some(child => child.textContent === 'Claude Default')) as HTMLElement;
    expect(option).toBeDefined();
    option.click();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(active.providerId).toBe('claude');
    expect(active.draftModel).toBe('claude-default');
    expect(ensureInitialized).toHaveBeenCalled();
    await reopened.destroy();
  });

  it('keeps a legacy Codex draft on its recorded provider when that provider is disabled', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    tab.session.selectDraft('codex', tab.draftModel);
    tab.session.selectDraft(tab.providerId, 'gpt-5.4');
    (ProviderRegistry.getEnabledProviderIds as jest.Mock).mockReturnValue(['claude']);
    (ProviderRegistry.resolveProviderForModel as jest.Mock).mockReturnValue('claude');
    onProviderAvailabilityChanged(tab, plugin);
    expect(getSessionProviderId(tab, plugin)).toBe('codex');
    expect(tab.providerId).toBe('codex');
    expect(tab.draftModel).toBe('gpt-5.4');
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
      tab.session.beginClose();
      initialization.resolve(undefined);
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
    } finally {
      getChatUIConfig.mockReturnValue(claudeConfig);
      getEnabledProviderIds.mockReturnValue(['claude']);
      resolveProviderForModel.mockReturnValue('claude');
    }
  });

  it('does not restore provider selection when failed selection settles after teardown', async () => {
    const getChatUIConfig = ProviderRegistry.getChatUIConfig as jest.Mock;
    const getEnabledProviderIds = ProviderRegistry.getEnabledProviderIds as jest.Mock;
    const resolveProviderForModel = ProviderRegistry.resolveProviderForModel as jest.Mock;
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
      expect(tab.providerId).toBe('codex');
      initialization.reject(new Error('Codex initialization failed'));
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(tab.providerId).toBe('codex');
      expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
    } finally {
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
    tab.session.beginClose();
    commitGate.resolve(undefined);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
  });

  it('does not seed an uninitialized provider after overlapping same-provider choices fail', async () => {
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
    }
  });

  it('records an explicit bound-conversation model choice without changing its provider', async () => {
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
    tab.session.beginClose();
    commitGate.resolve(undefined);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(plugin.settings.lastSelectedChatModel).toBeUndefined();
  });

  it('does not publish a detached tab model choice after persistence', async () => {
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
    await destroyTab(tab);
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

    await expect(tab.session.runtime.model.ensureExecutionInitialized()).resolves.toBe(true);

    expect(ensureInitialized).toHaveBeenCalledWith(
      plugin.providerHost,
      'claude',
      'session-execution',
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
  });

  it('keeps blank-tab initialization session-free', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
    });
    const coordinator = coordinatorInstances[0];

    await expect(tab.session.runtime.model.ensureExecutionInitialized()).resolves.toBe(true);

    expect(coordinator.bindConversation).toHaveBeenCalledWith(null);
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it('routes /clear to the manager-owned New port instead of resetting the tab itself', async () => {
    const conversation = createConversation();
    const plugin = createPlugin();
    const startNewConversation = jest.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
    }, { startNewConversation });
    tab.dom.inputEl.value = '/clear';

    await tab.controllers.inputController!.sendMessage();

    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(tab.conversationId).toBe(conversation.id);
  });

  it('does not route manager-owned commands from a closing runtime', async () => {
    const startNewConversation = jest.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
      conversation: createConversation(),
    }, { startNewConversation });
    tab.session.beginClose();
    tab.dom.inputEl.value = '/clear';

    await tab.controllers.inputController.sendMessage();

    expect(startNewConversation).not.toHaveBeenCalled();
  });

  it('claims a provisional preview without retaining it when the user types', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      lifecycleState: 'provisional',
    });
    expect(tab.session.isUserClaimed).toBe(false);

    tab.dom.inputEl.value = 'Keep this draft';
    (tab.dom.inputEl as any).dispatchEvent('input');

    expect(tab.lifecycleState).toBe('provisional');
    expect(tab.session.isUserClaimed).toBe(true);
  });

  it('does not read textarea geometry when the user types', async () => {
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    });
    const readOffsetHeight = jest.fn(() => 102);
    const readScrollHeight = jest.fn(() => 102);
    Object.defineProperties(tab.dom.inputEl, {
      offsetHeight: { configurable: true, get: readOffsetHeight },
      scrollHeight: { configurable: true, get: readScrollHeight },
    });

    tab.dom.inputEl.value = 'Keep this runtime';
    (tab.dom.inputEl as any).dispatchEvent('input');

    expect(tab.lifecycleState).toBe('open');
    expect(tab.session.isUserClaimed).toBe(true);
    expect(readOffsetHeight).not.toHaveBeenCalled();
    expect(readScrollHeight).not.toHaveBeenCalled();
  });

  it('claims a provisional preview without retaining it when the user attaches an image', async () => {
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
    expect(tab.lifecycleState).toBe('provisional');
    expect(tab.session.isUserClaimed).toBe(true);
  });

  it('claims a provisional preview without retaining it when the user removes captured editor context', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      lifecycleState: 'provisional',
    });
    const selectionController = (tab.controllers.composerSelections as any).editor;
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

    expect(tab.lifecycleState).toBe('provisional');
    expect(tab.session.isUserClaimed).toBe(true);
  });

  it('keeps a browsed conversation provisional after hydration', async () => {
    const conversation = createConversation();
    const plugin = createPlugin({
    getConversationSync: jest.fn().mockReturnValue(conversation),
      getConversationById: jest.fn().mockResolvedValue(conversation),
      switchConversation: jest.fn().mockResolvedValue(conversation),
      updateConversation: jest.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: createMockEl() as any,
      conversation,
      lifecycleState: 'provisional',
    });
    await tab.session.runtime.model.hydrate();

    expect(tab.lifecycleState).toBe('provisional');
  });

  it('invalidates commands before binding a hydrated session and activates input after loading', async () => {
    const conversation = createConversation();
    const onCommandContextChanged = jest.fn();
    const plugin = createPlugin({ getConversationById: jest.fn().mockResolvedValue(conversation) });
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any, conversation, onCommandContextChanged });
    const activated = jest.spyOn(tab.controllers.inputController, 'onConversationActivated');
    onCommandContextChanged.mockClear();
    const binding = deferred<void>();
    coordinatorInstances[0].bindConversation.mockImplementationOnce(() => binding.promise);
    const loading = tab.session.runtime.model.hydrate();
    for (let attempt = 0; attempt < 40 && coordinatorInstances[0].bindConversation.mock.calls.length === 0; attempt++) await Promise.resolve();
    expect(onCommandContextChanged.mock.invocationCallOrder[0]).toBeLessThan(coordinatorInstances[0].bindConversation.mock.invocationCallOrder[0]);
    expect(activated).not.toHaveBeenCalled();
    binding.resolve(undefined);
    await loading;
    expect(activated).toHaveBeenCalledTimes(1);
    expect(tab.state.currentConversationId).toBe(conversation.id);
  });

  it('routes requested events through the current input controller', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const handleExecutionEvent = jest.fn();
    jest.spyOn(tab.controllers.inputController, 'handleExecutionEvent').mockImplementation(handleExecutionEvent);
    const event = { type: 'text_delta' } as any;

    await coordinatorDeps[0].onRequestedEvent?.(event, {} as any);

    expect(handleExecutionEvent).toHaveBeenCalledWith(event);
  });

  it('keeps provider interactions action-required until they settle', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const handleApprovalRequest = jest.spyOn(tab.controllers.inlinePrompts, 'requestApproval');

    const request = coordinatorDeps[0].interactionPort.requestApproval({
      description: 'Read note',
      input: { path: 'note.md' },
      interactionId: 'interaction-1',
      kind: 'approval',
      sessionInstanceId: 'session-instance-1',
      toolName: 'Read',
      turnId: 'turn-1',
    }, new AbortController().signal);

    await Promise.resolve();
    expect(handleApprovalRequest).toHaveBeenCalledWith(
      'interaction-1',
      'Read',
      { path: 'note.md' },
      'Read note',
      {},
      expect.any(AbortSignal),
    );
    expect(tab.state.requiresAction).toBe(true);
    expect(coordinatorDeps[0].isOwnerIdle?.()).toBe(false);

    tab.controllers.inlinePrompts.dismiss('interaction-1');
    await expect(request).resolves.toEqual({
      decision: 'cancel',
      interactionId: 'interaction-1',
    });

    expect(tab.state.attention).toBeNull();
  });

  it('releases idle tab sessions after 30 minutes and treats review-only tabs as idle', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });

    tab.state.markReviewRequired();

    expect(coordinatorDeps[0].idleReleaseMs).toBe(30 * 60_000);
    expect(coordinatorDeps[0].isOwnerIdle?.()).toBe(true);
  });

  it.each([
    // An admitted turn that has not reached provider handoff; like a real turn, it unwinds on cancellation.
    ['a foreground turn', (tab: AssembledTabRuntime) => {
      void tab.session.turns.run(signal => new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }));
    }],
    // Chat tracks async subagents that the provider session does not report as background work.
    ['async subagent work', (tab: AssembledTabRuntime) => {
      jest.spyOn(tab.services.subagentManager, 'hasActiveAsyncSubagents').mockReturnValue(true);
    }],
    ['a rewind', (tab: AssembledTabRuntime) => { jest.spyOn(tab.state, 'isRewinding', 'get').mockReturnValue(true); }],
  ])('keeps the tab session through %s', async (_label, hold) => {
    const tab = await createTestTab({ plugin: createPlugin(), containerEl: createMockEl() as any });
    expect(coordinatorDeps[0].isOwnerIdle?.()).toBe(true);

    hold(tab);

    expect(coordinatorDeps[0].isOwnerIdle?.()).toBe(false);
  });

  it('publishes background review only after persistence and respects acknowledgement during that save', async () => {
    const saving = deferred<void>();
    const plugin = createPlugin({ updateConversation: jest.fn(() => saving.promise) });
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    tab.state.currentConversationId = 'conversation';
    const scope = { kind: 'background' as const, sequence: 1, sessionInstanceId: 'native', turnId: 'background' };
    const context = createEventContext();
    await coordinatorDeps[0].onSessionEvent?.({ type: 'background_turn_started', scope }, context);
    await coordinatorDeps[0].onSessionEvent?.({ type: 'text_delta', text: 'Background result', scope: { ...scope, sequence: 2 } }, context);
    const completion = coordinatorDeps[0].onSessionEvent?.({ type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 3 } }, context);
    for (let i = 0; i < 40 && !plugin.updateConversation.mock.calls.length; i++) await Promise.resolve();
    expect(plugin.updateConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({ lastActivityAt: expect.any(Number) }));
    expect(tab.state.attention).toBeNull();
    saving.resolve();
    await completion;
    expect(tab.state.attention).toMatchObject({ kind: 'review', outcome: 'completed' });
  });

  it('records background completion activity without requesting review for empty or metadata-only output', async () => {
    for (const usage of [false, true]) {
      const plugin = createPlugin();
      const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
      tab.state.currentConversationId = 'conversation';
      const index = coordinatorDeps.length - 1;
      const scope = { kind: 'background' as const, sequence: 1, sessionInstanceId: 'native', turnId: 'background' };
      const context = createEventContext();
      await coordinatorDeps[index].onSessionEvent?.({ type: 'background_turn_started', scope }, context);
      if (usage) await coordinatorDeps[index].onSessionEvent?.({ type: 'usage_updated', usage: {
        contextTokens: 10, contextWindow: 100, inputTokens: 10, percentage: 10,
      }, scope: { ...scope, sequence: 2 } }, context);
      await coordinatorDeps[index].onSessionEvent?.({ type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 3 } }, context);
      expect(plugin.updateConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({ lastActivityAt: expect.any(Number) }));
      expect(tab.state.attention).toBeNull();
      expect(tab.state.usage?.contextTokens ?? null).toBe(usage ? 10 : null);
      expect(tab.state.messages).toEqual([]);
    }
  });



  it('rejects stale provider binding events before touching the transcript', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    coordinatorInstances[0].isEventContextCurrent.mockReturnValue(false);
    await coordinatorDeps[0].onSessionEvent?.({ type: 'task_notification', content: 'Stale result',
      scope: { kind: 'session', sequence: 1, sessionInstanceId: 'old-native' } }, createEventContext());
    expect(tab.state.messages).toEqual([]);
    expect(plugin.updateConversation).not.toHaveBeenCalled();
  });

  it('routes async subagent completion to the session owner and persists its outcome', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    tab.state.currentConversationId = 'conversation';
    const apply = jest.spyOn(tab.controllers.streamController.subagents, 'handleAsyncSubagentCompletion').mockResolvedValue(true);
    coordinatorInstances[0].snapshot = { providerSessionId: 'native-session' };
    await coordinatorDeps[0].onSessionEvent?.({ originatingTurnId: 'turn-1', result: 'done',
      scope: { kind: 'session', sequence: 1, sessionInstanceId: 'session-instance-1' },
      status: 'completed', subagentId: 'subagent-1', type: 'async_subagent_completed' }, createEventContext());
    expect(apply).toHaveBeenCalledWith({ providerSessionId: 'native-session', result: 'done', status: 'completed', taskId: 'subagent-1', type: 'async_subagent_completion' });
    expect(plugin.updateConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({ lastActivityAt: expect.any(Number) }));
    expect(tab.state.attention).toMatchObject({ kind: 'review', outcome: 'completed' });
  });

  it('applies subagent progress without waiting behind queued background work', async () => {
    const tab = await createTestTab({ plugin: createPlugin(), containerEl: createMockEl() as any });
    const handleSubagentProgress = jest.fn();
    jest.spyOn(tab.controllers.streamController.subagents, 'handleSubagentProgress').mockImplementation(handleSubagentProgress);
    let releaseBackground!: () => void;
    const release = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const blocked = tab.session.enqueueBackgroundWork(() => release);
    const progress = { toolCallId: 'task-1', summary: 'Reading the auth module' };

    try {
      coordinatorDeps[0].onSessionEvent?.({
        progress,
        scope: { kind: 'session', sequence: 1, sessionInstanceId: 'session-instance-1' },
        type: 'subagent_progress',
      }, createEventContext());

      expect(handleSubagentProgress).toHaveBeenCalledWith(progress);
    } finally {
      releaseBackground();
      await blocked;
    }
  });

  it('rebinds while source background rendering is pending and saves only to the source', async () => {
    const old = createConversation();
    const next = { ...old, id: 'next', messages: [] };
    const lookup = (id: string) => id === old.id ? old : next;
    const plugin = createPlugin({ getCachedConversation: jest.fn(lookup), getConversationSync: jest.fn(lookup), getConversationById: jest.fn(async id => lookup(id)) });
    const manager = createTabManager(plugin);
    const tab = (await manager.createTab(old.id))!;
    const rendering = deferred<void>();
    const render = jest.spyOn(tab.renderer, 'renderContent').mockReturnValue(rendering.promise);
    const scope = { kind: 'background' as const, sequence: 1, sessionInstanceId: 'native', turnId: 'background' };
    const context = createEventContext();
    await coordinatorDeps[0].onSessionEvent?.({ type: 'background_turn_started', scope }, context);
    await coordinatorDeps[0].onSessionEvent?.({ type: 'text_delta', text: 'Old background result', scope: { ...scope, sequence: 2 } }, context);
    const completion = coordinatorDeps[0].onSessionEvent?.({ type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 3 } }, context);
    for (let i = 0; i < 40 && !render.mock.calls.length; i++) await Promise.resolve();
    expect(render).toHaveBeenCalled();
    await manager.openConversation(next.id);
    expect(manager.getActiveTab()?.conversationId).toBe(next.id);
    expect(manager.getActiveTab()?.state.messages).toEqual([]);
    rendering.resolve();
    await completion;
    expect(plugin.updateConversation.mock.calls.every(([id]: [string]) => id === old.id)).toBe(true);
    expect(manager.getActiveTab()?.state.messages).toEqual([]);
    await manager.destroy();
  });



  it('keeps assembled references structurally stable across idempotent teardown', async () => {
    const manager = createTabManager(createPlugin());

    try {
      const tab = await manager.createTab();
      const coordinator = tab!.executionCoordinator;
      const renderer = tab!.renderer;
      const controllers = tab!.controllers;
      const titleGenerationService = tab!.services.titleGenerationService;
      const contextTray = tab!.ui.contextTray;

      await destroyTab(tab!);
      await destroyTab(tab!);

      expect(tab!.lifecycleState).toBe('closing');
      expect(tab!.executionCoordinator).toBe(coordinator);
      expect(tab!.renderer).toBe(renderer);
      expect(tab!.controllers).toBe(controllers);
      expect(tab!.services.titleGenerationService).toBe(titleGenerationService);
      expect(tab!.ui.contextTray).toBe(contextTray);
      expect(coordinator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await manager.destroy();
    }
  });

  it('rejects replacing the factory-owned runtime resource owner', async () => {
    const tab = await createTestTab({
      plugin: createPlugin(),
      containerEl: createMockEl() as any,
    });
    const replacementOwner = {
      dispose: jest.fn().mockResolvedValue([]),
    };

    expect(() => registerTabRuntimeResourceOwner(tab, replacementOwner))
      .toThrow('Tab runtime already has a registered resource owner');

    await destroyTab(tab);

    expect(replacementOwner.dispose).not.toHaveBeenCalled();
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
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
  });

  it('plugin shutdown cancels and drains a session after its tab was destroyed', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    tab.state.currentConversationId = 'active-conversation';
    const turn = tab.session.turns.run((signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())));
    await destroyTab(tab);
    expect(coordinatorInstances[0].cancel).not.toHaveBeenCalled();
    await plugin.sessionRuntimes.dispose();
    await turn;
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(plugin.updateConversation).toHaveBeenCalledWith('active-conversation', expect.any(Object));
  });

  it.each(['creation', 'hydration'] as const)('retains submitted input when close overlaps %s', async phase => {
    const pending = deferred<any>();
    const conversation = { providerId: 'claude', messages: [], sessionId: null, selectedModel: 'claude-default', id: 'created-during-close' };
    const createConversation = jest.fn(() => phase === 'creation' ? pending.promise : Promise.resolve(conversation));
    const getConversationById = jest.fn(() => pending.promise);
    const updateConversation = jest.fn().mockResolvedValue(undefined);
    const plugin = createPlugin({
      createConversation, getConversationById, updateConversation,
      renameConversation: jest.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });
    const sending = tab.controllers.inputController.sendMessage({ content: 'Preserve admitted first prompt' });
    const blockedCall = phase === 'creation' ? createConversation : getConversationById;
    for (let attempt = 0; attempt < 40 && blockedCall.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(blockedCall).toHaveBeenCalledTimes(1);
    const closing = destroyTab(tab);
    pending.resolve(conversation);
    await Promise.all([sending, closing]);
    expect(tab.conversationId).toBe('created-during-close');
    expect(coordinatorInstances[0].prepare).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0].execute).toHaveBeenCalledTimes(1);
    expect(updateConversation).toHaveBeenCalledWith('created-during-close', expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'Preserve admitted first prompt' })]),
    }));
  });

  it('snapshots a bound session without cancelling or waiting for its response', async () => {
    const tab = await createTestTab({ plugin: createPlugin(), containerEl: createMockEl() as any });
    tab.state.currentConversationId = 'active-conversation';
    const release = holdResponse(tab.session.turns);
    try {
      await expect(drainTabForShutdownSnapshot(tab)).resolves.toEqual({ cleanupFailures: [] });
      expect(tab.session.turns.isActive).toBe(true);
      expect(coordinatorInstances[0].cancel).not.toHaveBeenCalled();
      expect(coordinatorInstances[0].dispose).not.toHaveBeenCalled();
    } finally { await release(); }
  });

  it('numbers a fork from canonical user turns while retaining non-canonical history', async () => {
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

    tab.state.messages.push({ id: 'user-c', role: 'user', content: 'Later question', timestamp: 7 });

    await handleForkRequest(tab, plugin, 'assistant-b', forkRequest, runtime => runtime.lifecycleState !== 'closing');

    expect(coordinatorInstances[0].resolveForkSource).toHaveBeenCalledWith(
      'assistant-b',
      expect.any(Function),
    );
    expect(forkRequest).toHaveBeenCalledWith(expect.objectContaining({
      forkAtUserMessage: 3,
      messages: expect.arrayContaining([
        expect.objectContaining({ id: 'interrupt-a', isInterrupt: true }),
        expect.objectContaining({ id: 'rebuilt-a', isRebuiltContext: true }),
      ]),
      resumeAt: 'assistant-b',
      sourceConversationId: conversation.id,
      sourceSessionId: 'native-session',
    }));
    expect(forkRequest.mock.calls[0][0].messages.map((message: { id: string }) => message.id)).toEqual([
      'user-a', 'assistant-a', 'interrupt-a', 'rebuilt-a', 'user-b', 'assistant-b',
    ]);
  });

  it('drops a fork resolved after its source runtime begins closing', async () => {
    const forkSource = deferred<any>();
    const forkRequest = jest.fn().mockResolvedValue(undefined);
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
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

    const fork = handleForkRequest(tab, plugin, 'assistant-a', forkRequest, runtime => runtime.lifecycleState !== 'closing');
    for (let attempt = 0;
      attempt < 10 && coordinatorInstances[0].resolveForkSource.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(coordinatorInstances[0].resolveForkSource).toHaveBeenCalled();
    tab.session.beginClose();
    forkSource.resolve({
      sessionId: 'native-session',
    });
    await fork;

    expect(forkRequest).not.toHaveBeenCalled();
  });

  it('drops a fork when its source session shuts down during source resolution', async () => {
    const conversation = createConversation();
    const forkSource = deferred<any>();
    const forkRequest = jest.fn().mockResolvedValue(undefined);
    const plugin = createPlugin();
    const tab = await createTestTab({
      plugin,
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

    const fork = handleForkRequest(tab, plugin, 'assistant-a', forkRequest, runtime => !runtime.session.runtime.isDisposed);
    for (let attempt = 0;
      attempt < 10 && coordinatorInstances[0].resolveForkSource.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    tab.session.runtime.beginShutdown();
    forkSource.resolve({ sessionId: 'native-session' });
    await fork;

    expect(forkRequest).not.toHaveBeenCalled();
  });

  it.each(['normal', 'yolo'] as const)('applies normalized %s permission events to tab settings', async (permissionMode) => {
    const plugin = createPlugin();
    await createTestTab({ plugin, containerEl: createMockEl() as any });
    plugin.settings.permissionMode = permissionMode === 'normal' ? 'yolo' : 'normal';

    await coordinatorDeps[0].onSessionEvent?.({
      type: 'permission_mode_changed',
      permissionMode,
      scope: { kind: 'session', sessionInstanceId: 'session-instance-1', sequence: 1 },
      snapshot: { providerId: 'claude', revision: 1, status: 'idle' },
    }, createEventContext());

    expect(plugin.settings.permissionMode).toBe(permissionMode);
  });

  it('updates permission settings for an unbound tab', async () => {
    const plugin = createPlugin();
    const tab = await createTestTab({ plugin, containerEl: createMockEl() as any });

    plugin.settings.permissionMode = 'yolo';
    expect(plugin.settings.permissionMode).toBe('yolo');

    await updateTabPermissionMode(tab, plugin, 'normal');

    expect(plugin.settings.permissionMode).toBe('normal');
  });
});
