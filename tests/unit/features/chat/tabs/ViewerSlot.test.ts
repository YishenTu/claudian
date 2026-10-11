import {
  commandCatalog,
  commandLoader,
  createManager,
  createMockTab,
  createPlugin,
  deferred,
  mockCreateTab,
  mockCreateTabRuntime,
  mockDestroyTab,
  mockNextHydration,
  mockTabs,
  runtimeOptions,
} from '@test/helpers/features/chat/TabManagerTestHarness';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

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

describe('ViewerSlot', () => {
  beforeEach(() => {
    jest.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(commandCatalog as never);
    jest.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue(commandLoader);
    jest.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockResolvedValue(undefined);
    jest.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockReturnValue({});
    mockTabs.length = 0;
    jest.clearAllMocks();
    (ProviderRegistry.getCapabilities as jest.Mock).mockReturnValue({
      providerId: 'claude',
      supportsProviderCommands: true,
    });
    commandLoader.loadCommands.mockResolvedValue({
      status: 'ready',
      items: [{ description: 'Review changes', name: 'review' }],
    });
  });

  it('reuses the provisional preview while browsing unopened sessions', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));

    await manager.viewerSlot.show('conversation-1');
    expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');
    const preview = manager.getActiveTab()!;
    await manager.viewerSlot.show('conversation-2');

    expect(manager.getTabCount()).toBe(1);
    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: preview.id, conversationId: 'conversation-2', lifecycleState: 'provisional' }));
  });

  it('keeps the latest provisional selection during overlapping preview hydration', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    await manager.viewerSlot.show('conversation-1');
    const firstHydration = deferred<void>();
    const switchedConversationIds: string[] = [];
    const hydrate = async (id: string) => {
      switchedConversationIds.push(id);
      if (id === 'conversation-2') await firstHydration.promise;
    };
    mockNextHydration(hydrate);

    const firstSelection = manager.viewerSlot.show('conversation-2');
    for (let attempt = 0;
      attempt < 20 && switchedConversationIds.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    expect(switchedConversationIds).toEqual(['conversation-2']);
    const supersededSelection = manager.viewerSlot.show('conversation-3');
    const latestSelection = manager.viewerSlot.show('conversation-4');

    mockNextHydration(hydrate);
    firstHydration.resolve(undefined);
    await Promise.all([firstSelection, supersededSelection, latestSelection]);

    expect(switchedConversationIds).toEqual(['conversation-2', 'conversation-4']);
    expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');
  });

  it('does not demote a preview retained while its conversation switch is pending', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    await manager.viewerSlot.show('conversation-1');
    const preview = manager.getActiveTab()!;
    const hydration = deferred<void>();
    const switchTo = mockNextHydration(async () => hydration.promise);

    const navigation = manager.viewerSlot.show('conversation-2');
    for (let attempt = 0; attempt < 10 && switchTo.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    preview.session.claimUserOwnership();
    preview.session.commitAdmission();
    hydration.resolve(undefined);
    await navigation;

    expect(manager.getActiveTab()?.lifecycleState).toBe('open');
  });

  it('keeps a stale provisional target that the user retained during initial hydration', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    await manager.createTab();
    const hydration = deferred<void>();
    mockCreateTabRuntime.mockImplementationOnce(async (options) => {
      const target = createMockTab(options);
      target.session.runtime.model.hydrate = jest.fn(async () => {
        await hydration.promise;
      });
      return target;
    });

    const staleNavigation = manager.viewerSlot.show('conversation-1');
    for (let attempt = 0; attempt < 20 && mockTabs.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    const retainedTarget = mockTabs[1];
    for (let attempt = 0;
      attempt < 20
        && retainedTarget.session.runtime.model.hydrate.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    const latestNavigation = manager.viewerSlot.show('conversation-2');
    retainedTarget.session.claimUserOwnership();
    retainedTarget.session.commitAdmission();
    hydration.resolve(undefined);
    await Promise.all([staleNavigation, latestNavigation]);

    expect(manager.getAllTabs()).toContain(retainedTarget);
    expect(retainedTarget.lifecycleState).toBe('open');
    expect(mockDestroyTab).not.toHaveBeenCalledWith(retainedTarget);
    expect(manager.getActiveTab()?.conversationId).toBe('conversation-2');
  });

  it('lets an immediate retained-tab selection supersede an in-flight preview', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const retained = await manager.createTab('retained-conversation');
    await manager.viewerSlot.show('conversation-1');
    const firstHydration = deferred<void>();
    const switchTo = mockNextHydration(async () => firstHydration.promise);

    const previewSelection = manager.viewerSlot.show('conversation-2');
    for (let attempt = 0; attempt < 20 && switchTo.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(switchTo).toHaveBeenCalledWith('conversation-2');

    const retainedSelection = manager.openConversation('retained-conversation');
    firstHydration.resolve(undefined);
    await Promise.all([previewSelection, retainedSelection]);

    expect(manager.getActiveTab()).toBe(retained);
  });

  it('drains and invalidates preview navigation before provisional cleanup', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    await manager.viewerSlot.show('conversation-1');
    const firstHydration = deferred<void>();
    const switchTo = mockNextHydration(async () => firstHydration.promise);

    const previewSelection = manager.viewerSlot.show('conversation-2');
    for (let attempt = 0; attempt < 20 && switchTo.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const cleanup = manager.viewerSlot.release();
    const ignoredLateSelection = manager.viewerSlot.show('conversation-3');

    firstHydration.resolve(undefined);
    await Promise.all([previewSelection, ignoredLateSelection, cleanup]);

    expect(manager.getAllTabs().every(tab => tab.lifecycleState !== 'provisional'))
      .toBe(true);
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  it('prevents queued preview navigation from creating tabs after destroy', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    await manager.viewerSlot.show('conversation-1');
    const firstHydration = deferred<void>();
    const switchTo = mockNextHydration(async () => firstHydration.promise);

    const firstSelection = manager.viewerSlot.show('conversation-2');
    for (let attempt = 0; attempt < 20 && switchTo.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const queuedSelection = manager.viewerSlot.show('conversation-3');
    const destruction = manager.destroy();

    firstHydration.resolve(undefined);
    await Promise.all([firstSelection, queuedSelection, destruction]);

    expect(manager.getAllTabs()).toHaveLength(0);
    expect(mockCreateTabRuntime).toHaveBeenCalledTimes(2);
  });

  it('discards provisional previews without removing open runtime tabs', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const first = await manager.createTab('conversation-1');
    const second = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([first, second]);
    expect(mockDestroyTab).toHaveBeenCalledTimes(1);
  });

  it('retains the active preview when it is the only tab', async () => {
    const { manager } = createManager(createPlugin({
      getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
    }));
    await manager.viewerSlot.show('conversation-1');
    const preview = manager.getActiveTab()!;
    expect(preview.lifecycleState).toBe('provisional');

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([preview]);
    expect(preview.lifecycleState).toBe('open');
    expect(mockDestroyTab).not.toHaveBeenCalled();
  });

  const conversationPlugin = () => createPlugin({
    getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
  });
  const pendingTurns: Array<() => void> = [];
  afterEach(() => {
    pendingTurns.splice(0).forEach(release => release());
  });
  const busyPreviewCases: Array<[string, (tab: any) => void]> = [
    ['a foreground turn', (tab) => {
      void tab.session.turns.run(() => new Promise<void>(resolve => { pendingTurns.push(resolve); }));
    }],
    ['provider background work', (tab) => { tab.executionCoordinator.hasBackgroundWork = true; }],
    ['a pending interaction', (tab) => { tab.state.requiresAction = true; }],
  ];
  const provisionalTabs = (manager: any) => manager.getAllTabs()
    .filter((tab: any) => tab.lifecycleState === 'provisional');

  it.each(busyPreviewCases)(
    'rebinds a preview holding %s without retaining its old presentation',
    async (_label, makeBusy) => {
      const { manager } = createManager(conversationPlugin());
      await manager.viewerSlot.show('conversation-1');
      const preview = manager.getActiveTab() as any;
      makeBusy(preview);

      await manager.viewerSlot.show('conversation-2');

      expect(manager.getAllTabs()).not.toContain(preview);
      expect(preview.conversationId).toBe('conversation-1');
      const slots = provisionalTabs(manager);
      expect(slots).toHaveLength(1);
      expect(slots[0].id).toBe(preview.id);
      expect(slots[0].conversationId).toBe('conversation-2');
      expect(manager.getActiveTabId()).toBe(slots[0].id);
    },
  );

  it.each(busyPreviewCases)(
    'detaches a preview holding %s when leaving the wide layout',
    async (_label, makeBusy) => {
      const { manager } = createManager(conversationPlugin());
      const retained = await manager.createTab('conversation-1');
      await manager.viewerSlot.show('conversation-2');
      const preview = manager.getActiveTab() as any;
      makeBusy(preview);

      await manager.viewerSlot.release();

      expect(manager.getAllTabs()).toEqual([retained]);
      expect(mockDestroyTab).toHaveBeenCalledWith(preview);
    },
  );

  it('returns to the last active retained tab when leaving wide discards the active preview', async () => {
    const { manager } = createManager(conversationPlugin());
    const lastActive = await manager.createTab('conversation-1');
    const neighbour = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');
    expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([lastActive, neighbour]);
    expect(manager.getActiveTabId()).toBe(lastActive!.id);
  });

  it('returns to a preview retained while active once a later preview is discarded', async () => {
    const { manager } = createManager(conversationPlugin());
    const first = await manager.createTab('conversation-1');
    await manager.viewerSlot.show('conversation-2');
    const promoted = manager.getActiveTab()!;
    manager.retainTabs([promoted.id]);
    const neighbour = await manager.createTab('conversation-3', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-4');

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([first, promoted, neighbour]);
    expect(manager.getActiveTabId()).toBe(promoted.id);
  });

  it('keeps a wide selection out of retained tabs when its owner closes during the switch', async () => {
    const plugin = conversationPlugin();
    const { manager } = createManager(plugin);
    const retained = await manager.createTab('retained-conversation');
    const target = await manager.createTab('conversation-1', undefined, { activate: false });
    const hydration = deferred<void>();
    target!.session.runtime.model.hydrate = jest.fn(() => hydration.promise);
    (retained!.session.runtime.model.hydrate as jest.Mock).mockClear();
    const opening = manager.viewerSlot.show('conversation-1');
    for (let attempt = 0;
      attempt < 20
        && (target!.session.runtime.model.hydrate as jest.Mock).mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.closeTab(target!.id);
    hydration.resolve();
    await opening;

    expect(retained!.session.runtime.model.hydrate).not.toHaveBeenCalled();
    expect(retained!.conversationId).toBe('retained-conversation');
    expect(manager.getActiveTab()).toEqual(expect.objectContaining({
      conversationId: 'conversation-1',
      lifecycleState: 'provisional',
    }));
  });

  it('creates a fresh provisional target when the reused preview closes during switching', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const source = await manager.createTab();
    await manager.viewerSlot.show('conversation-1');
    const preview = manager.getActiveTab();
    expect(preview?.lifecycleState).toBe('provisional');
    const previewSwitch = deferred<void>();
    const previewHydration = mockNextHydration(async () => previewSwitch.promise);

    const navigation = manager.viewerSlot.show('conversation-2');
    for (let attempt = 0;
      attempt < 10
        && previewHydration.mock.calls.length === 0;
      attempt += 1) {
      await Promise.resolve();
    }
    await manager.closeTab(preview!.id);
    previewSwitch.resolve(undefined);
    await navigation;

    expect(manager.getAllTabs()).toEqual(expect.arrayContaining([
      source,
      expect.objectContaining({
        conversationId: 'conversation-2',
        lifecycleState: 'provisional',
      }),
    ]));
  });

  describe('drafts and retention', () => {
    function linkedContentPlugin(paths: string[], overrides: Record<string, unknown> = {}) {
      const files = new Set(paths);
      return {
        files,
        plugin: createPlugin({
          app: {
            vault: {
              adapter: { basePath: '/vault' },
              getAbstractFileByPath: (path: string) => (files.has(path) ? { path } : null),
            },
            workspace: { revealLeaf: jest.fn(), setActiveLeaf: jest.fn() },
          },
          getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
          ...overrides,
        }),
      };
    }

    it('replaces the preview with a focused Linked content draft', async () => {
      const { plugin } = linkedContentPlugin(['Projects/Plan.md']);
      const { manager } = createManager(plugin);
      const retained = await manager.createTab('retained-conversation');
      await manager.viewerSlot.show('conversation-1');
      const preview = manager.getActiveTab()!;

      await manager.viewerSlot.startDraft({ linkedContentPath: 'Projects/Plan.md' });

      const draft = manager.getActiveTab() as any;
      expect(manager.getAllTabs()).toEqual([retained, draft]);
      expect(mockDestroyTab).toHaveBeenCalledWith(preview);
      expect(draft.conversationId).toBeNull();
      expect(draft.lifecycleState).toBe('provisional');
      expect(draft.linkedContent.selectExplicit).toHaveBeenCalledWith('Projects/Plan.md');
      expect(draft.composer.focus).toHaveBeenCalledTimes(1);
    });

    it('shows the new draft without passing through the last retained tab', async () => {
      const activations: string[] = [];
      const { manager } = createManager(conversationPlugin(), {
        onActiveTabChanged: (_from: string | null, to: string) => { activations.push(to); },
      });
      const retained = await manager.createTab('retained-conversation');
      await manager.viewerSlot.show('conversation-1');
      const preview = manager.getActiveTab()!;
      expect(preview.lifecycleState).toBe('provisional');
      activations.length = 0;

      await manager.viewerSlot.startDraft();

      const draft = manager.getActiveTab()!;
      expect(manager.getAllTabs()).toEqual([retained, draft]);
      expect(draft.lifecycleState).toBe('provisional');
      expect(activations).toEqual([draft.id]);
    });

    it('does not create a draft for Linked content that no longer exists', async () => {
      const { plugin } = linkedContentPlugin([]);
      const { manager } = createManager(plugin);

      await expect(manager.viewerSlot.startDraft({ linkedContentPath: 'Gone/Plan.md' }))
        .rejects.toThrow('Linked content is no longer available');

      expect(mockCreateTab).not.toHaveBeenCalled();
    });

    it('closes a draft whose Linked content disappears while it is created', async () => {
      const { files, plugin } = linkedContentPlugin(['Projects/Plan.md']);
      const { manager } = createManager(plugin);
      const retained = await manager.createTab();
      mockCreateTabRuntime.mockImplementationOnce(async (options) => {
        files.delete('Projects/Plan.md');
        return createMockTab(options);
      });

      await expect(manager.viewerSlot.startDraft({ linkedContentPath: 'Projects/Plan.md' }))
        .rejects.toThrow('Linked content is no longer available');

      expect(manager.getAllTabs()).toEqual([retained]);
      expect(mockTabs[1].linkedContent.selectExplicit).not.toHaveBeenCalled();
    });

    it('closes the draft when selecting its Linked content fails', async () => {
      const { plugin } = linkedContentPlugin(['Projects']);
      const { manager } = createManager(plugin);
      const retained = await manager.createTab();
      mockCreateTabRuntime.mockImplementationOnce(async (options) => {
        const tab = createMockTab(options);
        tab.linkedContent.selectExplicit = jest.fn(() => {
          throw new Error('invalid Linked content');
        });
        return tab;
      });

      await expect(manager.viewerSlot.startDraft({ linkedContentPath: 'Projects' }))
        .rejects.toThrow('invalid Linked content');

      expect(manager.getAllTabs()).toEqual([retained]);
    });

    it('starts /new from a wide-layout tab as a slot draft, leaving the source tab as it was', async () => {
      let slotManager: any = null;
      const { manager } = createManager(conversationPlugin(), {}, {}, {
        startNew: async (sourceTab) => {
          await slotManager.viewerSlot.startDraft({ sourceTab });
          return true;
        },
      });
      slotManager = manager;
      const source = await manager.createTab('conversation-1') as any;

      await runtimeOptions(0).startNewConversation();

      const draft = manager.getActiveTab()!;
      expect(draft).not.toBe(source);
      expect(draft.conversationId).toBeNull();
      expect(draft.lifecycleState).toBe('provisional');
      expect(source.conversationId).toBe('conversation-1');
    });

    it('clears the source tab in place for /new in the compact layout', async () => {
      const { manager } = createManager(conversationPlugin());
      const source = await manager.createTab('conversation-1') as any;

      await runtimeOptions(0).startNewConversation();

      expect(manager.getAllTabs()).toHaveLength(1);
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: source.id, conversationId: null }));
      expect(source.conversationId).toBe('conversation-1');
    });

    it('retains a pinned session as soon as it is shown and pinned previews on release', async () => {
      const pinned = new Set<string>(['pinned-conversation']);
      const { manager } = createManager(conversationPlugin(), {}, {}, {
        shouldRetainPreview: id => pinned.has(id),
      });
      await manager.createTab('retained-conversation');

      await manager.viewerSlot.show('pinned-conversation');
      expect(manager.getActiveTab()?.lifecycleState).toBe('open');

      await manager.viewerSlot.show('later-pinned');
      const preview = manager.getActiveTab()!;
      expect(preview.lifecycleState).toBe('provisional');
      pinned.add('later-pinned');
      await manager.viewerSlot.release();

      expect(preview.lifecycleState).toBe('open');
      expect(manager.getAllTabs()).toContain(preview);
      expect(mockDestroyTab).not.toHaveBeenCalled();
    });
  });
});
