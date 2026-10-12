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

  it('discards inactive previews without removing open runtime tabs', async () => {
    const getCachedConversation = jest.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = createManager(createPlugin({ getCachedConversation }));
    const first = await manager.createTab('conversation-1');
    const second = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');
    await manager.switchToTab(first!.id);

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
      await manager.viewerSlot.show('conversation-1');

      await manager.viewerSlot.release();

      expect(manager.getAllTabs()).toEqual([retained]);
      expect(mockDestroyTab).toHaveBeenCalledWith(preview);
    },
  );

  it('keeps the shown preview as a tab when leaving wide', async () => {
    const { manager } = createManager(conversationPlugin());
    const retained = await manager.createTab('conversation-1');
    await manager.viewerSlot.show('conversation-2');
    const preview = manager.getActiveTab()!;
    expect(preview.lifecycleState).toBe('provisional');

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([retained, preview]);
    expect(preview.lifecycleState).toBe('open');
    expect(manager.getActiveTabId()).toBe(preview.id);
  });

  it('returns to the last active retained tab when the active preview closes', async () => {
    const { manager } = createManager(conversationPlugin());
    const lastActive = await manager.createTab('conversation-1');
    const neighbour = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');
    const preview = manager.getActiveTab()!;

    await manager.closeTab(preview.id);

    expect(manager.getAllTabs()).toEqual([lastActive, neighbour]);
    expect(manager.getActiveTabId()).toBe(lastActive!.id);
  });

  it('keeps a preview provisional while the user types, holding unsent text per session', async () => {
    const { manager } = createManager(conversationPlugin());
    await manager.viewerSlot.show('conversation-1');
    const typeDraft = (text: string) => {
      const tab = manager.getActiveTab()!;
      tab.session.claimUserOwnership();
      tab.controllers.drafts.restore('main', { content: text });
    };
    const shownDraft = () => manager.getActiveTab()!.controllers.drafts.capture('main').content;
    typeDraft('first session note');

    await manager.viewerSlot.show('conversation-2');
    expect(provisionalTabs(manager)).toHaveLength(1);
    expect(manager.getActiveTab()?.conversationId).toBe('conversation-2');
    expect(shownDraft()).toBe('');
    typeDraft('second session note');

    await manager.viewerSlot.show('conversation-1');
    expect(shownDraft()).toBe('first session note');
    await manager.viewerSlot.show('conversation-2');
    expect(shownDraft()).toBe('second session note');
    expect(manager.getAllTabs()).toHaveLength(1);
  });

  it("returns a new session's unsent text when another draft starts", async () => {
    const { manager } = createManager(conversationPlugin());
    await manager.viewerSlot.startDraft();
    manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'new idea' });

    await manager.viewerSlot.show('conversation-1');
    expect(manager.getActiveTab()!.controllers.drafts.capture('main').content).toBe('');
    await manager.viewerSlot.startDraft();

    const draft = manager.getActiveTab()!;
    expect(draft.conversationId).toBeNull();
    expect(draft.controllers.drafts.capture('main').content).toBe('new idea');
    expect(manager.getAllTabs()).toEqual([draft]);
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

  describe('wide layout without tabs', () => {
    const shownDraft = (manager: any) => manager.getActiveTab()!.controllers.drafts.capture('main').content;

    it('unloads narrow tabs on entering wide and hands the shown session back on leaving', async () => {
      const { manager } = createManager(conversationPlugin());
      const first = await manager.createTab('conversation-1');
      const second = await manager.createTab('conversation-2', undefined, { activate: false });
      first!.controllers.drafts.restore('main', { content: 'first note' });
      second!.controllers.drafts.restore('main', { content: 'second note' });

      await manager.viewerSlot.enter();

      const preview = manager.getActiveTab()!;
      expect(manager.getAllTabs()).toEqual([preview]);
      expect(preview).toEqual(expect.objectContaining({ conversationId: 'conversation-1', lifecycleState: 'provisional' }));
      expect(shownDraft(manager)).toBe('first note');
      expect(mockDestroyTab).toHaveBeenCalledWith(first);
      expect(mockDestroyTab).toHaveBeenCalledWith(second);
      expect(manager.getTabIdentities().map(tab => tab.id)).toEqual([first!.id, second!.id, preview.id]);

      await manager.viewerSlot.show('conversation-2');
      expect(manager.getTab(second!.id)).toBeNull();
      expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');
      expect(shownDraft(manager)).toBe('second note');

      await manager.viewerSlot.release();

      expect(manager.getTabIdentities().map(tab => tab.id)).toEqual([first!.id, second!.id]);
      expect(manager.getActiveTabId()).toBe(second!.id);
      expect(shownDraft(manager)).toBe('second note');
      await manager.switchToTab(first!.id);
      expect(shownDraft(manager)).toBe('first note');
    });

    it('replaces a closed active preview with a draft instead of a narrow tab', async () => {
      const { manager } = createManager(conversationPlugin(), {}, {}, { showsPreviews: () => true });
      const narrow = await manager.createTab('conversation-1');
      await manager.viewerSlot.enter();
      await manager.viewerSlot.show('conversation-2');

      await manager.closeTab(manager.getActiveTabId()!);

      expect(manager.getTab(narrow!.id)).toBeNull();
      expect(manager.getAllTabs()).toEqual([manager.getActiveTab()]);
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({ conversationId: null, lifecycleState: 'provisional' }));
    });

    it('enters wide again after a release that overlapped the request', async () => {
      const { manager } = createManager(conversationPlugin());
      const narrow = await manager.createTab('conversation-1');
      await manager.viewerSlot.enter();

      await Promise.all([manager.viewerSlot.release(), manager.viewerSlot.enter()]);

      expect(manager.getTab(narrow!.id)).toBeNull();
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({
        conversationId: 'conversation-1', lifecycleState: 'provisional',
      }));
    });

    it('unloads a blank narrow tab too and shows its same session in the viewer', async () => {
      const { manager } = createManager(conversationPlugin());
      const blank = await manager.createTab(null);
      const session = blank!.session.runtime;
      blank!.linkedContent.selectExplicit('chosen.md');
      blank!.controllers.drafts.restore('main', { content: 'new idea' });

      await manager.viewerSlot.enter();

      const preview = manager.getActiveTab()!;
      expect(manager.getAllTabs()).toEqual([preview]);
      expect(manager.getTab(blank!.id)).toBeNull();
      expect([preview.lifecycleState, preview.session.runtime === session]).toEqual(['provisional', true]);
      expect([shownDraft(manager), (preview.linkedContent as any).getSnapshot().path]).toEqual(['new idea', 'chosen.md']);

      await manager.viewerSlot.release();
      const restored = manager.getActiveTab()!;
      expect(restored.id).toBe(blank!.id);
      expect(restored.session.runtime).toBe(session);
      expect([shownDraft(manager), (restored.linkedContent as any).getSnapshot().path]).toEqual(['new idea', 'chosen.md']);
    });

    it("seeds a cold wide restore's new session from the saved blank tab selection", async () => {
      const { manager } = createManager(conversationPlugin(), {}, {}, { showsPreviews: () => true });

      await manager.restoreState({
        openTabs: [{ tabId: 'draft', conversationId: null, draftModel: 'codex:gpt-5', providerId: 'codex' }],
        activeTabId: 'draft',
      });

      const preview = manager.getActiveTab()!;
      expect([preview.lifecycleState, preview.draftModel, preview.providerId]).toEqual(['provisional', 'codex:gpt-5', 'codex']);
    });

    it('keeps unsent text with a draft session that creates its conversation while unloaded', async () => {
      const { manager } = createManager(conversationPlugin());
      const blank = await manager.createTab(null);
      await manager.viewerSlot.enter();
      const session = manager.getActiveTab()!.session.runtime;
      manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'follow-up' });
      await manager.viewerSlot.show('conversation-1');

      session.setConversationId('created');
      manager.reconcileUnloadedSessions();
      await manager.viewerSlot.release();
      await manager.switchToTab(blank!.id);

      expect(manager.getActiveTab()!.session.runtime).toBe(session);
      expect(shownDraft(manager)).toBe('follow-up');
    });

    it('returns to the same new session when New follows browsing another session', async () => {
      const { manager } = createManager(conversationPlugin());
      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;
      manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'new idea' });

      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.startDraft();

      expect(manager.getActiveTab()!.session.runtime).toBe(session);
      expect(shownDraft(manager)).toBe('new idea');
    });

    it('starts a fresh new session when the remembered one created its conversation while browsing', async () => {
      const { manager } = createManager(conversationPlugin());
      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;

      await manager.viewerSlot.show('conversation-1');
      session.setConversationId('created');
      await manager.viewerSlot.startDraft();

      expect(manager.getActiveTab()!.session.runtime).not.toBe(session);
      expect(manager.getActiveTab()!.conversationId).toBeNull();
    });

    it('leaves a usable presentation when narrowing supersedes an unloading wide entry', async () => {
      const { manager } = createManager(conversationPlugin());
      const narrow = await manager.createTab('conversation-1');
      const unloading = deferred<void>();
      mockDestroyTab.mockImplementationOnce(() => unloading.promise);

      const entering = manager.viewerSlot.enter();
      for (let attempt = 0; attempt < 20 && mockDestroyTab.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      const releasing = manager.viewerSlot.release();
      unloading.resolve(undefined);
      await Promise.all([entering, releasing]);

      expect(manager.getActiveTab()?.conversationId).toBe('conversation-1');
      expect(manager.getActiveTab()?.lifecycleState).toBe('open');
      expect(manager.getActiveTabId()).toBe(narrow!.id);
    });

    it("returns a blank tab's text after wide browsed another session", async () => {
      const { manager } = createManager(conversationPlugin());
      const blank = await manager.createTab(null);
      blank!.controllers.drafts.restore('main', { content: 'new idea' });

      await manager.viewerSlot.enter();
      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.release();
      await manager.switchToTab(blank!.id);

      expect(shownDraft(manager)).toBe('new idea');
    });

    it('restores a narrow workspace in wide without assembling its tabs', async () => {
      const { manager } = createManager(conversationPlugin(), {}, {}, { showsPreviews: () => true });

      await manager.restoreState({
        openTabs: [{ tabId: 'one', conversationId: 'conversation-1' }, { tabId: 'two', conversationId: 'conversation-2' }],
        activeTabId: 'two',
      });

      const preview = manager.getActiveTab()!;
      expect(manager.getAllTabs()).toEqual([preview]);
      expect(preview).toEqual(expect.objectContaining({ conversationId: 'conversation-2', lifecycleState: 'provisional' }));
      expect(manager.getPersistedState()).toEqual({
        openTabs: [
          { tabId: 'one', conversationId: 'conversation-1' },
          { tabId: 'two', conversationId: 'conversation-2' },
          { tabId: preview.id, conversationId: 'conversation-2', preview: true },
        ],
        activeTabId: preview.id,
      });
    });

    it('returns a saved preview to its narrow tab when restoring narrow', async () => {
      const { manager } = createManager(conversationPlugin());

      await manager.restoreState({
        openTabs: [
          { tabId: 'one', conversationId: 'conversation-1' },
          { tabId: 'shown', conversationId: 'conversation-1', preview: true },
        ],
        activeTabId: 'shown',
      });

      expect(manager.getTabIdentities().map(tab => tab.id)).toEqual(['one']);
      expect(manager.getActiveTabId()).toBe('one');
    });
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
  });
});
