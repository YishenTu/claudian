import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { type ChatFeatureHostOptions,createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
export { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { Component, WorkspaceLeaf } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost, ChatViewHost } from '@/features/chat/ChatFeatureHost';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import type { TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import { TabConversationNavigation } from '@/features/chat/tabs/TabConversationNavigation';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { TabMembership } from '@/features/chat/tabs/TabMembership';
import { createTabRuntimeCallbacks, type TabRuntimeCallbackHost } from '@/features/chat/tabs/TabRuntimeCallbacks';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import type { TabLayoutPolicy, TabManagerCallbacks } from '@/features/chat/tabs/types';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

let sharedVault: Promise<DesktopVault> | undefined;
afterAll(async () => { await (await sharedVault)?.dispose(); });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

export async function createPlugin(overrides: ChatFeatureHostOptions = {}) {
  const fixture = overrides.fixture ?? await createFeatureHostFixture({
    vault: await (sharedVault ??= DesktopVault.create()),
    app: overrides.app,
    settings: {
      model: 'claude-default',
      lastSelectedChatModel: { providerId: 'claude', model: 'claude-default' },
      ...overrides.settings,
    },
  });
  const pool = createSessionRuntimePool(() => plugin);
  const messaging = new SessionMessagingService({
    getHost: () => plugin, getActiveConversationId: () => null, refreshModelControls: () => undefined,
  });
  const chatModelSelection = new ChatModelSelectionCoordinator(fixture.coordinator);
  const ports = {
    sessionRuntimes: pool,
    bindSessionTools: (id: string) => messaging.bindSessionTools(id),
    chatModelSelection,
    projects: createProjectsFake([projectRecord({ id: 'project-1' }), projectRecord({ id: 'project-2' })]),
    createConversation: vi.fn<ChatFeatureHost['createConversation']>(async () => conversationRecord('forked')),
    deleteConversation: vi.fn<ChatFeatureHost['deleteConversation']>(async () => undefined),
    findConversationAcrossViews: vi.fn<ChatFeatureHost['findConversationAcrossViews']>(() => null),
    getCachedConversation: vi.fn<ChatFeatureHost['getCachedConversation']>(id => conversationRecord(id)),
    getConversationById: vi.fn<ChatFeatureHost['getConversationById']>(async id => conversationRecord(id)),
    getConversationList: vi.fn<ChatFeatureHost['getConversationList']>(() => []),
    getConversationSync: vi.fn<ChatFeatureHost['getConversationSync']>(id => conversationRecord(id)),
    updateConversation: vi.fn<ChatFeatureHost['updateConversation']>(async () => undefined),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
  } satisfies Partial<ChatFeatureHost>;
  const { fixture: _fixture, settings: _settings, app: _app, ...capabilities } = overrides;
  const plugin: ChatFeatureHost = await createChatFeatureHost({ fixture, ...ports, ...capabilities });
  if (!capabilities.getConversationSummary) plugin.getConversationSummary = id => plugin.getCachedConversation(id);
  onTestFinished(() => messaging.dispose());
  return Object.assign(plugin, { pool });
}

export async function createManager(
  suppliedPlugin?: Awaited<ReturnType<typeof createPlugin>>,
  callbacks: TabManagerCallbacks = {},
  viewOverrides: Partial<TabManagerViewHost> = {},
  layoutPolicy?: Partial<TabLayoutPolicy>,
) {
  const plugin = suppliedPlugin ?? await createPlugin();
  const root = document.body.createDiv();
  const view: ChatViewHost = Object.assign(new Component(), {
    leaf: Object.assign(new WorkspaceLeaf(), plugin.app.workspace.getLeaf()),
    getTabManager: () => manager, getCompactTabManager: () => manager,
    getActiveTab: () => manager.getActiveTab(),
    startNewConversation: async () => { await manager.createTab(); },
    focusActiveInput: () => manager.getActiveTab()?.composer.focus(),
    isTabBarVisible: () => manager.getTabCount() > 1, renameActiveTab: () => false,
    notifyConversationListChanged: () => undefined, refreshModelSelector: () => undefined,
    refreshTabControls: () => undefined, refreshDualPaneLayout: () => undefined,
    refreshMessageTimestamps: () => undefined, updateHiddenCommands: () => undefined,
    invalidateProviderCommandCaches: () => undefined, invalidateProviderResources: () => undefined,
  }, viewOverrides);
  const manager = new TabManager(plugin, root, view, callbacks, new VaultMentionDataProvider(plugin.app), layoutPolicy && {
    forkTarget: () => 'ask', openPicked: async () => false, startNew: async () => false,
    showsPreviews: () => false, ...layoutPolicy,
  });
  onTestFinished(async () => { if (manager.getTabCount() > 0) await manager.destroy(); root.remove(); view.unload(); });
  return { manager, plugin, root, view, pool: plugin.pool };
}

export function holdHistory(plugin: ChatFeatureHost, conversationId: string) {
  const started = deferred<void>();
  const reply = deferred<Conversation | null>();
  const current = plugin.getConversationById;
  const original = (vi.isMockFunction(current) ? current.getMockImplementation()! : current).bind(plugin);
  const read = vi.spyOn(plugin, 'getConversationById').mockImplementation(id => {
    if (id !== conversationId) return original(id);
    started.resolve();
    return reply.promise;
  });
  read.mockClear();
  return { started: started.promise, release: () => reply.resolve(conversationRecord(conversationId)), read };
}


/** Drives the exported navigation contract on the manager's actual owner, including its source lease. */
export function navigationOwner(manager: TabManager): TabConversationNavigation {
  const owner: unknown = Reflect.get(manager, 'navigation');
  if (!(owner instanceof TabConversationNavigation)) throw new Error('TabManager navigation owner was not constructed');
  return owner;
}

/** ForkTarget receives this same membership owner from the composition in TabManager. */
export function membershipOwner(manager: TabManager): TabMembership {
  const owner: unknown = Reflect.get(manager, 'membership');
  if (!(owner instanceof TabMembership)) throw new Error('TabManager membership owner was not constructed');
  return owner;
}

/** Uses the manager's real callback composition with an explicit source runtime. */
export function forkRequestFrom(manager: TabManager, source: AssembledTabRuntime) {
  const host: TabRuntimeCallbackHost = Reflect.get(manager, 'runtimeCallbackHost');
  return createTabRuntimeCallbacks(host, () => source).forkRequestCallback!;
}
