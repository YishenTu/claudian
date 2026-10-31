/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App, Component } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudianSettings, Conversation } from '@/core/types';
import type { ChatViewHost } from '@/features/chat/ChatFeatureHost';
import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import { SessionManagerSurface } from '@/features/chat/session-manager/SessionManagerSurface';
import { SessionNavigation } from '@/features/chat/session-manager/SessionNavigation';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

afterEach(() => {
  ProviderWorkspaceRegistry.clear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function setup() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref() {}, getAbstractFileByPath: () => null });
  Object.assign(app.workspace, { getActiveFile: () => null });
  const backend = new FakeSideBackend();
  vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  vi.spyOn(ProviderRegistry.getConversationHistoryService('claude'), 'buildForkProviderState').mockResolvedValue({});
  ProviderWorkspaceRegistry.setServices('claude', {});
  const settings: Partial<ClaudianSettings> = {
    model: 'claude-sonnet-4-5', permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'high']) },
  };
  const conversation: Conversation = {
    id: 'conversation', providerId: 'claude', selectedModel: 'claude-sonnet-4-5', sessionId: 'native',
    title: 'Conversation', messages: [], createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  };
  const conversations = new Map(['conversation', 'second', 'third'].map(id => [id, { ...conversation, id, title: id === 'conversation' ? 'Conversation' : id }]));
  const findConversation = (id: string) => conversations.get(id) ?? null;
  const messaging = new SessionMessagingService({
    getHost: () => plugin,
    getActiveConversationId: () => manager.getActiveTab()?.conversationId ?? null,
    refreshModelControls: () => undefined,
  });
  onTestFinished(() => messaging.dispose());
  const pool = createSessionRuntimePool(() => plugin);
  const plugin = await createChatFeatureHost({
    sessionRuntimes: pool,
    bindSessionTools: id => messaging.bindSessionTools(id),
    app, settings,
    getConversationSummary: findConversation, getConversationSync: findConversation,
    projects: createProjectsFake(),
    getCachedConversation: findConversation,
    getConversationById: async (id: string) => structuredClone(findConversation(id)),
    getConversationList: () => [...conversations.values()].map(value => ({ ...value, messageCount: value.messages.length, preview: '' })),
    findConversationAcrossViews: () => null,
    updateConversation: async () => undefined,
    renameConversation: async () => undefined,
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
  });
  const view = Object.assign(new Component(), { leaf: {}, getTabManager: () => manager });
  const onTabAttentionChanged = vi.fn();
  const onActiveTabChanged = vi.fn();
  const root = document.body.createDiv();
  const manager: TabManager = new TabManager(
    plugin, root, view as never, { onTabAttentionChanged, onActiveTabChanged }, new VaultMentionDataProvider(app),
  );
  return { backend, manager, onTabAttentionChanged, onActiveTabChanged, plugin, pool, root, conversations, view };
}

it('badges the tab and notifies the tab bar while its side chat awaits approval', async () => {
  const { backend, manager, onTabAttentionChanged } = await setup();
  try {
    const tab = (await manager.createTab('conversation'))!;
    await waitFor(() => expect(tab.hydrationState).toBe('ready'));
    tab.state.messages = [
      { id: 'user', role: 'user', content: 'Parent task', timestamp: testDate().getTime() },
      { id: 'answer', role: 'assistant', content: 'Parent answer', assistantMessageId: 'checkpoint', timestamp: testDate().getTime() },
    ];
    const starting = tab.controllers.sideChatController.handleCommandSubmission('Explain the answer', []);
    await waitFor(() => expect(backend.sessions[0]?.requests).toHaveLength(1));
    const native = backend.latest;
    expect(manager.getTabBarItems()[0].attention).toBeNull();

    const approval = native.config.interactionPort.requestApproval({
      interactionId: 'side-approval', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId,
      kind: 'approval', toolName: 'Read', input: {}, description: 'Read note',
    }, new AbortController().signal);
    void approval.catch(() => undefined);

    await waitFor(() => expect(tab.controllers.sideChatController.runtime?.state.requiresAction).toBe(true));
    expect(tab.state.attention).toBeNull();
    expect(manager.getTabBarItems()[0].attention).toMatchObject({ kind: 'action-required' });
    expect(onTabAttentionChanged).toHaveBeenLastCalledWith(tab.id, expect.objectContaining({ kind: 'action-required' }));

    native.config.interactionPort.dismissInteraction('side-approval', 'superseded');
    native.complete();
    await starting;
    await waitFor(() => expect(manager.getTabBarItems()[0].attention).toBeNull());
    expect(onTabAttentionChanged).toHaveBeenLastCalledWith(tab.id, null);
  } finally {
    await manager.destroy();
  }
});


it('keeps execution alive across tab rebind and close, restoring the owner and unsent composer draft', async () => {
  const { backend, manager, pool } = await setup();
  const first = (await manager.createTab('conversation'))!;
  await waitFor(() => expect(first.hydrationState).toBe('ready'));
  manager.setTabLabel(first.id, 'Research');
  first.controllers.drafts.restore('main', { content: 'Read the note' });
  const request = backend.nextRequest(() => true);
  const sending = first.controllers.inputController.sendMessage();
  await request;
  const native = backend.latest;
  first.controllers.drafts.restore('main', { content: 'Unsent draft' });
  try {
    expect(manager.getTabBarItems()).toEqual([expect.objectContaining({ id: first.id, isWorking: true })]);
    await manager.openConversation('second');
    const current = manager.getActiveTab()!;
    expect([current.id, current.conversationId, current.label]).toEqual([first.id, 'second', 'Research']);
    expect(current).not.toBe(first);
    expect(first.conversationId).toBe('conversation');
    expect(current.lifecycleState).toBe('open');
    expect(current.controllers.drafts.capture('main').content).toBe('Unsent draft');
    expect(manager.getTabCount()).toBe(1);
    expect(pool.get('conversation')).toBe(first.session.runtime);
    expect(pool.isRunning('conversation')).toBe(true);
    expect(native.cancelCalls).toBe(0);

    await manager.openConversation('conversation');
    expect(manager.getActiveTab()!.session.runtime).toBe(first.session.runtime);
    expect(manager.getActiveTab()!.controllers.drafts.capture('main').content).toBe('Unsent draft');
    expect(await manager.closeTab(first.id)).toBe(true);
    expect(pool.isRunning('conversation')).toBe(true);
    const reattached = (await manager.createTab('conversation'))!;
    expect(reattached.session.runtime).toBe(first.session.runtime);
    expect(reattached.state).toBe(first.state);
    expect(native.cancelCalls).toBe(0);
    native.emitText('Completed after reattachment');
    native.complete();
    await sending;
    expect(reattached.state.messages.at(-1)?.content).toBe('Completed after reattachment');
  } finally {
    native.complete();
    await sending;
    await manager.destroy();
  }
});

it('restores cold identities with only the active runtime and hydrates another only when selected', async () => {
  const { backend, manager, onActiveTabChanged, plugin, pool, root } = await setup();
  const createTitle = vi.spyOn(ProviderRegistry, 'createTitleGenerationService');
  const saved = {
    openTabs: Array.from({ length: 20 }, (_, index) => ({
      tabId: `saved-${index}`, conversationId: null, draftModel: 'claude-sonnet-4-5',
    })),
    activeTabId: 'saved-0',
  };
  try {
    await manager.restoreState(saved);
    expect(manager.getTabCount()).toBe(20);
    expect(manager.getAllTabs()).toHaveLength(1);
    expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(1);
    expect(pool.getAll()).toHaveLength(1);
    expect(createTitle).toHaveBeenCalledTimes(1);
    expect(onActiveTabChanged).toHaveBeenCalledTimes(1);
    expect(manager.getPersistedState().openTabs.map(tab => tab.tabId)).toEqual(saved.openTabs.map(tab => tab.tabId));
    await manager.closeTab('saved-19');
    expect(pool.getAll()).toHaveLength(1);
    await plugin.mutateSettings(settings => { settings.lastSelectedChatModel = { model: 'changed-model', providerId: 'codex' }; });
    await manager.switchToTab('saved-1');
    expect(manager.getActiveTab()?.draftModel).toBe('claude-sonnet-4-5');
    expect(pool.getAll()).toHaveLength(2);
    expect(createTitle).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll('.claudian-tab-content')).toHaveLength(2);
    expect(backend.sessions).toHaveLength(0);
    const disposed = pool.getAll().map(runtime => vi.spyOn(runtime.executionCoordinator, 'dispose'));
    await manager.destroy();
    await pool.dispose();
    expect(disposed.every(spy => spy.mock.calls.length === 1)).toBe(true);
  } finally {
    await manager.destroy();
  }
});

it('parks each narrow tab draft while wide and restores its identity and text when narrowing', async () => {
  const { backend, manager } = await setup();
  const first = (await manager.createTab('conversation'))!;
  const second = (await manager.createTab('second', undefined, { activate: false }))!;
  first.controllers.drafts.restore('main', { content: 'first note' });
  second.controllers.drafts.restore('main', { content: 'second note' });
  const shownText = () => manager.getActiveTab()!.controllers.drafts.capture('main').content;
  try {
    await manager.viewerSlot.enter();
    const preview = manager.getActiveTab()!;
    expect(manager.getAllTabs()).toEqual([preview]);
    expect([preview.conversationId, preview.lifecycleState]).toEqual(['conversation', 'provisional']);
    expect(shownText()).toBe('first note');
    expect(first.dom.contentEl.isConnected).toBe(false);
    expect(second.dom.contentEl.isConnected).toBe(false);
    expect(manager.getTabIdentities().map(tab => tab.id)).toEqual([first.id, second.id, preview.id]);
    await manager.viewerSlot.show('second');
    expect(manager.getTab(second.id)).toBeNull();
    expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');
    expect(shownText()).toBe('second note');
    await manager.viewerSlot.release();
    expect(manager.getTabIdentities().map(tab => tab.id)).toEqual([first.id, second.id]);
    expect(manager.getActiveTabId()).toBe(second.id);
    expect(shownText()).toBe('second note');
    await manager.switchToTab(first.id);
    expect(shownText()).toBe('first note');
    expect(backend.sessions).toHaveLength(0);
  } finally {
    await manager.destroy();
  }
});

it('keeps a held blank draft, linked content and unsent text through wide and narrow presentation', async () => {
  const { backend, manager } = await setup();
  const blank = (await manager.createTab())!;
  const session = blank.session.runtime;
  blank.linkedContent.selectExplicit('chosen.md');
  blank.controllers.drafts.restore('main', { content: 'new idea' });
  try {
    await manager.viewerSlot.enter();
    const preview = manager.getActiveTab()!;
    expect(manager.getAllTabs()).toEqual([preview]);
    expect(manager.getTab(blank.id)).toBeNull();
    expect(preview.lifecycleState).toBe('provisional');
    expect(preview.session.runtime).toBe(session);
    expect([preview.controllers.drafts.capture('main').content, preview.session.runtime.model.linkedContentController.getSnapshot().path])
      .toEqual(['new idea', 'chosen.md']);
    expect(session.isDisposed).toBe(false);
    await manager.viewerSlot.release();
    const restored = manager.getActiveTab()!;
    expect(restored.id).toBe(blank.id);
    expect(restored.session.runtime).toBe(session);
    expect([restored.controllers.drafts.capture('main').content, restored.session.runtime.model.linkedContentController.getSnapshot().path])
      .toEqual(['new idea', 'chosen.md']);
    expect(backend.sessions).toHaveLength(0);
  } finally {
    await manager.destroy();
  }
});

it('reuses a provisional preview while parking typed text by conversation', async () => {
  const { backend, manager } = await setup();
  const text = () => manager.getActiveTab()!.controllers.drafts.capture('main').content;
  const type = (value: string) => {
    const tab = manager.getActiveTab()!;
    tab.dom.inputEl.value = value;
    fireEvent.input(tab.dom.inputEl);
  };
  try {
    await manager.viewerSlot.show('conversation');
    const first = manager.getActiveTab()!;
    expect(first.lifecycleState).toBe('provisional');
    type('first session note');
    await manager.viewerSlot.show('second');
    const second = manager.getActiveTab()!;
    expect([second.id, second.conversationId, second.lifecycleState]).toEqual([first.id, 'second', 'provisional']);
    expect(manager.getTabCount()).toBe(1);
    expect(text()).toBe('');
    type('second session note');
    await manager.viewerSlot.show('conversation');
    expect(text()).toBe('first session note');
    await manager.viewerSlot.show('second');
    expect(text()).toBe('second session note');
    expect(manager.getAllTabs()).toHaveLength(1);
    expect(manager.getActiveTab()?.lifecycleState).toBe('provisional');
    expect(backend.sessions).toHaveLength(0);
  } finally {
    await manager.destroy();
  }
});


it('keeps an unread result during background work and acknowledges it only when its tab becomes active', async () => {
  const { backend, manager } = await setup();
  const first = (await manager.createTab('conversation'))!;
  await waitFor(() => expect(first.hydrationState).toBe('ready'));
  first.controllers.drafts.restore('main', { content: 'Read the note' });
  const request = backend.nextRequest(() => true);
  const sending = first.controllers.inputController.sendMessage();
  await request;
  const native = backend.latest;
  vi.spyOn(first.dom.messagesEl, 'getClientRects').mockImplementation(() => {
    const rects = first.dom.contentEl.classList.contains('claudian-hidden') ? [] : [new DOMRect(0, 0, 100, 100)];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
  });
  try {
    await manager.createTab('second');
    native.emitText('Ready for review');
    native.complete();
    await sending;
    const item = () => manager.getTabBarItems().find(tab => tab.id === first.id)!;
    expect(item().attention).toMatchObject({ kind: 'review', outcome: 'completed' });
    const attention = item().attention;
    native.emitBackgroundEvent({ type: 'background_turn_started' });
    await waitFor(() => expect(item().isWorking).toBe(true));
    expect(item().attention).toEqual(attention);
    await manager.switchToTab(first.id);
    expect(item().attention).toBeNull();
    expect(item().isWorking).toBe(true);
    native.emitBackgroundEvent({ type: 'background_turn_completed', reason: 'completed' });
    await waitFor(() => expect(item().isWorking).toBe(false));
  } finally {
    native.complete();
    await sending;
    await manager.destroy();
  }
});


it.each(['running', 'idle'] as const)('uses the target session runtime to guard %s deletion from history', async target => {
  const { backend, manager, plugin, pool, conversations, view } = await setup();
  const deleteConversation = vi.fn(async () => undefined);
  const lifecycle = new ConversationLifecycle({
    sessions: pool,
    conversations: {
      deleteConversation,
      ensureAllConversationMetadataLoaded: async () => undefined,
      getConversationList: () => [...conversations.values()],
      setConversationArchived: async () => undefined,
      setConversationsPlacement: async () => undefined,
      restoreConversations: async () => undefined,
      archiveProjectIfEmpty: async () => undefined,
      archiveConversationsIf: async () => 0,
    },
    projects: plugin.projects,
    views: { getAllViews: () => [view as unknown as ChatViewHost] },
  });
  Object.defineProperty(plugin, 'conversationLifecycle', { value: lifecycle, configurable: true });
  const navigation = new SessionNavigation({ plugin, view: view as unknown as ChatViewHost, getTabManager: () => manager });
  let wide = true;
  const surface = new SessionManagerSurface({
    plugin,
    navigation: {
      getConversationStatus: id => navigation.getConversationStatus(id),
      contentExists: path => navigation.contentExists(path),
      openConversation: id => manager.openConversation(id),
      openSessionConversation: id => manager.openConversation(id),
      startLinkedContentConversation: path => manager.viewerSlot.startDraft({ linkedContentPath: path }),
      startProjectConversation: id => manager.viewerSlot.startDraft({ projectId: id }),
    },
    getActiveTab: () => manager.getActiveTab(), isWide: () => wide,
    canCreateTab: () => manager.canCreateTab(), requestNew: () => { void manager.createTab(); },
    notifyOtherViews: () => undefined,
  });
  const first = (await manager.createTab('conversation'))!;
  await waitFor(() => expect(first.hydrationState).toBe('ready'));
  first.controllers.drafts.restore('main', { content: 'Read the note' });
  const request = backend.nextRequest(() => true);
  const sending = first.controllers.inputController.sendMessage();
  await request;
  const native = backend.latest;
  const host = document.body.createDiv();
  surface.mountHistoryControl(host);
  const ui = within(host);
  try {
    // The active-mode archive action consumes real session status, not a supplied running flag.
    // Archive controls belong to the persistent sidebar; history's default action is Delete.
    const sidebar = document.body.createDiv();
    surface.mountSidebar(sidebar);
    surface.renderSidebar();
    const archive = within(sidebar).getByRole('button', { name: 'Cannot archive a running session' }) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
    expect(await axe(archive)).toHaveNoViolations();
    wide = false;
    surface.leaveWide();
    fireEvent.click(ui.getByRole('button', { name: 'Chat history' }));

    if (target === 'running') await manager.createTab('second');
    conversations.get('conversation')!.isArchived = true;
    conversations.get('third')!.isArchived = true;
    surface.invalidate();
    fireEvent.click(ui.getByRole('button', { name: (name, element) => name === 'Archive' && element.textContent === 'Archive' }));
    const rowTitle = target === 'running' ? 'Conversation' : 'third';
    const row = ui.getByText(rowTitle, { exact: true }).closest<HTMLElement>('.claudian-history-item')!;
    const deleting = vi.spyOn(lifecycle, 'delete');
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(deleting).toHaveBeenCalledWith([target === 'running' ? 'conversation' : 'third']);
    await deleting.mock.results[0].value;
    expect(deleteConversation.mock.calls).toEqual(target === 'idle' ? [['third']] : []);
    expect(native.cancelCalls).toBe(0);
  } finally {
    surface.dispose();
    native.complete();
    await sending;
    await manager.destroy();
  }
});
