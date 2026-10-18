/** @jest-environment jsdom */
import '@/providers';

import { deferred } from '@test/helpers/ChatInputHarness';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { installSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, Component, MarkdownRenderer, Menu, TFile, TFolder } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudianSettings, Conversation, ConversationMutablePatch } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { getSessionSettingsSnapshot, updateSessionProviderSettings, updateSessionReasoning } from '@/features/chat/sessions/sessionSettings';
import { activateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { t } from '@/i18n/i18n';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => { el.textContent = markdown; });
  Object.assign(HTMLElement.prototype, {
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    appendText(this: HTMLElement, text: string) { this.appendChild(this.ownerDocument.createTextNode(text)); },
    setCssProps(this: HTMLElement, props: Record<string, string>) {
      for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
    },
    toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
    scrollIntoView() {},
  });
});
afterEach(() => { globalThis.ResizeObserver = originalResizeObserver; ProviderWorkspaceRegistry.clear(); jest.restoreAllMocks(); document.body.replaceChildren(); });

function setup() {
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref() {} });
  const backend = new FakeSideBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  ProviderWorkspaceRegistry.setServices('claude', {});
  const registry = new ProviderExecutionLifecycleRegistry();
  const settings = {
    model: 'claude-sonnet-4-5', permissionMode: 'normal', effortLevel: 'high', excludedTags: [],
    providerConfigs: { claude: claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'high']) },
  } as unknown as ClaudianSettings;
  const conversation = {
    id: 'conversation', providerId: 'claude', selectedModel: settings.model, sessionId: 'native',
    title: 'Conversation', messages: [], createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  } as Conversation;
  let nativeHistory: Conversation['messages'] = [];
  const saves: ConversationMutablePatch[] = [];
  const plugin = {
    app, settings,
    providerHost: { app, settings, executionLifecycleRegistry: registry },
    getCommittedSettings: () => settings, getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => conversation, getConversationSync: () => conversation,
    getCachedConversation: () => conversation,
    getConversationById: jest.fn(async () => ({ ...conversation, messages: structuredClone(nativeHistory) })),
    getConversationList: () => [conversation], renameConversation: async () => undefined,
    findConversationAcrossViews: () => null,
    updateConversation: async (_id: string, patch: ConversationMutablePatch) => { saves.push(structuredClone(patch)); },
    mutateSettings: async (mutate: (settings: ClaudianSettings) => void) => mutate(settings),
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => undefined,
      persistExecutionSnapshot: async () => true, recordConversationActivity: async () => undefined,
    },
    projects: createProjectsFake(),
  } as unknown as ChatFeatureHost;
  const statusChanges = jest.fn();
  const pool = installSessionRuntimePool(plugin, { onChanged: statusChanges });
  const attach = async (options: { blank?: boolean; openConversation?: (id: string) => Promise<void> } = {}) => {
    const tab = await createTabRuntime({
      plugin, conversation: options.blank ? undefined : conversation, component: new Component(), containerEl: document.body.createDiv(),
      mentionDataProvider: new VaultMentionDataProvider(app), getProviderCatalogConfig: () => null,
      isRuntimeLive: () => true, openConversation: options.openConversation ?? (async () => undefined), startNewConversation: async () => undefined,
    });
    await tab.session.runtime.model.hydrate();
    activateTab(tab);
    return tab;
  };
  return { attach, pool, plugin, backend, saves, statusChanges, setNativeHistory: (messages: Conversation['messages']) => { nativeHistory = messages; } };
}

it('reattaches a held blank draft session, with its selections, to the next presentation', async () => {
  const h = setup();
  Object.assign(h.plugin.app.workspace, { getActiveFile: () => null });
  const first = await h.attach({ blank: true });
  const runtime = first.session.runtime;
  runtime.providerSelections.set('claude', { permissionMode: 'yolo', serviceTier: 'default' });
  const hold = h.pool.holdDraft(runtime);
  await destroyTab(first);
  await Promise.resolve();
  await Promise.resolve();
  expect(runtime.isDisposed).toBe(false);

  const second = await createTabRuntime({
    plugin: h.plugin, component: new Component(), containerEl: document.body.createDiv(),
    mentionDataProvider: new VaultMentionDataProvider(h.plugin.app), getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true, openConversation: async () => undefined, startNewConversation: async () => undefined,
    draftSessionKey: hold.key,
  });
  hold.release();

  expect(second.session.runtime).toBe(runtime);
  expect(runtime.providerSelections.get('claude')?.permissionMode).toBe('yolo');
  await destroyTab(second);
});

it('continues a requested response with no tab, then restores a pending approval and open response', async () => {
  const h = setup();
  const first = await h.attach();
  first.controllers.drafts.restore('main', { content: 'Read the note' });
  const sending = first.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const native = h.backend.latest;
  native.emitText('Before detach.');
  await waitFor(() => expect(first.state.currentTextContent).toBe('Before detach.'));
  await destroyTab(first);
  native.emitText(' While detached.');
  const approval = native.config.interactionPort.requestApproval({
    interactionId: 'approval', sessionInstanceId: native.sessionInstanceId, turnId: native.activeTurnId,
    kind: 'approval', toolName: 'Read', input: {}, description: 'Read note',
  }, new AbortController().signal);
  void approval.catch(() => undefined);
  await waitFor(() => expect(h.pool.get('conversation')?.statusAttention?.kind).toBe('action-required'));
  expect(native.cancelCalls).toBe(0);
  const second = await h.attach();
  expect(second.session.runtime).toBe(first.session.runtime);
  await waitFor(() => expect(second.dom.messagesEl.textContent).toContain('Before detach. While detached.'));
  fireEvent.click(within(second.dom.contentEl).getByRole('button', { name: 'Allow once' }));
  await expect(approval).resolves.toMatchObject({ decision: 'allow' });
  native.emitText(' After reattach.');
  native.complete();
  await sending;
  expect(second.state.messages.at(-1)?.contentBlocks).toEqual([
    { type: 'text', content: 'Before detach. While detached. After reattach.' },
  ]);
  expect(h.saves.at(-1)?.messages?.at(-1)?.contentBlocks).toEqual(second.state.messages.at(-1)?.contentBlocks);
  expect(native.cancelCalls).toBe(0);
  await destroyTab(second);
});

it('opens a reattached conversation at its latest message after rendering it in a hidden presentation', async () => {
  // Browser geometry: a transcript inside a hidden tab has no box and ignores scroll writes.
  const scrollTops = new WeakMap<Element, number>();
  const isLaidOut = (el: Element) => !el.closest('.claudian-hidden');
  jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return isLaidOut(this) ? 400 : 0;
  });
  jest.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return isLaidOut(this) ? 2000 : 0;
  });
  jest.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return scrollTops.get(this) ?? 0;
  });
  jest.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    if (isLaidOut(this)) scrollTops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
  });
  const resizeCallbacks: Array<() => void> = [];
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() { resizeCallbacks.push(() => this.callback([], this as unknown as ResizeObserver)); }
    unobserve() {}
    disconnect() {}
  };
  const h = setup();
  h.setNativeHistory([{ id: 'native-history', role: 'assistant', content: 'Latest answer', timestamp: testDate().getTime() }]);
  const first = await h.attach();
  await destroyTab(first);

  // Rebinding renders the pooled transcript before activation reveals its tab.
  const second = await h.attach();
  expect(second.session.runtime).toBe(first.session.runtime);
  expect(second.dom.messagesEl.textContent).toContain('Latest answer');
  resizeCallbacks.forEach(notify => notify());

  const { scrollTop, scrollHeight, clientHeight } = second.dom.messagesEl;
  expect(scrollTop).toBe(scrollHeight - clientHeight);
  await destroyTab(second);
});

it('lists every prompt of a long transcript in the directory, including prompts not rendered yet', async () => {
  const h = setup();
  const start = testDate().getTime();
  h.setNativeHistory(Array.from({ length: 30 }, (_, index) => [
    { id: `u${index}`, role: 'user' as const, content: `Prompt ${index}`, timestamp: start + index },
    { id: `a${index}`, role: 'assistant' as const, content: `Answer ${index}`, timestamp: start + index, durationSeconds: 1 },
  ]).flat());
  const tab = await h.attach();
  const view = within(tab.dom.messagesWrapperEl);
  expect(view.getByRole('button', { name: 'Show earlier messages' })).toBeTruthy();

  fireEvent.click(view.getByRole('button', { name: 'Conversation directory' }));
  const entries = view.getAllByRole('button').filter(button => button.classList.contains('claudian-nav-toc-item'));
  expect(entries.map(entry => entry.textContent)).toEqual(Array.from({ length: 30 }, (_, index) => `${index + 1}. Prompt ${index}`));
  expect(view.getByRole('button', { name: 'Show earlier messages' })).toBeTruthy();
  expect(within(tab.dom.messagesEl).queryByText('Prompt 0')).toBeNull();
  tab.dom.messagesEl.scrollTo = jest.fn();
  fireEvent.click(entries[0]);
  expect(within(tab.dom.messagesEl).getByText('Prompt 0')).toBeTruthy();
  expect(view.queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
  await destroyTab(tab);
});

it('hydrates an evicted model for a late native notification without replacing the provider binding', async () => {
  const h = setup();
  const first = await h.attach();
  await first.session.runtime.model.ensureExecutionInitialized();
  const runtime = first.session.runtime;
  const native = h.backend.latest;
  h.setNativeHistory([{ id: 'native-history', role: 'assistant', content: 'Native history', timestamp: testDate().getTime() }]);
  await destroyTab(first);
  await waitFor(() => expect(runtime.peekModel).toBeNull());
  // An unmodified transcript is released without rewriting its record.
  expect(h.saves).toEqual([]);
  native.establishChild('new-native-id', { cursor: 'new-cursor' });
  native.emitSessionEvent({ type: 'task_notification', content: 'Late result' });
  await waitFor(() => expect(h.saves.some(patch => patch.messages?.some(message => message.contentBlocks?.some(block => block.type === 'task_notification' && block.content === 'Late result')))).toBe(true));
  const saved = h.saves.find(patch => patch.messages?.some(message => message.contentBlocks?.some(block => block.type === 'task_notification' && block.content === 'Late result')))!;
  expect(saved.messages?.[0].content).toBe('Native history');
  expect(native.disposeCalls).toBe(0);
  expect(h.backend.sessions).toHaveLength(1);
  await waitFor(() => expect(runtime.peekModel).toBeNull());
});


it('keeps a detached parent while its side chat is still resolving the source', async () => {
  const h = setup();
  const first = await h.attach();
  first.state.messages = [
    { id: 'user', role: 'user', content: 'Parent task', timestamp: testDate().getTime() },
    { id: 'answer', role: 'assistant', content: 'Parent answer', assistantMessageId: 'checkpoint', timestamp: testDate().getTime() },
  ];
  const history = ProviderRegistry.getConversationHistoryService('claude');
  const resolving = deferred<void>();
  const coordinator = first.executionCoordinator;
  const resolve = coordinator.resolveForkSource.bind(coordinator);
  const resolveSource = jest.spyOn(coordinator, 'resolveForkSource').mockImplementation(async (...args) => {
    const source = await resolve(...args);
    await resolving.promise;
    return source;
  });
  jest.spyOn(history, 'buildForkProviderState').mockResolvedValue({});
  const starting = first.controllers.sideChatController.handleCommandSubmission('Explain the answer', []);
  await waitFor(() => expect(resolveSource).toHaveBeenCalled());
  await destroyTab(first);
  try {
    expect(h.pool.isRunning('conversation')).toBe(true);
    expect(first.session.runtime.peekModel).not.toBeNull();
  } finally { resolving.resolve(); }
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  h.backend.latest.emitText('Child output after detach');
  h.backend.latest.complete();
  await expect(starting).resolves.toBe(true);
  await waitFor(() => expect(first.session.runtime.peekModel).toBeNull());
  const second = await h.attach();
  await waitFor(() => expect(second.dom.contentEl.textContent).toContain('Child output after detach'));
  expect(second.controllers.sideChatController.runtime).toBe(first.controllers.sideChatController.runtime);
  const resumed = second.controllers.sideChatController.runtime!.submit({ content: 'Continue the child' });
  await waitFor(() => expect(h.backend.latest.requests).toHaveLength(2));
  expect(h.backend.latest.requests[1].conversationHistory?.[0].content).toBe('Parent task');
  h.backend.latest.emitText('Child resumed after parent eviction');
  h.backend.latest.complete();
  await resumed;
  await waitFor(() => expect(second.dom.contentEl.textContent).toContain('Child resumed after parent eviction'));
  await destroyTab(second);
});

it('lists Linked content choices from the attached view\'s cached vault index', async () => {
  const h = setup();
  const vault = h.plugin.app.vault as unknown as Record<string, unknown>;
  const note = Object.assign(new TFile(), { path: 'Notes/Plan.md', name: 'Plan.md', basename: 'Plan', extension: 'md' });
  const folder = Object.assign(new TFolder(), { path: 'Notes', name: 'Notes' });
  const getFiles = jest.fn(() => [note]);
  const getAllLoadedFiles = jest.fn(() => [folder, note]);
  Object.assign(vault, { getFiles, getAllLoadedFiles });
  Object.assign(h.plugin.app.workspace, { getActiveFile: () => null });
  const tab = await h.attach({ blank: true });
  const selector = within(tab.dom.messagesEl).getByRole('button', { name: 'None' });
  for (const query of ['plan', 'notes']) {
    fireEvent.click(selector);
    const search = within(tab.dom.messagesEl).getByRole('textbox', { name: 'Linked content:' });
    fireEvent.input(search, { target: { value: query } });
    expect(within(tab.dom.messagesEl).getByRole('option', { name: query === 'plan' ? /^Plan\./ : /^Notes\./ })).toBeTruthy();
    fireEvent.click(selector);
  }
  // Repeated picker openings reuse the view's index until a vault change invalidates it.
  expect(getFiles).toHaveBeenCalledTimes(1);
  expect(getAllLoadedFiles).toHaveBeenCalledTimes(1);
  await destroyTab(tab);
});

it('retains failed queued reference preparation as session recovery after its tab closes', async () => {
  const h = setup();
  const first = await h.attach();
  first.controllers.drafts.restore('main', { content: 'First request' });
  const sending = first.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const reference = deferred<Conversation | null>();
  jest.mocked(h.plugin.getConversationById).mockImplementationOnce(() => reference.promise);
  const original = '@[Reference](claudian-session:conv-1-source)';
  first.controllers.drafts.restore('main', { content: original });
  const preparing = first.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.plugin.getConversationById).toHaveBeenCalledWith('conv-1-source'));
  await destroyTab(first);
  h.backend.latest.complete();
  await sending;
  expect(first.session.runtime.peekModel).not.toBeNull();
  try { expect(h.pool.isRunning('conversation')).toBe(true); }
  finally { reference.resolve(null); }
  await preparing;
  expect(first.session.runtime.model.composer.hasRecovery).toBe(true);
  expect(h.pool.isRunning('conversation')).toBe(false);
  expect(h.backend.latest.requests).toHaveLength(1);
  const second = await h.attach();
  expect(second.controllers.drafts.capture('main').content).toBe(original);
  expect(second.session.runtime.model.composer.hasRecovery).toBe(false);
  expect(h.backend.latest.cancelCalls).toBe(0);
  await destroyTab(second);
});

it('preserves raw drafts when multiple reference preparations recover after detachment', async () => {
  const h = setup();
  const first = await h.attach();
  first.controllers.drafts.restore('main', { content: 'First request' });
  const sending = first.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const reference = deferred<Conversation | null>();
  jest.mocked(h.plugin.getConversationById)
    .mockImplementationOnce(() => reference.promise)
    .mockResolvedValueOnce(null);
  const firstDraft = '    keepIndented()\n\n@[First](claudian-session:conv-1-source)  \n';
  first.controllers.drafts.restore('main', { content: firstDraft });
  const preparingFirst = first.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.plugin.getConversationById).toHaveBeenCalledWith('conv-1-source'));
  const secondDraft = '@[Second](claudian-session:conv-2-source)';
  first.controllers.drafts.restore('main', { content: secondDraft });
  const preparingSecond = first.controllers.inputController.sendMessage();
  await destroyTab(first);
  h.backend.latest.complete();
  await sending;
  reference.resolve(null);
  await Promise.all([preparingFirst, preparingSecond]);

  expect(first.session.runtime.model.composer.hasRecovery).toBe(true);
  const second = await h.attach();
  expect(second.controllers.drafts.capture('main').content).toBe(`${secondDraft}\n\n${firstDraft}`);
  expect(h.backend.latest.requests).toHaveLength(1);
  expect(second.session.runtime.model.composer.hasRecovery).toBe(false);
  await destroyTab(second);
});

it('fences a detached side queue synchronously before the plugin shutdown drain', async () => {
  const h = setup();
  const first = await h.attach();
  first.state.messages = [
    { id: 'user', role: 'user', content: 'Parent task', timestamp: testDate().getTime() },
    { id: 'answer', role: 'assistant', content: 'Parent answer', assistantMessageId: 'checkpoint', timestamp: testDate().getTime() },
  ];
  jest.spyOn(ProviderRegistry.getConversationHistoryService('claude'), 'buildForkProviderState').mockResolvedValue({});
  const sending = first.controllers.sideChatController.handleCommandSubmission('First child request', []);
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const child = first.controllers.sideChatController.runtime!;
  expect(child.enqueue({ content: 'Queued child request' })).toBe(true);
  await destroyTab(first);
  h.pool.beginShutdown();
  const native = h.backend.latest;
  native.complete();
  try {
    await waitFor(() => expect(child.isWorking && native.requests.length === 1).toBe(false));
    expect(native.requests).toHaveLength(1);
    expect(child.enqueue({ content: 'Too late' })).toBe(false);
  } finally {
    native.complete();
    await sending;
    await h.pool.dispose();
  }
});

it('does not save a deleted conversation still attached when the plugin shuts down', async () => {
  const h = setup();
  const tab = await h.attach();
  tab.state.messages = [{ id: 'unsaved', role: 'user', content: 'Unsaved message', timestamp: testDate().getTime() }];
  await h.pool.retire('conversation');
  expect(h.pool.get('conversation')).toBe(tab.session.runtime);

  await h.pool.dispose();

  expect(h.saves).toEqual([]);
  expect(h.pool.get('conversation')).toBeNull();
  await destroyTab(tab);
});

it('joins a first-turn title request admitted while the plugin shutdown drain begins', async () => {
  const h = setup();
  Object.assign(h.plugin.settings, { enableAutoTitleGeneration: true, titleGenerationModel: 'claude-sonnet-4-5' });
  const fallbackTitleWritten = deferred<void>();
  const rename = jest.spyOn(h.plugin, 'renameConversation').mockImplementation(() => fallbackTitleWritten.promise);
  const tab = await h.attach();
  tab.controllers.drafts.restore('main', { content: 'First turn' });
  const sending = tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(rename).toHaveBeenCalled());
  const disposing = h.pool.dispose();
  fallbackTitleWritten.resolve();
  try {
    await disposing;
    const titleSession = h.backend.sessions.find(session => session.config.lifecycle === 'ephemeral');
    expect(titleSession).toBeDefined();
    expect(titleSession?.getStatus()).not.toBe('executing');
  } finally {
    await sending;
    await h.plugin.providerHost.executionLifecycleRegistry.dispose();
  }
});

it('keeps a detached queued continuation running between provider requests', async () => {
  const h = setup();
  const first = await h.attach();
  first.controllers.drafts.restore('main', { content: 'First request' });
  const sending = first.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  first.controllers.drafts.restore('main', { content: 'Follow-up' });
  await first.controllers.inputController.sendMessage();
  await destroyTab(first);
  h.backend.latest.complete();
  await sending;
  expect(h.backend.latest.requests).toHaveLength(1);
  expect(h.pool.isRunning('conversation')).toBe(true);
  await waitFor(() => expect(h.backend.latest.requests).toHaveLength(2));
  h.backend.latest.complete();
  await first.session.runtime.turns.drain();
  await waitFor(() => expect(first.session.runtime.peekModel).toBeNull());
  expect(h.pool.isRunning('conversation')).toBe(false);
});

it.each([false, true])('keeps completed detached work unread until its transcript is visibly attached (reference: %s)', async hasReference => {
  const h = setup();
  const first = await h.attach();
  if (hasReference) {
    jest.mocked(h.plugin.getConversationById).mockResolvedValueOnce({
      ...h.plugin.getConversationSummary('conversation'), id: 'conv-1-source',
      messages: [{ id: 'reference', role: 'user', content: 'Reference text', timestamp: testDate().getTime() }],
    } as Conversation);
  }
  first.controllers.drafts.restore('main', { content: hasReference ? 'Read @[Reference](claudian-session:conv-1-source)' : 'Read later' });
  const sending = first.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const runtime = first.session.runtime;
  await destroyTab(first);
  h.backend.latest.emitText('Completed while detached');
  h.backend.latest.complete();
  await sending;
  await waitFor(() => expect(runtime.peekModel).toBeNull());
  expect(runtime.statusAttention).toMatchObject({ kind: 'review', outcome: 'completed' });
  const second = await h.attach();
  runtime.model.acknowledgeReviewIfVisible();
  expect(runtime.statusAttention?.kind).toBe('review');
  jest.spyOn(second.dom.messagesEl, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  runtime.model.acknowledgeReviewIfVisible();
  expect(runtime.statusAttention?.kind).toBe('review');
  visibility.mockReturnValue('visible');
  runtime.model.acknowledgeReviewIfVisible();
  expect(runtime.statusAttention).toBeNull();
  await destroyTab(second);
});

const hasBlock = (patch: ConversationMutablePatch | undefined, content: string) => !!patch?.messages?.some(message => message.contentBlocks?.some(block => 'content' in block && block.content === content));

it('persists a detached transcript whose background save failed before releasing it', async () => {
  const h = setup();
  const first = await h.attach();
  await first.session.runtime.model.ensureExecutionInitialized();
  const runtime = first.session.runtime;
  const update = jest.spyOn(h.plugin, 'updateConversation').mockRejectedValueOnce(new Error('Disk full'));
  h.backend.latest.emitSessionEvent({ type: 'task_notification', content: 'Unsaved result' });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(h.saves).toEqual([]);
  await destroyTab(first);
  await waitFor(() => expect(runtime.peekModel).toBeNull());
  expect(hasBlock(h.saves.at(-1), 'Unsaved result')).toBe(true);
});

it('publishes session status only when its list projection changes', async () => {
  const h = setup();
  const tab = await h.attach();
  tab.controllers.drafts.restore('main', { content: 'Stream a reply' });
  const sending = tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  expect(h.pool.isRunning('conversation')).toBe(true);
  const native = h.backend.latest;
  native.emitText('First chunk.');
  await waitFor(() => expect(tab.state.currentTextContent).toBe('First chunk.'));
  h.statusChanges.mockClear();
  native.emitText(' Second chunk.');
  native.emitOutput({ type: 'usage', usage: { inputTokens: 10, contextWindow: 1000, contextTokens: 10, percentage: 1 } } as never);
  await waitFor(() => expect(tab.state.currentTextContent).toBe('First chunk. Second chunk.'));
  tab.state.autoScrollEnabled = !tab.state.autoScrollEnabled;
  expect(h.statusChanges).not.toHaveBeenCalled();
  native.complete();
  await sending;
  expect(h.pool.isRunning('conversation')).toBe(false);
  expect(h.statusChanges).toHaveBeenCalled();
  await destroyTab(tab);
});

it('keeps a newer composer draft when first conversation creation fails', async () => {
  const h = setup();
  const creating = deferred<Conversation>();
  Object.assign(h.plugin, { createConversation: jest.fn(() => creating.promise) });
  Object.assign(h.plugin.app.workspace, { getActiveFile: () => null });
  const tab = await h.attach({ blank: true });
  tab.controllers.drafts.restore('main', { content: 'First request' });
  const sending = tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.plugin.createConversation).toHaveBeenCalled());
  const newerDraft = '    followUp()\n';
  const newerImage = { id: 'new-image', name: 'next.png', mediaType: 'image/png' as const,
    data: 'bmV4dA==', size: 4, source: 'paste' as const };
  tab.controllers.drafts.restore('main', { content: newerDraft, images: [newerImage] });
  creating.reject(new Error('Disk full'));
  await Promise.allSettled([sending]);

  expect(tab.controllers.drafts.capture('main')).toEqual({
    content: `First request\n\n${newerDraft}`, images: [newerImage],
  });
  expect(tab.state.messages).toEqual([]);
  expect(tab.state.currentConversationId).toBeNull();
  expect(h.backend.sessions.flatMap(session => session.requests)).toEqual([]);
  await destroyTab(tab);
});

it('releases a closed blank tab whose conversation creation failed with no presentation to recover into', async () => {
  const h = setup();
  const creating = deferred<Conversation>();
  Object.assign(h.plugin, { createConversation: jest.fn(() => creating.promise) });
  Object.assign(h.plugin.app.workspace, { getActiveFile: () => null });
  const tab = await h.attach({ blank: true });
  const runtime = tab.session.runtime;
  tab.controllers.drafts.restore('main', { content: 'First draft' });
  const sending = tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.plugin.createConversation).toHaveBeenCalled());
  const closing = destroyTab(tab);
  creating.reject(new Error('Disk full'));
  await Promise.allSettled([sending, closing]);
  await waitFor(() => expect(runtime.isDisposed).toBe(true));
  expect(h.pool.getAll()).not.toContain(runtime);
  expect(h.backend.sessions.flatMap(session => session.requests)).toEqual([]);
});

describe('composer project chip', () => {
  const launch = projectRecord({ id: 'launch', name: 'Launch' });
  const chipName = 'Project: Launch';

  function projectSetup() {
    const h = setup();
    const projects = createProjectsFake([launch]);
    Object.assign(h.plugin.app.workspace, { getActiveFile: () => null });
    const created = h.plugin.getConversationSummary('conversation') as Conversation;
    // The record keeps whatever project the first-turn creation asked for.
    const createConversation = jest.fn(async (options: { projectId?: string } = {}) => {
      Object.assign(created, { messages: [] }, options.projectId ? { projectId: options.projectId } : {});
      return created;
    });
    Object.assign(h.plugin, { projects, createConversation });
    return { h, projects, created, createConversation };
  }

  async function sendFirst(tab: Awaited<ReturnType<ReturnType<typeof setup>['attach']>>, h: ReturnType<typeof setup>) {
    tab.controllers.drafts.restore('main', { content: 'First prompt' });
    const sending = tab.controllers.inputController.sendMessage();
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    h.backend.latest.complete();
    await sending;
  }

  it('follows the draft seed, then membership, until the project is deleted', async () => {
    const { h, projects, created } = projectSetup();
    const tab = await h.attach({ blank: true });
    const row = within(tab.dom.infoRowEl);
    expect(row.queryByRole('button', { name: chipName })).toBeNull();

    tab.controllers.conversationController.seedDraftProject(launch.id);
    expect(row.getByRole('button', { name: chipName }).getAttribute('type')).toBe('button');
    expect((await axe(tab.dom.infoRowEl)).violations).toEqual([]);

    await sendFirst(tab, h);
    expect(created.projectId).toBe(launch.id);
    // Once the session starts, the chip is a fixed label rather than a selector.
    const fixedChip = row.getByRole('button', { name: chipName }) as HTMLButtonElement;
    expect([fixedChip.disabled, fixedChip.hasAttribute('aria-haspopup')]).toEqual([true, false]);

    // Project deletion reaches each composer through the view's list-change fan-out.
    projects.remove(launch.id);
    tab.composer.refreshProject();
    expect(row.queryByRole('button', { name: chipName })).toBeNull();
    await destroyTab(tab);
  });

  type MenuEntry = { title: string; checked: boolean | null; clickHandler: (() => void) | null };
  type MockMenu = { items: MenuEntry[]; showAtPosition: jest.Mock };
  const menus = () => (Menu as unknown as { instances: MockMenu[] }).instances;
  afterEach(() => { menus().length = 0; });

  function openChipMenu(row: ReturnType<typeof within>, name = chipName): MockMenu {
    const before = menus().length;
    const chip = row.getByRole('button', { name });
    expect(chip.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(chip);
    expect(menus()).toHaveLength(before + 1);
    const menu = menus().at(-1)!;
    expect(menu.showAtPosition).toHaveBeenCalledTimes(1);
    return menu;
  }

  function choose(menu: MockMenu, title: string): void {
    menu.items.find(item => item.title === title)!.clickHandler!();
  }

  it('shows no chip for a draft outside any project, including after choosing No project', async () => {
    const { h } = projectSetup();
    const tab = await h.attach({ blank: true });
    const row = within(tab.dom.infoRowEl);
    expect(tab.dom.infoRowEl.isConnected).toBe(true);
    expect(row.queryByRole('button', { name: /^Project:/ })).toBeNull();

    tab.controllers.conversationController.seedDraftProject(launch.id);
    choose(openChipMenu(row), t('chat.projects.noProject'));
    expect(row.queryByRole('button', { name: /^Project:/ })).toBeNull();
    await destroyTab(tab);
  });

  it('lists live projects pinned first with the current one checked, then No project', async () => {
    const { h, projects } = projectSetup();
    projects.put(projectRecord({ id: 'ops', name: 'Ops', isPinned: true }));
    projects.put(projectRecord({ id: 'alpha', name: 'Alpha' }));
    const tab = await h.attach({ blank: true });
    tab.controllers.conversationController.seedDraftProject(launch.id);
    const row = within(tab.dom.infoRowEl);

    const menu = openChipMenu(row);
    expect(menu.items.map(item => [item.title, item.checked === true])).toEqual([
      ['Ops', false], ['Alpha', false], ['Launch', true], [t('chat.projects.noProject'), false],
    ]);
    expect(row.queryByRole('button', { name: `Remove ${chipName}` })).toBeNull();
    expect((await axe(tab.dom.infoRowEl)).violations).toEqual([]);
    await destroyTab(tab);
  });

  it.each([
    ['switches', 'ops'],
    ['drops', undefined],
  ])('%s the draft seed from the chip menu for the first input\'s creation', async (_case, projectId) => {
    const { h, projects, created, createConversation } = projectSetup();
    projects.put(projectRecord({ id: 'ops', name: 'Ops' }));
    const tab = await h.attach({ blank: true });
    tab.controllers.conversationController.seedDraftProject(launch.id);
    const row = within(tab.dom.infoRowEl);

    choose(openChipMenu(row), projectId ? 'Ops' : t('chat.projects.noProject'));
    expect(tab.controllers.conversationController.project).toEqual({ projectId, isDraft: true, changeable: true });
    expect(row.queryByRole('button', { name: /^Project:/ })?.getAttribute('aria-label')).toBe(
      projectId ? 'Project: Ops' : undefined,
    );

    await sendFirst(tab, h);
    expect(createConversation.mock.calls[0]?.[0]?.projectId).toBe(projectId);
    expect(created.projectId).toBe(projectId);
    await destroyTab(tab);
  });

  it('shows a started session\'s project as a fixed chip, and none outside a project', async () => {
    const { h, created } = projectSetup();
    Object.assign(created, { projectId: launch.id });
    const tab = await h.attach();
    const row = within(tab.dom.infoRowEl);

    // Membership is the conversation's: the draft seed cannot be written once a conversation is bound.
    expect(() => tab.controllers.conversationController.seedDraftProject(null)).toThrow();
    const chip = row.getByRole('button', { name: chipName }) as HTMLButtonElement;
    expect([chip.disabled, chip.hasAttribute('aria-haspopup')]).toEqual([true, false]);
    const menuCount = menus().length;
    fireEvent.click(chip);
    expect(menus()).toHaveLength(menuCount);

    Object.assign(created, { projectId: undefined });
    tab.composer.refreshProject();
    expect(row.queryByRole('button', { name: /^Project:/ })).toBeNull();
    await destroyTab(tab);
  });

  it('freezes the seed while first-turn creation is pending and releases it when creation fails', async () => {
    const { h, createConversation } = projectSetup();
    const creating = deferred<Conversation>();
    createConversation.mockImplementationOnce(() => creating.promise);
    const tab = await h.attach({ blank: true });
    const { conversationController } = tab.controllers;
    conversationController.seedDraftProject(launch.id);
    const row = within(tab.dom.infoRowEl);
    expect((row.getByRole('button', { name: chipName }) as HTMLButtonElement).disabled).toBe(false);
    // A menu opened before the first input resolves its choice when chosen, after the freeze.
    const staleMenu = openChipMenu(row);

    tab.controllers.drafts.restore('main', { content: 'First prompt' });
    const sending = tab.controllers.inputController.sendMessage();
    await waitFor(() => expect(createConversation).toHaveBeenCalledWith(expect.objectContaining({ projectId: launch.id })));

    // The captured seed is what creation uses, so the chip offers no menu to change it.
    const frozenChip = row.getByRole('button', { name: chipName }) as HTMLButtonElement;
    expect(frozenChip.disabled).toBe(true);
    const menuCount = menus().length;
    fireEvent.click(frozenChip);
    expect(menus()).toHaveLength(menuCount);
    expect(() => conversationController.seedDraftProject(null)).toThrow();
    choose(staleMenu, t('chat.projects.noProject'));
    expect(conversationController.project).toEqual({ projectId: launch.id, isDraft: true, changeable: false });

    creating.reject(new Error('Disk full'));
    await sending.catch(() => undefined);

    choose(openChipMenu(row), t('chat.projects.noProject'));
    expect(row.queryByRole('button', { name: chipName })).toBeNull();
    expect(conversationController.project).toEqual({ projectId: undefined, isDraft: true, changeable: true });
    await destroyTab(tab);
  });

  it('shows a held seeded draft\'s project as soon as the next presentation attaches', async () => {
    const { h } = projectSetup();
    const first = await h.attach({ blank: true });
    first.controllers.conversationController.seedDraftProject(launch.id);
    const hold = h.pool.holdDraft(first.session.runtime);
    await destroyTab(first);

    const second = await createTabRuntime({
      plugin: h.plugin, component: new Component(), containerEl: document.body.createDiv(),
      mentionDataProvider: new VaultMentionDataProvider(h.plugin.app), getProviderCatalogConfig: () => null,
      isRuntimeLive: () => true, openConversation: async () => undefined, startNewConversation: async () => undefined,
      draftSessionKey: hold.key,
    });
    hold.release();

    expect(second.session.runtime).toBe(first.session.runtime);
    expect(within(second.dom.infoRowEl).getByRole('button', { name: chipName })).toBeTruthy();
    await destroyTab(second);
  });
});

function branchHistory(): Conversation['messages'] {
  const now = testDate().getTime();
  return [
    { id: 'u1', role: 'user', content: 'First prompt', userMessageId: 'native-u1', timestamp: now },
    { id: 'a1', role: 'assistant', content: 'First answer', assistantMessageId: 'native-a1', timestamp: now },
    { id: 'u2', role: 'user', content: 'Second prompt', userMessageId: 'native-u2', timestamp: now },
    { id: 'a2', role: 'assistant', content: 'Second answer', assistantMessageId: 'native-a2', timestamp: now },
  ];
}

it('leaves a branch preview when its presentation detaches from a retained model', async () => {
  const h = setup();
  h.setNativeHistory(branchHistory());
  const first = await h.attach();
  await first.controllers.conversationController.navigateBranch('u2');
  expect(first.controllers.drafts.capture('main').content).toBe('Second prompt');
  expect(first.dom.messagesEl.textContent).not.toContain('Second answer');
  // A save in flight retains the detached model across the rebind.
  const held = deferred<void>();
  jest.spyOn(h.plugin, 'updateConversation').mockImplementationOnce(() => held.promise);
  const saving = first.controllers.conversationController.save();
  const model = first.session.runtime.model;
  await destroyTab(first);
  // The departing presentation is not rendered again; reattachment renders the full transcript.
  expect(first.dom.messagesEl.textContent).not.toContain('Second answer');
  const second = await h.attach();
  expect(second.session.runtime.peekModel).toBe(model);
  held.resolve();
  await saving;
  expect(second.dom.messagesEl.textContent).toContain('Second answer');
  second.controllers.drafts.restore('main', { content: 'Continue normally' });
  const sending = second.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.latest?.requests).toHaveLength(1));
  h.backend.latest.complete();
  await sending;
  expect(second.state.messages.filter(message => message.role === 'user').map(message => message.content))
    .toEqual(['First prompt', 'Second prompt', 'Continue normally']);
  await destroyTab(second);
});

it('retains a detached model until its uncertain branch navigation is reconciled', async () => {
  const h = setup();
  h.setNativeHistory(branchHistory());
  const first = await h.attach();
  const coordinator = first.executionCoordinator;
  const uncertain = { status: 'recovery-required' as const, error: 'Branch state is uncertain' };
  jest.spyOn(coordinator, 'navigateConversationBranch').mockResolvedValue(uncertain);
  const reconcile = jest.spyOn(coordinator, 'reconcileConversationBranch').mockResolvedValue(uncertain);
  await first.controllers.conversationController.navigateBranch('u2', 'native-sibling');
  expect(reconcile).toHaveBeenCalledTimes(1);
  await destroyTab(first);
  // Give a premature eviction every chance to run before the session is reattached.
  for (let tick = 0; tick < 10; tick++) await new Promise(resolve => setTimeout(resolve, 0));
  const second = await h.attach();
  reconcile.mockImplementation(async () => ({ status: 'committed', messages: second.state.messages }));
  second.controllers.drafts.restore('main', { content: 'After recovery' });
  const sending = second.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.latest?.requests).toHaveLength(1));
  expect(reconcile).toHaveBeenCalledTimes(2);
  h.backend.latest.complete();
  await sending;
  await destroyTab(second);
});

it('holds mailbox delivery behind a branch preview and wakes when the full transcript returns', async () => {
  const h = setup();
  h.setNativeHistory(branchHistory());
  const tab = await h.attach();
  await tab.controllers.conversationController.navigateBranch('u2');
  expect(tab.controllers.conversationController.hasBranchDraft).toBe(true);
  expect(tab.dom.messagesEl.textContent).not.toContain('Second answer');
  const runtime = tab.session.runtime;
  expect(await runtime.mailbox!.deliver({ message: { from: 'Sender', sessionId: 'sender', text: 'New incoming task' }, signal: new AbortController().signal })).toBe('queued');
  expect(h.backend.sessions.flatMap(session => session.requests)).toHaveLength(0);
  expect(tab.controllers.drafts.capture('main').content).toBe('Second prompt');
  tab.controllers.conversationController.cancelBranchDraft();
  expect(tab.dom.messagesEl.textContent).toContain('Second answer');
  await waitFor(() => expect(h.backend.latest?.requests).toHaveLength(1));
  expect(h.backend.latest.requests[0].conversationHistory?.map(message => message.content))
    .toEqual(['First prompt', 'First answer', 'Second prompt', 'Second answer']);
  h.backend.latest.complete();
  await runtime.turns.drain();
  await destroyTab(tab);
});

it('rematches an open mention after editing queued input back into the composer', async () => {
  const h = setup();
  const at = testDate().getTime();
  const note = Object.assign(new TFile(), {
    path: 'Notes/Plan.md', name: 'Plan.md', basename: 'Plan', extension: 'md',
    stat: { ctime: at, mtime: at, size: 1 },
  });
  Object.assign(h.plugin.app.vault, { getFiles: () => [note], getAllLoadedFiles: () => [note] });
  const tab = await h.attach();
  tab.controllers.drafts.restore('main', { content: 'First request' });
  const sending = tab.controllers.inputController.sendMessage();
  try {
    await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
    tab.controllers.drafts.restore('main', { content: 'Queued request' });
    await tab.controllers.inputController.sendMessage();
    tab.dom.inputEl.value = '@Plan';
    fireEvent.input(tab.dom.inputEl);
    await waitFor(() => expect(tab.ui.composerDropdown.isVisible()).toBe(true));
    expect(within(tab.dom.inputContainerEl).getByRole('option', { name: /Plan/ })).toBeDefined();

    fireEvent.click(within(tab.dom.inputComposerEl).getByRole('button', { name: 'Edit queued message' }));
    expect(tab.dom.inputEl.value).toBe('Queued request\n\n@Plan');
    expect(tab.controllers.inputController.queue.message).toBeNull();
    fireEvent.click(within(tab.dom.inputContainerEl).getByRole('option', { name: /Plan/ }));

    await waitFor(() => expect(tab.dom.inputEl.value).toBe('Queued request\n\n[[Notes/Plan.md|Plan]] '));
    expect(h.backend.latest.requests).toHaveLength(1);
    const textbox = within(tab.dom.inputEl).getByRole('textbox', { name: 'Message' });
    expect(tab.dom.inputEl.contains(document.activeElement)).toBe(true);
    expect(await axe(textbox, { runOnly: ['label', 'aria-valid-attr-value'] })).toHaveNoViolations();
  } finally {
    h.backend.latest.complete();
    await sending;
    await destroyTab(tab);
    await h.pool.dispose();
  }
});

it('copies the parent session selections into a new side chat after another session changes preferences', async () => {
  const h = setup();
  const tab = await h.attach();
  const runtime = tab.session.runtime;
  tab.state.messages = [
    { id: 'parent-user', role: 'user', content: 'Parent task', timestamp: testDate().getTime() },
    { id: 'parent-answer', role: 'assistant', content: 'Parent answer', assistantMessageId: 'checkpoint', timestamp: testDate().getTime() },
  ];
  await updateSessionProviderSettings(runtime, h.plugin, settings => {
    settings.permissionMode = 'manual'; settings.serviceTier = 'fast';
  });
  await updateSessionReasoning(runtime, h.plugin, 'low');
  const other = h.pool.ensure({ conversationId: 'other-conversation', providerId: 'claude', draftModel: null });
  await updateSessionProviderSettings(other, h.plugin, settings => {
    settings.permissionMode = 'yolo'; settings.serviceTier = 'default';
  });
  await updateSessionReasoning(other, h.plugin, 'high');
  expect(getSessionSettingsSnapshot(runtime, h.plugin)).toMatchObject({
    permissionMode: 'manual', reasoning: 'low', serviceTier: 'fast',
  });
  jest.spyOn(ProviderRegistry.getConversationHistoryService('claude'), 'buildForkProviderState').mockResolvedValue({});
  const sending = tab.controllers.sideChatController.handleCommandSubmission('Explore independently', []);
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  const configuration = h.backend.latest.requests[0].configuration;
  h.backend.latest.complete();
  await sending;
  expect(configuration).toMatchObject({ permissionMode: 'manual', reasoning: 'low', serviceTier: 'fast' });
  expect(getChatSettingsSnapshot(h.plugin.settings, 'claude', 'claude-sonnet-4-5')).toMatchObject({
    permissionMode: 'yolo', reasoning: 'high', serviceTier: 'default',
  });
  await updateSessionProviderSettings(runtime, h.plugin, settings => {
    settings.permissionMode = 'normal'; settings.serviceTier = 'default';
  });
  await updateSessionReasoning(runtime, h.plugin, 'high');
  const followUp = tab.controllers.sideChatController.submitToSide('Continue the child', []);
  await waitFor(() => expect(h.backend.latest.requests).toHaveLength(2));
  h.backend.latest.complete();
  await followUp;
  expect(h.backend.latest.requests[1].configuration).toMatchObject({
    permissionMode: 'manual', reasoning: 'low', serviceTier: 'fast',
  });
  expect(getSessionSettingsSnapshot(other, h.plugin)).toMatchObject({
    permissionMode: 'yolo', reasoning: 'high', serviceTier: 'default',
  });
  await destroyTab(tab);
});

it('keeps archived sessions out of the composer resume picker', async () => {
  const h = setup();
  const current = h.plugin.getConversationSummary('conversation') as Conversation;
  const active = { ...current, id: 'active-session', title: 'Active task' };
  const archived = { ...current, id: 'archived-session', title: 'Archived task', isArchived: true,
    lastActivityAt: testDate({ minutes: 1 }).getTime() };
  Object.assign(h.plugin, { getConversationList: () => [archived, active] });
  const openConversation = jest.fn(async () => undefined);
  const tab = await h.attach({ openConversation });
  tab.dom.inputEl.value = '/sessions';
  await tab.controllers.inputController.sendMessage();
  const list = within(tab.dom.inputContainerEl).getByRole('listbox', { name: 'Resume conversation' });
  expect(within(list).getByRole('option', { name: /Active task/ })).toBeDefined();
  expect(within(list).queryByRole('option', { name: /Archived task/ })).toBeNull();
  fireEvent.keyDown(tab.dom.inputEl, { key: 'Enter' });
  expect(openConversation).toHaveBeenCalledWith('active-session');
  expect(h.backend.sessions).toHaveLength(0);
  expect(within(tab.dom.inputContainerEl).queryByRole('listbox', { name: 'Resume conversation' })).toBeNull();
  await destroyTab(tab);
});

it('does not open an empty resume picker when only archived sessions exist', async () => {
  const h = setup();
  Object.assign(h.plugin.app.workspace, { getActiveFile: () => null });
  const archived = { ...h.plugin.getConversationSummary('conversation')!, isArchived: true };
  Object.assign(h.plugin, { getConversationList: () => [archived] });
  const tab = await h.attach({ blank: true });
  tab.dom.inputEl.value = '/sessions';
  await tab.controllers.inputController.sendMessage();
  expect(within(tab.dom.inputContainerEl).queryByRole('listbox', { name: 'Resume conversation' })).toBeNull();
  expect(h.backend.sessions).toHaveLength(0);
  await destroyTab(tab);
});

it.each(['main', 'side'] as const)('keeps native requested permission changes for the %s destination', async destination => {
  const h = setup();
  await h.plugin.mutateSettings(settings => { settings.permissionMode = 'manual'; });
  const tab = await h.attach();
  let sending: Promise<unknown>;
  if (destination === 'side') {
    tab.state.messages = [
      { id: 'parent-user', role: 'user', content: 'Parent task', timestamp: testDate().getTime() },
      { id: 'parent-answer', role: 'assistant', content: 'Parent answer', assistantMessageId: 'checkpoint', timestamp: testDate().getTime() },
    ];
    jest.spyOn(ProviderRegistry.getConversationHistoryService('claude'), 'buildForkProviderState').mockResolvedValue({});
    sending = tab.controllers.sideChatController.handleCommandSubmission('Explore independently', []);
  } else {
    tab.controllers.drafts.restore('main', { content: 'First request' });
    sending = tab.controllers.inputController.sendMessage();
  }
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  h.backend.latest.emitOutput({ type: 'permission_mode_changed', permissionMode: 'yolo',
    snapshot: { providerId: 'claude', revision: 1, status: 'executing' } });
  await waitFor(() => expect(within(tab.dom.inputComposerEl).getByRole('button', { name: 'Permission mode: YOLO' })).toBeDefined());
  h.backend.latest.complete();
  await sending;
  tab.dom.inputEl.value = 'Continue with the native permission';
  const followUp = tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.latest.requests).toHaveLength(2));
  expect(h.backend.latest.requests[1].configuration.permissionMode).toBe('yolo');
  h.backend.latest.complete();
  await followUp;
  tab.controllers.sideChatController.collapse();
  const parentMode = within(tab.dom.inputComposerEl).getByRole('button', {
    name: destination === 'side' ? 'Permission mode: Manual' : 'Permission mode: YOLO',
  });
  expect(parentMode).toBeDefined();
  expect(await axe(parentMode)).toHaveNoViolations();
  await destroyTab(tab);
});

it('returns unsent queued input when a completed response cannot be saved', async () => {
  const h = setup();
  const tab = await h.attach();
  tab.controllers.drafts.restore('main', { content: 'First request' });
  const sending = tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(h.backend.sessions[0]?.requests).toHaveLength(1));
  tab.controllers.drafts.restore('main', { content: 'Queued follow-up' });
  await tab.controllers.inputController.sendMessage();
  const newerDraft = '    keepThisDraft()\n';
  tab.controllers.drafts.restore('main', { content: newerDraft });
  const saveError = new Error('Disk full');
  jest.spyOn(h.plugin, 'updateConversation').mockRejectedValueOnce(saveError);
  h.backend.latest.emitText('Completed response');
  h.backend.latest.complete();
  await expect(sending).rejects.toBe(saveError);

  expect(tab.controllers.drafts.capture('main').content).toBe(`Queued follow-up\n\n${newerDraft}`);
  expect(tab.state.queuedMessage).toBeNull();
  expect(h.backend.latest.requests).toHaveLength(1);
  expect(tab.state.hasPendingConversationSave).toBe(true);
  expect(h.pool.isRunning('conversation')).toBe(false);
  expect(tab.state.messages.some(message => message.contentBlocks?.some(block => block.type === 'text' && block.content === 'Completed response'))).toBe(true);
  await destroyTab(tab);
});
