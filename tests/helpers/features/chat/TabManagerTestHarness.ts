/**
 * Shared fixture for suites that drive a real TabManager over a mocked runtime factory.
 *
 * Each suite installs the module mocks itself so Vitest can hoist them, delegating to this
 * module through `vi.importActual`:
 *
 * ```ts
 * vi.mock('@/features/chat/tabs/TabLifecycle', async () => (
 *   (await vi.importActual('@test/helpers/features/chat/TabManagerTestHarness')).tabLifecycleModuleMock()
 * ));
 * ```
 *
 * This module must not import any mocked module (or TabManager) at load time, because
 * those mock factories load it while the suite's imports are still being evaluated.
 */
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { createMockEl } from '@test/helpers/MockElement';
import type { Mock } from 'vitest';

import { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { LinkedContentController } from '@/features/chat/linked-content/LinkedContentController';
import { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { ChatState } from '@/features/chat/state/ChatState';
import type { TabManager } from '@/features/chat/tabs/TabManager';
import { TabSession } from '@/features/chat/tabs/TabSession';
import type { TabLayoutPolicy } from '@/features/chat/tabs/types';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';


export const mockDestroyTab = vi.fn().mockResolvedValue(undefined);
export const mockDrainTabForShutdownSnapshot = vi.fn().mockResolvedValue({
  cleanupFailures: [],
});
export const mockTabs: any[] = [];
export const mockCreateTab = vi.fn((options: Record<string, any>) => createMockTab(options));
export const mockCreateTabRuntime = vi.fn(async (options: Record<string, any>) => {
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
export const mockChooseForkTarget = vi.fn();

export const commandLoader = {
  getCacheFingerprint: vi.fn().mockReturnValue('commands-v1'),
  isAvailable: vi.fn().mockReturnValue(true),
  loadCommands: vi.fn().mockResolvedValue({
    status: 'ready',
    items: [{ description: 'Review changes', name: 'review' }],
  }),
};
export const commandCatalog = {
  getDropdownConfig: vi.fn().mockReturnValue({}),
  listDropdownEntries: vi.fn().mockResolvedValue([]),
};

/** The real Linked content owner over the plugin's app; only the vault index is empty. */
function createLinkedContent(plugin: any): LinkedContentController {
  const controller = new LinkedContentController({
    app: plugin.app,
    getExcludedTags: () => plugin.settings?.excludedTags ?? [],
    getCachedVaultFiles: () => [],
    getCachedVaultFolders: () => [],
  });
  controller.resetAutoDraft();
  return controller;
}

const mockDraftSessions = new Map<string, ChatSessionRuntime>();
const mockLinkedContent = new WeakMap<ChatSessionRuntime, LinkedContentController>();
const mockDraftProjects = new WeakMap<ChatSessionRuntime, string | null>();

export function createMockTab(options: Record<string, any>): any {
  const review = new ChatState();
  const input = { value: '', focus: vi.fn() };
  const tab = {
    id: options.tabId ?? `tab-${mockTabs.length + 1}`,
    conversationId: options.conversation?.id ?? null,
    draftModel: options.conversation ? null : (options.draftModel ?? 'claude-default'),
    executionCoordinator: {
      getCommandSnapshot: () => undefined,
      hasBackgroundWork: false,
      publishedBackgroundWork: false,
      prepare: vi.fn().mockResolvedValue(undefined),
      state: 'absent',
    },
    hydrationState: options.conversation ? 'idle' : 'ready',
    lifecycleState: options.lifecycleState ?? 'open',
    providerId: options.conversation?.providerId ?? options.providerId ?? 'claude',
    session: null as unknown as TabSession,
    ...options.initialState,
    captureReviewableSettlement: options.captureReviewableSettlement ?? null,
    state: {
      acknowledgeReview: vi.fn(() => review.acknowledgeReview()),
      get reviewEpoch() { return review.reviewEpoch; },
      attention: null,
      currentConversationId: options.conversation?.id ?? null,
      hasPendingConversationSave: false,
      isRewinding: false,
      isStreaming: false,
      messages: [],
      markReviewRequired: vi.fn(),
      requiresAction: false,
    },
    services: {
      subagentManager: {
        hasActiveAsyncSubagents: vi.fn().mockReturnValue(false),
      },
    },
    composer: { focus: vi.fn() },
    linkedContent: null as unknown as LinkedContentController,
    controllers: {
      drafts: new ComposerDraftController({ getInput: () => input as never, getImages: () => null, getDestination: () => 'main' }),
      conversationController: {
        initializeWelcome: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
        cancelBranchDraft: vi.fn(),
        // The project seed belongs to the session's model, so a reattached session keeps it.
        seedDraftProject: vi.fn((projectId: string | null) => { mockDraftProjects.set(tab.session.runtime, projectId); }),
        get project() { return { projectId: mockDraftProjects.get(tab.session.runtime) ?? undefined, changeable: true }; },
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
      hydrate: vi.fn(async () => { tab.hydrationState = 'ready'; }),
      acknowledgeReviewIfVisible: () => tab.state.acknowledgeReview(),
      publish: () => tab.session.runtime.notifyChanged(),
      dismissInteractions: () => undefined,
      // The same seed the tab's controller reports; a held draft reattached elsewhere keeps it.
      conversationController: {
        get project() { return { projectId: mockDraftProjects.get(tab.session.runtime) ?? undefined, changeable: true }; },
      },
    }) as never);
  mockDraftSessions.set(session.sessionKey, session);
  tab.session = new TabSession(tab, session);
  // Linked content belongs to the session's model, so a reattached session keeps its choice.
  tab.linkedContent = mockLinkedContent.get(session) ?? createLinkedContent(options.plugin);
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
    activateTab: vi.fn(),
    commitProvisionalTab: vi.fn((tab) => {
      tab.session.claimUserOwnership();
      if (tab.lifecycleState === 'provisional') tab.session.commitAdmission();
    }),
    deactivateTab: vi.fn(),
    drainTabForShutdownSnapshot: (...args: unknown[]) => mockDrainTabForShutdownSnapshot(...args),
    destroyTab: (...args: unknown[]) => mockDestroyTab(...args),
    getTabTitle: vi.fn().mockReturnValue('Tab'),
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
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      getCommandCatalog: vi.fn().mockImplementation(() => commandCatalog),
      getIfInitialized: vi.fn().mockReturnValue({}),
      getCommandLoader: vi.fn().mockImplementation(() => commandLoader),
    },
  };
}

export function providerRegistryModuleMock() {
  return {
    ProviderRegistry: {
      getRegisteredProviderIds: vi.fn().mockReturnValue(['claude', 'codex', 'opencode']),
      getEnabledProviderIds: vi.fn().mockReturnValue(['claude']),
      getBlankTabProviderIds: vi.fn().mockReturnValue(['claude']),
      isEnabled: vi.fn().mockReturnValue(true),
      getChatUIConfig: vi.fn().mockReturnValue({ getModelOptions: () => [{ value: 'claude-default' }], getDefaultModel: () => 'claude-default' }),
      getModelPolicy: vi.fn().mockReturnValue({ getModelOptions: () => [{ value: 'claude-default' }], getDefaultModel: () => 'claude-default' }),
      getCapabilities: vi.fn().mockReturnValue({
        providerId: 'claude',
        supportsProviderCommands: true,
      }),
      getConversationHistoryService: vi.fn().mockReturnValue({
        buildForkProviderState: vi.fn().mockReturnValue({ fork: true }),
      }),
      resolveProviderForModel: vi.fn().mockReturnValue('claude'),
    },
  };
}

export function createPlugin(overrides: Record<string, unknown> = {}) {
  return {
    // Live projects New may inherit; any other seeded id resolves to no project.
    projects: createProjectsFake([projectRecord({ id: 'project-1' }), projectRecord({ id: 'project-2' })]),
    sessionRuntimes: {
      getAttachment: () => null,
      get: () => null,
      holdDraft: (runtime: ChatSessionRuntime) => ({ key: runtime.sessionKey, runtime, release: () => undefined }),
    },
    app: {
      vault: { adapter: { basePath: '/vault' }, getAbstractFileByPath: () => null },
      workspace: {
        getActiveFile: () => null,
        revealLeaf: vi.fn(),
        setActiveLeaf: vi.fn(),
      },
    },
    settings: {},
    providerHost: {
      executionLifecycleRegistry: {
        getProviderGeneration: vi.fn().mockReturnValue(0),
      },
    },
    createConversation: vi.fn().mockResolvedValue({
      id: 'forked',
      providerId: 'claude',
    }),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    findConversationAcrossViews: vi.fn().mockReturnValue(null),
    getAgentSkillResourceGeneration: vi.fn().mockReturnValue(0),
    getCachedConversation: vi.fn().mockReturnValue(null),
    getConversationById: vi.fn().mockResolvedValue(null),
    getConversationList: vi.fn().mockReturnValue([]),
    getConversationSummary(id: string) { return this.getCachedConversation(id); },
    getConversationSync: vi.fn().mockReturnValue(null),
    updateConversation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

export async function createManager(
  plugin = createPlugin(),
  callbacks: Record<string, unknown> = {},
  viewOverrides: Record<string, unknown> = {},
  layoutPolicy?: Partial<TabLayoutPolicy>,
) {
  // Loaded lazily: TabManager pulls in the mocked modules, whose factories load this module.
  const { TabManager: TabManagerClass } = await import('@/features/chat/tabs/TabManager');
  const view = {
    leaf: {},
    getTabManager: vi.fn(),
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
export function mockNextHydration(hydrate: (conversationId: string) => Promise<unknown>): Mock {
  const hydration = vi.fn(hydrate);
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
