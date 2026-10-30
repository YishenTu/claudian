/** @vitest-environment jsdom */

import { createHarness as createExecutionHarness, deferred } from '@test/helpers/ChatExecutionHarness';
import { holdResponse } from '@test/helpers/ConversationPorts';
import { useNextTaskAnimationFrames } from '@test/helpers/dom/animationFrames';
import { triggerResize } from '@test/helpers/dom/ResizeObserver';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createSessionBrowserHost } from '@test/helpers/features/chat/SessionBrowserTestHarness';
import { fireEvent, within } from '@testing-library/dom';
import { Menu, Platform, Scope, TFile } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { BUILT_IN_COMMANDS } from '@/core/commands/builtInCommands';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { TabLayoutPolicy } from '@/features/chat/tabs/types';
import { ViewerSlot } from '@/features/chat/tabs/ViewerSlot';
import { createChatTabCommands } from '@/features/chat/workspace/ChatTabCommands';

beforeEach(() => {
  useNextTaskAnimationFrames();
  registerChatTestProvider('claude');
});

const openedViews: Awaited<ReturnType<typeof createClaudianView>>[] = [];

async function createView(options: {
  width?: number;
  host?: Omit<NonNullable<NonNullable<Parameters<typeof createSessionBrowserHost>[0]>['host']>, 'fixture' | 'app'>;
} = {}) {
  const records = ['one', 'two'].map(id => conversationRecord(id));
  const { settings, ...overrides } = options.host ?? {};
  const fixture = await createFeatureHostFixture({ settings: { restoreTabsOnStartup: true, enableAutoTitleGeneration: false, ...settings } });
  const { plugin, pool } = await createSessionBrowserHost({ conversations: records.map(record => ({ ...record, messageCount: 0, preview: '' })), host: {
    fixture,
    chatModelSelection: new ChatModelSelectionCoordinator(fixture.coordinator),
    executionPersistence: createExecutionHarness().repository,
    getConversationById: async id => records.find(record => record.id === id) ?? null,
    getConversationSync: id => records.find(record => record.id === id) ?? null,
    getCachedConversation: id => records.find(record => record.id === id) ?? null,
    getConversationSummary: id => records.find(record => record.id === id) ?? null,
    ensureConversationMetadataLoaded: async () => undefined,
    updateConversation: async (id, updates) => { Object.assign(records.find(record => record.id === id)!, updates); },
    registerZenModeSource: vi.fn(() => vi.fn()),
    ...overrides,
  } });
  const messaging = new SessionMessagingService({ getHost: () => plugin, getActiveConversationId: () => null, refreshModelControls: () => undefined });
  plugin.bindSessionTools = id => messaging.bindSessionTools(id);
  onTestFinished(() => messaging.dispose());
  const contentEl = document.body.createDiv();
  const resize = (width: number) => {
    const contentRect = new DOMRect(0, 0, width, 0);
    contentEl.getBoundingClientRect = () => contentRect;
    triggerResize(contentEl, { contentRect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] });
  };
  contentEl.getBoundingClientRect = () => new DOMRect(0, 0, options.width ?? 400, 0);
  const view = await createClaudianView({ host: plugin, contentEl });
  view.load();
  openedViews.push(view);
  const saved: unknown[] = [];
  const { App: HostApp } = await vi.importActual<typeof import('../../../__mocks__/obsidian')>('obsidian');
  const app = plugin.app;
  if (!(app instanceof HostApp)) throw new Error('Expected the shared Obsidian App');
  const saveLayout = vi.spyOn(app.workspace, 'saveLayout');
  saveLayout.mockImplementation(async () => { saved.push(structuredClone(view.getState())); });
  await view.onOpen();
  const manager = view.getTabManager() as TabManager;
  expect(manager).toBeInstanceOf(TabManager);
  return { view, manager, plugin, pool, contentEl, resize, saveLayout, saved, records };
}

async function openView(options: Parameters<typeof createView>[0] = {}, state: unknown = {}) {
  const fixture = await createView(options);
  await fixture.view.setState(state, { history: false });
  return fixture;
}

function workspaceState(ids = ['restored-1', 'restored-2']) {
  return { tabWorkspace: { version: 1, activeTabId: ids.at(-1), openTabs: ids.map(tabId => ({ tabId, conversationId: null })) } };
}

afterEach(async () => {
  for (const view of openedViews.splice(0)) { await view.onClose(); view.unload(); }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ClaudianView real tab lifecycle', () => {
  it('waits for Obsidian state delivery, then restores all identities before publishing the active composer', async () => {
    const { view, manager, contentEl } = await createView();
    expect(manager.getTabCount()).toBe(0);
    await view.setState(workspaceState(), { history: false });
    expect(manager.getTabIdentities().map(tab => tab.id)).toEqual(['restored-1', 'restored-2']);
    expect(manager.getActiveTab()?.id).toBe('restored-2');
    expect(view.getState()).toMatchObject(workspaceState());
    expect(contentEl.contains(manager.getActiveTab()!.dom.inputEl)).toBe(true);
    // Later host deliveries cannot replace already-admitted membership.
    await view.setState(workspaceState(['stale']), { history: false });
    expect(manager.getTabCount()).toBe(2);
  });

  it('abandons deferred metadata restoration when the view closes', async () => {
    const metadata = deferred<void>();
    const entered = deferred<void>();
    const unregister = vi.fn();
    const { view, manager, plugin } = await createView({ host: {
      ensureConversationMetadataLoaded: () => { entered.resolve(); return metadata.promise; },
      registerZenModeSource: () => unregister,
    } });
    const restoring = view.setState({ tabWorkspace: { version: 1, activeTabId: 'bound', openTabs: [{ tabId: 'bound', conversationId: 'one' }] } }, { history: false });
    await entered.promise;
    const closing = view.onClose();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(manager.canCreateTab()).toBe(false);
    expect(vi.mocked(plugin.app.vault.offref).mock.calls.map(([ref]) => (ref as unknown as { name: string }).name)).toEqual(expect.arrayContaining(['create', 'delete', 'modify', 'rename']));
    metadata.resolve();
    await Promise.all([restoring, closing]);
    expect(manager.getTabCount()).toBe(0);
    expect(view.getTabManager()).toBeNull();
    expect(view.getZenPresentation()).toBeNull();
  });

  it('shares one shutdown drain and snapshots an identity created by admitted work before flushing', async () => {
    const { view, manager, saved, saveLayout } = await openView();
    const tab = manager.getActiveTab()!;
    const started = deferred<void>();
    const release = deferred<void>();
    const turn = tab.session.runtime.turns.run(async () => {
      started.resolve();
      await release.promise;
      tab.session.setConversationId('one');
    });
    await started.promise;
    const first = view.prepareForPluginUnload();
    const second = view.prepareForPluginUnload();
    expect(manager.canCreateTab()).toBe(false);
    expect(saved).toEqual([]);
    release.resolve();
    await Promise.all([turn, first, second]);
    expect(saved).toEqual([{ tabWorkspace: expect.objectContaining({ openTabs: [expect.objectContaining({ tabId: tab.id, conversationId: 'one' })] }) }]);
    expect(saveLayout).toHaveBeenCalledTimes(1);
  });

  it('keeps the final identity visible while the host save blocks teardown', async () => {
    const { view, manager, saveLayout } = await openView({}, workspaceState());
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const entered = deferred<void>();
    const save = deferred<void>();
    saveLayout.mockImplementation(() => { entered.resolve(); return save.promise; });
    const final = view.getState();
    const duringRemoval: unknown[] = [];
    const tabRoot = manager.getActiveTab()!.dom.contentEl;
    const remove = tabRoot.remove.bind(tabRoot);
    vi.spyOn(tabRoot, 'remove').mockImplementation(() => { duringRemoval.push(view.getState()); remove(); });
    let prepared = false;
    const preparing = view.prepareForPluginUnload().then(() => { prepared = true; });
    let closed = false;
    const closing = view.onClose().then(() => { closed = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(prepared).toBe(false);
      expect(closed).toBe(false);
      expect(view.getState()).toEqual(final);
      expect(manager.canCreateTab()).toBe(false);
      expect(manager.getTabCount()).toBe(2);
    } finally {
      save.resolve();
      await Promise.all([preparing, closing]);
    }
    expect(manager.getTabCount()).toBe(0);
    expect(view.getTabManager()).toBeNull();
    expect(view.scope).toBeNull();
    expect(view.getState()).toEqual(final);
    expect(duringRemoval).toEqual([final]);
  });

  it('reopens wide only after the closing snapshot and keeps the new lifecycle after old cleanup', async () => {
    const { view, manager, saveLayout, resize } = await openView({}, workspaceState());
    const entered = deferred<void>();
    const save = deferred<void>();
    saveLayout.mockImplementationOnce(() => { entered.resolve(); return save.promise; });
    const persistence = view.tabWorkspace.currentPersistence;
    const closing = view.onClose();
    await entered.promise;
    resize(640);
    const opening = view.onOpen();
    expect(view.getTabManager()).toBe(manager);
    save.resolve();
    await Promise.all([closing, opening]);
    const reopened = view.getTabManager() as TabManager;
    expect(reopened).not.toBe(manager);
    expect(reopened.getTabIdentities().map(tab => tab.id)).toEqual(expect.arrayContaining(['restored-1', 'restored-2']));
    expect(reopened.getTabCount()).toBe(3);
    expect(reopened.getActiveTab()!.conversationId).toBeNull();
    expect(view.tabWorkspace.currentPersistence).toBe(persistence);
    expect(view.scope).toBeInstanceOf(Scope);
    expect(view.tabBar).not.toBeNull();
    expect(view.releaseMentionCacheEvents).toEqual(expect.any(Function));
    expect(view.getState()).toMatchObject({ tabWorkspace: { openTabs: expect.arrayContaining(workspaceState().tabWorkspace.openTabs) } });
    // Reused persistence must remain writable after the old close finalizer runs.
    await reopened.createTab();
    await view.prepareForPluginUnload();
    expect(saveLayout).toHaveBeenCalledTimes(2);
  });

  it('waits for admitted identity settlement before reopening, even with startup restoration disabled', async () => {
    const { view, manager } = await openView({ host: { settings: { restoreTabsOnStartup: false } } });
    const tab = manager.getActiveTab()!;
    const started = deferred<void>();
    const release = deferred<void>();
    const turning = tab.session.runtime.turns.run(async () => {
      started.resolve();
      await release.promise;
      tab.session.setConversationId('one');
    });
    await started.promise;
    const closing = view.onClose();
    const opening = view.onOpen();
    expect(view.getTabManager()).toBe(manager);
    expect(manager.canCreateTab()).toBe(false);
    release.resolve();
    await Promise.all([turning, closing, opening]);
    const restored = view.getTabManager() as TabManager;
    expect(restored).not.toBe(manager);
    expect(restored.getTabIdentities()).toEqual(expect.arrayContaining([expect.objectContaining({ id: tab.id, conversationId: 'one' })]));
    expect(view.getState()).toMatchObject({ tabWorkspace: { openTabs: expect.arrayContaining([expect.objectContaining({ tabId: tab.id, conversationId: 'one' })]) } });
  });

  it('still releases view and manager resources when the layout save fails', async () => {
    const { view, manager, saveLayout, plugin } = await openView();
    saveLayout.mockRejectedValue(new Error('disk full'));
    await expect(view.onClose()).resolves.toBeUndefined();
    expect(manager.getTabCount()).toBe(0);
    expect(view.getTabManager()).toBeNull();
    expect(view.scope).toBeNull();
    expect(vi.mocked(plugin.app.vault.offref).mock.calls.map(([ref]) => (ref as unknown as { name: string }).name)).toEqual(expect.arrayContaining(['create', 'delete', 'modify', 'rename']));
  });
});

describe('ClaudianView provider and presentation wiring', () => {
  it('refreshes changed-provider controls and every blank tab, then refreshes all providers on a global change', async () => {
    registerChatTestProvider('codex');
    registerChatTestProvider('grok');
    const { view, manager, records } = await openView({ host: { settings: { providerConfigs: { codex: { enabled: true }, grok: { enabled: true } } } } });
    records[0].providerId = 'codex';
    records[1].providerId = 'grok';
    const codex = (await manager.createTab('one'))!;
    const grok = (await manager.createTab('two'))!;
    const blank = (await manager.createTab(null, undefined, { providerId: 'grok' }))!;
    const refreshCodex = vi.spyOn(codex, 'refreshProviderControls');
    const refreshGrok = vi.spyOn(grok, 'refreshProviderControls');
    const refreshBlank = vi.spyOn(blank, 'refreshProviderControls');
    view.refreshModelSelector('codex');
    expect(refreshCodex).toHaveBeenCalledTimes(1);
    expect(refreshGrok).not.toHaveBeenCalled();
    expect(refreshBlank).toHaveBeenCalledTimes(1);
    view.refreshModelSelector();
    expect(refreshGrok).toHaveBeenCalledTimes(1);
  });

  it('moves the composer and chip placement with the real compact/wide transition and keeps the sidebar after the chat panel', async () => {
    const { view, manager, contentEl, resize } = await openView();
    const tab = manager.getActiveTab()!;
    const chip = vi.spyOn(tab.controllers.sideChatController, 'setCollapsedHost');
    view.presentation.update();
    const slot = contentEl.querySelector('.claudian-side-chat-chip-slot');
    expect(chip).toHaveBeenLastCalledWith(slot);
    expect(contentEl.querySelector('.claudian-active-input-slot')?.contains(tab.dom.inputComposerEl)).toBe(true);
    const panels = [...contentEl.children];
    expect(panels.map(element => element.className)).toEqual(['claudian-chat-panel', 'claudian-session-resizer', 'claudian-session-sidebar']);
    expect(panels[1].getAttribute('role')).toBe('separator');
    expect(panels[2].querySelectorAll('.claudian-session-surface')).toHaveLength(1);
    const enter = vi.spyOn(manager.viewerSlot, 'enter');
    resize(640);
    await enter.mock.results[0].value;
    expect(chip).toHaveBeenLastCalledWith(null);
    const release = vi.spyOn(manager.viewerSlot, 'release');
    resize(400);
    await release.mock.results[0].value;
    await Promise.resolve();
    const active = manager.getActiveTab()!;
    expect(contentEl.querySelector('.claudian-active-input-slot')?.contains(active.dom.inputComposerEl)).toBe(true);
  });

  it('routes picked sessions and /new through the real viewer only while wide', async () => {
    const enter = vi.spyOn(ViewerSlot.prototype, 'enter');
    const { manager, resize, contentEl } = await openView({ width: 640 });
    // Cold restoration enters the real viewer once; the view must not enter it a second time.
    expect(enter).toHaveBeenCalledTimes(1);
    const policy = (manager as unknown as { layoutPolicy: TabLayoutPolicy }).layoutPolicy;
    expect(policy.forkTarget()).toBe('viewer');
    const source = manager.getActiveTab()!;
    expect(await policy.openPicked('two', source)).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBe('two');
    expect(await policy.startNew(manager.getActiveTab()!, {})).toBe(true);
    expect(manager.getActiveTab()!.conversationId).toBeNull();
    const release = vi.spyOn(manager.viewerSlot, 'release');
    resize(400);
    await release.mock.results[0].value;
    await Promise.resolve();
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(false);
    expect(policy.forkTarget()).toBe('ask');
    const current = manager.getActiveTab();
    expect(await policy.openPicked('one', current!)).toBe(false);
    expect(await policy.startNew(current!, {})).toBe(false);
    expect(manager.getActiveTab()).toBe(current);
    resize(640);
    expect(enter).toHaveBeenCalledTimes(2);
    await enter.mock.results[1].value;
  });

  it('notifies other open views when the real session publishes work or attention changes', async () => {
    const { view, manager, plugin } = await openView();
    const other = await createClaudianView({ host: plugin });
    other.load();
    openedViews.push(other);
    const notify = vi.spyOn(other, 'notifyConversationListChanged');
    plugin.getAllViews = () => [view, other];
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    expect(notify).toHaveBeenCalled();
    await release();
    notify.mockClear();
    tab.session.runtime.attention.markReviewRequired('completed');
    expect(notify).toHaveBeenCalled();
  });
});

describe('ClaudianView tab controls and layout', () => {
  it('uses native navigation buttons, creates and focuses a real tab, and opens history', async () => {
    const { view, manager, contentEl } = await openView();
    const controls = within(contentEl);
    const newTab = controls.getByRole('button', { name: 'New tab' });
    const newConversation = controls.getByRole('button', { name: 'New conversation' });
    const history = controls.getByRole('button', { name: 'Chat history' });
    for (const button of [newTab, newConversation, history]) expect(button.getAttribute('type')).toBe('button');
    const created = vi.spyOn(manager, 'createTab');
    fireEvent.click(newTab);
    const tab = await created.mock.results[0].value;
    expect(manager.getTabCount()).toBe(2);
    expect(manager.getActiveTab()).toBe(tab);
    expect(tab.dom.inputEl.contains(document.activeElement) || document.activeElement === tab.dom.inputEl).toBe(true);
    const replacement = vi.spyOn(manager, 'createNewConversation');
    fireEvent.click(newConversation);
    await replacement.mock.results[0].value;
    expect(manager.getActiveTab()!.conversationId).toBeNull();
    fireEvent.click(history);
    expect(contentEl.querySelector('.claudian-history-menu')?.classList.contains('visible')).toBe(true);
    const navRow = contentEl.querySelector('.claudian-view-input-nav-row');
    expect(navRow?.contains(newTab)).toBe(true);
    expect(view.getSharedSelectionFocusScopeEls!()).toEqual([navRow]);
  });

  it('restores inactive shells for rename availability and persists a label through the real manager', async () => {
    const { view, manager, contentEl } = await openView({}, workspaceState());
    const rename = createChatTabCommands({
      workspace: { getLeavesOfType: () => [] },
      views: { getView: () => view, activateView: vi.fn() },
    }).find(command => command.id === 'rename-current-tab')!;
    expect(manager.getTabCount()).toBe(2);
    expect(rename.checkCallback!(true)).toBe(true);
    view.tabBar.callbacks.onTabLabelChange('restored-2', 'Research');
    expect(manager.getTabBarItems().find(tab => tab.id === 'restored-2')).toMatchObject({ label: 'Research' });
    await manager.closeTab('restored-1');
    view.refreshTabControls();
    expect(rename.checkCallback!(true)).toBe(false);
    expect(contentEl.querySelector('.claudian-tab-bar-container')?.classList.contains('claudian-hidden')).toBe(true);
  });

  it.each([400, 640])('starts New through the correct owner in a %s px view', async width => {
    const { view, manager } = await openView({ width });
    const draft = vi.spyOn(manager.viewerSlot, 'startDraft');
    const createTab = vi.spyOn(manager, 'createTab');
    await view.startNewConversation();
    expect(draft).toHaveBeenCalledTimes(width === 640 ? 1 : 0);
    expect(createTab).toHaveBeenCalledTimes(width === 640 ? 0 : 1);
    expect(manager.getActiveTab()!.conversationId).toBeNull();
    expect(view.getCompactTabManager()).toBe(width === 640 ? null : manager);
  });

  it('keeps compact controls hidden until real viewer cleanup completes, and closes search immediately', async () => {
    const { view, manager, contentEl, resize } = await openView();
    fireEvent.click(within(contentEl).getByRole('button', { name: 'Chat history' }));
    const historyMenu = contentEl.querySelector('.claudian-history-menu')!;
    expect(historyMenu.classList.contains('visible')).toBe(true);
    const enter = vi.spyOn(manager.viewerSlot, 'enter');
    resize(640);
    await enter.mock.results[0].value;
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(true);
    expect(historyMenu.classList.contains('visible')).toBe(false);
    fireEvent.click(contentEl.querySelector<HTMLElement>('.claudian-session-search-control')!);
    expect(contentEl.querySelector('.claudian-session-search-input')).not.toBeNull();
    const released = vi.spyOn(manager.viewerSlot, 'release');
    resize(400);
    expect(contentEl.querySelector('.claudian-session-search-input')).toBeNull();
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(true);
    await released.mock.results[0].value;
    // The layout's continuation follows the owner's fulfilled release promise.
    await Promise.resolve();
    expect(contentEl.classList.contains('claudian-wide-session-layout')).toBe(false);
    expect(view.getCompactTabManager()).toBe(manager);
  });

  it('routes active-file and metadata changes only to the active real Linked content owner', async () => {
    const { manager, plugin } = await openView();
    const inactive = manager.getActiveTab()!;
    const active = (await manager.createTab())!;
    const inactiveFile = vi.spyOn(inactive.linkedContent, 'handleActiveFileChanged');
    const activeFile = vi.spyOn(active.linkedContent, 'handleActiveFileChanged');
    const activeMetadata = vi.spyOn(active.linkedContent, 'handleActiveFileMetadataChanged');
    const inactiveMetadata = vi.spyOn(inactive.linkedContent, 'handleActiveFileMetadataChanged');
    const file = new TFile();
    Object.assign(file, { path: 'Projects/Plan.md', extension: 'md', name: 'Plan.md', basename: 'Plan' });
    plugin.app.workspace.trigger('file-open', file);
    plugin.app.workspace.trigger('file-open', null);
    plugin.app.metadataCache.trigger('changed', file);
    plugin.app.metadataCache.trigger('resolve', file);
    plugin.app.metadataCache.trigger('resolved');
    expect(activeFile.mock.calls).toEqual([[file, true], [null, true]]);
    expect(activeMetadata.mock.calls).toEqual([[file], [file], [null]]);
    expect(inactiveFile).not.toHaveBeenCalled();
    expect(inactiveMetadata).not.toHaveBeenCalled();
  });

  it('releases mention invalidation listeners on close and replaces them on reopen', async () => {
    const { view, plugin } = await openView();
    const markFilesDirty = vi.spyOn(view.mentionDataProvider, 'markFilesDirty');
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).toHaveBeenCalledTimes(1);
    await view.onClose();
    markFilesDirty.mockClear();
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).not.toHaveBeenCalled();
    await view.onOpen();
    markFilesDirty.mockClear();
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).toHaveBeenCalledTimes(1);
    const previousManager = view.getTabManager() as TabManager;
    await view.onOpen();
    markFilesDirty.mockClear();
    plugin.app.vault.trigger('create');
    expect(markFilesDirty).toHaveBeenCalledTimes(1);
    await previousManager.destroy();
    expect(vi.mocked(plugin.app.vault.offref).mock.calls.map(([ref]) => (ref as unknown as { name: string }).name)).toEqual(expect.arrayContaining(['create', 'delete', 'modify', 'rename']));
  });
});

describe('ClaudianView composer and scoped keys', () => {
  function scoped(view: Awaited<ReturnType<typeof createClaudianView>>, key: string, event: Partial<KeyboardEvent> = {}) {
    return view.scope.handlers.find((handler: { key: string }) => handler.key === key).func({
      key, isComposing: false, preventDefault() {}, stopPropagation() {}, ...event,
    });
  }

  it.each([['Hello', 'Hello @projects/plan.md '], ['Hello ', 'Hello @projects/plan.md ']])('appends to %j and focuses the real composer', async (existing, expected) => {
    const { view, manager } = await openView();
    const tab = manager.getActiveTab()!;
    tab.controllers.drafts.restore('main', { content: existing, images: [] });
    expect(view.appendToActiveInput('@projects/plan.md ')).toBe(true);
    expect(tab.controllers.drafts.capture('main').content).toBe(expected);
    view.focusActiveInput();
    expect(tab.dom.inputEl.contains(document.activeElement) || tab.dom.inputEl === document.activeElement).toBe(true);
  });

  it('returns false when the view has no admitted composer', async () => {
    const { view } = await createView();
    expect(view.appendToActiveInput('text')).toBe(false);
  });

  it('handles Escape in the view scope and cancels an active real turn only once', async () => {
    const { view, manager } = await openView();
    const tab = manager.getActiveTab()!;
    const cancel = vi.spyOn(tab.session.turns, 'cancel');
    const release = holdResponse(tab.session.runtime.turns);
    expect(view.scope).toBeInstanceOf(Scope);
    expect(view.scope.parent).toBe(view.app.scope);
    expect(view.registerDomEvent).not.toHaveBeenCalledWith(expect.anything(), 'keydown', expect.any(Function), { capture: true });
    expect(scoped(view, 'Escape', { defaultPrevented: true })).toBe(false);
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(scoped(view, 'Escape')).toBe(false);
    expect(tab.session.turns.cancelRequested).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    await release();
    expect(tab.state.isStreaming).toBe(false);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('lets session search and IME consume Escape before cancelling the active turn', async () => {
    const { view, manager, contentEl } = await openView({ width: 640 });
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    fireEvent.click(contentEl.querySelector<HTMLElement>('.claudian-session-search-control')!);
    const search = contentEl.querySelector<HTMLInputElement>('.claudian-session-search-input')!;
    fireEvent.compositionStart(search);
    expect(scoped(view, 'Escape')).toBeUndefined();
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    fireEvent.compositionEnd(search);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(contentEl.querySelector('.claudian-session-search-input')).toBeNull();
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    scoped(view, 'Escape');
    expect(tab.session.turns.cancelRequested).toBe(true);
    await release();
    expect(tab.state.isStreaming).toBe(false);
  });

  it.each(['toolbar', 'resume', 'composer', 'tab rename'] as const)('dismisses the real %s surface before stopping a turn', async surface => {
    const { view, manager, contentEl } = await openView({}, workspaceState());
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    let isOpen: () => boolean;
    if (surface === 'toolbar') {
      const button = tab.dom.inputWrapper.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
      fireEvent.click(button);
      isOpen = () => button.getAttribute('aria-expanded') === 'true';
    } else if (surface === 'resume') {
      await tab.controllers.builtInCommandController.execute(BUILT_IN_COMMANDS.find(command => command.action === 'resume')!, ProviderRegistry.getCapabilities('claude'));
      isOpen = () => tab.controllers.builtInCommandController.isResumeDropdownVisible();
    } else if (surface === 'composer') {
      tab.dom.inputEl.value = '/';
      tab.dom.inputEl.selectionStart = 1;
      tab.ui.composerDropdown.handleInputChange();
      await within(contentEl).findByRole('listbox');
      isOpen = () => tab.ui.composerDropdown.isVisible();
    } else {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      view.tabBar.beginRename(tab.id);
      isOpen = () => within(contentEl).queryByRole('textbox', { name: 'Tab name' }) !== null;
    }
    expect(isOpen()).toBe(true);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(isOpen()).toBe(false);
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    scoped(view, 'Escape');
    expect(tab.session.turns.cancelRequested).toBe(true);
    await release();
    expect(tab.state.isStreaming).toBe(false);
  });

  it('dismisses inline session rename before handling the scoped stop action', async () => {
    const { view, manager, contentEl } = await openView();
    const tab = manager.getActiveTab()!;
    const release = holdResponse(tab.session.runtime.turns);
    fireEvent.click(within(contentEl).getByRole('button', { name: 'Chat history' }));
    const item = contentEl.querySelector<HTMLElement>('.claudian-history-menu .claudian-history-item')!;
    fireEvent.contextMenu(item);
    const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string; clickHandler?: () => void }> }> }).instances.at(-1)!;
    menu.items.find(action => action.title === 'Rename')!.clickHandler!();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(within(contentEl).getByRole('textbox', { name: 'Conversation title' })).toBeTruthy();
    expect(scoped(view, 'Escape')).toBe(false);
    expect(within(contentEl).queryByRole('textbox', { name: 'Conversation title' })).toBeNull();
    expect(tab.state.isStreaming).toBe(true);
    expect(tab.session.turns.cancelRequested).toBe(false);
    await release();
  });

  it.each([true, false])('scoped Mod+Enter sends only with composer focus (focused=%s)', async focused => {
    const priorPlatform = Platform.isMacOS;
    Platform.isMacOS = true;
    try {
      const { view, manager } = await openView();
      const tab = manager.getActiveTab()!;
      const send = vi.spyOn(tab.controllers.inputController, 'sendMessage');
      if (focused) tab.composer.focus();
      else { const outside = document.body.createEl('button'); outside.focus(); }
      const preventDefault = vi.fn();
      expect(scoped(view, 'Enter', { metaKey: true, preventDefault })).toBe(focused ? false : undefined);
      expect(preventDefault).toHaveBeenCalledTimes(focused ? 1 : 0);
      expect(send).toHaveBeenCalledTimes(focused ? 1 : 0);
      if (focused) await send.mock.results[0].value;
    } finally { Platform.isMacOS = priorPlatform; }
  });


  it('scoped Escape stops published provider background work without a foreground turn', async () => {
    const native = registerChatTestProvider('claude');
    const { view, manager } = await openView();
    const tab = manager.getActiveTab()!;
    await tab.executionCoordinator.bindConversation({ conversationId: 'one', providerId: 'claude' });
    await tab.executionCoordinator.prepare();
    const session = native.sessions[0];
    session.emit({ type: 'background_turn_started', scope: { kind: 'background', sessionInstanceId: session.sessionInstanceId, turnId: 'background', sequence: 1 } });
    await tab.session.runtime.awaitBackgroundWork();
    expect(tab.state.isStreaming).toBe(false);
    expect(tab.session.hasMainBackgroundWork).toBe(true);
    expect(scoped(view, 'Escape')).toBe(false);
    expect(session.cancelCalls).toBe(1);
  });

});
