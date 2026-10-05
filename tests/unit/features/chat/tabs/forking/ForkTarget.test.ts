import {
  commandCatalog,
  commandLoader,
  createManager,
  createMockTab,
  createPlugin,
  deferred,
  mockChooseForkTarget,
  mockCreateTabRuntime,
  mockDestroyTab,
  mockTabs,
  runtimeOptions,
} from '@test/helpers/features/chat/TabManagerTestHarness';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ForkContext } from '@/features/chat/conversation/forkSourceTypes';

jest.mock('@/features/chat/tabs/TabLifecycle', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').tabLifecycleModuleMock()
));
jest.mock('@/features/chat/tabs/tabProviderUI', () => ({ refreshTabWorkspaceServices: jest.fn() }));
jest.mock('@/features/chat/tabs/tabProviderLifecycle', () => ({ onProviderAvailabilityChanged: jest.fn().mockReturnValue(false) }));
jest.mock('@/features/chat/tabs/TabRuntimeFactory', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').tabRuntimeFactoryModuleMock()
));
jest.mock('@/features/chat/tabs/forking/ForkTargetModal', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').forkTargetModalModuleMock()
));
jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').providerWorkspaceRegistryModuleMock()
));
jest.mock('@/core/providers/ProviderRegistry', () => (
  jest.requireActual('@test/helpers/features/chat/TabManagerTestHarness').providerRegistryModuleMock()
));

/** Layout policy that skips the target chooser and always forks into a new runtime tab. */
const NEW_TAB_FORKS = { shouldForkToNewTab: () => true };
/** Layout policy that asks the chooser, which picks the current tab. */
const CURRENT_TAB_FORKS = { shouldForkToNewTab: () => false };

function forkContext(overrides: Partial<ForkContext> = {}): ForkContext {
  return {
    messages: [],
    providerId: 'claude',
    resumeAt: 'assistant-checkpoint',
    sourceConversationId: null,
    sourceSessionId: 'native-session',
    ...overrides,
  };
}

/** The fork request a runtime receives from its manager, bound to that runtime as source. */
function forkRequestFrom(runtimeIndex: number): (context: ForkContext) => Promise<void> {
  return runtimeOptions(runtimeIndex).forkRequestCallback;
}

async function flushUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !done(); attempt += 1) {
    await Promise.resolve();
  }
}

describe('ForkTarget', () => {
  beforeEach(() => {
    jest.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(commandCatalog as never);
    jest.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue(commandLoader);
    jest.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockResolvedValue(undefined);
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockReturnValue({});
    mockTabs.length = 0;
    jest.clearAllMocks();
    mockChooseForkTarget.mockReset();
    (ProviderRegistry.getCapabilities as jest.Mock).mockReturnValue({
      providerId: 'claude',
      supportsProviderCommands: true,
    });
  });

  it.each(['checkpoint', 'full-session'] as const)('preserves linked content and provider state for a %s fork', async (forkMode) => {
    const sourceConversation = {
      id: 'source-conversation',
      linkedContentPath: 'Projects',
      providerId: 'claude',
    };
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn().mockReturnValue(sourceConversation),
      getConversationSync: jest.fn().mockReturnValue(sourceConversation),
    }), NEW_TAB_FORKS);
    const source = await manager.createTab('source-conversation');

    source!.state.messages = [{ id: 'latest', role: 'assistant', content: 'Done', timestamp: 1 }];
    await forkRequestFrom(0)(forkContext({
      forkMode,
      linkedContentPath: 'Projects',
      messages: [...source!.state.messages],
      sourceConversationId: 'source-conversation',
    }));
    expect(plugin.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      linkedContentPath: 'Projects',
      providerId: 'claude',
    }));
    expect(plugin.updateConversation).toHaveBeenCalledWith(
      'forked',
      expect.objectContaining({ providerState: { fork: true } }),
    );
  });

  it('aborts a fork when its source runtime rebinds during provider-state creation', async () => {
    const forkState = deferred<Record<string, unknown>>();
    const buildForkProviderState = jest.fn(() => forkState.promise);
    (ProviderRegistry.getConversationHistoryService as jest.Mock).mockReturnValueOnce({
      buildForkProviderState,
    });
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), NEW_TAB_FORKS);
    const source = await manager.createTab('conversation-a');
    const conversationChanged = runtimeOptions(0)
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;

    const fork = forkRequestFrom(0)(forkContext({ sourceConversationId: 'conversation-a' }));
    await flushUntil(() => buildForkProviderState.mock.calls.length > 0);
    conversationChanged(source, 'conversation-b');
    forkState.resolve({ fork: true });

    await fork;
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([source]);
  });

  it('revalidates the fork lease before starting target-side effects', async () => {
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), NEW_TAB_FORKS);
    const source = await manager.createTab('conversation-a');
    const conversationChanged = runtimeOptions(0)
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;
    (plugin.updateConversation as jest.Mock).mockImplementationOnce(() => ({
      then: (resolve: (value?: void) => void) => {
        resolve();
        queueMicrotask(() => conversationChanged(source, 'conversation-b'));
      },
    }));

    await forkRequestFrom(0)(forkContext({ sourceConversationId: 'conversation-a' }));

    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(1);
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([source]);
  });

  it('aborts a fork when its source rebinds while choosing the fork target', async () => {
    const target = deferred<'current-tab'>();
    mockChooseForkTarget.mockReturnValueOnce(target.promise);
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), CURRENT_TAB_FORKS);
    const source = await manager.createTab('conversation-a');
    (source!.controllers.conversationController.switchTo as jest.Mock).mockClear();
    const factoryOptions = runtimeOptions(0);

    const fork = factoryOptions.forkRequestCallback(forkContext({
      sourceConversationId: 'conversation-a',
    }));
    await flushUntil(() => mockChooseForkTarget.mock.calls.length > 0);
    factoryOptions.onConversationIdChanged(source, 'conversation-b');
    target.resolve('current-tab');
    await fork;

    expect(plugin.createConversation).not.toHaveBeenCalled();
    expect(source!.controllers.conversationController.switchTo).not.toHaveBeenCalled();
  });

  it('forks into a new runtime tab without prompting in dual mode', async () => {
    const { manager } = createManager(createPlugin(), NEW_TAB_FORKS);
    await manager.createTab();

    await forkRequestFrom(0)(forkContext());

    expect(mockChooseForkTarget).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(manager.getTabCount()).toBe(2);
  });

  it('keeps a forked tab when its post-commit observer throws', async () => {
    const callbackError = new Error('Failed to render fork tab');
    let rejectForkTab = false;
    const onTabCreated = jest.fn(() => {
      if (rejectForkTab) throw callbackError;
    });
    const { manager, plugin } = createManager(createPlugin(), { ...NEW_TAB_FORKS, onTabCreated });
    await manager.createTab();
    rejectForkTab = true;

    await forkRequestFrom(0)(forkContext());

    expect(onTabCreated).toHaveBeenCalledTimes(2);
    expect(manager.getAllTabs()).toHaveLength(2);
    expect(plugin.deleteConversation).not.toHaveBeenCalled();
  });

  it('rejects a full-session fork if its source advances during native startup', async () => {
    const forkState = deferred<Record<string, unknown>>();
    const buildForkProviderState = jest.fn(() => forkState.promise);
    (ProviderRegistry.getConversationHistoryService as jest.Mock).mockReturnValueOnce({ buildForkProviderState });
    const { manager, plugin } = createManager(createPlugin(), NEW_TAB_FORKS);
    const source = await manager.createTab();
    source!.state.messages = [{ id: 'latest', role: 'assistant', content: 'Done', timestamp: 1 }];
    const fork = forkRequestFrom(0)(forkContext({
      messages: [...source!.state.messages], providerId: 'opencode', resumeAt: 'native-latest', forkMode: 'full-session',
    }));
    await flushUntil(() => buildForkProviderState.mock.calls.length > 0);
    expect(buildForkProviderState).toHaveBeenCalled();
    source!.state.messages.push({ id: 'next', role: 'user', content: 'Continue', timestamp: 2 });
    forkState.resolve({ sessionId: 'native-child' });
    await fork;
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([source]);
  });

  it('deletes a fork conversation when manager destruction wins the race', async () => {
    const forkState = deferred<Record<string, unknown>>();
    const buildForkProviderState = jest.fn(() => forkState.promise);
    (ProviderRegistry.getConversationHistoryService as jest.Mock).mockReturnValueOnce({
      buildForkProviderState,
    });
    const { manager, plugin } = createManager(createPlugin(), NEW_TAB_FORKS);
    await manager.createTab();

    const fork = forkRequestFrom(0)(forkContext());
    await flushUntil(() => buildForkProviderState.mock.calls.length > 0);
    expect(buildForkProviderState).toHaveBeenCalled();
    await manager.destroy();
    forkState.resolve({ fork: true });

    await fork;
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([]);
  });

  it('removes a fork tab assembled after its source begins closing', async () => {
    const { manager, plugin } = createManager(createPlugin(), NEW_TAB_FORKS);
    const retained = await manager.createTab();
    const source = await manager.createTab();
    const forkAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => forkAssembly.promise);

    const fork = forkRequestFrom(1)(forkContext());
    await flushUntil(() => mockCreateTabRuntime.mock.calls.length >= 3);
    const forkTab = createMockTab(runtimeOptions(2));
    await manager.closeTab(source!.id);
    forkAssembly.resolve(forkTab);

    await fork;
    expect(mockDestroyTab).toHaveBeenCalledWith(forkTab);
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([retained]);
  });

  it('keeps a fork tab retained by the user while its source closes', async () => {
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), NEW_TAB_FORKS);
    const retained = await manager.createTab();
    const source = await manager.createTab('source-conversation');
    const forkAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => forkAssembly.promise);

    const fork = forkRequestFrom(1)(forkContext({ sourceConversationId: 'source-conversation' }));
    await flushUntil(() => mockCreateTabRuntime.mock.calls.length >= 3);
    const forkTab = createMockTab(runtimeOptions(2));
    forkTab.session.claimUserOwnership();
    await manager.closeTab(source!.id);
    forkAssembly.resolve(forkTab);

    await fork;
    expect(manager.getAllTabs()).toEqual([retained, forkTab]);
    expect(plugin.deleteConversation).not.toHaveBeenCalledWith('forked');
    expect(mockDestroyTab).not.toHaveBeenCalledWith(forkTab);
  });

  it('keeps a fork conversation when failed compensation leaves its tab live', async () => {
    const replacementError = new Error('Replacement assembly failed');
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({
        id,
        providerId: 'claude',
      })),
    }), NEW_TAB_FORKS);
    const source = await manager.createTab();
    const forkAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(async () => forkAssembly.promise);

    const fork = forkRequestFrom(0)(forkContext());
    await flushUntil(() => mockCreateTabRuntime.mock.calls.length >= 2);
    const forkTab = createMockTab(runtimeOptions(1));
    (manager as any).tabs.delete(source!.id);
    (manager as any).activeTabId = null;
    mockCreateTabRuntime.mockRejectedValueOnce(replacementError);
    forkAssembly.resolve(forkTab);

    await expect(fork).rejects.toBe(replacementError);
    expect(manager.getAllTabs()).toEqual([forkTab]);
    expect(forkTab.conversationId).toBe('forked');
    expect(plugin.deleteConversation).not.toHaveBeenCalledWith('forked');
  });

  it('deletes a current-tab fork when its source closes during the switch', async () => {
    mockChooseForkTarget.mockResolvedValueOnce('current-tab');
    const { manager, plugin } = createManager(createPlugin(), CURRENT_TAB_FORKS);
    await manager.createTab();
    const source = await manager.createTab();
    const switchToFork = deferred<void>();
    const switchTo = source!.controllers.conversationController.switchTo as jest.Mock;
    switchTo.mockImplementationOnce(() => switchToFork.promise);

    const fork = forkRequestFrom(1)(forkContext());
    await flushUntil(() => switchTo.mock.calls.length > 0);
    await manager.closeTab(source!.id);
    switchToFork.resolve(undefined);

    await fork;
    expect(switchTo).toHaveBeenCalledWith('forked');
    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });

  it('retains a current-tab fork when a reversible close reservation rolls back', async () => {
    mockChooseForkTarget.mockResolvedValueOnce('current-tab');
    const replacementError = new Error('Replacement assembly failed');
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn((id: string) => ({ id, providerId: 'claude' })),
    }), CURRENT_TAB_FORKS);
    const source = await manager.createTab('source-conversation');
    const switchFork = deferred<void>();
    const conversationChanged = runtimeOptions(0)
      .onConversationIdChanged as (runtime: any, conversationId: string) => void;
    source!.controllers.conversationController.switchTo = jest.fn(async (conversationId: string) => {
      await switchFork.promise;
      source!.state.currentConversationId = conversationId;
      conversationChanged(source, conversationId);
    });

    const fork = forkRequestFrom(0)(forkContext({ sourceConversationId: 'source-conversation' }));
    await flushUntil(() => (
      (source!.controllers.conversationController.switchTo as jest.Mock).mock.calls.length > 0
    ));
    const replacementAssembly = deferred<any>();
    mockCreateTabRuntime.mockImplementationOnce(() => replacementAssembly.promise);
    const close = manager.discardTab(source!.id);

    switchFork.resolve(undefined);
    await fork;
    replacementAssembly.reject(replacementError);
    await expect(close).rejects.toBe(replacementError);

    expect(source!.conversationId).toBe('forked');
    expect(source!.session.acceptsIntents).toBe(true);
    expect(plugin.deleteConversation).not.toHaveBeenCalledWith('forked');
    expect(manager.getAllTabs()).toEqual([source]);
  });

  it('keeps the fork target chooser and current-tab replacement in single mode', async () => {
    mockChooseForkTarget.mockResolvedValueOnce('current-tab');
    const { manager, plugin } = createManager(createPlugin(), CURRENT_TAB_FORKS);
    const source = await manager.createTab();

    await forkRequestFrom(0)(forkContext());

    expect(mockChooseForkTarget).toHaveBeenCalledWith(plugin.app);
    expect(source!.controllers.conversationController!.switchTo).toHaveBeenCalledWith('forked');
    expect(manager.getTabCount()).toBe(1);
    expect(Notice).toHaveBeenCalled();
  });

  it('deletes a partial fork if metadata save fails', async () => {
    const { manager, plugin } = createManager(createPlugin({
      getCachedConversation: jest.fn().mockReturnValue({
        id: 'source-conversation',
        providerId: 'claude',
      }),
    }), NEW_TAB_FORKS);
    await manager.createTab('source-conversation');
    (plugin.updateConversation as jest.Mock).mockRejectedValueOnce(
      new Error('metadata save failed'),
    );

    await expect(forkRequestFrom(0)(forkContext({
      sourceConversationId: 'source-conversation',
    }))).rejects.toThrow('metadata save failed');

    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });

  it('deletes a partial fork if async provider-state construction fails', async () => {
    const { manager, plugin } = createManager(createPlugin(), NEW_TAB_FORKS);
    await manager.createTab();
    (ProviderRegistry.getConversationHistoryService as jest.Mock).mockReturnValueOnce({
      buildForkProviderState: jest.fn().mockRejectedValue(new Error('fork state failed')),
    });

    await expect(forkRequestFrom(0)(forkContext())).rejects.toThrow('fork state failed');

    expect(plugin.deleteConversation).toHaveBeenCalledWith('forked');
  });
});
