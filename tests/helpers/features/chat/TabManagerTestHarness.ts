/**
 * Shared fixture for suites that drive a real TabManager over a mocked runtime factory.
 *
 * Each suite installs the module mocks itself so Jest can hoist them, delegating to this
 * module through `jest.requireActual`:
 *
 * ```ts
 * jest.mock('@/features/chat/tabs/TabLifecycle', () => (
 *   jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').tabLifecycleModuleMock()
 * ));
 * ```
 *
 * This module must not import any mocked module (or TabManager) at load time, because
 * those mock factories load it while the suite's imports are still being evaluated.
 */
import { createMockEl } from '@test/helpers/MockElement';

import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TabManager } from '@/features/chat/tabs/TabManager';
import { TabSession } from '@/features/chat/tabs/TabSession';
import type { TabLayoutPolicy } from '@/features/chat/tabs/types';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

export const mockDestroyTab = jest.fn().mockResolvedValue(undefined);
export const mockDrainTabForShutdownSnapshot = jest.fn().mockResolvedValue({
  cleanupFailures: [],
});
export const mockTabs: any[] = [];
export const mockCreateTab = jest.fn((options: Record<string, any>) => createMockTab(options));
export const mockCreateTabRuntime = jest.fn(async (options: Record<string, any>) => {
  const captureReviewableSettlement = options.captureReviewableSettlement
    ? (outcome: 'completed' | 'error' = 'completed') => (
        options.captureReviewableSettlement(tab, outcome)
      )
    : undefined;
  const onConversationIdChanged = options.onConversationIdChanged;
  options.onConversationIdChanged = (runtime: any, id: string | null) => {
    runtime.session.setConversationId(id);
    onConversationIdChanged?.(runtime, id);
  };
  const tab = mockCreateTab({
    ...options,
    captureReviewableSettlement,
  });
  return tab;
});
export const mockChooseForkTarget = jest.fn();

export const commandLoader = {
  getCacheFingerprint: jest.fn().mockReturnValue('commands-v1'),
  isAvailable: jest.fn().mockReturnValue(true),
  loadCommands: jest.fn().mockResolvedValue({
    status: 'ready',
    items: [{ description: 'Review changes', name: 'review' }],
  }),
};
export const commandCatalog = {
  getDropdownConfig: jest.fn().mockReturnValue({}),
  listDropdownEntries: jest.fn().mockResolvedValue([]),
};

/** Records an explicit Linked content choice the way the controller's snapshot reports it. */
function createMockLinkedContent() {
  let snapshot: { mode: string; path: string | null } = { mode: 'auto-draft', path: null };
  return {
    getSnapshot: () => snapshot,
    selectExplicit: jest.fn((path: string | null) => { snapshot = { mode: 'explicit-draft', path }; }),
  };
}

const mockDraftSessions = new Map<string, ChatSessionRuntime>();
const mockLinkedContent = new WeakMap<ChatSessionRuntime, ReturnType<typeof createMockLinkedContent>>();

export function createMockTab(options: Record<string, any>): any {
  const review = new ChatState();
  const input = { value: '', focus: jest.fn() };
  const tab = {
    id: options.tabId ?? `tab-${mockTabs.length + 1}`,
    conversationId: options.conversation?.id ?? null,
    draftModel: options.conversation ? null : (options.draftModel ?? 'claude-default'),
    executionCoordinator: {
      getCommandSnapshot: () => undefined,
      hasBackgroundWork: false,
      publishedBackgroundWork: false,
      prepare: jest.fn().mockResolvedValue(undefined),
      state: 'absent',
    },
    hydrationState: options.conversation ? 'idle' : 'ready',
    lifecycleState: options.lifecycleState ?? 'open',
    providerId: options.conversation?.providerId ?? options.providerId ?? 'claude',
    session: null as unknown as TabSession,
    ...options.initialState,
    captureReviewableSettlement: options.captureReviewableSettlement ?? null,
    state: {
      acknowledgeReview: jest.fn(() => review.acknowledgeReview()),
      get reviewEpoch() { return review.reviewEpoch; },
      attention: null,
      currentConversationId: options.conversation?.id ?? null,
      hasPendingConversationSave: false,
      isRewinding: false,
      isStreaming: false,
      messages: [],
      markReviewRequired: jest.fn(),
      requiresAction: false,
    },
    services: {
      subagentManager: {
        hasActiveAsyncSubagents: jest.fn().mockReturnValue(false),
      },
    },
    composer: { focus: jest.fn() },
    linkedContent: null as unknown as ReturnType<typeof createMockLinkedContent>,
    controllers: {
      drafts: new ComposerDraftController({ getInput: () => input as never, getImages: () => null, getDestination: () => 'main' }),
      conversationController: {
        initializeWelcome: jest.fn(),
        save: jest.fn().mockResolvedValue(undefined),
        cancelBranchDraft: jest.fn(),
      },
      inputController: {
      },
      sideChatController: {
        destination: 'main',
        runtime: null,
      },
    },
    dom: {
      contentEl: createMockEl(),
      messagesEl: createMockEl(),
    },
    ui: {
    },
  };
  // The pool port reattaches a held draft by key; every other assembly starts its own session.
  const heldKey = options.draftSessionKey;
  const session = (heldKey ? mockDraftSessions.get(heldKey) : undefined)
    ?? new ChatSessionRuntime({ ...tab }, tab.executionCoordinator as never, () => ({
      state: tab.state,
      get hasPendingInteraction() { return tab.state.requiresAction; },
      hydrate: jest.fn(async () => { tab.hydrationState = 'ready'; }),
      acknowledgeReviewIfVisible: () => tab.state.acknowledgeReview(),
      publish: () => tab.session.runtime.notifyChanged(),
      dismissInteractions: () => undefined,
    }) as never);
  mockDraftSessions.set(session.sessionKey, session);
  tab.session = new TabSession(tab, session);
  // Linked content belongs to the session's model, so a reattached session keeps its choice.
  tab.linkedContent = mockLinkedContent.get(session) ?? createMockLinkedContent();
  mockLinkedContent.set(session, tab.linkedContent);
  for (const key of ['conversationId', 'providerId', 'draftModel'] as const) {
    Object.defineProperty(tab, key, { get: () => tab.session[key] });
  }
  void tab.session.runtime.model;
  Object.defineProperty(tab.state, 'currentConversationId', {
    get: () => tab.session.conversationId,
    set: (id: string | null) => tab.session.setConversationId(id),
  });
  mockTabs.push(tab);
  return tab;
}

export function tabLifecycleModuleMock() {
  return {
    activateTab: jest.fn(),
    commitProvisionalTab: jest.fn((tab) => {
      tab.session.claimUserOwnership();
      if (tab.lifecycleState === 'provisional') tab.session.commitAdmission();
    }),
    deactivateTab: jest.fn(),
    drainTabForShutdownSnapshot: (...args: unknown[]) => mockDrainTabForShutdownSnapshot(...args),
    destroyTab: (...args: unknown[]) => mockDestroyTab(...args),
    getTabTitle: jest.fn().mockReturnValue('Tab'),
  };
}

export function tabRuntimeFactoryModuleMock() {
  return {
    createTabRuntime: (options: Record<string, any>) => mockCreateTabRuntime(options),
  };
}

export function forkTargetModalModuleMock() {
  return {
    chooseForkTarget: (...args: unknown[]) => mockChooseForkTarget(...args),
  };
}

export function providerWorkspaceRegistryModuleMock() {
  return {
    ProviderWorkspaceRegistry: {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      getCommandCatalog: jest.fn().mockImplementation(() => commandCatalog),
      getIfInitialized: jest.fn().mockReturnValue({}),
      getCommandLoader: jest.fn().mockImplementation(() => commandLoader),
    },
  };
}

export function providerRegistryModuleMock() {
  return {
    ProviderRegistry: {
      getRegisteredProviderIds: jest.fn().mockReturnValue(['claude', 'codex', 'opencode']),
      getEnabledProviderIds: jest.fn().mockReturnValue(['claude']),
      getBlankTabProviderIds: jest.fn().mockReturnValue(['claude']),
      isEnabled: jest.fn().mockReturnValue(true),
      getChatUIConfig: jest.fn().mockReturnValue({ getModelOptions: () => [{ value: 'claude-default' }], getDefaultModel: () => 'claude-default' }),
      getModelPolicy: jest.fn().mockReturnValue({ getModelOptions: () => [{ value: 'claude-default' }], getDefaultModel: () => 'claude-default' }),
      getCapabilities: jest.fn().mockReturnValue({
        providerId: 'claude',
        supportsProviderCommands: true,
      }),
      getConversationHistoryService: jest.fn().mockReturnValue({
        buildForkProviderState: jest.fn().mockReturnValue({ fork: true }),
      }),
      resolveProviderForModel: jest.fn().mockReturnValue('claude'),
    },
  };
}

export function createPlugin(overrides: Record<string, unknown> = {}) {
  return {
    sessionRuntimes: {
      getAttachment: () => null,
      get: () => null,
      holdDraft: (runtime: ChatSessionRuntime) => ({ key: runtime.sessionKey, runtime, release: () => undefined }),
    },
    app: {
      vault: { adapter: { basePath: '/vault' } },
      workspace: {
        revealLeaf: jest.fn(),
        setActiveLeaf: jest.fn(),
      },
    },
    settings: {},
    providerHost: {
      executionLifecycleRegistry: {
        getProviderGeneration: jest.fn().mockReturnValue(0),
      },
    },
    createConversation: jest.fn().mockResolvedValue({
      id: 'forked',
      providerId: 'claude',
    }),
    deleteConversation: jest.fn().mockResolvedValue(undefined),
    findConversationAcrossViews: jest.fn().mockReturnValue(null),
    getAgentSkillResourceGeneration: jest.fn().mockReturnValue(0),
    getCachedConversation: jest.fn().mockReturnValue(null),
    getConversationById: jest.fn().mockResolvedValue(null),
    getConversationList: jest.fn().mockReturnValue([]),
    getConversationSummary(id: string) { return this.getConversationSync(id); },
    getConversationSync: jest.fn().mockReturnValue(null),
    updateConversation: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

export function createManager(
  plugin = createPlugin(),
  callbacks: Record<string, unknown> = {},
  viewOverrides: Record<string, unknown> = {},
  layoutPolicy?: Partial<TabLayoutPolicy>,
) {
  // Loaded lazily: TabManager pulls in the mocked modules, whose factories load this module.
  const { TabManager: TabManagerClass } = jest.requireActual<{ TabManager: typeof TabManager }>(
    '@/features/chat/tabs/TabManager',
  );
  const view = {
    leaf: {},
    getTabManager: jest.fn(),
    ...viewOverrides,
  } as any;
  return {
    manager: new TabManagerClass(
      plugin,
      createMockEl() as any,
      view,
      callbacks,
      new VaultMentionDataProvider(plugin.app),
      layoutPolicy && {
        forkTarget: () => 'ask',
        openPicked: async () => false,
        startNew: async () => false,
        showsPreviews: () => false,
        ...layoutPolicy,
      },
    ) as TabManager,
    plugin,
  };
}

/** Factory options the manager passed when assembling the `index`-th runtime. */
export function runtimeOptions(index: number): Record<string, any> {
  return mockCreateTabRuntime.mock.calls[index]?.[0] as Record<string, any>;
}

export function expectTabMetadataReleased(manager: TabManager, tabId: string): void {
  const internals = manager as any;
  const discovery = internals.commandDiscovery;
  expect(discovery.providerRuntimeCommandLoads.has(tabId)).toBe(false);
  expect(discovery.providerRuntimeCommandCache.has(tabId)).toBe(false);
  expect(discovery.providerCommandDiscoveryStores.has(tabId)).toBe(false);
  expect(discovery.tabCommandContextRevisions.has(tabId)).toBe(false);
}

export function deferred<T>(): {
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

/** Controls hydration at the runtime factory boundary, including replacement presentations. */
export function mockNextHydration(hydrate: (conversationId: string) => Promise<unknown>): jest.Mock {
  const hydration = jest.fn(hydrate);
  mockCreateTabRuntime.mockImplementationOnce(async options => {
    const tab = createMockTab(options);
    tab.session.runtime.model.hydrate = async () => {
      await hydration(tab.conversationId);
      tab.hydrationState = 'ready';
    };
    return tab;
  });
  return hydration;
}
