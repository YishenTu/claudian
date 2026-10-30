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
import type { Mock } from 'vitest';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

vi.mock('@/features/chat/tabs/TabLifecycle', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).tabLifecycleModuleMock()
));
vi.mock('@/features/chat/tabs/tabProviderUI', () => ({ refreshTabWorkspaceServices: vi.fn() }));
vi.mock('@/features/chat/tabs/tabProviderLifecycle', () => ({ onProviderAvailabilityChanged: vi.fn().mockReturnValue(false) }));
vi.mock('@/features/chat/tabs/TabRuntimeFactory', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).tabRuntimeFactoryModuleMock()
));
vi.mock('@/features/chat/tabs/forking/ForkTargetModal', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).forkTargetModalModuleMock()
));
vi.mock('@/core/providers/ProviderWorkspaceRegistry', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).providerWorkspaceRegistryModuleMock()
));
vi.mock('@/core/providers/ProviderRegistry', async () => (
  (await vi.importActual<typeof import('@test/helpers/features/chat/TabManagerTestHarness')>('@test/helpers/features/chat/TabManagerTestHarness')).providerRegistryModuleMock()
));

describe('ViewerSlot', () => {
  beforeEach(() => {
    vi.mocked(ProviderWorkspaceRegistry.getCommandCatalog).mockReturnValue(commandCatalog as never);
    vi.mocked(ProviderWorkspaceRegistry.getCommandLoader).mockReturnValue(commandLoader);
    vi.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockResolvedValue(undefined);
    vi.mocked(ProviderWorkspaceRegistry.getIfInitialized).mockReturnValue({});
    mockTabs.length = 0;
    vi.clearAllMocks();
    (ProviderRegistry.getCapabilities as Mock).mockReturnValue({
      providerId: 'claude',
      supportsProviderCommands: true,
    });
    commandLoader.loadCommands.mockResolvedValue({
      status: 'ready',
      items: [{ description: 'Review changes', name: 'review' }],
    });
  });

  it('keeps the latest provisional selection during overlapping preview hydration', async () => {
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
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
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
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
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
    await manager.createTab();
    const hydration = deferred<void>();
    mockCreateTabRuntime.mockImplementationOnce(async (options) => {
      const target = createMockTab(options);
      target.session.runtime.model.hydrate = vi.fn(async () => {
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
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
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
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
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
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
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
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
    const first = await manager.createTab('conversation-1');
    const second = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');
    await manager.switchToTab(first!.id);

    await manager.viewerSlot.release();

    expect(manager.getAllTabs()).toEqual([first, second]);
    expect(mockDestroyTab).toHaveBeenCalledTimes(1);
  });

  it('retains the active preview when it is the only tab', async () => {
    const { manager } = await createManager(createPlugin({
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
      const { manager } = await createManager(conversationPlugin());
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
      const { manager } = await createManager(conversationPlugin());
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
    const { manager } = await createManager(conversationPlugin());
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
    const { manager } = await createManager(conversationPlugin());
    const lastActive = await manager.createTab('conversation-1');
    const neighbour = await manager.createTab('conversation-2', undefined, { activate: false });
    await manager.viewerSlot.show('conversation-3');
    const preview = manager.getActiveTab()!;

    await manager.closeTab(preview.id);

    expect(manager.getAllTabs()).toEqual([lastActive, neighbour]);
    expect(manager.getActiveTabId()).toBe(lastActive!.id);
  });

  it("returns a new session's unsent text when another draft starts", async () => {
    const { manager } = await createManager(conversationPlugin());
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
    const { manager } = await createManager(plugin);
    const retained = await manager.createTab('retained-conversation');
    const target = await manager.createTab('conversation-1', undefined, { activate: false });
    const hydration = deferred<void>();
    target!.session.runtime.model.hydrate = vi.fn(() => hydration.promise);
    (retained!.session.runtime.model.hydrate as Mock).mockClear();
    const opening = manager.viewerSlot.show('conversation-1');
    for (let attempt = 0;
      attempt < 20
        && (target!.session.runtime.model.hydrate as Mock).mock.calls.length === 0;
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
    const getCachedConversation = vi.fn((id: string) => ({
      id,
      providerId: 'claude',
    }));
    const { manager } = await createManager(createPlugin({ getCachedConversation }));
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

    it('replaces a closed active preview with a draft instead of a narrow tab', async () => {
      const { manager } = await createManager(conversationPlugin(), {}, {}, { showsPreviews: () => true });
      const narrow = await manager.createTab('conversation-1');
      await manager.viewerSlot.enter();
      await manager.viewerSlot.show('conversation-2');

      await manager.closeTab(manager.getActiveTabId()!);

      expect(manager.getTab(narrow!.id)).toBeNull();
      expect(manager.getAllTabs()).toEqual([manager.getActiveTab()]);
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({ conversationId: null, lifecycleState: 'provisional' }));
    });

    it('enters wide again after a release that overlapped the request', async () => {
      const { manager } = await createManager(conversationPlugin());
      const narrow = await manager.createTab('conversation-1');
      await manager.viewerSlot.enter();

      await Promise.all([manager.viewerSlot.release(), manager.viewerSlot.enter()]);

      expect(manager.getTab(narrow!.id)).toBeNull();
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({
        conversationId: 'conversation-1', lifecycleState: 'provisional',
      }));
    });

    it("seeds a cold wide restore's new session from the saved blank tab selection", async () => {
      const { manager } = await createManager(conversationPlugin(), {}, {}, { showsPreviews: () => true });

      await manager.restoreState({
        openTabs: [{ tabId: 'draft', conversationId: null, draftModel: 'codex:gpt-5', providerId: 'codex' }],
        activeTabId: 'draft',
      });

      const preview = manager.getActiveTab()!;
      expect([preview.lifecycleState, preview.draftModel, preview.providerId]).toEqual(['provisional', 'codex:gpt-5', 'codex']);
    });

    it('keeps unsent text with a draft session that creates its conversation while unloaded', async () => {
      const { manager } = await createManager(conversationPlugin());
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

    it('publishes a wide project draft already seeded, so a first input cannot outrun the seed', async () => {
      const seedsWhenActivated: unknown[] = [];
      const { manager } = await createManager(conversationPlugin(), {
        onActiveTabChanged: () => {
          const tab = manager.getActiveTab();
          if (tab && !tab.conversationId) {
            seedsWhenActivated.push((tab.controllers.conversationController as any).project.projectId);
          }
        },
      });
      await manager.createTab(null);
      await manager.viewerSlot.enter();
      seedsWhenActivated.length = 0;

      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      expect(seedsWhenActivated).toEqual(['project-1']);
    });

    it('starts a project-seeded draft in the compact active tab, as New does there', async () => {
      const { manager } = await createManager(conversationPlugin());
      const bound = await manager.createTab('conversation-1');
      const draftProject = () => (manager.getActiveTab()!.controllers.conversationController as any).project.projectId;

      await manager.createNewConversation({ projectId: 'project-1' });
      const tab = manager.getActiveTab()!;
      expect([manager.getTabCount(), tab.conversationId, draftProject()]).toEqual([1, null, 'project-1']);
      expect(tab.session.runtime === bound!.session.runtime).toBe(false);
    });

    it('publishes a compact project draft already seeded, so a first input cannot outrun the seed', async () => {
      const seedsWhenActivated: unknown[] = [];
      const { manager } = await createManager(conversationPlugin(), {
        onActiveTabChanged: () => {
          const tab = manager.getActiveTab();
          if (tab && !tab.conversationId) {
            seedsWhenActivated.push((tab.controllers.conversationController as any).project.projectId);
          }
        },
      });
      await manager.createTab('conversation-1');

      await manager.createNewConversation({ projectId: 'project-1' });
      expect(seedsWhenActivated).toEqual(['project-1']);
    });

    it('seeds the draft its request created even when another tab becomes active during hydration', async () => {
      const { manager } = await createManager(conversationPlugin());
      const bound = await manager.createTab('conversation-1');
      const other = await manager.createTab(null, undefined, { activate: false });
      await manager.switchToTab(bound!.id);
      const draftProject = (tab: typeof other) => (tab!.controllers.conversationController as any).project.projectId;
      const hydration = deferred<void>();
      mockNextHydration(async () => hydration.promise);

      const starting = manager.createNewConversation({ projectId: 'project-1' });
      await Promise.resolve();
      await manager.switchToTab(other!.id);
      hydration.resolve(undefined);
      await starting;

      const draft = manager.getAllTabs().find(tab => tab.id === bound!.id)!;
      expect([draft.conversationId, draftProject(draft), draftProject(manager.getActiveTab())]).toEqual([null, 'project-1', undefined]);
    });

    it('reattaches a remembered project draft without reseeding it, since its first turn may have frozen the seed', async () => {
      const { manager } = await createManager(conversationPlugin());
      await manager.createTab(null);
      await manager.viewerSlot.enter();
      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      const session = manager.getActiveTab()!.session.runtime;
      await manager.viewerSlot.show('conversation-1');

      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      const reattached = manager.getActiveTab()!;
      expect(reattached.session.runtime).toBe(session);
      expect(reattached.controllers.conversationController.seedDraftProject).not.toHaveBeenCalled();
    });

    it('returns to a blank draft only for the same project, and the seed follows its session leaving wide', async () => {
      const { manager } = await createManager(conversationPlugin());
      await manager.createTab(null);
      await manager.viewerSlot.enter();
      const blankSession = manager.getActiveTab()!.session.runtime;
      const draftProject = () => (manager.getActiveTab()!.controllers.conversationController as any).project.projectId;

      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      const session = manager.getActiveTab()!.session.runtime;
      expect([session === blankSession, draftProject()]).toEqual([false, 'project-1']);

      // New for the same project returns to its blank draft; New outside it never brings that draft back.
      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, draftProject()]).toEqual([false, undefined]);
      await manager.viewerSlot.startDraft({ projectId: 'project-1' });
      expect([manager.getActiveTab()!.session.runtime === session, draftProject()]).toEqual([true, 'project-1']);

      await manager.viewerSlot.release();
      const narrow = manager.getActiveTab()!;
      expect([narrow.lifecycleState, narrow.session.runtime === session, draftProject()]).toEqual(['open', true, 'project-1']);
    });

    it('returns to the same new session when New follows browsing another session', async () => {
      const { manager } = await createManager(conversationPlugin());
      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;
      manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'new idea' });

      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.startDraft();

      expect(manager.getActiveTab()!.session.runtime).toBe(session);
      expect(shownDraft(manager)).toBe('new idea');
    });

    it('re-links the focused Note whenever New returns to the new session, keeping its text', async () => {
      let activeFile: { path: string; extension: string } | null = { path: 'Notes/A.md', extension: 'md' };
      const focus = (path: string) => { activeFile = { path, extension: 'md' }; };
      const plugin = conversationPlugin();
      plugin.app.workspace.getActiveFile = () => activeFile;
      const { manager } = await createManager(plugin);
      const shownLink = () => (manager.getActiveTab()!.linkedContent as any).getSnapshot();

      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;
      manager.getActiveTab()!.controllers.drafts.restore('main', { content: 'new idea' });
      expect(shownLink()).toEqual({ mode: 'auto-draft', path: 'Notes/A.md' });

      // Shown draft: a removed link follows focus again.
      manager.getActiveTab()!.linkedContent.selectExplicit(null);
      focus('Notes/B.md');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, shownLink()])
        .toEqual([true, { mode: 'auto-draft', path: 'Notes/B.md' }]);

      // Held draft: an explicit pick is replaced by the Note focused while it was detached.
      manager.getActiveTab()!.linkedContent.selectExplicit('Projects');
      await manager.viewerSlot.show('conversation-1');
      focus('Notes/C.md');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, shownLink()])
        .toEqual([true, { mode: 'auto-draft', path: 'Notes/C.md' }]);

      // Held auto draft: it missed focus changes while detached.
      await manager.viewerSlot.show('conversation-1');
      focus('Notes/D.md');
      await manager.viewerSlot.startDraft();
      expect([manager.getActiveTab()!.session.runtime === session, shownLink(), shownDraft(manager)])
        .toEqual([true, { mode: 'auto-draft', path: 'Notes/D.md' }, 'new idea']);
    });

    it('starts a fresh new session when the remembered one created its conversation while browsing', async () => {
      const { manager } = await createManager(conversationPlugin());
      await manager.viewerSlot.startDraft();
      const session = manager.getActiveTab()!.session.runtime;

      await manager.viewerSlot.show('conversation-1');
      session.setConversationId('created');
      await manager.viewerSlot.startDraft();

      expect(manager.getActiveTab()!.session.runtime).not.toBe(session);
      expect(manager.getActiveTab()!.conversationId).toBeNull();
    });

    it('leaves a usable presentation when narrowing supersedes an unloading wide entry', async () => {
      const { manager } = await createManager(conversationPlugin());
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
      const { manager } = await createManager(conversationPlugin());
      const blank = await manager.createTab(null);
      blank!.controllers.drafts.restore('main', { content: 'new idea' });

      await manager.viewerSlot.enter();
      await manager.viewerSlot.show('conversation-1');
      await manager.viewerSlot.release();
      await manager.switchToTab(blank!.id);

      expect(shownDraft(manager)).toBe('new idea');
    });

    it('restores a narrow workspace in wide without assembling its tabs', async () => {
      const { manager } = await createManager(conversationPlugin(), {}, {}, { showsPreviews: () => true });

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
      const { manager } = await createManager(conversationPlugin());

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
            workspace: { getActiveFile: () => null, revealLeaf: vi.fn(), setActiveLeaf: vi.fn() },
          },
          getCachedConversation: (id: string) => ({ id, providerId: 'claude' }),
          ...overrides,
        }),
      };
    }

    it('replaces the preview with a focused Linked content draft', async () => {
      const { plugin } = linkedContentPlugin(['Projects/Plan.md']);
      const { manager } = await createManager(plugin);
      const retained = await manager.createTab('retained-conversation');
      await manager.viewerSlot.show('conversation-1');
      const preview = manager.getActiveTab()!;

      await manager.viewerSlot.startDraft({ linkedContentPath: 'Projects/Plan.md' });

      const draft = manager.getActiveTab() as any;
      expect(manager.getAllTabs()).toEqual([retained, draft]);
      expect(mockDestroyTab).toHaveBeenCalledWith(preview);
      expect(draft.conversationId).toBeNull();
      expect(draft.lifecycleState).toBe('provisional');
      expect(draft.linkedContent.getSnapshot()).toEqual({ mode: 'explicit-draft', path: 'Projects/Plan.md' });
      expect(draft.composer.focus).toHaveBeenCalledTimes(1);
    });

    it('shows the new draft without passing through the last retained tab', async () => {
      const activations: string[] = [];
      const { manager } = await createManager(conversationPlugin(), {
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
      const { manager } = await createManager(plugin);

      await expect(manager.viewerSlot.startDraft({ linkedContentPath: 'Gone/Plan.md' }))
        .rejects.toThrow('Linked content is no longer available');

      expect(mockCreateTab).not.toHaveBeenCalled();
    });

    it('closes a draft whose Linked content disappears while it is created', async () => {
      const { files, plugin } = linkedContentPlugin(['Projects/Plan.md']);
      const { manager } = await createManager(plugin);
      const retained = await manager.createTab();
      mockCreateTabRuntime.mockImplementationOnce(async (options) => {
        files.delete('Projects/Plan.md');
        return createMockTab(options);
      });

      await expect(manager.viewerSlot.startDraft({ linkedContentPath: 'Projects/Plan.md' }))
        .rejects.toThrow('Linked content is no longer available');

      expect(manager.getAllTabs()).toEqual([retained]);
      expect(mockTabs[1].linkedContent.getSnapshot()).toEqual({ mode: 'auto-draft', path: null });
    });

    it('closes the draft when selecting its Linked content fails', async () => {
      const { plugin } = linkedContentPlugin(['Projects']);
      const { manager } = await createManager(plugin);
      const retained = await manager.createTab();
      mockCreateTabRuntime.mockImplementationOnce(async (options) => {
        const tab = createMockTab(options);
        tab.linkedContent.selectExplicit = vi.fn(() => {
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
      const { manager } = await createManager(conversationPlugin(), {}, {}, {
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

    it.each([
      ['wide', true],
      ['compact', false],
    ])('starts /new in the source session\'s project, or in none (%s)', async (_layout, wide) => {
      let slotManager: any = null;
      const { manager } = await createManager(conversationPlugin(), {}, {}, {
        // As the view's policy does: the wide layout starts the draft in its slot with the inherited seed.
        startNew: async (sourceTab, seed) => {
          if (!wide) return false;
          await slotManager.viewerSlot.startDraft({ sourceTab, ...seed });
          return true;
        },
      });
      slotManager = manager;
      const draftProject = () => (manager.getActiveTab()!.controllers.conversationController as any).project.projectId;
      const source = await manager.createTab(null) as any;
      source.controllers.conversationController.seedDraftProject('project-1');

      await runtimeOptions(0).startNewConversation();
      const projectDraft = manager.getActiveTab()!;
      expect([projectDraft.session.runtime === source.session.runtime, draftProject()]).toEqual([false, 'project-1']);

      projectDraft.controllers.conversationController.seedDraftProject(null);
      await runtimeOptions(mockCreateTabRuntime.mock.calls.length - 1).startNewConversation();
      expect([manager.getActiveTab()!.session.runtime === projectDraft.session.runtime, draftProject()])
        .toEqual([wide, undefined]);
    });

    it('clears the source tab in place for /new in the compact layout', async () => {
      const { manager } = await createManager(conversationPlugin());
      const source = await manager.createTab('conversation-1') as any;

      await runtimeOptions(0).startNewConversation();

      expect(manager.getAllTabs()).toHaveLength(1);
      expect(manager.getActiveTab()).toEqual(expect.objectContaining({ id: source.id, conversationId: null }));
      expect(source.conversationId).toBe('conversation-1');
    });
  });
});
