/** @vitest-environment jsdom */
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { conversationRecord, createManager, createPlugin, deferred, forkRequestFrom, holdHistory, navigationOwner } from '@test/helpers/features/chat/TabManagerIntegrationHarness';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { Conversation } from '@/core/types';
import { createQueuedMessage } from '@/features/chat/state/chatTurnRequest';
import type { TabManager } from '@/features/chat/tabs/TabManager';

let provider: ReturnType<typeof registerChatTestProvider>;
beforeEach(() => {
  useNextTaskAnimationFrames();
  provider = registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }, { value: 'claude-alternate', label: 'Alternate' }] });
});


  it('leaves the first tab inactive when activation is explicitly disabled', async () => {
    const { manager } = await createManager();

    const tab = await manager.createTab(null, 'inactive-tab', { activate: false });

    expect(manager.getAllTabs()).toEqual([tab]);
    expect(manager.getActiveTab()).toBeNull();
    expect(manager.getPersistedState()).toEqual({
      activeTabId: null,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: 'inactive-tab',
      }],
    });
  });

  it('keeps branch navigation admitted without showing a session work spinner', async () => {
    const { manager } = await createManager();
    const tab = (await manager.createTab())!;
    const navigation = deferred<void>();
    const pending = tab.session.runtime.runConversationNavigation(() => navigation.promise);
    expect(tab.session.turns.isActive).toBe(true);
    expect(tab.session.canNavigateConversation).toBe(false);
    expect(manager.isTabWorking(tab.id)).toBe(false);
    expect(manager.getTabBarItems()).toEqual([
      expect.objectContaining({ id: tab.id, isWorking: false }),
    ]);
    navigation.resolve();
    await pending;
    expect(tab.session.turns.isActive).toBe(false);
    expect(manager.isTabWorking(tab.id)).toBe(false);
  });

  it('allows unlimited runtime tabs', async () => {
    const { manager } = await createManager();

    const tabs = await Promise.all(
      Array.from({ length: 12 }, () => manager.createTab()),
    );

    expect(tabs.every(Boolean)).toBe(true);
    expect(manager.getTabCount()).toBe(12);
    expect(manager.canCreateTab()).toBe(true);
  });

  it('does not roll back committed admission when its observer throws', async () => {
    const callbackError = new Error('Failed to render created tab');
    const onTabClosed = vi.fn();
    const onTabCreated = vi.fn(() => {
      throw callbackError;
    });
    const { manager } = await createManager(await createPlugin(), {
      onTabClosed,
      onTabCreated,
    });

    await expect(manager.createTab(null, 'committed-tab')).resolves.toEqual(
      expect.objectContaining({ id: 'committed-tab' }),
    );

    expect(onTabCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'committed-tab' }));
    expect(manager.getAllTabs()).toEqual([
      expect.objectContaining({ id: 'committed-tab' }),
    ]);
    expect(manager.getAllTabs().every(tab => tab.dom.contentEl.isConnected)).toBe(true);
    expect(onTabClosed).not.toHaveBeenCalled();
  });

  it('restores the previous active tab when activation fails after admission', async () => {
    const callbackError = new Error('Failed to render active tab');
    let rejectActivation = false;
    let persistedDuringActivation: ReturnType<TabManager['getPersistedState']> | null = null;
    const onTabCreated = vi.fn();
    const onActiveTabChanged = vi.fn((_previousId: string | null, nextId: string) => {
      if (rejectActivation && nextId === 'failed-tab') {
        persistedDuringActivation = manager.getPersistedState();
        throw callbackError;
      }
    });
    const { manager } = await createManager(await createPlugin(), {
      onActiveTabChanged,
      onTabCreated,
    });
    const retained = await manager.createTab();
    onTabCreated.mockClear();
    rejectActivation = true;

    await expect(manager.createTab(null, 'failed-tab')).rejects.toBe(callbackError);

    expect(manager.getAllTabs()).toEqual([retained]);
    expect(manager.getActiveTab()).toBe(retained);
    expect(persistedDuringActivation).toEqual({
      activeTabId: retained!.id,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: retained!.id,
      }],
    });
    expect(onTabCreated).not.toHaveBeenCalled();
    expect(manager.getTab('failed-tab')).toBeNull();
  });

  it('does not roll back a committed switch when its completion observer throws', async () => {
    const switchError = new Error('Failed to publish completed switch');
    const onActiveTabChanged = vi.fn();
    const onTabSwitched = vi.fn((_previousId: string | null, nextId: string) => {
      if (nextId === 'target-tab') throw switchError;
    });
    const { manager } = await createManager(await createPlugin(), {
      onActiveTabChanged,
      onTabSwitched,
    });
    await manager.createTab(null, 'predecessor-tab');
    const target = await manager.createTab(null, 'target-tab', { activate: false });
    onActiveTabChanged.mockClear();
    onTabSwitched.mockClear();

    await expect(manager.switchToTab(target!.id)).resolves.toBeUndefined();

    expect(manager.getActiveTab()).toBe(target);
    expect(onActiveTabChanged.mock.calls).toEqual([
      ['predecessor-tab', 'target-tab'],
    ]);
  });

  it('keeps the active source live when successor activation fails during close', async () => {
    const activationError = new Error('Failed to activate close successor');
    let rejectSuccessorActivation = false;
    const onActiveTabChanged = vi.fn((_previousId: string | null, nextId: string) => {
      if (rejectSuccessorActivation && nextId === 'successor-tab') throw activationError;
    });
    const onTabClosed = vi.fn();
    const { manager } = await createManager(await createPlugin(), {
      onActiveTabChanged,
      onTabClosed,
    });
    const closing = await manager.createTab(null, 'closing-tab');
    const successor = await manager.createTab(null, 'successor-tab', { activate: false });
    rejectSuccessorActivation = true;
    onActiveTabChanged.mockClear();

    await expect(manager.closeTab(closing!.id)).rejects.toBe(activationError);

    expect(manager.getAllTabs()).toEqual([closing, successor]);
    expect(manager.getActiveTab()).toBe(closing);
    expect(closing!.lifecycleState).toBe('open');
    expect(closing!.session.acceptsIntents).toBe(true);
    expect(closing!.dom.contentEl.isConnected).toBe(true);
    expect(onTabClosed).not.toHaveBeenCalled();
    expect(onActiveTabChanged.mock.calls).toEqual([
      ['closing-tab', 'successor-tab'],
      ['successor-tab', 'closing-tab'],
    ]);
  });

  it('discards a compensating last blank tab and installs a fresh draft', async () => {
    const onTabClosed = vi.fn();
    const { manager } = await createManager(await createPlugin(), { onTabClosed });
    const staleDraft = await manager.createTab();

    await expect(manager.closeTab(staleDraft!.id)).resolves.toBe(false);
    await expect(manager.discardTab(staleDraft!.id)).resolves.toBe(true);

    const replacement = manager.getActiveTab();
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(staleDraft);
    expect(replacement?.conversationId).toBeNull();
    expect(staleDraft!.dom.contentEl.isConnected).toBe(false);
    expect(onTabClosed).toHaveBeenCalledWith(staleDraft!.id);
    expect(manager.getAllTabs()).toEqual([replacement]);
  });

  it('keeps session turns and stream generations alive when view shutdown begins', async () => {
    const { manager } = await createManager();
    const tab = await manager.createTab();
    const release = deferred<void>();
    let turnSignal: AbortSignal | null = null;
    const turn = tab!.session.turns.run(async signal => {
      turnSignal = signal;
      await release.promise;
    });
    const generation = tab!.session.turns.streamGeneration;

    manager.beginShutdown();

    expect(turnSignal!.aborted).toBe(false);
    expect(tab!.session.turns.cancelRequested).toBe(false);
    expect(tab!.session.turns.streamGeneration).toBe(generation);
    release.resolve();
    await turn;
    await manager.destroy();
  });

  it('does not invent a snapshot owner for intentionally inactive restored tabs', async () => {
    const { manager } = await createManager();
    const first = await manager.createTab(null, 'restored-1', { activate: false });
    const second = await manager.createTab(null, 'restored-2', { activate: false });

    manager.beginShutdown();
    await manager.drainForShutdownSnapshot();

    expect(manager.getActiveTab()).toBeNull();
    expect(manager.getPersistedState()).toEqual({
      activeTabId: null,
      openTabs: [
        { conversationId: null, draftModel: 'claude-default', providerId: 'claude', tabId: first!.id },
        { conversationId: null, draftModel: 'claude-default', providerId: 'claude', tabId: second!.id },
      ],
    });
    manager.sealShutdownSnapshot();
    await manager.destroy();
  });

  it('persists retained tabs and the shown session preview as the active entry', async () => {
    const getCachedConversation = vi.fn((id: string) => (conversationRecord(id, { providerId: 'claude' })));
    const { manager } = await createManager(await createPlugin({ getCachedConversation }));
    const retained = await manager.createTab('conversation-1');
    const blank = await manager.createTab(null, undefined, { activate: false });
    blank!.session.selectDraft(blank!.providerId, 'codex:gpt-5');
    blank!.session.selectDraft('codex', blank!.draftModel);
    await manager.viewerSlot.show('conversation-2');
    const preview = manager.getActiveTab();
    expect(preview?.lifecycleState).toBe('provisional');

    const persisted = manager.getPersistedState();
    expect(persisted).toEqual({
      openTabs: [
        { tabId: retained!.id, conversationId: 'conversation-1' },
        { tabId: blank!.id, conversationId: null, draftModel: 'codex:gpt-5', providerId: 'codex' },
        { tabId: preview!.id, conversationId: 'conversation-2', preview: true },
      ],
      activeTabId: preview!.id,
    });

    const wide = (await createManager(await createPlugin({ getCachedConversation }), {}, {}, { showsPreviews: () => true })).manager;
    await wide.restoreState(persisted);
    expect(wide.getActiveTab()).toEqual(expect.objectContaining({
      id: preview!.id, conversationId: 'conversation-2', lifecycleState: 'provisional',
    }));
  });

  it('starts a wide workspace with nothing to restore on a draft preview, not a retained tab', async () => {
    const { manager } = await createManager(await createPlugin(), {}, {}, { showsPreviews: () => true });

    await manager.restoreState({ openTabs: [], activeTabId: null });

    expect(manager.getActiveTab()).toEqual(expect.objectContaining({ conversationId: null, lifecycleState: 'provisional' }));
  });

  it('binds an unloaded blank tab to the conversation its new session creates', async () => {
    const { manager } = await createManager();
    const blank = await manager.createTab(null);
    await manager.viewerSlot.enter();

    manager.getActiveTab()!.session.runtime.setConversationId('created');
    manager.reconcileUnloadedSessions();

    expect(manager.getPersistedState().openTabs[0]).toEqual({ tabId: blank!.id, conversationId: 'created' });
  });

  it('persists the active blank draft as a preview that survives reload', async () => {
    const { manager } = await createManager();
    const retained = await manager.createTab(null);
    await manager.viewerSlot.startDraft();
    const draft = manager.getActiveTab()!;
    expect(draft.lifecycleState).toBe('provisional');

    const persisted = manager.getPersistedState();
    expect(persisted).toEqual({
      activeTabId: draft.id,
      openTabs: [
        { tabId: retained!.id, conversationId: null, draftModel: 'claude-default', providerId: 'claude' },
        { tabId: draft.id, conversationId: null, draftModel: 'claude-default', providerId: 'claude', preview: true },
      ],
    });

    const wide = (await createManager(await createPlugin(), {}, {}, { showsPreviews: () => true })).manager;
    await wide.restoreState(persisted);
    expect(wide.getActiveTabId()).toBe(draft.id);
    expect(wide.getActiveTab()?.lifecycleState).toBe('provisional');
    expect(wide.getPersistedState()).toEqual(persisted);

    const compact = (await createManager()).manager;
    await compact.restoreState(persisted);
    expect(compact.getActiveTabId()).toBe(draft.id);
    expect(compact.getActiveTab()?.lifecycleState).toBe('open');
    expect(compact.getPersistedState().openTabs[1]).not.toHaveProperty('preview');

    draft.session.claimUserOwnership();
    draft.session.commitAdmission();
    expect(manager.getPersistedState().openTabs[1]).not.toHaveProperty('preview');
  });

  it('drops an inactive draft preview from persistence', async () => {
    const { manager } = await createManager();
    const retained = await manager.createTab(null);
    await manager.viewerSlot.startDraft();
    await manager.switchToTab(retained!.id);

    expect(manager.getPersistedState()).toEqual({
      activeTabId: retained!.id,
      openTabs: [{ tabId: retained!.id, conversationId: null, draftModel: 'claude-default', providerId: 'claude' }],
    });
  });

  it('retains a preview the user names, so its label persists', async () => {
    const onTabLabelChanged = vi.fn();
    const { manager } = await createManager(await createPlugin({
      getCachedConversation: (id: string) => (conversationRecord(id, { providerId: 'claude' })),
    }), { onTabLabelChanged });
    await manager.viewerSlot.show('conversation-1');
    const preview = manager.getActiveTab()!;

    manager.setTabLabel(preview.id, '  Research  ');

    expect(preview.lifecycleState).toBe('open');
    expect(onTabLabelChanged).toHaveBeenCalledWith(preview.id, 'Research');
    expect(manager.getTabBarItems()[0]).toEqual(expect.objectContaining({ label: 'Research' }));
    expect(manager.getPersistedState()).toEqual({
      activeTabId: preview.id,
      openTabs: [{ tabId: preview.id, conversationId: 'conversation-1', label: 'Research' }],
    });

    manager.setTabLabel(preview.id, null);

    expect(onTabLabelChanged).toHaveBeenLastCalledWith(preview.id, null);
    expect(manager.getPersistedState().openTabs).toEqual([
      { tabId: preview.id, conversationId: 'conversation-1' },
    ]);
  });

  it('restores a tab label onto its identity and keeps it when the tab assembles', async () => {
    const { manager } = await createManager(await createPlugin({
      getCachedConversation: (id: string) => (conversationRecord(id, { providerId: 'claude' })),
    }));

    await manager.restoreState({
      openTabs: [
        { tabId: 'one', conversationId: 'one' },
        { tabId: 'two', conversationId: 'two', label: 'Draft review' },
      ],
      activeTabId: 'one',
    });
    expect(manager.getTab('two')).toBeNull();
    manager.setTabLabel('two', 'Final review');
    await manager.switchToTab('two');

    expect(manager.getTab('two')?.label).toBe('Final review');
    expect(manager.getPersistedState().openTabs).toEqual([
      { tabId: 'one', conversationId: 'one' },
      { tabId: 'two', conversationId: 'two', label: 'Final review' },
    ]);
  });

  it('does not treat teardown lifecycle as a committed membership removal', async () => {
    const { manager } = await createManager();
    const tab = await manager.createTab(null, 'tearing-down-tab');

    tab!.session.beginClose();

    expect(manager.getPersistedState()).toEqual({
      activeTabId: tab!.id,
      openTabs: [{
        conversationId: null,
        draftModel: 'claude-default',
        providerId: 'claude',
        tabId: tab!.id,
      }],
    });
  });

  it('publishes every successful inactive admission after the transaction', async () => {
    const onTabCreated = vi.fn();
    const { manager } = await createManager(await createPlugin(), { onTabCreated });
    await manager.createTab();
    onTabCreated.mockClear();

    const background = await manager.createTab(null, 'background-tab', {
      activate: false,
    });

    expect(background?.id).toBe('background-tab');
    expect(onTabCreated.mock.calls).toEqual([[background]]);
  });

  it('publishes active selection only after switching an admitted tab', async () => {
    const onActiveTabCommitted = vi.fn();
    const { manager } = await createManager(
      await createPlugin(),
      { onActiveTabCommitted },
    );
    const initial = await manager.createTab(null, 'initial-tab');
    const background = await manager.createTab(null, 'background-tab', {
      activate: false,
    });
    onActiveTabCommitted.mockClear();

    await manager.switchToTab(background!.id);

    expect(manager.getActiveTab()).toBe(background);
    expect(onActiveTabCommitted).toHaveBeenCalledWith(initial!.id, background!.id);
  });


it('validates cached workspace ownership during admission', async () => {
  const { manager } = await createManager();
  const vault = await DesktopVault.create();
  onTestFinished(() => vault.dispose());
  const foreign = await createFeatureHostFixture({ vault });
  await ProviderWorkspaceRegistry.ensureInitialized(foreign.providerHost, 'claude', 'other-vault');
  const tab = await manager.createTab();
  expect(tab?.hydrationState).toBe('failed');
  expect(provider.sessions).toEqual([]);
  expect(provider.loadCommands).not.toHaveBeenCalled();
});

it('does not inherit the active tab provider when creating another blank tab', async () => {
  const { manager } = await createManager();
  const active = (await manager.createTab())!;
  active.session.selectDraft('codex', 'codex:gpt-5');
  const next = (await manager.createTab())!;
  expect([next.providerId, next.draftModel]).toEqual(['claude', 'claude-default']);
  expect([active.providerId, active.draftModel]).toEqual(['codex', 'codex:gpt-5']);
});

it('keeps the committed persistence owner while another tab is hydrating', async () => {
  const { manager, plugin } = await createManager();
  const initial = (await manager.createTab(null, 'initial-tab'))!;
  const target = (await manager.createTab('conversation-1', 'target-tab', { activate: false }))!;
  const hydration = holdHistory(plugin, 'conversation-1');
  const switching = manager.switchToTab(target.id);
  await hydration.started;
  let idleSettled = false;
  const switchingIdle = manager.waitForTabSwitchIdle().then(() => { idleSettled = true; });
  try {
    // History has started and is held; let an incorrectly resolved idle promise report early completion.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(idleSettled).toBe(false);
    expect(manager.getActiveTab()).toBe(target);
    expect(manager.getPersistedState()).toEqual({
      activeTabId: initial.id,
      openTabs: [
        { conversationId: null, draftModel: 'claude-default', providerId: 'claude', tabId: initial.id },
        { conversationId: 'conversation-1', tabId: target.id },
      ],
    });
  } finally {
    hydration.release();
    await Promise.all([switching, switchingIdle]);
  }
  expect(idleSettled).toBe(true);
  expect(manager.getPersistedState().activeTabId).toBe(target.id);
});

it.each(['shutdown', 'destroy'] as const)('joins active and queued tab switches during %s', async action => {
  const { manager, plugin } = await createManager();
  const initial = (await manager.createTab())!;
  const target = (await manager.createTab('hydrating', 'hydrating', { activate: false }))!;
  const hydration = holdHistory(plugin, 'hydrating');
  const switching = manager.switchToTab(target.id);
  await hydration.started;
  const queuedSwitch = manager.switchToTab(initial.id);
  if (action === 'shutdown') manager.beginShutdown();
  let settled = false;
  const finishing = (action === 'shutdown' ? manager.drainForShutdownSnapshot() : manager.destroy()).then(() => { settled = true; });
  expect(settled).toBe(false);
  expect(initial.dom.contentEl.isConnected).toBe(true);
  expect(target.dom.contentEl.isConnected).toBe(true);
  hydration.release();
  await Promise.all([switching, queuedSwitch, finishing]);
  if (action === 'shutdown') manager.sealShutdownSnapshot();
  expect(manager.getAllTabs()).toEqual(action === 'shutdown' ? [initial, target] : []);
  expect(initial.dom.contentEl.isConnected).toBe(action === 'shutdown');
  expect(target.dom.contentEl.isConnected).toBe(action === 'shutdown');
});

it('projects provider background work only after the coordinator publishes its transition', async () => {
  const { manager } = await createManager();
  const tab = (await manager.createTab('conversation-1'))!;
  expect(await tab.session.runtime.model.ensureExecutionInitialized()).toBe(true);
  const native = provider.sessions[0];
  let nativeWork = true;
  Object.assign(native, { hasBackgroundWork: () => nativeWork });
  const isWorking = () => manager.getTabBarItems().find(item => item.id === tab.id)?.isWorking;
  expect(tab.executionCoordinator.hasBackgroundWork).toBe(true);
  expect(isWorking()).toBe(false);
  native.emit({ type: 'session_state_changed', scope: { kind: 'session', sessionInstanceId: native.sessionInstanceId, sequence: 1 }, snapshot: native.getSnapshot() });
  expect(isWorking()).toBe(true);
  nativeWork = false;
  native.emit({ type: 'session_state_changed', scope: { kind: 'session', sessionInstanceId: native.sessionInstanceId, sequence: 2 }, snapshot: native.getSnapshot() });
  expect(isWorking()).toBe(false);
  tab.controllers.inputController.queue.enqueue(createQueuedMessage('queued', { text: 'queued' }));
  expect(isWorking()).toBe(true);
  tab.controllers.inputController.queue.clear();
  expect(isWorking()).toBe(false);
});

it('marks only inactive tabs when a reviewable turn settles', async () => {
  const { manager } = await createManager();
  const active = (await manager.createTab())!;
  const background = (await manager.createTab(null, undefined, { activate: false }))!;
  vi.spyOn(active.dom.messagesEl, 'getClientRects').mockReturnValue(Object.assign([new DOMRect(0, 0, 100, 100)], { item: () => null }));
  active.captureReviewableSettlement!('completed')();
  background.captureReviewableSettlement!('error')();
  expect(active.state.attention).toBeNull();
  expect(background.state.attention).toMatchObject({ kind: 'review', outcome: 'error' });
});

it('uses activity at completion and invalidates review after activation', async () => {
  const { manager } = await createManager();
  const active = (await manager.createTab())!;
  const background = (await manager.createTab(null, undefined, { activate: false }))!;
  for (const tab of [active, background]) {
    vi.spyOn(tab.dom.messagesEl, 'getClientRects').mockImplementation(() => Object.assign(
      tab.dom.contentEl.classList.contains('claudian-hidden') ? [] : [new DOMRect(0, 0, 100, 100)], { item: () => null },
    ));
  }
  const reportActive = active.captureReviewableSettlement!('completed');
  const reportBackground = background.captureReviewableSettlement!('completed');
  await manager.switchToTab(background.id);
  await manager.switchToTab(active.id);
  reportActive(); reportBackground();
  expect(active.state.attention).toBeNull();
  expect(background.state.attention).toBeNull();
});

it('rolls back a tab assembly whose admission continuation runs after manager destruction', async () => {
  const onTabCreated = vi.fn();
  const { manager, root, pool } = await createManager(await createPlugin(), { onTabCreated });
  const creation = manager.createTab(null, 'late-tab');
  const destruction = manager.destroy();
  await expect(creation).resolves.toBeNull();
  await destruction;
  expect(onTabCreated).not.toHaveBeenCalled();
  expect(manager.getAllTabs()).toEqual([]);
  expect(root.childElementCount).toBe(0);
  expect(pool.getAll()).toEqual([]);
  expect(manager.canCreateTab()).toBe(false);
  await expect(manager.createTab()).resolves.toBeNull();
});

it('rejects a duplicate explicit tab ID without disturbing its reserved runtime', async () => {
  const { manager, root } = await createManager();
  const firstCreation = manager.createTab(null, 'restored-tab');
  await expect(manager.createTab(null, 'restored-tab')).rejects.toThrow('restored-tab');
  const first = await firstCreation;
  expect(manager.getAllTabs()).toEqual([first]);
  expect(manager.getActiveTab()).toBe(first);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
});

it('reactivates the previous tab when deactivation fails during admission', async () => {
  const error = new Error('Failed to deactivate previous tab');
  const { manager, root } = await createManager();
  const initial = (await manager.createTab(null, 'initial-tab'))!;
  vi.spyOn(initial.dom.contentEl, 'addClass').mockImplementationOnce(() => { throw error; });
  await expect(manager.createTab(null, 'failed-tab')).rejects.toBe(error);
  expect(manager.getAllTabs()).toEqual([initial]);
  expect(manager.getActiveTab()).toBe(initial);
  expect(initial.dom.contentEl.classList.contains('claudian-hidden')).toBe(false);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
});

it.each(['before', 'after'] as const)('attributes admission failure to its request with another switch queued %s it', async placement => {
  const error = new Error('Failed queued tab activation');
  const { manager, plugin, root } = await createManager(await createPlugin(), {
    onActiveTabChanged: (_previous, id) => { if (id === 'failed-tab') throw error; },
  });
  await manager.createTab(null, 'initial-tab');
  const blocking = (await manager.createTab('blocking', 'blocking', { activate: false }))!;
  const hydration = holdHistory(plugin, 'blocking');
  const blockingSwitch = manager.switchToTab(blocking.id);
  await hydration.started;
  const first = placement === 'before' ? manager.switchToTab('initial-tab') : manager.createTab(null, 'failed-tab');
  const second = placement === 'before' ? manager.createTab(null, 'failed-tab') : manager.switchToTab('initial-tab');
  const failing = placement === 'before' ? second : first;
  const succeeding = placement === 'before' ? first : second;
  const rejected = failing.then(() => null, error => error);
  hydration.release();
  await Promise.all([blockingSwitch, succeeding]);
  expect(await rejected).toBe(error);
  expect(manager.getTab('failed-tab')).toBeNull();
  expect(manager.getActiveTab()?.id).toBe('initial-tab');
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(2);
});

it('fences overlapping closes before repeating teardown or callbacks', async () => {
  const onTabClosed = vi.fn();
  const { manager } = await createManager(await createPlugin(), { onTabClosed });
  const retained = (await manager.createTab())!;
  const closing = (await manager.createTab())!;
  const remove = vi.spyOn(closing.dom.contentEl, 'remove');
  const first = manager.closeTab(closing.id);
  const overlapping = manager.closeTab(closing.id);
  await expect(Promise.all([first, overlapping])).resolves.toEqual([true, false]);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(onTabClosed.mock.calls).toEqual([[closing.id]]);
  expect(manager.getAllTabs()).toEqual([retained]);
});

it('claims the final tab before its replacement admission continuation', async () => {
  const { manager } = await createManager();
  const closing = (await manager.createTab())!;
  const first = manager.discardTab(closing.id);
  const overlapping = manager.discardTab(closing.id);
  await expect(Promise.all([first, overlapping])).resolves.toEqual([true, false]);
  expect(manager.getAllTabs()).toEqual([manager.getActiveTab()]);
  expect(manager.getActiveTab()).not.toBe(closing);
  expect(closing.dom.contentEl.isConnected).toBe(false);
});

it('installs one live replacement when different tabs close concurrently', async () => {
  const { manager, root } = await createManager();
  const first = (await manager.createTab())!;
  const second = (await manager.createTab())!;
  await expect(Promise.all([manager.closeTab(first.id), manager.closeTab(second.id)])).resolves.toEqual([true, true]);
  expect(manager.getAllTabs()).toEqual([manager.getActiveTab()]);
  expect(manager.getActiveTab()?.conversationId).toBeNull();
  expect(first.dom.contentEl.isConnected).toBe(false);
  expect(second.dom.contentEl.isConnected).toBe(false);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
});

it('retains one original when concurrent-close replacement assembly fails', async () => {
  const error = new Error('Replacement assembly failed');
  const { manager, root } = await createManager();
  const first = (await manager.createTab())!;
  const second = (await manager.createTab())!;
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw error; });
  const firstClose = manager.closeTab(first.id);
  const secondClose = manager.closeTab(second.id);
  await expect(secondClose).rejects.toBe(error);
  await expect(firstClose).resolves.toBe(true);
  expect(manager.getAllTabs()).toEqual([second]);
  expect(manager.getActiveTab()).toBe(second);
  expect(second.session.acceptsIntents).toBe(true);
  expect(second.dom.contentEl.isConnected).toBe(true);
});

it('keeps the final tab live when replacement assembly fails', async () => {
  const error = new Error('Replacement assembly failed');
  const onTabClosed = vi.fn();
  const { manager, root } = await createManager(await createPlugin(), { onTabClosed });
  const retained = (await manager.createTab())!;
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw error; });
  await expect(manager.discardTab(retained.id)).rejects.toBe(error);
  expect(manager.getAllTabs()).toEqual([retained]);
  expect(manager.getActiveTab()).toBe(retained);
  expect(retained.session.acceptsIntents).toBe(true);
  expect(retained.dom.contentEl.isConnected).toBe(true);
  expect(onTabClosed).not.toHaveBeenCalled();
});

it('keeps identity publication live during reversible final-tab replacement', async () => {
  const error = new Error('Replacement assembly failed');
  const onTabConversationChanged = vi.fn();
  const { manager, root } = await createManager(await createPlugin(), { onTabConversationChanged });
  const retained = (await manager.createTab())!;
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => {
    retained.state.currentConversationId = 'created-during-close';
    throw error;
  });
  await expect(manager.discardTab(retained.id)).rejects.toBe(error);
  expect(retained.conversationId).toBe('created-during-close');
  expect(onTabConversationChanged.mock.calls).toEqual([[retained.id, 'created-during-close']]);
  expect(manager.getAllTabs()).toEqual([retained]);
  expect(retained.session.acceptsIntents).toBe(true);
});

it('does not emit close callbacks after manager destruction begins', async () => {
  const onTabClosed = vi.fn();
  const { manager } = await createManager(await createPlugin(), { onTabClosed });
  await manager.createTab();
  const closing = (await manager.createTab())!;
  const close = manager.closeTab(closing.id);
  const destruction = manager.destroy();
  await Promise.all([close, destruction]);
  expect(onTabClosed).not.toHaveBeenCalled();
  expect(manager.getAllTabs()).toEqual([]);
});

it('releases membership and discovery when external DOM cleanup fails during close', async () => {
  const onTabClosed = vi.fn();
  const { manager, pool } = await createManager(await createPlugin(), { onTabClosed });
  const retained = (await manager.createTab())!;
  const closing = (await manager.createTab())!;
  const discovery = closing.providerCatalogResolver()!.discovery;
  await discovery.load();
  vi.spyOn(closing.dom.contentEl, 'remove').mockImplementationOnce(() => { throw new Error('Detach failed'); });
  await expect(manager.closeTab(closing.id)).rejects.toThrow('tab DOM root');
  expect(manager.getAllTabs()).toEqual([retained]);
  expect(manager.getActiveTab()).toBe(retained);
  expect(onTabClosed).toHaveBeenCalledWith(closing.id);
  expect(pool.getAll().includes(closing.session.runtime)).toBe(false);
  expect(closing.providerCatalogResolver()).toBeNull();
  expect(discovery.getSnapshot()).toEqual({ status: 'idle' });
  closing.dom.contentEl.remove();
});

it('fences discovery and external observers while accepting a terminal identity during close', async () => {
  const callbacks = { onTabAttentionChanged: vi.fn(), onTabConversationChanged: vi.fn(), onTabRewindingChanged: vi.fn(), onTabStreamingChanged: vi.fn() };
  const { manager, plugin } = await createManager(await createPlugin(), callbacks);
  const retained = (await manager.createTab())!;
  const closing = (await manager.createTab(null, undefined, { activate: false }))!;
  const discovery = closing.providerCatalogResolver()!.discovery;
  const close = manager.closeTab(closing.id);
  expect(closing.lifecycleState).toBe('closing');
  closing.session.runtime.publish('streaming');
  closing.session.runtime.publish('rewinding');
  closing.state.markReviewRequired('completed');
  closing.state.currentConversationId = 'late-conversation';
  expect(closing.conversationId).toBe('late-conversation');
  expect(closing.providerCatalogResolver()).toBeNull();
  expect(discovery.getSnapshot()).toEqual({ status: 'idle' });
  for (const observer of Object.values(callbacks)) expect(observer).not.toHaveBeenCalled();
  await forkRequestFrom(manager, closing)({ messages: [], providerId: 'claude', resumeAt: 'checkpoint', sourceConversationId: 'late-conversation', sourceSessionId: 'native' });
  await navigationOwner(manager).open('stale-conversation', {}, closing);
  expect(plugin.createConversation).not.toHaveBeenCalled();
  expect(plugin.getConversationById).not.toHaveBeenCalled();
  await close;
  expect(manager.getAllTabs()).toEqual([retained]);
  expect(closing.providerCatalogResolver()).toBeNull();
});

it('accepts a terminal conversation binding until the shutdown snapshot is sealed', async () => {
  const onTabConversationChanged = vi.fn();
  const { manager } = await createManager(await createPlugin(), { onTabConversationChanged });
  const tab = (await manager.createTab())!;
  const unbound = (await manager.createTab())!;
  manager.beginShutdown();
  tab.state.currentConversationId = 'created-during-shutdown';
  expect(tab.conversationId).toBe('created-during-shutdown');
  expect(onTabConversationChanged.mock.calls).toEqual([[tab.id, 'created-during-shutdown']]);
  const snapshot = manager.getPersistedState();
  manager.sealShutdownSnapshot();
  tab.session.runtime.publish('conversation');
  unbound.state.currentConversationId = 'created-after-seal';
  expect(unbound.session.runtime.conversationId).toBe('created-after-seal');
  expect(unbound.conversationId).toBeNull();
  expect(onTabConversationChanged).toHaveBeenCalledTimes(1);
  expect(manager.getPersistedState()).toEqual(snapshot);
});

it('drains every admitted conversation creation before sealing the shutdown snapshot', async () => {
  const { manager, plugin } = await createManager();
  const tabs = [(await manager.createTab())!, (await manager.createTab())!];
  const shells = tabs.map(() => deferred<Conversation>());
  vi.spyOn(plugin, 'createConversation').mockImplementationOnce(() => shells[0].promise).mockImplementationOnce(() => shells[1].promise);
  const creations = tabs.map(tab => tab.controllers.conversationController.createConversation(
    tab.session.runtime.model.linkedContentController.beginSubmission(), { providerId: 'claude' },
  ));
  manager.beginShutdown();
  let drained = false;
  const drain = manager.drainForShutdownSnapshot().then(() => { drained = true; });
  shells[0].resolve(conversationRecord('first-created'));
  await creations[0];
  expect(drained).toBe(false);
  shells[1].resolve(conversationRecord('second-created'));
  await Promise.all([...creations, drain]);
  expect(tabs.every(tab => tab.session.acceptsIntents)).toBe(true);
  manager.sealShutdownSnapshot();
  expect(manager.getPersistedState().openTabs.map(tab => tab.conversationId)).toEqual(['first-created', 'second-created']);
});

it('leaves sealed tab identities untouched when provider availability changes after shutdown', async () => {
  const onTabDraftChanged = vi.fn();
  const onTabProviderChanged = vi.fn();
  registerChatTestProvider('claude', { models: [] });
  const { manager } = await createManager(await createPlugin(), { onTabDraftChanged, onTabProviderChanged });
  await manager.restoreState({ openTabs: [{ tabId: 'active', conversationId: null }, { tabId: 'inactive', conversationId: null }], activeTabId: 'active' });
  registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }] });
  const sealed = manager.getPersistedState();
  expect(manager.getTab('inactive')).toBeNull();
  manager.beginShutdown();
  manager.sealShutdownSnapshot();
  manager.reconcileProviderAvailability();
  expect(manager.getPersistedState()).toEqual(sealed);
  expect(onTabDraftChanged).not.toHaveBeenCalled();
  expect(onTabProviderChanged).not.toHaveBeenCalled();
});

it('drains in-flight conversation navigation before sealing shutdown state', async () => {
  const { manager, plugin, root } = await createManager();
  const tab = (await manager.createTab())!;
  const hydration = holdHistory(plugin, 'during-shutdown');
  const navigation = manager.openConversation('during-shutdown');
  await hydration.started;
  manager.beginShutdown();
  let settled = false;
  const drain = manager.drainForShutdownSnapshot().then(() => { settled = true; });
  expect(settled).toBe(false);
  hydration.release();
  await Promise.all([navigation, drain]);
  expect(tab.conversationId).toBeNull();
  expect(manager.getAllTabs()).toEqual([tab]);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
  manager.sealShutdownSnapshot();
});

it('joins an admitted close before choosing the shutdown snapshot owner', async () => {
  const { manager } = await createManager();
  const retained = (await manager.createTab())!;
  const closing = (await manager.createTab())!;
  const close = manager.closeTab(closing.id);
  manager.beginShutdown();
  const drain = manager.drainForShutdownSnapshot();
  await Promise.all([close, drain]);
  expect(manager.getActiveTab()).toBe(retained);
  expect(manager.getAllTabs()).toEqual([retained]);
  manager.sealShutdownSnapshot();
  expect(manager.getPersistedState().activeTabId).toBe(retained.id);
});

it('does not recreate discovery from a released tab after destroy', async () => {
  const { manager } = await createManager();
  const tab = (await manager.createTab())!;
  const discovery = tab.providerCatalogResolver()!.discovery;
  await discovery.load();
  await manager.destroy();
  tab.session.runtime.publish('commands');
  expect(tab.providerCatalogResolver()).toBeNull();
  expect(discovery.getSnapshot()).toEqual({ status: 'idle' });
});

it('disposes every tab and releases manager state when one DOM teardown fails', async () => {
  const { manager, pool } = await createManager();
  const first = (await manager.createTab())!;
  const second = (await manager.createTab())!;
  const firstRemove = vi.spyOn(first.dom.contentEl, 'remove').mockImplementationOnce(() => { throw new Error('Detach failed'); });
  const secondRemove = vi.spyOn(second.dom.contentEl, 'remove');
  const destruction = manager.destroy();
  const overlap = manager.destroy();
  const [error, overlappingError] = await Promise.all([destruction.catch(reason => reason), overlap.catch(reason => reason)]);
  expect(error).toMatchObject({ message: expect.stringContaining('tab DOM root') });
  expect(overlappingError).toBe(error);
  await expect(manager.destroy()).rejects.toBe(error);
  expect(firstRemove).toHaveBeenCalledTimes(1);
  expect(secondRemove).toHaveBeenCalledTimes(1);
  expect(manager.getAllTabs()).toEqual([]);
  expect(manager.getActiveTab()).toBeNull();
  expect(pool.getAll()).toEqual([]);
  expect(first.providerCatalogResolver()).toBeNull();
  expect(second.providerCatalogResolver()).toBeNull();
  first.dom.contentEl.remove();
});

it('finishes mandatory teardown when concurrent preview cleanup fails', async () => {
  const { manager, pool } = await createManager();
  const retained = (await manager.createTab('retained'))!;
  await manager.viewerSlot.show('preview');
  const preview = manager.getActiveTab()!;
  await manager.switchToTab(retained.id);
  const detaching = deferred<void>();
  vi.spyOn(preview.dom.contentEl, 'remove').mockImplementationOnce(() => { detaching.resolve(); throw new Error('Preview detach failed'); });
  const cleanup = manager.viewerSlot.release().catch(error => error);
  await detaching.promise;
  const destruction = manager.destroy().catch(error => error);
  const [cleanupError, destructionError] = await Promise.all([cleanup, destruction]);
  expect(cleanupError).toMatchObject({ message: expect.stringContaining('tab DOM root') });
  expect(destructionError).toBe(cleanupError);
  expect(manager.getAllTabs()).toEqual([]);
  expect(retained.dom.contentEl.isConnected).toBe(false);
  expect(pool.getAttachment('retained')).toBeNull();
  expect(pool.getAttachment('preview')).toBeNull();
  preview.dom.contentEl.remove();
});

it('joins an unloaded draft session creating its conversation before the shutdown snapshot', async () => {
  const { manager, plugin } = await createManager();
  const blank = (await manager.createTab())!;
  const model = blank.session.runtime.model;
  const reply = deferred<Conversation>();
  vi.spyOn(plugin, 'createConversation').mockReturnValueOnce(reply.promise);
  const creating = model.conversationController.createConversation(model.linkedContentController.beginSubmission(), { providerId: 'claude' });
  await manager.viewerSlot.enter();
  await manager.viewerSlot.show('conversation-1');
  expect(manager.getTab(blank.id)).toBeNull();
  let drained = false;
  const drain = manager.drainForShutdownSnapshot().then(() => { drained = true; });
  expect(drained).toBe(false);
  reply.resolve(conversationRecord('created'));
  await Promise.all([creating, drain]);
  expect(manager.getPersistedState().openTabs[0]).toEqual({ tabId: blank.id, conversationId: 'created' });
});

it('reports an unloaded narrow tab from its running session and review attention', async () => {
  const { manager } = await createManager();
  const narrow = (await manager.createTab('conversation-1'))!;
  narrow.controllers.inputController.queue.enqueue(createQueuedMessage('queued', { text: 'queued' }));
  await manager.viewerSlot.enter();
  await manager.viewerSlot.show('conversation-2');
  narrow.state.markReviewRequired('completed');
  expect(manager.getTab(narrow.id)).toBeNull();
  expect(manager.isTabWorking(narrow.id)).toBe(true);
  expect(manager.getTabBarItems().find(item => item.id === narrow.id)).toMatchObject({ isWorking: true, attention: { kind: 'review', outcome: 'completed' } });
  narrow.controllers.inputController.queue.clear();
  expect(manager.isTabWorking(narrow.id)).toBe(false);
});

it('reports an unloaded blank tab from its held draft before it creates a conversation', async () => {
  const { manager } = await createManager();
  const blank = (await manager.createTab())!;
  blank.controllers.inputController.queue.enqueue(createQueuedMessage('queued', { text: 'queued' }));
  await manager.viewerSlot.enter();
  await manager.viewerSlot.show('conversation-1');
  expect(manager.getTab(blank.id)).toBeNull();
  expect(manager.isTabWorking(blank.id)).toBe(true);
  blank.controllers.inputController.queue.clear();
  expect(manager.isTabWorking(blank.id)).toBe(false);
});

it('publishes persisted blank-tab model changes', async () => {
  const onTabDraftChanged = vi.fn();
  const { manager } = await createManager(await createPlugin(), { onTabDraftChanged });
  const tab = (await manager.createTab())!;
  tab.session.selectDraft('claude', 'claude-alternate');
  expect(onTabDraftChanged).toHaveBeenCalledWith(tab.id, 'claude-alternate');
  expect(manager.getPersistedState().openTabs[0]).toMatchObject({ draftModel: 'claude-alternate' });
});

it('restores identities cold in order and activates once, preserving inactive model and label', async () => {
  registerChatTestProvider('codex', { models: [{ value: 'codex:gpt-5', label: 'GPT 5' }] });
  const onActiveTabChanged = vi.fn();
  const getConversationSummary = vi.fn((id: string) => conversationRecord(id));
  const { manager, plugin, root } = await createManager(await createPlugin({ getConversationSummary }), { onActiveTabChanged });
  // The supplied summary port owns cold metadata; loading history remains deferred.
  plugin.getConversationSummary = getConversationSummary;
  await manager.restoreState({ openTabs: [
    { tabId: 'restored-1', conversationId: 'conversation-1', label: 'Keep label' },
    { tabId: 'restored-2', conversationId: null, providerId: 'codex', draftModel: 'codex:gpt-5' },
  ], activeTabId: 'restored-2' });
  expect(manager.getTabIdentities().map(tab => [tab.id, tab.lifecycleState])).toEqual([['restored-1', 'open'], ['restored-2', 'open']]);
  expect(getConversationSummary).toHaveBeenCalledWith('conversation-1');
  expect(manager.getTab('restored-1')).toBeNull();
  expect(manager.getAllTabs()).toHaveLength(1);
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
  expect(manager.getActiveTab()).toMatchObject({ id: 'restored-2', draftModel: 'codex:gpt-5' });
  expect(onActiveTabChanged).toHaveBeenCalledTimes(1);
  await Promise.all([manager.switchToTab('restored-1'), manager.switchToTab('restored-1')]);
  expect(manager.getAllTabs()).toHaveLength(2);
  expect(manager.getActiveTab()).toMatchObject({ id: 'restored-1', label: 'Keep label' });
  expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(['restored-1', 'restored-2']);
  expect(provider.sessions).toEqual([]);
});

it('restores a usable tab when the selected saved runtime cannot be assembled', async () => {
  const { manager, root } = await createManager();
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw new Error('Unavailable selected tab'); });
  await expect(manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' })).resolves.toBeUndefined();
  expect(manager.getActiveTabId()).toBe('two');
  expect(manager.getTab('one')).toBeNull();
  expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(['one', 'two']);
  await manager.switchToTab('one');
  expect(manager.getActiveTabId()).toBe('one');
});

it.each([false, true])('drops a duplicate cross-view restore before assembly (owner inactive: %s)', async inactive => {
  const { ClaudianViews } = await import('@/composition/ClaudianViews');
  const plugin = await createPlugin();
  const first = await createManager(plugin);
  const second = await createManager(plugin);
  vi.spyOn(plugin.app.workspace, 'getLeavesOfType').mockReturnValue([first, second].map(({ view }) => Object.assign(view.leaf, { view })));
  const views = new ClaudianViews(plugin.app.workspace, () => 'right-sidebar');
  vi.spyOn(plugin, 'findConversationAcrossViews').mockImplementation(id => views.findConversationAcrossViews(id));
  await Promise.all([
    first.manager.restoreState({ openTabs: [
      { tabId: 'owner', conversationId: 'shared', label: 'Keep label' },
      ...(inactive ? [{ tabId: 'draft', conversationId: null }] : []),
    ], activeTabId: inactive ? 'draft' : 'owner' }),
    second.manager.restoreState({ openTabs: [{ tabId: 'duplicate', conversationId: 'shared' }], activeTabId: 'duplicate' }),
  ]);
  expect(first.manager.getPersistedState().openTabs).toContainEqual({ tabId: 'owner', conversationId: 'shared', label: 'Keep label' });
  expect(second.manager.getPersistedState().openTabs).toEqual([expect.objectContaining({ conversationId: null })]);
  expect(second.manager.getActiveTab()?.conversationId).toBeNull();
  expect(second.manager.getTab('duplicate')).toBeNull();
  expect(plugin.app.workspace.revealLeaf).not.toHaveBeenCalled();
  expect(first.manager.getTab('owner') === null).toBe(inactive);
});

it('keeps the active source reversible when an inactive successor fails assembly', async () => {
  const { manager, root } = await createManager();
  await manager.restoreState({ openTabs: [{ tabId: 'active', conversationId: 'one' }, { tabId: 'open', conversationId: 'two' }], activeTabId: 'active' });
  const source = manager.getActiveTab()!;
  const before = manager.getPersistedState();
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw new Error('Assembly failed'); });
  await expect(manager.closeTab('active')).rejects.toThrow('Assembly failed');
  expect(manager.getActiveTab()).toBe(source);
  expect(source.session.acceptsIntents).toBe(true);
  expect(source.dom.contentEl.isConnected).toBe(true);
  expect(manager.getPersistedState()).toEqual(before);
  await expect(manager.closeTab('active')).resolves.toBe(true);
  expect(manager.getActiveTabId()).toBe('open');
});

it('resets a deleted conversation during reversible close even if successor assembly fails', async () => {
  const { manager, root } = await createManager();
  await manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
  const source = manager.getActiveTab()!;
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw new Error('Successor unavailable'); });
  const closing = manager.closeTab('one');
  const rejected = closing.then(() => null, error => error);
  await manager.resetConversationTabs('one');
  expect(await rejected).toMatchObject({ message: 'Successor unavailable' });
  expect(manager.getActiveTab()).toMatchObject({ id: source.id, conversationId: null });
  expect(source.conversationId).toBe('one');
  expect(source.dom.contentEl.isConnected).toBe(false);
  expect(provider.sessions).toEqual([]);
});

it('joins a restored assembly continuation during shutdown without losing its identity snapshot', async () => {
  const { manager, root } = await createManager();
  await manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
  const switching = manager.switchToTab('two');
  const shutdown = manager.drainForShutdownSnapshot();
  await Promise.all([switching, shutdown]);
  expect(manager.getTab('two')).toBeNull();
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
  expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(['one', 'two']);
  expect(manager.getPersistedState().activeTabId).toBe('one');
});

it('resets deleted restored identities and retries a failed assembled reset', async () => {
  const { manager, root } = await createManager();
  await manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: 'deleted' })), activeTabId: 'one' });
  expect(manager.getTab('two')).toBeNull();
  vi.spyOn(root, 'createDiv').mockImplementationOnce(() => { throw new Error('Reset failed'); });
  await expect(manager.resetConversationTabs('deleted')).rejects.toThrow('Reset failed');
  expect(manager.getActiveTab()?.conversationId).toBe('deleted');
  expect(manager.getTab('two')).toBeNull();
  expect(manager.getTabIdentities().find(tab => tab.id === 'two')?.conversationId).toBeNull();
  await manager.resetConversationTabs('deleted');
  expect(manager.getTabIdentities().every(tab => tab.conversationId === null)).toBe(true);
  expect(manager.getActiveTabId()).toBe('one');
});

it.each(['close', 'delete'] as const)('discards a restored assembly continuation when %s invalidates its identity', async operation => {
  const { manager, root } = await createManager();
  await manager.restoreState({ openTabs: ['one', 'two'].map(id => ({ tabId: id, conversationId: id })), activeTabId: 'one' });
  const switching = manager.switchToTab('two');
  if (operation === 'close') await manager.closeTab('two');
  else await manager.resetConversationTabs('two');
  await switching;
  expect(manager.getTab('two')).toBeNull();
  expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
  expect(manager.getActiveTabId()).toBe('one');
  expect(manager.getTabIdentities().find(tab => tab.id === 'two')?.conversationId).toBe(operation === 'close' ? undefined : null);
});
