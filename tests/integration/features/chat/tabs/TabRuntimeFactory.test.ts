/** @vitest-environment jsdom */
import { FakeSession, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { holdResponse } from '@test/helpers/ConversationPorts';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { fireEvent } from '@testing-library/dom';
import { App, Component, MarkdownRenderer, WorkspaceLeaf } from 'obsidian';
import type { Mock, MockInstance } from 'vitest';

import { RoutedTitleGenerationService } from '@/core/auxiliary/RoutedTitleGenerationService';
import type { ProviderSessionEvent } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { Conversation, ToolCallInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { SelectionController } from '@/features/chat/input/SelectionController';
import { NavigationController } from '@/features/chat/navigation/NavigationController';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
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

const coordinatorInstances: ChatExecutionCoordinator[] = [];
const runtimes: ChatSessionRuntime[] = [];
const pools: SessionRuntimePool[] = [];
let claude: ReturnType<typeof registerChatTestProvider>;
let ensureInitialized: MockInstance<typeof ProviderWorkspaceRegistry.ensureInitialized>;
let cancelTitle: MockInstance<RoutedTitleGenerationService['cancel']>;
const executeSession = FakeSession.prototype.execute;
const nativeSessions = new Map<ChatExecutionCoordinator, FakeSession>();

async function nativeSession(index = 0): Promise<FakeSession> {
  const coordinator = coordinatorInstances[index];
  if (!coordinator.snapshot) {
    await coordinator.bindConversation({ conversationId: runtimes[index].conversationId ?? 'conversation-1', providerId: 'claude' });
  }
  await coordinator.prepare();
  if (!nativeSessions.has(coordinator)) nativeSessions.set(coordinator, claude.sessions.at(-1)!);
  return nativeSessions.get(coordinator)!;
}

async function emitSessionEvent(event: ProviderSessionEvent, index = 0): Promise<void> {
  const session = await nativeSession(index);
  session.emit(Object.assign({}, event, { scope: { ...event.scope, sessionInstanceId: session.sessionInstanceId } }));
  await runtimes[index].awaitBackgroundWork();
}

async function createPlugin(overrides: Omit<NonNullable<Parameters<typeof createChatFeatureHost>[0]>, 'fixture'> = {}) {
  let nextModelSelectionIntent = 0;
  const pool = new SessionRuntimePool({
    createRuntime: identity => {
      const runtime = createChatSessionRuntime(plugin, identity);
      const coordinator = runtime.executionCoordinator;
      for (const method of ['execute', 'prepare', 'bindConversation', 'dispose', 'cancel', 'resolveForkSource'] as const) vi.spyOn(coordinator, method);
      coordinatorInstances.push(coordinator);
      runtimes.push(runtime);
      return runtime;
    },
    releaseHistory: async () => true,
    onChanged: () => undefined,
    onError: () => undefined,
  });
  const messaging: SessionMessagingService = new SessionMessagingService({ getHost: () => plugin, getActiveConversationId: () => null, refreshModelControls: () => undefined });
  onTestFinished(() => messaging.dispose());
  const ports = {
    bindSessionTools: (id: string) => messaging.bindSessionTools(id),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
    projects: createProjectsFake([]),
    chatModelSelection: {
      beginIntent: vi.fn(() => ++nextModelSelectionIntent),
      commitIntent: vi.fn<ChatFeatureHost['chatModelSelection']['commitIntent']>(async (_intent, selection) => {
        plugin.settings.lastSelectedChatModel = selection;
        return true;
      }),
    },
    getActiveEnvironmentVariables: vi.fn().mockReturnValue({}),
    getConversationById: vi.fn().mockResolvedValue(null),
    updateConversation: vi.fn().mockResolvedValue(undefined),
    getCachedConversation: vi.fn().mockReturnValue(null),
    getConversationList: vi.fn().mockReturnValue([]),
    getConversationSummary: (id: string): ReturnType<ChatFeatureHost['getConversationSummary']> => plugin.getConversationSync(id),
    getConversationSync: vi.fn().mockReturnValue(null),
    findConversationAcrossViews: vi.fn().mockReturnValue(null),
    handleMissingProviderSession: vi.fn(),
  } satisfies Partial<ChatFeatureHost>;
  const plugin: Awaited<ReturnType<typeof createChatFeatureHost>> & typeof ports & { sessionRuntimes: SessionRuntimePool } = Object.assign(await createChatFeatureHost({
    ...ports,
    app: new App(),
    sessionRuntimes: pool,
    ...overrides,
    settings: { model: 'claude-default', permissionMode: 'normal', enableAutoTitleGeneration: false, ...overrides.settings },
  }), ports, { sessionRuntimes: pool });
  // Caller overrides remain authoritative over baseline observations.
  const { settings: _settings, ...capabilities } = overrides;
  Object.assign(plugin, capabilities);
  pools.push(pool);
  return plugin;
}

function createTabManager(
  plugin: Awaited<ReturnType<typeof createPlugin>>,
  containerEl = document.createElement('div'),
  callbacks: Record<string, unknown> = {},
  viewOverrides: Record<string, unknown> = {},
) {
  const component = new Component();
  component.load();
  onTestFinished(() => component.unload());
  const view = Object.assign(component, {
    getTabManager: vi.fn(),
    leaf: new WorkspaceLeaf(),
    ...viewOverrides,
  });
  return new TabManager(
    plugin,
    containerEl,
    view,
    callbacks,
    new VaultMentionDataProvider(plugin.app),
  );
}

function expectTabManagerMetadataReleased(manager: TabManager, tabId: string): void {
  const discovery = manager['commandDiscovery'];
  // Discovery state can outlive membership, so a released tab must leave no tracked entry.
  expect(discovery.getTrackedTabIds()).not.toContain(tabId);
}

function createTrackedTabContainer(): {
  containerEl: HTMLDivElement;
  removeTabRoot: Mock;
  tabRoot: HTMLElement;
} {
  const containerEl = document.createElement('div');
  const tabRoot = document.createElement('div');
  const removeTabRoot = vi.fn();
  tabRoot.remove = removeTabRoot;
  containerEl.createDiv = vi.fn().mockReturnValue(tabRoot);
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

const directlyCreatedTabs: AssembledTabRuntime[] = [];

async function createTestTab(
  options: Pick<TabRuntimeFactoryOptions, 'containerEl' | 'plugin'> &
    Partial<Omit<
      TabRuntimeFactoryOptions,
      'component' | 'containerEl' | 'getProviderCatalogConfig' | 'plugin'
    >>,
  assembly: {
    forkRequestCallback?: TabRuntimeFactoryOptions['forkRequestCallback'];
    getProviderCatalogConfig?: TabRuntimeFactoryOptions['getProviderCatalogConfig'];
    onProviderChanged?: (providerId: string) => void | Promise<void>;
    openConversation?: (conversationId: string) => Promise<void>;
    startNewConversation?: () => Promise<void>;
  } = {},
) {
  const component = new Component();
  component.load();
  onTestFinished(() => component.unload());
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

function createConversation(): Conversation {
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
  };
}

function browseProvider(tab: { dom: { inputWrapper: HTMLElement } }, providerId: string): void {
  const tabs = Array.from([...tab.dom.inputWrapper.querySelectorAll<HTMLElement>('.claudian-model-provider-tab')]) as HTMLElement[];
  tabs.find(item => item.dataset.provider === providerId)?.click();
}

describe('Tab provider execution ownership', () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    coordinatorInstances.length = 0;
    runtimes.length = 0;
    nativeSessions.clear();
    vi.restoreAllMocks();
    ensureInitialized = vi.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized');
    cancelTitle = vi.spyOn(RoutedTitleGenerationService.prototype, 'cancel');
    vi.spyOn(FakeSession.prototype, 'execute').mockImplementation(function (this: FakeSession, request) {
      executeSession.call(this, request);
      const run = this.runs.at(-1)!;
      run.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(this, run, 1) });
      run.events.end();
      return run;
    });
    claude = registerChatTestProvider('claude', { models: [
      { label: 'Claude Default', value: 'claude-default' },
      { label: 'Claude Alternate', value: 'claude-alternate' },
    ], modelPolicy: {
      getDefaultModel: vi.fn(() => 'claude-default'),
      getModelOptions: vi.fn(() => [
        { label: 'Claude Default', value: 'claude-default' },
        { label: 'Claude Alternate', value: 'claude-alternate' },
      ]),
    }, historyService: { resolveSessionIdForConversation: conversation => conversation?.sessionId ?? null } });
    registerChatTestProvider('codex', { models: [{ label: 'Codex', value: 'codex-default' }] });
  });

  afterEach(async () => {
    const tabs = directlyCreatedTabs.splice(0);
    await Promise.allSettled(tabs.map(tab => destroyTab(tab)));
    await Promise.allSettled(pools.splice(0).map(pool => pool.dispose()));
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('does not carry a branch preview prompt into the conversation a tab rebinds to', async () => {
    const first: Conversation = {
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
    const plugin = await createPlugin({
      getCachedConversation: vi.fn(byId), getConversationSync: vi.fn(byId),
      getConversationById: vi.fn(async (id: string) => byId(id)), switchConversation: vi.fn(async (id: string) => byId(id)),
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
    let cached: Conversation | null = conversation;
    const plugin = await createPlugin({
      getCachedConversation: vi.fn(() => cached),
      getConversationById: vi.fn(async () => cached),
      getConversationSync: vi.fn(() => cached),
    });
    const manager = createTabManager(plugin);
    const view = await createClaudianView({ host: plugin, tabManager: manager });
    const { store } = await createSessionBrowserHost();
    const lifecycle = new ConversationLifecycle({
      sessions: plugin.sessionRuntimes,
      projects: { get: () => null, setArchived: async () => undefined },
      conversations: store,
      views: { getAllViews: () => [view] },
    });
    const tab = (await manager.createTab(conversation.id))!;
    const runtime = tab.session.runtime;
    vi.spyOn(manager, 'resetConversationTabs').mockRejectedValueOnce(new Error('reset failed'));
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
    let cached: Conversation | null = conversation;
    const plugin = await createPlugin({
      getCachedConversation: vi.fn(() => cached),
      getConversationById: vi.fn(async () => cached),
      getConversationSync: vi.fn(() => cached),
      renameConversation: vi.fn().mockResolvedValue(undefined),
    });
    const manager = createTabManager(plugin);
    const view = await createClaudianView({ host: plugin, tabManager: manager });
    const { store } = await createSessionBrowserHost();
    const lifecycle = new ConversationLifecycle({
      sessions: plugin.sessionRuntimes,
      projects: { get: () => null, setArchived: async () => undefined },
      conversations: store,
      views: { getAllViews: () => [view] },
    });
    plugin.handleMissingProviderSession.mockImplementation(async (id: string) => {
      // The repository removes the record, then awaits the deletion callback.
      cached = null;
      await lifecycle.resetDeletedConversationTabs(id);
      return 'deleted';
    });
    const tab = (await manager.createTab(conversation.id))!;
    const runtime = tab.session.runtime;
    const handoff = deferred<void>();
    const executed = deferred<void>();
    vi.spyOn(FakeSession.prototype, 'execute').mockImplementationOnce(function (this: FakeSession, request) {
      executeSession.call(this, request);
      const run = this.runs.at(-1)!;
      executed.resolve();
      void handoff.promise.then(() => {
        run.events.push({ type: 'execution_error', category: 'provider-session-missing', recoverable: false,
          message: 'Native session deleted', missingProviderSessionId: 'native-session', scope: requestedScope(this, run, 1) });
        run.events.end();
      });
      return run;
    });
    tab.dom.inputEl.value = 'Unsent prompt';
    const sending = tab.controllers.inputController.sendMessage();
    try {
      await executed.promise;
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
    const plugin = await createPlugin({
      getCachedConversation: vi.fn().mockReturnValue(conversation),
      getConversationById: vi.fn().mockResolvedValue(conversation),
      getConversationSync: vi.fn().mockReturnValue(conversation),
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
    const conversation = createConversation();
    const manager = createTabManager(await createPlugin({ getConversationById: vi.fn(async () => conversation), getCachedConversation: vi.fn(() => conversation) }));
    const tab = (await manager.createTab(conversation.id))!;
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    claude.loadCommands.mockResolvedValue({ status: 'empty' });
    await tab.session.runtime.model.ensureExecutionInitialized();
    const session = await nativeSession();
    session.commands = [{ id: 'before', name: 'before', description: '', content: '' }];
    const discovery = tab.providerCatalogResolver()!.discovery;
    expect(await discovery.load()).toMatchObject({ status: 'ready', items: [{ name: 'before' }] });
    session.commands = [{ id: 'after', name: 'after', description: '', content: '' }];
    await emitSessionEvent({ type: 'commands_changed', scope: { kind: 'session', sessionInstanceId: session.sessionInstanceId, sequence: 1 } });
    expect(await discovery.load()).toMatchObject({ status: 'ready', items: [{ name: 'after' }] });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(session.disposeCalls).toBe(1);
    expect(await discovery.load()).toEqual({ status: 'empty' });
    await manager.destroy();
  });

  it('publishes work changes from turn, provider-background, and async-subagent owners', async () => {
    const onWorkChanged = vi.fn();
    const tab = await createTestTab({
      plugin: await createPlugin(),
      containerEl: document.createElement('div'),
      onWorkChanged,
    });

    await tab.session.turns.run(async () => undefined);
    expect(onWorkChanged).toHaveBeenCalledWith(tab);
    onWorkChanged.mockClear();
    await emitSessionEvent({ type: 'background_turn_started', scope: { kind: 'background', sessionInstanceId: 'native', turnId: 'background', sequence: 1 } });
    expect(onWorkChanged).toHaveBeenCalledWith(tab);
    onWorkChanged.mockClear();
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

    expect(onWorkChanged).toHaveBeenCalledWith(tab);
  });

  it('refreshes every provider control without starting command discovery', async () => {
    const getProviderCatalogConfig = vi.fn().mockReturnValue(null);
    const tab = await createTestTab(
      { plugin: await createPlugin(), containerEl: document.createElement('div') },
      { getProviderCatalogConfig },
    );
    const controls = [
      tab.ui.modelSelector, tab.ui.modeSelector, tab.ui.effortSelector,
      tab.ui.permissionToggle, tab.ui.serviceTierToggle,
    ];
    const updates = controls.map((control) => vi.spyOn(control, 'updateDisplay'));
    const optionRenders = [tab.ui.modelSelector, tab.ui.modeSelector]
      .map((control) => vi.spyOn(control, 'renderOptions'));
    getProviderCatalogConfig.mockClear();

    tab.refreshProviderControls();

    for (const spy of [...updates, ...optionRenders]) expect(spy).toHaveBeenCalled();
    expect(getProviderCatalogConfig).not.toHaveBeenCalled();
  });

  it('counts detached async subagent work as tab work outside the foreground turn', async () => {
    const tab = await createTestTab({ plugin: await createPlugin(), containerEl: document.createElement('div') });
    expect(tab.session.isWorking).toBe(false);

    vi.spyOn(tab.services.subagentManager, 'hasActiveAsyncSubagents').mockReturnValue(true);

    expect(tab.session.hasActiveTurn).toBe(false);
    expect(tab.session.isWorking).toBe(true);
  });

  it('blocks branch admission until the main turn has finished its finalization', async () => {
    const tab = await createTestTab({ plugin: await createPlugin(), containerEl: document.createElement('div') });
    tab.state.currentConversationId = 'conversation';
    tab.state.messages = [
      { id: 'first', role: 'user', content: 'First', timestamp: Date.now(), userMessageId: 'native-first' },
      { id: 'second', role: 'user', content: 'Second', timestamp: Date.now(), userMessageId: 'native-second' },
    ];
    const render = vi.spyOn(tab.renderer, 'renderMessages');
    const refresh = vi.spyOn(tab.renderer, 'refreshBranchButtonState');
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
      plugin: await createPlugin(),
      containerEl: document.createElement('div'),
    });
    const link = tab.dom.inputEl.createEl('a', { href: 'Notes/A.md', text: 'A' });
    const sendMessage = vi.spyOn(tab.controllers.inputController, 'sendMessage');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    link.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets later navigation override bottom auto-scroll intent', async () => {
    const plugin = await createPlugin();
    plugin.settings.keyboardNavigation = {
      focusInputKey: 'i',
      scrollDownKey: 's',
      scrollUpKey: 'w',
    };
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
    });
    Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { configurable: true, value: 500 });
    tab.dom.messagesEl.scrollTop = 100;
    tab.state.autoScrollEnabled = false;
    tab.dom.messagesEl.scrollTo = vi.fn();

    const bottomButton = tab.dom.messagesWrapperEl.querySelector<HTMLElement>(
      '.claudian-nav-btn-bottom',
    )!;
    bottomButton?.click();

    expect(bottomButton).not.toBeNull();
    expect(tab.state.autoScrollEnabled).toBe(true);

    fireEvent.scroll(tab.dom.messagesEl);

    expect(tab.state.autoScrollEnabled).toBe(true);

    tab.dom.messagesEl.scrollTop = 500;
    fireEvent.scroll(tab.dom.messagesEl);
    Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 1_200 });
    fireEvent.scroll(tab.dom.messagesEl);

    expect(tab.state.autoScrollEnabled).toBe(true);

    const sidebar = tab.dom.messagesWrapperEl.querySelector<HTMLElement>('.claudian-nav-sidebar')!;
    for (const buttonIndex of [0, 1, 3]) {
      bottomButton?.click();
      sidebar?.querySelectorAll<HTMLElement>('button')[buttonIndex]?.click();
      expect(tab.state.autoScrollEnabled).toBe(false);
    }

    const userMessage = tab.dom.messagesEl.createDiv({ cls: 'claudian-message-user' });
    userMessage.setAttribute('data-toc-title', 'Prompt');
    const messageControl = userMessage.createEl('button');
    bottomButton?.click();
    sidebar?.querySelectorAll<HTMLElement>('button')[2]?.click();
    tab.dom.messagesWrapperEl.querySelector<HTMLElement>('.claudian-nav-toc-item')?.click();
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    fireEvent.keyDown(messageControl, {key: 'w', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false});
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    fireEvent.keyDown(messageControl, {key: 'PageUp', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false});
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    fireEvent.pointerDown(tab.dom.messagesEl, { clientX: 250 });
    expect(tab.state.autoScrollEnabled).toBe(true);

    fireEvent.touchStart(userMessage);
    expect(tab.state.autoScrollEnabled).toBe(true);

    fireEvent.touchMove(userMessage);
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    fireEvent.keyDown(messageControl, {key: ' ', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false});
    expect(tab.state.autoScrollEnabled).toBe(true);

    fireEvent.pointerMove(tab.dom.messagesEl, { buttons: 1 });
    expect(tab.state.autoScrollEnabled).toBe(true);

    bottomButton?.click();
    Object.defineProperty(tab.dom.messagesEl, 'offsetWidth', { value: 506, configurable: true });
    Object.defineProperty(tab.dom.messagesEl, 'clientWidth', { value: 500, configurable: true });
    tab.dom.messagesEl.getBoundingClientRect = vi.fn().mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 506,
      top: 0,
      width: 506,
      x: 0,
      y: 0,
      toJSON: vi.fn(),
    });
    fireEvent(tab.dom.messagesEl, new MouseEvent('pointerdown', { bubbles: true, clientX: 503 }));
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    fireEvent.keyDown(messageControl, {key: 'Home', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false});
    expect(tab.state.autoScrollEnabled).toBe(false);

    bottomButton?.click();
    fireEvent.wheel(tab.dom.messagesEl, {});

    expect(tab.state.autoScrollEnabled).toBe(false);
  });

  describe('waiting indicator around an earlier turn question', () => {
    const question: ToolCallInfo = {
      id: 'ask',
      name: 'AskUserQuestion',
      status: 'completed',
      input: { replyMode: 'user-message', questions: [{ question: 'Which check?', options: [{ label: 'History' }] }] },
    };

    /** Opens a question in one turn and starts the next turn while it is still pending. */
    async function startLaterTurnUnderQuestion() {
      const tab = await createTestTab({ plugin: await createPlugin(), containerEl: document.createElement('div') });
      tab.state.currentContentEl = document.createElement('div');
      document.createElement('div').appendChild(tab.dom.inputContainerEl);
      const finishAsking = holdResponse(tab.session.turns);
      tab.controllers.inputController.updateAsyncQuestion(question);
      await finishAsking();
      const finishLater = holdResponse(tab.session.turns);
      tab.controllers.streamController.thinkingIndicator.show();
      await vi.advanceTimersByTimeAsync(500);
      expect(tab.state.requiresAction).toBe(true);
      expect(tab.state.thinkingEl).toBeNull();
      const settleQuestion = async () => {
        tab.controllers.inputController.updateAsyncQuestion({ ...question, resolvedAnswers: { '0': 'History' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(tab.state.requiresAction).toBe(false);
      };
      return { tab, finishLater, settleQuestion };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('shows the later turn indicator once the earlier turn question settles', async () => {
      const { tab, finishLater, settleQuestion } = await startLaterTurnUnderQuestion();

      await settleQuestion();
      await vi.advanceTimersByTimeAsync(500);

      expect(tab.state.thinkingEl).not.toBeNull();
      await finishLater();
    });

    it('does not resurrect the indicator when the earlier question settles after the later turn produced output', async () => {
      const { tab, finishLater, settleQuestion } = await startLaterTurnUnderQuestion();
      await tab.controllers.streamController.handleStreamChunk(
        { type: 'text', content: 'Working on it' },
        { id: 'assistant', timestamp: Date.now(), content: '', role: 'assistant' },
      );

      await settleQuestion();
      await vi.advanceTimersByTimeAsync(500);

      expect(tab.state.thinkingEl).toBeNull();
      await finishLater();
    });
  });

  it('keeps auto-scroll disabled when bottom navigation is used with the setting off', async () => {
    const plugin = await createPlugin();
    plugin.settings.enableAutoScroll = false;
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
    });
    tab.state.autoScrollEnabled = false;
    tab.dom.messagesEl.scrollTo = vi.fn();

    tab.dom.messagesWrapperEl.querySelector<HTMLElement>('.claudian-nav-btn-bottom')?.click();

    expect(tab.state.autoScrollEnabled).toBe(false);
  });

  it('re-arms auto-scroll when a streaming user manually returns to the bottom', async () => {
    vi.useFakeTimers();
    try {
      const tab = await createTestTab({
        plugin: await createPlugin(),
        containerEl: document.createElement('div'),
      });
      holdResponse(tab.session.turns);
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 1_000 });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { configurable: true, value: 500 });
      tab.dom.messagesEl.scrollTop = 500;

      fireEvent.wheel(tab.dom.messagesEl, {});
      tab.dom.messagesEl.scrollTop = 250;
      fireEvent.scroll(tab.dom.messagesEl);

      expect(tab.state.autoScrollEnabled).toBe(false);

      tab.dom.messagesEl.scrollTop = 500;
      fireEvent.scroll(tab.dom.messagesEl);

      expect(tab.state.autoScrollEnabled).toBe(true);

      tab.state.currentContentEl = tab.dom.messagesEl.createDiv();
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 1_200 });
      await tab.controllers.streamController.handleStreamChunk(
        { type: 'text', content: 'continued' },
        { id: 'assistant', timestamp: Date.now(), content: '', role: 'assistant' },
      );
      await vi.advanceTimersByTimeAsync(200);

      expect(tab.dom.messagesEl.scrollTop).toBe(1_200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps auto-scroll armed during downward wheel momentum at the bottom', async () => {
    vi.useFakeTimers();
    try {
      const tab = await createTestTab({
        plugin: await createPlugin(),
        containerEl: document.createElement('div'),
      });
      holdResponse(tab.session.turns);
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 1_000 });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { configurable: true, value: 500 });
      tab.dom.messagesEl.scrollTop = 250;
      tab.state.autoScrollEnabled = false;

      fireEvent.wheel(tab.dom.messagesEl, {deltaY: 120});
      tab.dom.messagesEl.scrollTop = 500;
      fireEvent.scroll(tab.dom.messagesEl);

      expect(tab.state.autoScrollEnabled).toBe(true);

      for (let index = 0; index < 3; index++) {
        fireEvent.wheel(tab.dom.messagesEl, {deltaY: 120});
      }

      expect(tab.state.autoScrollEnabled).toBe(true);

      tab.state.currentContentEl = tab.dom.messagesEl.createDiv();
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 1_200 });
      await tab.controllers.streamController.handleStreamChunk(
        { type: 'text', content: 'continued' },
        { id: 'assistant', timestamp: Date.now(), content: '', role: 'assistant' },
      );
      await vi.advanceTimersByTimeAsync(200);

      expect(tab.dom.messagesEl.scrollTop).toBe(1_200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a pending bottom re-arm override newer navigation', async () => {
    vi.useFakeTimers();
    try {
      const tab = await createTestTab({
        plugin: await createPlugin(),
        containerEl: document.createElement('div'),
      });
      Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: 1_000 });
      Object.defineProperty(tab.dom.messagesEl, 'clientHeight', { configurable: true, value: 500 });
      tab.dom.messagesEl.scrollTop = 500;
      tab.dom.messagesEl.scrollTo = vi.fn();
      tab.state.autoScrollEnabled = false;

      fireEvent.scroll(tab.dom.messagesEl);
      tab.dom.messagesWrapperEl.querySelector<HTMLElement>('.claudian-nav-btn-top')?.click();
      fireEvent.wheel(tab.dom.messagesEl, {deltaY: 120});
      vi.advanceTimersByTime(150);

      expect(tab.state.autoScrollEnabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the renderer file-link and session-link listeners during tab teardown', async () => {
    const added = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const removed = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const tab = await createTestTab({
      plugin: await createPlugin(),
      containerEl: document.createElement('div'),
    });
    const messagesEl = tab.dom.messagesEl;

    const handlers = added.mock.calls.filter((call, index) => call[0] === 'click' && added.mock.contexts[index] === messagesEl).map(call => call[1]);
    expect(handlers).toHaveLength(2);
    await destroyTab(tab);
    const released = removed.mock.calls.filter((call, index) => call[0] === 'click' && removed.mock.contexts[index] === messagesEl).map(call => call[1]);
    expect(released).toEqual(expect.arrayContaining(handlers));
  });

  it('exposes only stable session fields to provider catalog callbacks', async () => {
    const getProviderCatalogConfig = vi.fn((_context: unknown) => null);
    const tab = await createTestTab(
      {
        plugin: await createPlugin(),
        containerEl: document.createElement('div'),
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
    const plugin = await createPlugin();
    const onTabCreated = vi.fn();
    const manager = createTabManager(plugin, document.createElement('div'), { onTabCreated });

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
    const plugin = await createPlugin({
      getCachedConversation: vi.fn().mockReturnValue(conversation),
    getConversationSync: vi.fn().mockReturnValue(conversation),
      getConversationById: vi.fn().mockResolvedValue(conversation),
      switchConversation: vi.fn().mockResolvedValue(conversation),
      updateConversation: vi.fn().mockResolvedValue(undefined),
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
    const updateConversation = vi.fn().mockResolvedValue(undefined);
    const plugin = await createPlugin({
      getCachedConversation: vi.fn((id: string) => (id === failed.id ? failed : next)),
      getConversationSync: vi.fn((id: string) => (id === failed.id ? failed : next)),
      getConversationById: vi.fn(async (id: string) => {
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
    tabRoot.createDiv = vi.fn().mockImplementation(() => {
      throw shellError;
    });
    const onTabCreated = vi.fn();
    const manager = createTabManager(await createPlugin(), containerEl, { onTabCreated });

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
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      throw assemblyError;
    }) as unknown as typeof ResizeObserver;
    const plugin = await createPlugin();
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const onTabCreated = vi.fn();
    const manager = createTabManager(plugin, containerEl, { onTabCreated });

    try {
      await expect(manager.createTab(null, tabId)).rejects.toBe(assemblyError);

      expect(manager.getAllTabs()).toEqual([]);
      expect(onTabCreated).not.toHaveBeenCalled();
      expect(removeTabRoot).toHaveBeenCalledTimes(1);
      expect(coordinatorInstances).toHaveLength(1);
      expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
      expect(cancelTitle).toHaveBeenCalledTimes(1);
      expectTabManagerMetadataReleased(manager, tabId);
    } finally {
      await manager.destroy();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('rolls back UI and core ownership when controller construction fails', async () => {
    const controllerError = new Error('controller construction failed');
    const tabId = 'controller-failure';
    const disconnects: ReturnType<typeof vi.fn>[] = [];
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      const disconnect = vi.fn();
      disconnects.push(disconnect);
      return { disconnect, observe: vi.fn() };
    }) as unknown as typeof ResizeObserver;
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const onTabCreated = vi.fn();
    const manager = createTabManager(await createPlugin(), containerEl, { onTabCreated }, {
      getSharedSelectionFocusScopeEls: () => {
        throw controllerError;
      },
    });

    await expect(manager.createTab(null, tabId)).rejects.toBe(controllerError);

    expect(manager.getAllTabs()).toEqual([]);
    expect(onTabCreated).not.toHaveBeenCalled();
    expect(disconnects.length).toBeGreaterThan(0);
    for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(cancelTitle).toHaveBeenCalledTimes(1);
    expect(removeTabRoot).toHaveBeenCalledTimes(1);
    expectTabManagerMetadataReleased(manager, tabId);
    await manager.destroy();
  });

  it('rolls back controllers, UI, and core ownership when input wiring fails', async () => {
    const wiringError = new Error('input wiring failed');
    const tabId = 'input-failure';
    const disconnects: ReturnType<typeof vi.fn>[] = [];
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      const disconnect = vi.fn();
      disconnects.push(disconnect);
      return { disconnect, observe: vi.fn() };
    }) as unknown as typeof ResizeObserver;
    const originalInitialize = NavigationController.prototype.initialize;
    const initializeSpy = vi.spyOn(NavigationController.prototype, 'initialize')
      .mockImplementation(function(this: NavigationController) {
        originalInitialize.call(this);
        const inputEl = this['deps'].getInputEl();
        const addEventListener = inputEl.addEventListener.bind(inputEl);
        inputEl.addEventListener = vi.fn<typeof inputEl.addEventListener>((event: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (event === 'keydown') throw wiringError;
          return addEventListener(event, listener, options);
        });
      });
    const disposeSpy = vi.spyOn(NavigationController.prototype, 'dispose');
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const onTabCreated = vi.fn();
    const manager = createTabManager(await createPlugin(), containerEl, { onTabCreated });

    try {
      await expect(manager.createTab(null, tabId)).rejects.toBe(wiringError);

      expect(manager.getAllTabs()).toEqual([]);
      expect(onTabCreated).not.toHaveBeenCalled();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(disconnects.length).toBeGreaterThan(0);
    for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalledTimes(1);
      expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
      expect(cancelTitle).toHaveBeenCalledTimes(1);
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
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      throw assemblyError;
    }) as unknown as typeof ResizeObserver;
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    removeTabRoot.mockImplementation(() => { throw rollbackError; });
    const manager = createTabManager(await createPlugin(), containerEl);

    const error = await manager.createTab(null, tabId).catch(cause => cause);

    expect(error).toBeInstanceOf(TabRuntimeConstructionError);
    expect(error.cause).toBe(assemblyError);
    expect(error.rollbackFailures).toEqual([
      { error: rollbackError, resource: 'tab DOM root' },
    ]);
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(cancelTitle).toHaveBeenCalledTimes(1);
    expect(removeTabRoot).toHaveBeenCalledTimes(1);
    expect(manager.getAllTabs()).toEqual([]);
    expectTabManagerMetadataReleased(manager, tabId);
    await manager.destroy();
  });

  it('snapshots the global provider-qualified model without changing an existing blank tab', async () => {
    const plugin = await createPlugin();
    plugin.settings.lastSelectedChatModel = {
      providerId: 'claude',
      model: 'claude-default',
    };
    const existing = await createTestTab({ plugin, containerEl: document.createElement('div') });

    plugin.settings.lastSelectedChatModel = {
      providerId: 'claude',
      model: 'claude-alternate',
    };
    const next = await createTestTab({ plugin, containerEl: document.createElement('div') });

    expect(existing.draftModel).toBe('claude-default');
    expect(next.draftModel).toBe('claude-alternate');
    expect(next.providerId).toBe('claude');
  });

  it('keeps an explicit blank-tab selection through loading and changed catalog publications', async () => {
    const plugin = await createPlugin();
    const uiConfig = ProviderRegistry.getChatUIConfig('claude');
    plugin.settings.lastSelectedChatModel = { providerId: 'claude', model: 'claude-default' };
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    (uiConfig.getModelOptions as Mock).mockReturnValue([]);
    onProviderAvailabilityChanged(tab, plugin);
    expect(tab.draftModel).toBe('claude-default');
    expect(tab.providerId).toBe('claude');
    (uiConfig.getModelOptions as Mock).mockReturnValue([{ value: 'claude-alternate', label: 'Alternate' }]);
    (uiConfig.getDefaultModel as Mock).mockReturnValue('claude-alternate');
    onProviderAvailabilityChanged(tab, plugin);
    expect(tab.draftModel).toBe('claude-default');
  });

  it('preserves an unavailable last-selected model when creating a blank tab and publishing availability', async () => {
    const plugin = await createPlugin();
    plugin.settings.lastSelectedChatModel = { providerId: 'claude', model: 'retired' };
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    onProviderAvailabilityChanged(tab, plugin);
    expect(tab.providerId).toBe('claude');
    expect(tab.draftModel).toBe('retired');
  });

  it('restores a draft on its recorded provider even when model ownership is unresolved', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div'),
      draftModel: 'retired-endpoint', providerId: 'codex',
    });
    expect(tab.providerId).toBe('codex');
    expect(tab.draftModel).toBe('retired-endpoint');
  });

  it('restores an ownerless legacy draft as a blocked tab', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div'), draftModel: 'retired-endpoint' });
    expect(tab.providerId).toBeNull();
    expect(tab.draftModel).toBe('retired-endpoint');
    await expect(tab.session.runtime.model.ensureExecutionInitialized()).resolves.toBe(false);
    expect(ensureInitialized).not.toHaveBeenCalled();
    expect(coordinatorInstances[0].bindConversation).not.toHaveBeenCalled();
  });

  it('persists and reopens an unresolved draft without starting provider services', async () => {
    const plugin = await createPlugin();
    plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    const manager = createTabManager(plugin, document.createElement('div'));
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
    const reopened = createTabManager(plugin, document.createElement('div'));
    await reopened.restoreState(saved);
    expect(reopened.getActiveTab()?.providerId).toBeNull();
    expect(ensureInitialized).not.toHaveBeenCalled();
    const active = reopened.getActiveTab()!;
    const option = Array.from([...active.dom.inputWrapper.querySelectorAll<HTMLElement>('.claudian-model-option')])
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
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    tab.session.selectDraft('codex', tab.draftModel);
    tab.session.selectDraft(tab.providerId, 'gpt-5.4');
    plugin.settings.providerConfigs = { ...plugin.settings.providerConfigs, codex: { enabled: false } };
    onProviderAvailabilityChanged(tab, plugin);
    expect(getSessionProviderId(tab, plugin)).toBe('codex');
    expect(tab.providerId).toBe('codex');
    expect(tab.draftModel).toBe('gpt-5.4');
  });

  it('adopts a provider default when a model-less blank tab gains available options', async () => {
    const plugin = await createPlugin();
    const uiConfig = ProviderRegistry.getChatUIConfig('claude');
    (uiConfig.getDefaultModel as Mock).mockReturnValue(null);
    (uiConfig.getModelOptions as Mock).mockReturnValue([]);
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });

    expect(tab.draftModel).toBeNull();

    (uiConfig.getDefaultModel as Mock).mockReturnValue('claude-default');
    (uiConfig.getModelOptions as Mock).mockReturnValue([
      { label: 'Claude Default', value: 'claude-default' },
    ]);

    expect(onProviderAvailabilityChanged(tab, plugin)).toBe(true);
    expect(tab.draftModel).toBe('claude-default');
    expect(tab.providerId).toBe('claude');
  });

  it('records an explicit blank-tab model choice as the future-tab seed', async () => {
    const plugin = await createPlugin();
    const onDraftModelChanged = vi.fn();
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      onDraftModelChanged,
    });
    const modelOptions = Array.from(
      [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
        '.claudian-model-option',
      )] as HTMLElement[],
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
    registerChatTestProvider('codex', { models: [{ label: 'Codex', value: 'codex-default' }] });
    const initialization = deferred<void>();
    const onProviderChanged = vi.fn(() => initialization.promise);

    {
      const plugin = await createPlugin({ settings: { providerConfigs: { codex: { enabled: true } } } });
      const tab = await createTestTab({ plugin, containerEl: document.createElement('div') }, {
        onProviderChanged,
      });
      const modelOptions = Array.from(
        [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
          '.claudian-model-option',
        )] as HTMLElement[],
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

      expect(plugin.settings.lastSelectedChatModel).toBeNull();
    }
  });

  it('does not restore provider selection when failed selection settles after teardown', async () => {
    registerChatTestProvider('codex', { models: [{ label: 'Codex', value: 'codex-default' }] });
    const initialization = deferred<void>();
    const onProviderChanged = vi.fn(() => initialization.promise);

    {
      const plugin = await createPlugin({ settings: { providerConfigs: { codex: { enabled: true } } } });
      const tab = await createTestTab({ plugin, containerEl: document.createElement('div') }, {
        onProviderChanged,
      });
      // A new session shows one provider's models at a time; browse to Codex first.
      browseProvider(tab, 'codex');
      const modelOptions = Array.from(
        [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
          '.claudian-model-option',
        )] as HTMLElement[],
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
      expect(plugin.settings.lastSelectedChatModel).toBeNull();
    }
  });

  it('does not seed a blank-tab model choice after its commit loses runtime ownership', async () => {
    const commitGate = deferred<void>();
    const plugin = await createPlugin();
    plugin.chatModelSelection.commitIntent = vi.fn(async (
      _intent: number,
      selection: Parameters<ChatFeatureHost['chatModelSelection']['commitIntent']>[1],
      isStillValid?: () => boolean,
    ) => {
      await commitGate.promise;
      if (isStillValid && !isStillValid()) return false;
      plugin.settings.lastSelectedChatModel = selection;
      return true;
    });
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    const modelOptions = Array.from(
      [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
        '.claudian-model-option',
      )] as HTMLElement[],
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

    expect(plugin.settings.lastSelectedChatModel).toBeNull();
  });

  it('does not seed an uninitialized provider after overlapping same-provider choices fail', async () => {
    registerChatTestProvider('codex', { models: [{ label: 'Codex First', value: 'codex-first' }, { label: 'Codex Latest', value: 'codex-latest' }] });
    let rejectCodexSwitch!: (error: Error) => void;
    const codexSwitch = new Promise<void>((_resolve, reject) => {
      rejectCodexSwitch = reject;
    });

    {
      const plugin = await createPlugin({ settings: { providerConfigs: { codex: { enabled: true } } } });
      const tab = await createTestTab({ plugin, containerEl: document.createElement('div') }, {
        onProviderChanged: () => codexSwitch,
      });
      // A new session shows one provider's models at a time; browse to Codex first.
      browseProvider(tab, 'codex');
      const modelOptions = Array.from(
        [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
          '.claudian-model-option',
        )] as HTMLElement[],
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
      expect(plugin.settings.lastSelectedChatModel).toBeNull();
    }
  });

  it('records an explicit bound-conversation model choice without changing its provider', async () => {
    const conversation = createConversation();
    const plugin = await createPlugin({
      updateConversation: vi.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
    });
    const modelOptions = Array.from(
      [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
        '.claudian-model-option',
      )] as HTMLElement[],
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
    const plugin = await createPlugin({
      updateConversation: vi.fn().mockResolvedValue(undefined),
    });
    plugin.chatModelSelection.commitIntent = vi.fn(async (
      _intent: number,
      selection: Parameters<ChatFeatureHost['chatModelSelection']['commitIntent']>[1],
      isStillValid?: () => boolean,
    ) => {
      await commitGate.promise;
      if (isStillValid && !isStillValid()) return false;
      plugin.settings.lastSelectedChatModel = selection;
      return true;
    });
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
    });
    const modelOptions = Array.from(
      [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
        '.claudian-model-option',
      )] as HTMLElement[],
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

    expect(plugin.settings.lastSelectedChatModel).toBeNull();
  });

  it('does not publish a detached tab model choice after persistence', async () => {
    const persistence = deferred<void>();
    const conversation = createConversation();
    const plugin = await createPlugin({
      updateConversation: vi.fn(() => persistence.promise),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
    });
    const modelOptions = Array.from(
      [...tab.dom.inputWrapper.querySelectorAll<HTMLElement>(
        '.claudian-model-option',
      )] as HTMLElement[],
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
    expect(plugin.settings.lastSelectedChatModel).toBeNull();
  });

  it('binds persisted native state and prepares only for a bound conversation', async () => {
    const conversation = createConversation();
    const plugin = await createPlugin({
      getConversationById: vi.fn().mockResolvedValue(conversation),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
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
    const plugin = await createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
    });
    const coordinator = coordinatorInstances[0];

    await expect(tab.session.runtime.model.ensureExecutionInitialized()).resolves.toBe(true);

    expect(coordinator.bindConversation).toHaveBeenCalledWith(null);
    expect(coordinator.prepare).not.toHaveBeenCalled();
  });

  it('routes /clear to the manager-owned New port instead of resetting the tab itself', async () => {
    const conversation = createConversation();
    const plugin = await createPlugin();
    const startNewConversation = vi.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
    }, { startNewConversation });
    tab.dom.inputEl.value = '/clear';

    await tab.controllers.inputController!.sendMessage();

    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(tab.executionCoordinator.execute).not.toHaveBeenCalled();
    expect(tab.conversationId).toBe(conversation.id);
  });

  it('hands a /clear submission with a newline separator to provider execution instead of the manager', async () => {
    const conversation = createConversation();
    const cached: Conversation = conversation;
    const plugin = await createPlugin({
      getCachedConversation: vi.fn(() => cached),
      getConversationById: vi.fn(async () => cached),
      getConversationSync: vi.fn(() => cached),
      renameConversation: vi.fn().mockResolvedValue(undefined),
    });
    const startNewConversation = vi.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
    }, { startNewConversation });
    tab.dom.inputEl.value = '/clear\nExplain this command';

    await tab.controllers.inputController.sendMessage();

    expect(startNewConversation).not.toHaveBeenCalled();
    const coordinator = tab.executionCoordinator;
    expect(coordinator.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(coordinator.execute).mock.calls[0]![0].canonicalText).toBe('/clear\nExplain this command');
  });

  it('does not route manager-owned commands from a closing runtime', async () => {
    const startNewConversation = vi.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin: await createPlugin(),
      containerEl: document.createElement('div'),
      conversation: createConversation(),
    }, { startNewConversation });
    tab.session.beginClose();
    tab.dom.inputEl.value = '/clear';

    await tab.controllers.inputController.sendMessage();

    expect(startNewConversation).not.toHaveBeenCalled();
  });

  it('claims a provisional preview without retaining it when the user types', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      lifecycleState: 'provisional',
    });
    expect(tab.session.isUserClaimed).toBe(false);

    tab.dom.inputEl.value = 'Keep this draft';
    fireEvent.input((tab.dom.inputEl));

    expect(tab.lifecycleState).toBe('provisional');
    expect(tab.session.isUserClaimed).toBe(true);
  });

  it('does not read textarea geometry when the user types', async () => {
    const tab = await createTestTab({
      plugin: await createPlugin(),
      containerEl: document.createElement('div'),
    });
    const readOffsetHeight = vi.fn(() => 102);
    const readScrollHeight = vi.fn(() => 102);
    Object.defineProperties(tab.dom.inputEl, {
      offsetHeight: { configurable: true, get: readOffsetHeight },
      scrollHeight: { configurable: true, get: readScrollHeight },
    });

    tab.dom.inputEl.value = 'Keep this runtime';
    fireEvent.input((tab.dom.inputEl));

    expect(tab.lifecycleState).toBe('open');
    expect(tab.session.isUserClaimed).toBe(true);
    expect(readOffsetHeight).not.toHaveBeenCalled();
    expect(readScrollHeight).not.toHaveBeenCalled();
  });

  it('claims a provisional preview without retaining it when the user attaches an image', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      lifecycleState: 'provisional',
    });
    const file = new File([new Uint8Array([1])], 'draft.png', { type: 'image/png' });
    // jsdom's File lacks the browser Blob.arrayBuffer API.
    file.arrayBuffer = async () => new Uint8Array([1]).buffer;
    const attached = await tab.ui.imageContextManager['addImageFromFile'](file, 'paste');

    expect(attached).toBe(true);
    expect(tab.lifecycleState).toBe('provisional');
    expect(tab.session.isUserClaimed).toBe(true);
  });

  it('claims a provisional preview without retaining it when the user removes captured editor context', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      lifecycleState: 'provisional',
    });
    const selectionController = tab.controllers.composerSelections['editor'];
    assert(selectionController instanceof SelectionController);
    selectionController['storedSelection'] = {
      lineCount: 1,
      notePath: 'note.md',
      selectedText: 'draft context',
    };
    selectionController['updateIndicator']();

    const removeButton = tab.dom.contextRowEl.querySelector<HTMLElement>(
      '.claudian-context-chip-remove',
    )!;
    fireEvent.click(removeButton);

    expect(tab.lifecycleState).toBe('provisional');
    expect(tab.session.isUserClaimed).toBe(true);
  });

  it('keeps a browsed conversation provisional after hydration', async () => {
    const conversation = createConversation();
    const plugin = await createPlugin({
    getConversationSync: vi.fn().mockReturnValue(conversation),
      getConversationById: vi.fn().mockResolvedValue(conversation),
      switchConversation: vi.fn().mockResolvedValue(conversation),
      updateConversation: vi.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
      lifecycleState: 'provisional',
    });
    await tab.session.runtime.model.hydrate();

    expect(tab.lifecycleState).toBe('provisional');
  });

  it('invalidates commands before binding a hydrated session and activates input after loading', async () => {
    const conversation = createConversation();
    const onCommandContextChanged = vi.fn();
    const plugin = await createPlugin({ getConversationById: vi.fn().mockResolvedValue(conversation) });
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div'), conversation, onCommandContextChanged });
    const activated = vi.spyOn(tab.controllers.inputController, 'onConversationActivated');
    onCommandContextChanged.mockClear();
    const binding = deferred<void>();
    const reading = deferred<void>();
    plugin.getConversationById.mockImplementationOnce(async () => { reading.resolve(); await binding.promise; return conversation; });
    const loading = tab.session.runtime.model.hydrate();
    await reading.promise;
    expect(activated).not.toHaveBeenCalled();
    binding.resolve(undefined);
    await loading;
    expect(activated).toHaveBeenCalledTimes(1);
    expect(onCommandContextChanged.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(coordinatorInstances[0].bindConversation).mock.invocationCallOrder[0]);
    expect(tab.state.currentConversationId).toBe(conversation.id);
  });

  it('routes requested events through the current input controller', async () => {
    const conversation = createConversation();
    const plugin = await createPlugin({ getConversationById: vi.fn(async () => conversation), renameConversation: vi.fn(async () => undefined), completeConversationTitleGeneration: vi.fn(async () => undefined) });
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div'), conversation });
    await tab.session.runtime.model.hydrate();
    const received = vi.spyOn(tab.controllers.inputController, 'handleExecutionEvent');
    vi.spyOn(FakeSession.prototype, 'execute').mockImplementationOnce(function (this: FakeSession, request) {
      executeSession.call(this, request);
      const run = this.runs.at(-1)!;
      run.events.push({ type: 'text_delta', text: 'Provider reply', scope: requestedScope(this, run, 1) });
      run.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(this, run, 2) });
      run.events.end();
      return run;
    });
    tab.dom.inputEl.value = 'Read this';
    await tab.controllers.inputController.sendMessage();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta', text: 'Provider reply' }));
    expect(tab.state.messages.some(message => message.content.includes('Provider reply'))).toBe(true);
  });

  it('keeps provider interactions action-required until they settle', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    const handleApprovalRequest = vi.spyOn(tab.controllers.inlinePrompts, 'requestApproval');

    const session = await nativeSession();
    session.emit({ type: 'background_turn_started', scope: { kind: 'background', sessionInstanceId: session.sessionInstanceId, sequence: 1, turnId: 'turn-1' } });
    const request = claude.createSession.mock.calls.at(-1)![0].interactionPort.requestApproval({
      description: 'Read note',
      input: { path: 'note.md' },
      interactionId: 'interaction-1',
      kind: 'approval',
      sessionInstanceId: session.sessionInstanceId,
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
    expect(runtimes[0].isIdle).toBe(false);

    tab.controllers.inlinePrompts.dismiss('interaction-1');
    await expect(request).resolves.toEqual({
      decision: 'cancel',
      interactionId: 'interaction-1',
    });

    expect(tab.state.attention).toBeNull();
  });

  it('releases idle tab sessions after 30 minutes and treats review-only tabs as idle', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });

    tab.state.markReviewRequired();

    vi.useFakeTimers();
    try {
      const session = await nativeSession();
      expect(runtimes[0].isIdle).toBe(true);
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
      expect(session.disposeCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(session.disposeCalls).toBe(1);
    } finally { vi.useRealTimers(); }
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
      vi.spyOn(tab.services.subagentManager, 'hasActiveAsyncSubagents').mockReturnValue(true);
    }],
    ['a rewind', (tab: AssembledTabRuntime) => { vi.spyOn(tab.state, 'isRewinding', 'get').mockReturnValue(true); }],
  ])('keeps the tab session through %s', async (_label, hold) => {
    const tab = await createTestTab({ plugin: await createPlugin(), containerEl: document.createElement('div') });
    expect(runtimes[0].isIdle).toBe(true);

    hold(tab);

    expect(runtimes[0].isIdle).toBe(false);
  });

  it('publishes background review only after persistence and respects acknowledgement during that save', async () => {
    const saving = deferred<void>();
    const plugin = await createPlugin({ updateConversation: vi.fn(() => saving.promise) });
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    tab.state.currentConversationId = 'conversation';
    const scope = { kind: 'background' as const, sequence: 1, sessionInstanceId: 'native', turnId: 'background' };
    await emitSessionEvent({ type: 'background_turn_started', scope });
    await emitSessionEvent({ type: 'text_delta', text: 'Background result', scope: { ...scope, sequence: 2 } });
    const completion = emitSessionEvent({ type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 3 } });
    for (let i = 0; i < 40 && !plugin.updateConversation.mock.calls.length; i++) await Promise.resolve();
    expect(plugin.updateConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({ lastActivityAt: expect.any(Number) }));
    expect(tab.state.attention).toBeNull();
    saving.resolve();
    await completion;
    expect(tab.state.attention).toMatchObject({ kind: 'review', outcome: 'completed' });
  });

  it('records background completion activity without requesting review for empty or metadata-only output', async () => {
    for (const usage of [false, true]) {
      const plugin = await createPlugin();
      const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
      tab.state.currentConversationId = 'conversation';
      const index = coordinatorInstances.length - 1;
      const scope = { kind: 'background' as const, sequence: 1, sessionInstanceId: 'native', turnId: 'background' };
        await emitSessionEvent({ type: 'background_turn_started', scope }, index);
      if (usage) await emitSessionEvent({ type: 'usage_updated', usage: {
        contextTokens: 10, contextWindow: 100, inputTokens: 10, percentage: 10,
      }, scope: { ...scope, sequence: 2 } }, index);
      await emitSessionEvent({ type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 3 } }, index);
      expect(plugin.updateConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({ lastActivityAt: expect.any(Number) }));
      expect(tab.state.attention).toBeNull();
      expect(tab.state.usage?.contextTokens ?? null).toBe(usage ? 10 : null);
      expect(tab.state.messages).toEqual([]);
    }
  });

  it('rejects stale provider binding events before touching the transcript', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    const session = await nativeSession();
    await coordinatorInstances[0].bindConversation(null);
    session.emit({ type: 'task_notification', content: 'Stale result', scope: { kind: 'session', sequence: 1, sessionInstanceId: session.sessionInstanceId } });
    await runtimes[0].awaitBackgroundWork();
    expect(tab.state.messages).toEqual([]);
    expect(plugin.updateConversation).not.toHaveBeenCalled();
  });

  it('routes async subagent completion to the session owner and persists its outcome', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    tab.state.currentConversationId = 'conversation';
    tab.services.subagentManager.handleTaskToolUse('task-1', { description: 'Background', prompt: 'Read', run_in_background: true }, tab.dom.messagesEl);
    tab.services.subagentManager.handleTaskToolResult('task-1', 'agent_id: subagent-1');
    const apply = vi.spyOn(tab.controllers.streamController.subagents, 'handleAsyncSubagentCompletion');
    const session = await nativeSession();
    session.snapshot = { ...session.snapshot, providerSessionId: 'native-session' };
    await emitSessionEvent({ type: 'session_state_changed', snapshot: session.snapshot, scope: { kind: 'session', sessionInstanceId: session.sessionInstanceId, sequence: 0 } });
    await emitSessionEvent({ originatingTurnId: 'turn-1', result: 'done',
      scope: { kind: 'session', sequence: 1, sessionInstanceId: 'session-instance-1' },
      status: 'completed', subagentId: 'subagent-1', type: 'async_subagent_completed' });
    expect(apply).toHaveBeenCalledWith({ providerSessionId: 'native-session', result: 'done', status: 'completed', taskId: 'subagent-1', type: 'async_subagent_completion' });
    expect(tab.services.subagentManager.getByTaskId('task-1')).toMatchObject({ status: 'completed', result: 'done' });
    expect(plugin.updateConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({ lastActivityAt: expect.any(Number) }));
    expect(tab.state.attention).toMatchObject({ kind: 'review', outcome: 'completed' });
  });

  it('applies subagent progress without waiting behind queued background work', async () => {
    const tab = await createTestTab({ plugin: await createPlugin(), containerEl: document.createElement('div') });
    const session = await nativeSession();
    const handleSubagentProgress = vi.spyOn(tab.controllers.streamController.subagents, 'handleSubagentProgress');
    let releaseBackground!: () => void;
    const release = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const blocked = tab.session.enqueueBackgroundWork(() => release);
    const progress = { toolCallId: 'task-1', summary: 'Reading the auth module' };

    try {
      session.emit({
        progress,
        scope: { kind: 'session', sequence: 1, sessionInstanceId: session.sessionInstanceId },
        type: 'subagent_progress',
      });

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
    const plugin = await createPlugin({ getCachedConversation: vi.fn(lookup), getConversationSync: vi.fn(lookup), getConversationById: vi.fn(async id => lookup(id)) });
    const manager = createTabManager(plugin);
    await manager.createTab(old.id);
    const rendering = deferred<void>();
    const enteredRender = deferred<void>();
    const renderMarkdown = MarkdownRenderer.render;
    const render = vi.spyOn(MarkdownRenderer, 'render').mockImplementationOnce(async (...args) => {
      enteredRender.resolve();
      await rendering.promise;
      await renderMarkdown(...args);
    });
    const scope = { kind: 'background' as const, sequence: 1, sessionInstanceId: 'native', turnId: 'background' };
    await emitSessionEvent({ type: 'background_turn_started', scope });
    await emitSessionEvent({ type: 'text_delta', text: 'Old background result', scope: { ...scope, sequence: 2 } });
    const completion = emitSessionEvent({ type: 'background_turn_completed', reason: 'completed', scope: { ...scope, sequence: 3 } });
    await enteredRender.promise;
    expect(render).toHaveBeenCalled();
    await manager.openConversation(next.id);
    expect(manager.getActiveTab()?.conversationId).toBe(next.id);
    expect(manager.getActiveTab()?.state.messages).toEqual([]);
    rendering.resolve();
    await completion;
    expect(plugin.updateConversation.mock.calls.every(([id]) => id === old.id)).toBe(true);
    expect(manager.getActiveTab()?.state.messages).toEqual([]);
    await manager.destroy();
  });

  it('keeps assembled references structurally stable across idempotent teardown', async () => {
    const manager = createTabManager(await createPlugin());

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
      plugin: await createPlugin(),
      containerEl: document.createElement('div'),
    });
    const replacementOwner = {
      dispose: vi.fn().mockResolvedValue([]),
    };

    expect(() => registerTabRuntimeResourceOwner(tab, replacementOwner))
      .toThrow('Tab runtime already has a registered resource owner');

    await destroyTab(tab);

    expect(replacementOwner.dispose).not.toHaveBeenCalled();
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('continues teardown after a cleanup failure without reacquiring or retrying resources', async () => {
    const cleanupError = new Error('navigation cleanup failed');
    const disconnects: ReturnType<typeof vi.fn>[] = [];
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      const disconnect = vi.fn();
      disconnects.push(disconnect);
      return { disconnect, observe: vi.fn() };
    }) as unknown as typeof ResizeObserver;
    const { containerEl, removeTabRoot } = createTrackedTabContainer();
    const tab = await createTestTab({ plugin: await createPlugin(), containerEl: containerEl });
    const failedDispose = vi.fn(() => {
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
    expect(disconnects.length).toBeGreaterThan(0);
    for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(removeTabRoot).toHaveBeenCalledTimes(1);
  });

  it('plugin shutdown cancels and drains a session after its tab was destroyed', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
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
    const pending = deferred<Conversation>();
    const conversation: Conversation = { providerId: 'claude', messages: [], sessionId: null,
      selectedModel: 'claude-default', id: 'created-during-close', title: 'Created', createdAt: 1, lastActivityAt: 1 };
    const blocked = deferred<void>();
    const createConversation = vi.fn(() => { if (phase === 'creation') blocked.resolve(); return phase === 'creation' ? pending.promise : Promise.resolve(conversation); });
    const getConversationById = vi.fn(() => { if (phase === 'hydration') blocked.resolve(); return pending.promise; });
    const updateConversation = vi.fn().mockResolvedValue(undefined);
    const plugin = await createPlugin({
      createConversation, getConversationById, updateConversation,
      renameConversation: vi.fn().mockResolvedValue(undefined),
    });
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });
    const sending = tab.controllers.inputController.sendMessage({ content: 'Preserve admitted first prompt' });
    const blockedCall = phase === 'creation' ? createConversation : getConversationById;
    await blocked.promise;
    expect(blockedCall).toHaveBeenCalledTimes(1);
    const closing = destroyTab(tab);
    pending.resolve(conversation);
    await Promise.all([sending, closing]);
    expect(tab.conversationId).toBe('created-during-close');
    expect(claude.createSession).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0].execute).toHaveBeenCalledTimes(1);
    expect(updateConversation).toHaveBeenCalledWith('created-during-close', expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'Preserve admitted first prompt' })]),
    }));
  });

  it('snapshots a bound session without cancelling or waiting for its response', async () => {
    const tab = await createTestTab({ plugin: await createPlugin(), containerEl: document.createElement('div') });
    tab.state.currentConversationId = 'active-conversation';
    const release = holdResponse(tab.session.turns);
    try {
      await expect(drainTabForShutdownSnapshot(tab)).resolves.toEqual({ cleanupFailures: [] });
      expect(tab.session.turns.isActive).toBe(true);
      expect(coordinatorInstances[0].cancel).not.toHaveBeenCalled();
      expect(coordinatorInstances[0].dispose).not.toHaveBeenCalled();
    } finally { await release(); }
  });

  it('numbers a fork from canonical user turns while retaining non-canonical history and the source project', async () => {
    const conversation = { ...createConversation(), projectId: 'project-1' };
    const plugin = await createPlugin({
      getConversationSync: vi.fn().mockReturnValue(conversation),
      projects: createProjectsFake([projectRecord({ id: 'project-1' })]),
    });
    const forkRequest = vi.fn().mockResolvedValue(undefined);
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
    }, {
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
      projectId: 'project-1',
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
    const forkRequest = vi.fn().mockResolvedValue(undefined);
    const plugin = await createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation: createConversation(),
    }, { forkRequestCallback: forkRequest });
    plugin.getConversationSync.mockReturnValue(createConversation());
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
    // The real coordinator yields at native identity resolution; close before its continuation.
    expect(coordinatorInstances[0].resolveForkSource).toHaveBeenCalled();
    tab.session.beginClose();
    await fork;

    expect(forkRequest).not.toHaveBeenCalled();
  });

  it('drops a fork when its source session shuts down during source resolution', async () => {
    const conversation = createConversation();
    const forkRequest = vi.fn().mockResolvedValue(undefined);
    const plugin = await createPlugin();
    const tab = await createTestTab({
      plugin,
      containerEl: document.createElement('div'),
      conversation,
    }, { forkRequestCallback: forkRequest });
    plugin.getConversationSync.mockReturnValue(createConversation());
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
    // The real coordinator yields at native identity resolution; close before its continuation.
    tab.session.runtime.beginShutdown();
    await fork;

    expect(forkRequest).not.toHaveBeenCalled();
  });

  it.each(['normal', 'yolo'] as const)('applies normalized %s permission events to tab settings', async (permissionMode) => {
    const plugin = await createPlugin();
    await createTestTab({ plugin, containerEl: document.createElement('div') });
    plugin.settings.permissionMode = permissionMode === 'normal' ? 'yolo' : 'normal';

    await emitSessionEvent({
      type: 'permission_mode_changed',
      permissionMode,
      scope: { kind: 'session', sessionInstanceId: 'session-instance-1', sequence: 1 },
      snapshot: { providerId: 'claude', revision: 1, status: 'idle' },
    });

    expect(plugin.settings.permissionMode).toBe(permissionMode === 'normal' ? 'acceptEdits' : 'yolo');
  });

  it('updates permission settings for an unbound tab', async () => {
    const plugin = await createPlugin();
    const tab = await createTestTab({ plugin, containerEl: document.createElement('div') });

    plugin.settings.permissionMode = 'yolo';
    expect(plugin.settings.permissionMode).toBe('yolo');

    await updateTabPermissionMode(tab, plugin, 'normal');

    expect(plugin.settings.permissionMode).toBe('acceptEdits');
  });
});
