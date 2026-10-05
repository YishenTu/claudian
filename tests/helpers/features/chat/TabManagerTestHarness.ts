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

import type { TabManager } from '@/features/chat/tabs/TabManager';
import { TabSession } from '@/features/chat/tabs/TabSession';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

export const mockDestroyTab = jest.fn().mockResolvedValue(undefined);
export const mockDrainTabForShutdownSnapshot = jest.fn().mockResolvedValue({
  cancelledActiveTurn: false,
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
  setCommandSnapshot: jest.fn(),
};

export function createMockTab(options: Record<string, any>): any {
  const tab = {
    id: options.tabId ?? `tab-${mockTabs.length + 1}`,
    conversationId: options.conversation?.id ?? null,
    draftModel: options.conversation ? null : 'claude-default',
    executionCoordinator: {
      getCommandSnapshot: () => undefined,
      hasBackgroundWork: false,
      prepare: jest.fn().mockResolvedValue(undefined),
      state: 'absent',
    },
    hydrationState: options.conversation ? 'idle' : 'ready',
    lifecycleState: options.lifecycleState ?? 'open',
    providerId: options.conversation?.providerId ?? 'claude',
    session: null as unknown as TabSession,
    ...options.initialState,
    captureReviewableSettlement: options.captureReviewableSettlement ?? null,
    state: {
      acknowledgeReview: jest.fn(),
      attention: null,
      currentConversationId: options.conversation?.id ?? null,
      hasPendingConversationSave: false,
      isRewinding: false,
      isStreaming: false,
      isSwitchingConversation: false,
      messages: [],
      markReviewRequired: jest.fn(),
      requiresAction: false,
    },
    services: {
      subagentManager: {
        hasActiveAsyncSubagents: jest.fn().mockReturnValue(false),
      },
    },
    controllers: {
      conversationController: {
        initializeWelcome: jest.fn(),
        save: jest.fn().mockResolvedValue(undefined),
        switchTo: jest.fn().mockImplementation(async (conversationId: string) => {
          tab.session.setConversationId(conversationId);
          tab.state.currentConversationId = conversationId;
        }),
      },
      inputController: {
        resumeQueuedTurnAfterIntentAdmission: jest.fn(),
      },
      sideChatController: {
        destination: 'main',
        handleConversationChanged: jest.fn(),
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
  tab.session = new TabSession(tab, tab.executionCoordinator as never);
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

export function createManager(plugin = createPlugin(), callbacks: Record<string, unknown> = {}) {
  // Loaded lazily: TabManager pulls in the mocked modules, whose factories load this module.
  const { TabManager: TabManagerClass } = jest.requireActual<{ TabManager: typeof TabManager }>(
    '@/features/chat/tabs/TabManager',
  );
  const view = {
    leaf: {},
    getTabManager: jest.fn(),
  } as any;
  return {
    manager: new TabManagerClass(
      plugin,
      createMockEl() as any,
      view,
      callbacks,
      new VaultMentionDataProvider(plugin.app),
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
  expect(internals.tabActivationRevisions.has(tabId)).toBe(false);
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
