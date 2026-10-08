/** @jest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { createHarness, releaseSideChatHarnesses } from '@test/helpers/features/chat/SideChatDOMHarness';
import { FakeSideSession } from '@test/helpers/features/chat/SideChatSessionHarness';
import { modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, Component, setIcon } from 'obsidian';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { getToolIcon } from '@/core/tools/toolIcons';
import type { ClaudianSettings, Conversation, StreamChunk } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { FLAVOR_TEXTS } from '@/features/chat/turns/flavorTexts';
import { ZenModeController } from '@/features/chat/zen/ZenModeController';
import { adaptCodexStreamChunk } from '@/providers/codex/execution/CodexExecutionEventNormalizer';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
const originalStructuredClone = globalThis.structuredClone;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.structuredClone = value => deserialize(serialize(value));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.structuredClone = originalStructuredClone;
  ProviderWorkspaceRegistry.clear();
  jest.restoreAllMocks();
  await releaseSideChatHarnesses();
});

type Split = { collapsed: boolean; containerEl: HTMLElement };
type Leaf = { view: unknown; getRoot: () => unknown; isDeferred?: boolean; loadIfDeferred?: () => Promise<void> };

/** Narrow stand-in for Obsidian's desktop workspace layout, events and keymap. */
function createWorkspace() {
  const containerEl = document.body.createDiv({ cls: 'workspace' });
  const leftSplit: Split = { collapsed: false, containerEl: containerEl.createDiv({ cls: 'workspace-split mod-left-split' }) };
  const rootEl = containerEl.createDiv({ cls: 'workspace-split mod-vertical mod-root' });
  const rightSplit: Split = { collapsed: false, containerEl: containerEl.createDiv({ cls: 'workspace-split mod-right-split' }) };
  const rootSplit = {};
  const noteEditor = rootEl.createDiv({ cls: 'workspace-leaf' }).createEl('textarea', {
    attr: { 'aria-label': 'Note editor' },
  }) as HTMLTextAreaElement;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const leaves: Leaf[] = [];
  const workspace = {
    containerEl,
    leftSplit,
    rightSplit,
    rootSplit,
    layoutReady: true,
    onLayoutReady: (callback: () => void) => callback(),
    on(name: string, callback: (...args: unknown[]) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(callback);
      return { name, callback };
    },
    offref(ref: { name: string; callback: (...args: unknown[]) => void }) {
      listeners.get(ref.name)?.delete(ref.callback);
    },
    trigger(name: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
    },
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    getLeavesOfType: () => leaves,
    getActiveFile: () => null,
    revealLeaf: jest.fn(async (leaf: Leaf) => {
      const root = leaf.getRoot() as Split;
      root.collapsed = false;
      workspace.trigger('resize');
    }),
  };
  const scopes: unknown[] = [];
  const keymap = {
    pushScope: (scope: unknown) => { scopes.push(scope); },
    popScope: (scope: unknown) => { scopes.splice(scopes.indexOf(scope), 1); },
  };
  const setCollapsed = (split: Split, collapsed: boolean) => {
    split.collapsed = collapsed;
    workspace.trigger('resize');
  };
  return { workspace, keymap, scopes, rootEl, rootSplit, leftSplit, rightSplit, noteEditor, leaves, setCollapsed };
}

function createSettings(enabled: boolean): ClaudianSettings {
  const entry = modelCatalogCases.find(candidate => candidate.id === 'claude')!;
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as ClaudianSettings;
  entry.populate(settings);
  settings.enableZenMode = enabled;
  return settings;
}

async function createZenFixture(options: { enabled?: boolean; ready?: boolean } = {}) {
  const settings = createSettings(options.enabled ?? true);
  const harness = createHarness({ settings: settings as unknown as Record<string, unknown> });
  ProviderWorkspaceRegistry.setServices('claude', {});
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref: () => undefined });
  const layout = createWorkspace();
  Object.assign(app, { workspace: layout.workspace, keymap: layout.keymap });
  const sessions: FakeSideSession[] = [];
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockImplementation((_host, providerId = 'claude') => ({
    providerId,
    createSession: config => {
      const session = new FakeSideSession(config);
      sessions.push(session);
      return session;
    },
  }));
  const conversations: Conversation[] = [];
  const zen = new ZenModeController({
    app,
    isEnabled: (): boolean => settingsCoordinator.getCommittedSettings().enableZenMode,
    getPosition: () => settingsCoordinator.getCommittedSettings().zenModePosition,
    savePosition: (position) => {
      void settingsCoordinator.mutate((draft) => { draft.zenModePosition = position; });
    },
  });
  const settingsCoordinator: SettingsCoordinator<ClaudianSettings> = new SettingsCoordinator(
    settings,
    async () => undefined,
    () => zen.reconcile(),
  );
  const find = (id: string) => conversations.find(entry => entry.id === id) ?? null;
  const plugin = {
    ...(harness.plugin as ChatFeatureHost), app, settings,
    chatModelSelection: new ChatModelSelectionCoordinator(settingsCoordinator),
    executionPersistence: {
      registerExecutionBinding: () => undefined,
      releaseExecutionBinding: () => undefined,
      persistExecutionSnapshot: async () => true,
      assertConversationExecutionAuthority: async () => undefined,
      recordConversationActivity: async () => undefined,
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSummary: find,
    getConversationSync: find,
    getConversationById: async (id: string) => find(id),
    getConversationList: () => conversations,
    updateConversation: async () => undefined,
    renameConversation: async () => undefined,
    mutateSettings: settingsCoordinator.mutate.bind(settingsCoordinator),
    getCommittedSettings: settingsCoordinator.getCommittedSettings.bind(settingsCoordinator),
    registerZenModeSource: (source: Parameters<ZenModeController['register']>[0]) => zen.register(source),
  } as unknown as ChatFeatureHost;

  const addView = async (placement: 'left' | 'right' | 'main', ready = true) => {
    const conversation = {
      id: `conversation-${conversations.length + 1}`,
      providerId: 'claude',
      selectedModel: modelCatalogCases.find(candidate => candidate.id === 'claude')!.selected,
      messages: [],
      sessionId: `session-${conversations.length + 1}`,
    } as unknown as Conversation;
    conversations.push(conversation);
    const split = placement === 'left' ? layout.leftSplit : placement === 'right' ? layout.rightSplit : null;
    const viewContainerEl = (split?.containerEl ?? layout.rootEl).createDiv({ cls: 'claudian-container' });
    const leaf: Leaf = { getRoot: () => split ?? layout.rootSplit, view: null };
    const view = createClaudianView({
      host: plugin,
      app,
      leaf,
      containerEl: viewContainerEl,
      contentEl: viewContainerEl,
    });
    // The view-owned footer and tab container that onOpen builds.
    view.viewContainerEl = viewContainerEl;
    view.buildViewLayout(viewContainerEl);
    const activeInputSlotEl = viewContainerEl.querySelector<HTMLElement>('.claudian-active-input-slot')!;
    const sideChatChipHostEl = viewContainerEl.querySelector<HTMLElement>('.claudian-side-chat-chip-slot')!;
    const tab: AssembledTabRuntime = await createTabRuntime({
      plugin,
      component: Object.assign(new Component(), { registerDomEvent: () => undefined, registerEvent: () => undefined }) as never,
      containerEl: view.tabContentEl,
      mentionDataProvider: new VaultMentionDataProvider(plugin.app),
      conversation, getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
    });
    tab.state.currentConversationId = conversation.id;
    tab.dom.contentEl.removeClass('claudian-hidden');
    cleanups.push(() => destroyTab(tab));
    view.tabManager = {
      getActiveTab: () => tab,
      getTab: (id: string) => id === tab.id ? tab : null,
      getTabCount: () => 1,
    };

    Object.assign(view.tabWorkspace, { lifecycleRevision: 1, initializedRevision: ready ? 1 : -1 });
    leaf.view = view;
    layout.leaves.push(leaf);
    view.presentation.update();
    view.startZenModeSource();
    cleanups.push(() => view.stopZenModeSource());
    return { view, tab, leaf, activeInputSlotEl, sideChatChipHostEl };
  };

  zen.start();
  cleanups.push(() => zen.dispose());
  const primary = await addView('right', options.ready ?? true);
  return { ...layout, ...primary, app, zen, sessions, settingsCoordinator, addView };
}

function zenPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.claudian-zen');
}

function preview(): string {
  return zenPanel()?.querySelector('.claudian-zen-preview')?.textContent ?? '';
}

function seedHistory(tab: AssembledTabRuntime): void {
  tab.state.messages = [
    { id: 'u1', role: 'user', content: 'Earlier question', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'Earlier answer', timestamp: 2 },
  ];
}

async function sendFromZen(tab: AssembledTabRuntime, sessions: FakeSideSession[], text: string) {
  tab.dom.inputEl.value = text;
  fireEvent.keyDown(tab.dom.inputEl as unknown as HTMLElement, { key: 'Enter' });
  await waitFor(() => expect(sessions.at(-1)?.requests.at(-1)?.input).toEqual([{ text, type: 'text' }]));
  return sessions.at(-1)!;
}

it('moves the existing composer and transcript into the central workspace while the sidebar is collapsed', async () => {
  const { tab, rootEl, rightSplit, setCollapsed, activeInputSlotEl } = await createZenFixture();
  const composer = tab.dom.inputComposerEl;
  const transcript = tab.dom.messagesWrapperEl;
  expect(zenPanel()).toBeNull();

  setCollapsed(rightSplit, true);

  const panel = zenPanel();
  expect(panel?.parentElement).toBe(rootEl);
  expect(panel!.contains(composer)).toBe(true);
  expect(panel!.contains(transcript)).toBe(true);
  expect(rootEl.classList.contains('claudian-zen-host')).toBe(true);

  setCollapsed(rightSplit, false);

  expect(zenPanel()).toBeNull();
  expect(rootEl.classList.contains('claudian-zen-host')).toBe(false);
  expect(composer.parentElement).toBe(activeInputSlotEl);
  expect(transcript.parentElement).toBe(tab.dom.contentEl);
  expect(tab.dom.contentEl.firstElementChild).toBe(transcript);
});

it('follows the view brand provider after it changes while zen is open', async () => {
  const { view, tab, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  view.syncProviderBrandColor();
  expect(zenPanel()!.dataset.provider).toBe('claude');

  // The tab switches to another provider's model from the zen composer.
  view.plugin.getConversationSummary(tab.conversationId).providerId = 'codex';
  view.syncProviderBrandColor();

  expect(view.viewContainerEl.dataset.provider).toBe('codex');
  expect(zenPanel()!.dataset.provider).toBe('codex');
});

it.each([
  ['the setting is off', { enabled: false }, 'right'],
  ['only the other sidebar collapses', {}, 'left'],
])('does not activate when %s', async (_label, options, collapse) => {
  const fixture = await createZenFixture(options);
  fixture.setCollapsed(collapse === 'left' ? fixture.leftSplit : fixture.rightSplit, true);
  expect(zenPanel()).toBeNull();
  expect(fixture.tab.dom.inputComposerEl.parentElement).toBe(fixture.activeInputSlotEl);
});

it('ignores a chat in the central workspace', async () => {
  const fixture = await createZenFixture({ ready: false });
  const central = await fixture.addView('main');
  fixture.setCollapsed(fixture.rightSplit, true);
  fixture.setCollapsed(fixture.leftSplit, true);
  expect(zenPanel()).toBeNull();
  expect(central.tab.dom.inputComposerEl.parentElement).toBe(central.activeInputSlotEl);
});

it('waits for ordinary restoration before presenting an already collapsed sidebar', async () => {
  const fixture = await createZenFixture({ ready: false });
  fixture.setCollapsed(fixture.rightSplit, true);
  expect(zenPanel()).toBeNull();
  expect(fixture.sessions).toHaveLength(0);

  fixture.view.tabWorkspace.initializedRevision = 1;
  fixture.view.notifyZenPresentationChanged();

  expect(zenPanel()!.contains(fixture.tab.dom.inputComposerEl)).toBe(true);
  expect(fixture.sessions).toHaveLength(0);
});

it('loads a chat that Obsidian deferred in an already collapsed sidebar', async () => {
  const fixture = await createZenFixture();
  let loaded: Awaited<ReturnType<typeof fixture.addView>> | null = null;
  const deferred: Leaf = {
    view: {},
    getRoot: () => fixture.leftSplit,
    isDeferred: true,
    loadIfDeferred: jest.fn(async () => {
      fixture.leaves.splice(fixture.leaves.indexOf(deferred), 1);
      loaded = await fixture.addView('left');
    }),
  };
  fixture.leaves.push(deferred);

  // Nothing collapsed, or the setting off, leaves the deferred chat alone.
  fixture.workspace.trigger('layout-change');
  await fixture.settingsCoordinator.mutate(settings => { settings.enableZenMode = false; });
  fixture.setCollapsed(fixture.leftSplit, true);
  expect(deferred.loadIfDeferred).not.toHaveBeenCalled();

  await fixture.settingsCoordinator.mutate(settings => { settings.enableZenMode = true; });
  fixture.workspace.trigger('resize');
  expect(deferred.loadIfDeferred).toHaveBeenCalledTimes(1);

  await waitFor(() => expect(loaded).not.toBeNull());
  expect(zenPanel()!.contains(loaded!.tab.dom.inputComposerEl)).toBe(true);
  expect(deferred.loadIfDeferred).toHaveBeenCalledTimes(1);
});

it('prefers a loaded chat over loading a deferred one', async () => {
  const fixture = await createZenFixture();
  const deferred: Leaf = {
    view: {},
    getRoot: () => fixture.leftSplit,
    isDeferred: true,
    loadIfDeferred: jest.fn(async () => undefined),
  };
  fixture.leaves.push(deferred);
  fixture.setCollapsed(fixture.rightSplit, true);
  fixture.setCollapsed(fixture.leftSplit, true);

  expect(zenPanel()!.contains(fixture.tab.dom.inputComposerEl)).toBe(true);
  expect(deferred.loadIfDeferred).not.toHaveBeenCalled();
});

it('applies committed setting changes without reopening the sidebar or touching execution', async () => {
  const fixture = await createZenFixture();
  const { tab, sessions, settingsCoordinator } = fixture;
  fixture.setCollapsed(fixture.rightSplit, true);
  const session = await sendFromZen(tab, sessions, 'Keep working');
  tab.dom.inputEl.value = 'Unsent draft';

  await settingsCoordinator.mutate(settings => { settings.enableZenMode = false; });
  expect(zenPanel()).toBeNull();
  expect(fixture.rightSplit.collapsed).toBe(true);
  expect(tab.dom.inputComposerEl.parentElement).toBe(fixture.activeInputSlotEl);

  await settingsCoordinator.mutate(settings => { settings.enableZenMode = true; });
  expect(zenPanel()!.contains(tab.dom.inputComposerEl)).toBe(true);
  expect(tab.dom.inputEl.value).toBe('Unsent draft');
  expect(tab.state.isStreaming).toBe(true);
  expect(sessions).toHaveLength(1);
  expect(session.cancelCalls).toBe(0);
  session.complete();
});

it('keeps one live turn, draft and node identity across repeated presentation changes', async () => {
  const fixture = await createZenFixture();
  const { tab, sessions, rightSplit, setCollapsed } = fixture;
  const composer = tab.dom.inputComposerEl;
  const transcript = tab.dom.messagesWrapperEl;
  setCollapsed(rightSplit, true);
  expect(preview()).toBe('');

  const session = await sendFromZen(tab, sessions, 'Summarize the note');
  await waitFor(() => expect(preview()).toBe('Summarize the note'));
  session.emitText('## First line\n\nSecond line\n');
  await waitFor(() => expect(preview()).toBe('First line'));

  tab.dom.inputEl.value = 'Next question';
  for (let toggle = 0; toggle < 3; toggle += 1) {
    setCollapsed(rightSplit, false);
    expect(zenPanel()).toBeNull();
    setCollapsed(rightSplit, true);
  }
  expect(zenPanel()!.contains(composer)).toBe(true);
  expect(zenPanel()!.contains(transcript)).toBe(true);
  expect(tab.dom.inputEl.value).toBe('Next question');
  expect(sessions).toHaveLength(1);
  expect(session.requests).toHaveLength(1);
  expect(session.cancelCalls).toBe(0);

  session.emitText('Third line');
  await waitFor(() => expect(tab.state.currentTextContent).toContain('Third line'));
  session.complete();
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));
  // The finished turn leads with its duration, then the first line of the result.
  await waitFor(() => expect(preview()).toMatch(/^Worked for \d{2}:\d{2} · First line$/));
});

/** Text of the transcript's visible waiting indicator, or null when none is shown. */
function waitingIndicatorText(tab: AssembledTabRuntime): string | null {
  const indicator = tab.dom.messagesEl.querySelector('.claudian-thinking');
  return indicator?.firstElementChild?.textContent ?? null;
}

async function waitForFlavor(tab: AssembledTabRuntime, timeout?: number): Promise<string> {
  await waitFor(() => expect(FLAVOR_TEXTS).toContain(waitingIndicatorText(tab)), { timeout });
  return waitingIndicatorText(tab)!;
}

function expectZenPreview(text: string): void {
  expect(within(zenPanel()!).getByRole('button', { name: 'Show conversation', description: text })).toBeDefined();
}

it.each([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
])('retains waiting flavor in the transcript and Zen across empty Codex %s after a notification', async method => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const session = await sendFromZen(tab, sessions, 'Explain this note');
  const flavor = await waitForFlavor(tab);
  session.emitSessionEvent({ type: 'task_notification', content: 'A background task finished' });
  await waitFor(() => expect(tab.state.messages.some(message => (
    message.contentBlocks?.some(block => block.type === 'task_notification')
  ))).toBe(true));

  const chunks: StreamChunk[] = [];
  const router = new CodexNotificationRouter(chunk => chunks.push(chunk));
  router.handleNotification(method, { threadId: 'thread', turnId: 'turn', itemId: 'item', delta: '' });
  const events = chunks.flatMap(chunk => adaptCodexStreamChunk(chunk) ?? []);
  expect(events).not.toHaveLength(0);
  for (const event of events) session.emitOutput(event);
  await new Promise(resolve => setTimeout(resolve, 600));

  // Empty provider output must not replace the visible waiting surface or create empty reasoning.
  expect(waitingIndicatorText(tab)).toBe(flavor);
  expect(tab.dom.messagesEl.querySelector('.claudian-thinking-block')).toBeNull();
  await waitFor(() => expectZenPreview(flavor));
  session.complete();
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));
});

it('shares one status across waiting, thinking, tools, text and silent pauses, then clears it', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const transcript = within(tab.dom.messagesEl);
  const session = await sendFromZen(tab, sessions, 'Explain this note');

  const waiting = await waitForFlavor(tab);
  await waitFor(() => expectZenPreview(waiting));

  session.emitOutput({ type: 'thinking_delta', text: 'Reviewing the note.' });
  await waitFor(() => expect(preview()).toBe('Thinking…'));
  expect(transcript.getByRole('button', { name: /^Thinking \d+s\.\.\.$/, hidden: true })).toBeDefined();
  expect(waitingIndicatorText(tab)).toBeNull();

  session.emitOutput({
    type: 'tool_started', toolCallId: 'tool-1', name: 'Read', input: { file_path: 'note.md' },
    toolScope: { kind: 'main' },
  } as never);
  // The transcript keeps its waiting surface while the tool runs; zen names the tool instead.
  await waitForFlavor(tab);
  expect(preview()).toBe('Read · running');

  session.emitText('Here is the answer.');
  await waitFor(() => expect(preview()).toBe('Here is the answer.'));
  expect(waitingIndicatorText(tab)).toBeNull();
  expect(tab.dom.messagesEl.querySelector('.claudian-tool-call')).not.toBeNull();

  // Execution continues silently after intermediate text.
  const paused = await waitForFlavor(tab, 3_000);
  await waitFor(() => expectZenPreview(paused));

  session.complete();
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));
  await waitFor(() => expect(preview()).toMatch(/^Worked for \d{2}:\d{2} · Here is the answer\.$/));
  expect(waitingIndicatorText(tab)).toBeNull();
  // The drawer holds the moved transcript, its navigation and the preview line.
  expect(await axe(zenPanel()!.querySelector<HTMLElement>('.claudian-zen-drawer')!)).toHaveNoViolations();
});

it('gives a pending approval priority over the waiting status and resumes it afterwards', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const session = await sendFromZen(tab, sessions, 'Write a note');
  await waitForFlavor(tab);

  const approval = session.config.interactionPort.requestApproval({
    description: 'Write a note', input: {}, interactionId: 'approval-1',
    kind: 'approval', sessionInstanceId: session.sessionInstanceId,
    toolName: 'Write', turnId: session.activeTurnId,
  }, new AbortController().signal);
  await waitFor(() => expect(preview()).toBe('Needs your input'));
  expect(waitingIndicatorText(tab)).toBeNull();
  // Output arriving while the prompt is open must not bring the indicator back over it.
  session.emitOutput({
    type: 'tool_started', toolCallId: 'tool-1', name: 'Write', input: { file_path: 'note.md' },
    toolScope: { kind: 'main' },
  } as never);
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(waitingIndicatorText(tab)).toBeNull();
  expect(preview()).toBe('Needs your input');

  fireEvent.click(await within(zenPanel()!).findByText('Allow once'));
  await expect(approval).resolves.toMatchObject({ decision: 'allow' });
  await waitForFlavor(tab);
  await waitFor(() => expect(preview()).toBe('Write · running'));

  session.complete();
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));
  expect(waitingIndicatorText(tab)).toBeNull();
});

it('keeps explicit compaction status across a prompt', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const session = await sendFromZen(tab, sessions, '/compact');
  await waitFor(() => expect(waitingIndicatorText(tab)).toBe('Compacting...'));
  await waitFor(() => expectZenPreview('Compacting...'));

  const approval = session.config.interactionPort.requestApproval({
    description: 'Approve action', input: {}, interactionId: 'approval-compact',
    kind: 'approval', sessionInstanceId: session.sessionInstanceId,
    toolName: 'Write', turnId: session.activeTurnId,
  }, new AbortController().signal);
  await waitFor(() => expect(preview()).toBe('Needs your input'));
  fireEvent.click(await within(zenPanel()!).findByText('Allow once'));
  await approval;
  await waitFor(() => expect(waitingIndicatorText(tab)).toBe('Compacting...'));
  await waitFor(() => expectZenPreview('Compacting...'));
  session.complete();
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));
});

it('clears a pending waiting status when provider invalidation ends the turn', async () => {
  const { tab, view, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const session = await sendFromZen(tab, sessions, 'Invalidate during text');
  session.emitText('Partial response');
  await waitFor(() => expect(preview()).toBe('Partial response'));
  await view.plugin.providerHost.executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
  await tab.session.turns.drain();
  expect(session.cancelCalls).toBeGreaterThan(0);

  // Past the text-pause delay, the ended turn must not bring its indicator back.
  await new Promise(resolve => setTimeout(resolve, 1_700));
  expect(waitingIndicatorText(tab)).toBeNull();
  expect(tab.state.waitingStatus).toBeNull();
});

it('leaves no waiting indicator behind when a forced new chat dismisses a pending approval', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const session = await sendFromZen(tab, sessions, 'Write a note');
  await waitForFlavor(tab);
  const approval = session.config.interactionPort.requestApproval({
    description: 'Write a note', input: {}, interactionId: 'approval-1',
    kind: 'approval', sessionInstanceId: session.sessionInstanceId,
    toolName: 'Write', turnId: session.activeTurnId,
  }, new AbortController().signal).catch(() => undefined);
  await waitFor(() => expect(preview()).toBe('Needs your input'));

  // Persistence that outlasts the indicator delay leaves time for a stale resume to fire.
  const { conversationController } = tab.controllers;
  const save = conversationController.save.bind(conversationController);
  jest.spyOn(conversationController, 'save').mockImplementation(async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 600));
    return save(...args);
  });
  await conversationController.createNew({ force: true });
  await approval;

  expect(tab.state.isStreaming).toBe(false);
  expect(tab.state.thinkingEl).toBeNull();
  expect(tab.state.waitingStatus).toBeNull();
});

it('reports a provider failure after streamed output as an error', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);

  const session = await sendFromZen(tab, sessions, 'Long task');
  session.emitText('Starting work');
  await waitFor(() => expect(preview()).toBe('Starting work'));
  session.fail('Provider overloaded');
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));

  await waitFor(() => expect(preview()).toBe('Error: Provider overloaded'));
  expect(zenPanel()!.dataset.tone).toBe('error');
  expect(screen.getByRole('status').textContent).toBe('Error: Provider overloaded');
});

it('leaves sending and stopping to the moved composer', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const panel = zenPanel()!;
  expect(within(panel).queryByRole('button', { name: 'Send' })).toBeNull();
  expect(within(panel).queryByRole('button', { name: 'Stop' })).toBeNull();

  const session = await sendFromZen(tab, sessions, 'Long task');
  session.emitText('Partial answer');
  await waitFor(() => expect(preview()).toBe('Partial answer'));
  fireEvent.keyDown(tab.dom.inputEl as unknown as HTMLElement, { key: 'Escape' });

  expect(session.cancelCalls).toBe(1);
  await waitFor(() => expect(preview()).toBe('Interrupted'));
  // A cancelled turn leaves no waiting indicator behind, even after a text pause would have elapsed.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(waitingIndicatorText(tab)).toBeNull();
  expect(preview()).toBe('Interrupted');
});

it('offers no history for a new conversation until it has messages', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const panel = zenPanel()!;
  const disclosure = panel.querySelector<HTMLButtonElement>('.claudian-zen-disclosure')!;
  const history = panel.querySelector<HTMLElement>('.claudian-zen-history')!;
  // The whole drawer waits for the first message.
  const drawer = panel.querySelector<HTMLElement>('.claudian-zen-drawer')!;
  expect(drawer.classList.contains('claudian-hidden')).toBe(true);
  expect(history.classList.contains('claudian-hidden')).toBe(true);

  const session = await sendFromZen(tab, sessions, 'First question');
  await waitFor(() => expect(drawer.classList.contains('claudian-hidden')).toBe(false));
  expect(disclosure.classList.contains('claudian-hidden')).toBe(false);
  // The whole preview line is the disclosure control, and the drawer holds nothing else.
  expect(disclosure.contains(panel.querySelector('.claudian-zen-preview'))).toBe(true);
  expect(panel.querySelector('.claudian-zen-bar')!.children).toHaveLength(1);
  fireEvent.click(panel.querySelector('.claudian-zen-preview')!);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect(history.classList.contains('claudian-hidden')).toBe(false);
  expect(panel.classList.contains('claudian-zen--expanded')).toBe(true);
  session.complete();
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));

  // A new chat hides the remembered expansion until its first message.
  tab.state.clearMessages();
  await waitFor(() => expect(drawer.classList.contains('claudian-hidden')).toBe(true));
  expect(history.classList.contains('claudian-hidden')).toBe(true);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
});

it('moves the composer controls to their own row only once the typed text would reach them', async () => {
  const { tab, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const slot = zenPanel()!.querySelector<HTMLElement>('.claudian-zen-composer')!;
  const toolbar = tab.dom.inputWrapper.querySelector<HTMLElement>(':scope > .claudian-input-toolbar')!;
  expect(slot.contains(toolbar)).toBe(true);

  // jsdom has no layout: a 400px input row, a 180px control group, and 8px per typed character.
  Object.defineProperty(tab.dom.inputWrapper, 'clientWidth', { configurable: true, value: 400 });
  let toolbarWidth = 180;
  jest.spyOn(toolbar, 'getBoundingClientRect').mockImplementation(() => ({ width: toolbarWidth } as DOMRect));
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Range) {
      return { width: this.toString().length * 8, height: 20 } as DOMRect;
    },
  });
  cleanups.push(() => { delete (Range.prototype as Partial<Range>).getBoundingClientRect; });
  const stacked = () => slot.classList.contains('claudian-zen-composer--stacked');

  tab.dom.inputEl.value = 'Short question';
  await waitFor(() => expect(tab.dom.inputEl.textContent).toBe('Short question'));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(stacked()).toBe(false);

  // 400 - 180 - 16px clearance leaves 204px: 26 characters reach the controls.
  tab.dom.inputEl.value = 'x'.repeat(26);
  await waitFor(() => expect(stacked()).toBe(true));
  tab.dom.inputEl.value = 'x'.repeat(25);
  await waitFor(() => expect(stacked()).toBe(false));

  tab.dom.inputEl.value = 'one\ntwo';
  await waitFor(() => expect(stacked()).toBe(true));
  tab.dom.inputEl.value = '';
  await waitFor(() => expect(stacked()).toBe(false));

  // Attachments take the controls' row with them, below the input.
  tab.ui.contextTray.setItems('editor-selection', [{ id: 'selection', kind: 'selection', label: '3 lines selected' }]);
  await waitFor(() => expect(stacked()).toBe(true));
  tab.ui.contextTray.clearItems('editor-selection');
  await waitFor(() => expect(stacked()).toBe(false));

  // Wider controls (a longer model label, fast mode appearing) also make room below.
  tab.dom.inputEl.value = 'Short question';
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(stacked()).toBe(false);
  toolbarWidth = 390;
  // The chip's label is replaced the way ModelSelector.updateDisplay sets it.
  const modelLabel = within(toolbar).getByRole('button', { name: /^Model:/ }).querySelector<HTMLElement>('.claudian-model-label')!;
  modelLabel.setText(`${modelLabel.textContent} (long alias)`);
  await waitFor(() => expect(stacked()).toBe(true));
});

it('follows chat state while transcript rendering is suspended', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  tab.state.messages = [
    { id: 'u1', role: 'user', content: 'Earlier question', timestamp: 1 },
    {
      id: 'a1', role: 'assistant', content: 'Loaded answer\nfinal loaded line', timestamp: 2,
      contentBlocks: [{ type: 'text', content: 'Loaded answer\nfinal loaded line' }],
    },
  ];
  setCollapsed(rightSplit, true);
  expect(preview()).toBe('Loaded answer');
  const toolIcon = zenPanel()!.querySelector<HTMLElement>('.claudian-zen-preview-icon')!;
  expect(toolIcon.getAttribute('aria-hidden')).toBe('true');
  expect(toolIcon.classList.contains('claudian-hidden')).toBe(true);

  tab.controllers.streamController.setViewportVisible(false);
  const session = await sendFromZen(tab, sessions, 'Check the vault');
  session.emitText('Hidden progress');
  await waitFor(() => expect(preview()).toBe('Hidden progress'));
  expect(tab.dom.messagesEl.textContent).not.toContain('Hidden progress');

  session.emitOutput({
    type: 'tool_started', toolCallId: 'tool-1', name: 'Read', input: { file_path: 'note.md' },
    toolScope: { kind: 'main' },
  } as never);
  await waitFor(() => expect(preview()).toBe('Read · running'));
  // The same icon the transcript's tool renderer shows.
  expect(toolIcon.classList.contains('claudian-hidden')).toBe(false);
  expect(setIcon).toHaveBeenLastCalledWith(toolIcon, getToolIcon('Read'));
  session.complete();
  await waitFor(() => expect(tab.state.isStreaming).toBe(false));
});

it('sends with the existing keyboard rules and leaves note input alone', async () => {
  const { tab, sessions, rightSplit, setCollapsed, noteEditor, scopes } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const input = tab.dom.inputEl as unknown as HTMLElement;

  noteEditor.focus();
  noteEditor.value = 'Note text';
  fireEvent.keyDown(noteEditor, { key: 'Enter' });
  fireEvent.keyDown(noteEditor, { key: 'Escape' });
  expect(sessions).toHaveLength(0);
  expect(scopes).toHaveLength(0);

  input.focus();
  expect(scopes).toHaveLength(1);
  tab.dom.inputEl.value = 'Line one';
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(sessions).toHaveLength(0);

  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(sessions[0]?.requests).toHaveLength(1));
  expect(sessions).toHaveLength(1);

  noteEditor.focus();
  expect(scopes).toHaveLength(0);
  sessions[0].complete();
});

it('discloses the existing transcript accessibly and remembers the choice for the view lifetime', async () => {
  const { tab, rightSplit, setCollapsed, scopes, noteEditor } = await createZenFixture();
  seedHistory(tab);
  setCollapsed(rightSplit, true);
  const panel = zenPanel()!;
  const show = within(panel).getByRole('button', { name: 'Show conversation' });
  const history = document.getElementById(show.getAttribute('aria-controls')!)!;
  expect(show.getAttribute('aria-expanded')).toBe('false');
  expect(history.classList.contains('claudian-hidden')).toBe(true);
  expect(history.contains(tab.dom.messagesWrapperEl)).toBe(true);
  expect(screen.getByRole('region', { name: 'Claudian chat' })).toBe(panel);

  // Moved chat nodes keep their own coverage; this checks the zen chrome.
  expect(await axe(panel.querySelector<HTMLElement>('.claudian-zen-bar')!)).toHaveNoViolations();

  show.focus();
  expect(scopes).toHaveLength(1);
  fireEvent.click(show);
  expect(show.getAttribute('aria-expanded')).toBe('true');
  expect(history.classList.contains('claudian-hidden')).toBe(false);
  expect(document.activeElement).toBe(history);
  expect(scopes).toHaveLength(1);
  expect(tab.controllers.sideChatController.destination).toBe('main');

  setCollapsed(rightSplit, false);
  noteEditor.focus();
  setCollapsed(rightSplit, true);
  const reopened = zenPanel()!.querySelector('.claudian-zen-disclosure')!;
  expect(reopened.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(noteEditor);
  expect(scopes).toHaveLength(0);
});

it('collapses the expanded transcript on a click or focus move elsewhere in Obsidian', async () => {
  const { tab, rightSplit, setCollapsed, noteEditor } = await createZenFixture();
  seedHistory(tab);
  setCollapsed(rightSplit, true);
  const panel = zenPanel()!;
  const hide = within(panel).getByRole('button', { name: 'Show conversation' });
  fireEvent.click(hide);
  const history = document.getElementById(hide.getAttribute('aria-controls')!)!;

  // Clicks inside zen, or in menus and modals it opened, keep it open.
  fireEvent.pointerDown(tab.dom.messagesEl);
  fireEvent.pointerDown(tab.dom.inputEl as unknown as HTMLElement);
  for (const cls of ['menu', 'modal-container', 'suggestion-container']) {
    const overlay = document.body.createDiv({ cls });
    fireEvent.pointerDown(overlay.createDiv());
    overlay.remove();
  }
  expect(hide.getAttribute('aria-expanded')).toBe('true');

  fireEvent.pointerDown(noteEditor);
  expect(hide.getAttribute('aria-expanded')).toBe('false');
  expect(history.classList.contains('claudian-hidden')).toBe(true);

  // A collapsed transcript ignores outside clicks entirely.
  fireEvent.pointerDown(noteEditor);
  expect(hide.getAttribute('aria-expanded')).toBe('false');

  // Keyboard users leave the same way: focus moving from zen into the note collapses it.
  fireEvent.click(hide);
  const inputEl = tab.dom.inputEl as unknown as HTMLElement;
  fireEvent.focusOut(inputEl, { relatedTarget: panel.querySelector('.claudian-zen-disclosure') });
  expect(hide.getAttribute('aria-expanded')).toBe('true');
  fireEvent.focusOut(inputEl, { relatedTarget: null });
  expect(hide.getAttribute('aria-expanded')).toBe('true');
  fireEvent.focusOut(inputEl, { relatedTarget: noteEditor });
  expect(hide.getAttribute('aria-expanded')).toBe('false');
});

it('moves the panel by its grip, docks it magnetically, and remembers where it was left', async () => {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  globalThis.ResizeObserver = class {
    readonly #entry: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.#entry = { callback, targets: new Set() };
      observers.push(this.#entry);
    }
    observe(target: Element) { this.#entry.targets.add(target); }
    unobserve(target: Element) { this.#entry.targets.delete(target); }
    disconnect() { this.#entry.targets.clear(); }
  } as unknown as typeof ResizeObserver;
  const resize = (target: Element) => {
    for (const { callback, targets } of observers) {
      if (targets.has(target)) callback([], {} as ResizeObserver);
    }
  };
  // jsdom lacks PointerEvent, so fireEvent would dispatch plain events without pointer coordinates.
  const originalPointerEvent = window.PointerEvent;
  window.PointerEvent = class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  } as unknown as typeof PointerEvent;
  cleanups.push(() => { window.PointerEvent = originalPointerEvent; });
  const { rootEl, rightSplit, setCollapsed, settingsCoordinator, noteEditor, workspace } = await createZenFixture();
  // jsdom has no layout: a 1000x800 central workspace holding a 600x100 panel, without zen styles.
  // A 584x60 composer sits 8px inside the panel's bottom, which follows the bottom offset; a
  // drawer, when shown, sits on it, 526px wide.
  Object.defineProperty(rootEl, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(rootEl, 'clientHeight', { configurable: true, value: 800 });
  jest.spyOn(rootEl, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 800, height: 800 } as DOMRect));
  let panelHeight = 100;
  let drawerHeight = 0;
  const stubPanel = (panel: HTMLElement) => {
    const composerBottom = () => 800 - Number.parseFloat(panel.style.getPropertyValue('--claudian-zen-offset-y') || '0');
    jest.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => ({
      left: 200, right: 800, top: composerBottom() + 8 - panelHeight, bottom: composerBottom() + 8,
      width: 600, height: panelHeight,
    } as DOMRect));
    jest.spyOn(panel.querySelector<HTMLElement>('.claudian-zen-composer')!, 'getBoundingClientRect')
      .mockImplementation(() => ({ left: 208, right: 792, top: composerBottom() - 60, bottom: composerBottom() } as DOMRect));
    jest.spyOn(panel.querySelector<HTMLElement>('.claudian-zen-drawer')!, 'getBoundingClientRect')
      .mockImplementation(() => ({
        left: 237, right: 763, top: composerBottom() - 60 - drawerHeight, bottom: composerBottom() - 60,
        height: drawerHeight,
      } as DOMRect));
  };
  // Corner points of the hint outline, relative to the panel box; zen styles add no gap or radii here.
  const outlinePoints = () => {
    const d = rootEl.querySelector('.claudian-zen-dock-hint-outline')?.getAttribute('d') ?? '';
    return (d.match(/[MLA][^MLAZ]*/g) ?? []).map((command) => {
      const values = command.slice(1).trim().split(/[\s,]+/).map(Number);
      return values.slice(-2);
    });
  };
  const offset = (panel: HTMLElement) => [
    panel.style.getPropertyValue('--claudian-zen-offset-x'),
    panel.style.getPropertyValue('--claudian-zen-offset-y'),
  ];
  const savedPosition = () => settingsCoordinator.getCommittedSettings().zenModePosition;
  const drag = (grip: HTMLElement, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: to[0], clientY: to[1] });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: to[0], clientY: to[1] });
  };

  setCollapsed(rightSplit, true);
  let panel = zenPanel()!;
  stubPanel(panel);
  const grip = within(panel).getByRole('button', { name: 'Move chat panel' });
  expect(await axe(grip)).toHaveNoViolations();
  expect(offset(panel)).toEqual(['0px', '0px']);

  // Dragging left beyond the edge stops at the workspace's side; upward is a positive bottom offset.
  drag(grip, [500, 700], [100, 400]);
  expect(offset(panel)).toEqual(['-200px', '300px']);
  await waitFor(() => expect(savedPosition()).toEqual({ x: -0.2, y: 0.375 }));
  expect(panel.classList.contains('claudian-zen--opens-below')).toBe(false);

  // Near the top, composer menus open downward instead of past the workspace edge.
  drag(grip, [0, 0], [0, -500]);
  expect(offset(panel)).toEqual(['-200px', '700px']);
  expect(panel.classList.contains('claudian-zen--opens-below')).toBe(true);
  await waitFor(() => expect(savedPosition()).toEqual({ x: -0.2, y: 0.875 }));

  // A taller panel slides down to stay inside the workspace, then returns to the remembered spot.
  panelHeight = 300;
  resize(panel);
  expect(offset(panel)).toEqual(['-200px', '500px']);
  panelHeight = 100;
  resize(panel);
  expect(offset(panel)).toEqual(['-200px', '700px']);
  expect(savedPosition()).toEqual({ x: -0.2, y: 0.875 });

  // Reattaching restores the remembered position.
  setCollapsed(rightSplit, false);
  noteEditor.focus();
  setCollapsed(rightSplit, true);
  panel = zenPanel()!;
  stubPanel(panel);
  expect(offset(panel)).toEqual(['-200px', '700px']);

  // While dragging, a hint marks the dock and lights up once the panel is close enough to snap.
  const reopenedGrip = within(panel).getByRole('button', { name: 'Move chat panel' });
  const hint = () => rootEl.querySelector<HTMLElement>('.claudian-zen-dock-hint');
  expect(hint()).toBeNull();
  fireEvent.pointerDown(reopenedGrip, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(document, { pointerId: 1, clientX: 100, clientY: 300 });
  expect(hint()?.getAttribute('aria-hidden')).toBe('true');
  expect([hint()!.style.width, hint()!.style.height]).toEqual(['600px', '100px']);
  // Without a drawer, the outline is the composer alone.
  expect(Math.min(...outlinePoints().map(([, y]) => y))).toBe(32);
  expect(hint()!.classList.contains('claudian-zen-dock-hint--active')).toBe(false);
  expect(panel.classList.contains('claudian-zen--snapped')).toBe(false);

  // Released close to its dock, the panel snaps into it and forgets the free position.
  fireEvent.pointerMove(document, { pointerId: 1, clientX: 190, clientY: 690 });
  expect(offset(panel)).toEqual(['0px', '0px']);
  expect(hint()!.classList.contains('claudian-zen-dock-hint--active')).toBe(true);
  expect(panel.classList.contains('claudian-zen--snapped')).toBe(true);
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 190, clientY: 690 });
  expect(hint()).toBeNull();
  expect(panel.classList.contains('claudian-zen--snapped')).toBe(false);
  expect(offset(panel)).toEqual(['0px', '0px']);
  await waitFor(() => expect(savedPosition()).toBeNull());

  // The grip also moves by keyboard, and Home docks it again.
  reopenedGrip.focus();
  fireEvent.keyDown(reopenedGrip, { key: 'ArrowUp' });
  fireEvent.keyDown(reopenedGrip, { key: 'ArrowRight', shiftKey: true });
  expect(offset(panel)).toEqual(['64px', '16px']);
  await waitFor(() => expect(savedPosition()).toEqual({ x: 0.064, y: 0.02 }));
  fireEvent.keyDown(reopenedGrip, { key: 'Home' });
  expect(offset(panel)).toEqual(['0px', '0px']);
  await waitFor(() => expect(savedPosition()).toBeNull());

  // Tall history lifts the panel's middle, but the composer stays low, so its menus keep opening upward.
  panelHeight = 400;
  drag(reopenedGrip, [0, 0], [0, -250]);
  expect(offset(panel)).toEqual(['0px', '250px']);
  expect(panel.classList.contains('claudian-zen--opens-below')).toBe(false);

  // Growth during a drag is rechecked on release, so the panel never stays past the top edge.
  panelHeight = 100;
  resize(panel);
  fireEvent.pointerDown(reopenedGrip, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(document, { pointerId: 1, clientX: 0, clientY: -500 });
  expect(offset(panel)).toEqual(['0px', '700px']);
  panelHeight = 300;
  resize(panel);
  expect(hint()!.style.height).toBe('300px');
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 0, clientY: -500 });
  expect(offset(panel)).toEqual(['0px', '500px']);
  await waitFor(() => expect(savedPosition()).toEqual({ x: 0, y: 0.625 }));

  // With a drawer above the composer, the hint takes the panel's stepped outline.
  panelHeight = 100;
  drawerHeight = 24;
  resize(panel);
  fireEvent.pointerDown(reopenedGrip, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  const points = outlinePoints();
  expect(Math.min(...points.map(([, y]) => y))).toBe(8);
  expect(points).toEqual(expect.arrayContaining([[37, 32], [563, 32], [8, 92], [592, 92]]));
  // The drawer can grow while a shrinking composer keeps the root's total height unchanged.
  drawerHeight = 32;
  resize(panel.querySelector('.claudian-zen-drawer')!);
  expect(Math.min(...outlinePoints().map(([, y]) => y))).toBe(0);
  fireEvent.pointerUp(document, { pointerId: 1, clientX: 0, clientY: 0 });

  // Obsidian's fixed status bar overlays the workspace; all ways home must clear it.
  const statusBar = document.body.createDiv({ cls: 'status-bar' });
  cleanups.push(() => statusBar.remove());
  statusBar.style.position = 'fixed';
  let statusLeft = 750;
  let statusHeight = 30;
  let statusBottom = 800;
  jest.spyOn(statusBar, 'getBoundingClientRect').mockImplementation(() => ({
    left: statusLeft, right: 1000, width: 1000 - statusLeft,
    top: statusBottom - statusHeight, bottom: statusBottom, height: statusHeight,
  } as DOMRect));
  workspace.trigger('layout-change');
  fireEvent.keyDown(reopenedGrip, { key: 'Home' });
  expect(offset(panel)).toEqual(['0px', '30px']);
  expect(panel.style.getPropertyValue('--claudian-zen-bottom-clearance')).toBe('30px');
  await waitFor(() => expect(savedPosition()).toBeNull());
  fireEvent.keyDown(reopenedGrip, { key: 'ArrowDown', shiftKey: true });
  expect(offset(panel)).toEqual(['0px', '30px']);
  fireEvent.keyDown(reopenedGrip, { key: 'ArrowUp', shiftKey: true });
  fireEvent.dblClick(reopenedGrip);
  expect(offset(panel)).toEqual(['0px', '30px']);

  fireEvent.pointerDown(reopenedGrip, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(document, { pointerId: 2, clientX: 100, clientY: -80 });
  expect(hint()!.style.bottom).toBe('30px');
  fireEvent.pointerMove(document, { pointerId: 2, clientX: 10, clientY: -10 });
  expect(offset(panel)).toEqual(['0px', '30px']);
  expect(hint()!.classList.contains('claudian-zen-dock-hint--active')).toBe(true);
  fireEvent.pointerUp(document, { pointerId: 2 });
  await waitFor(() => expect(savedPosition()).toBeNull());

  statusHeight = 45;
  resize(statusBar);
  expect(offset(panel)).toEqual(['0px', '45px']);
  // No overlap on the left: the old bottom edge is still available.
  for (let index = 0; index < 4; index++) fireEvent.keyDown(reopenedGrip, { key: 'ArrowLeft', shiftKey: true });
  fireEvent.keyDown(reopenedGrip, { key: 'ArrowDown', shiftKey: true });
  expect(offset(panel)).toEqual(['-200px', '0px']);
  await waitFor(() => expect(savedPosition()).toEqual({ x: -0.2, y: 0 }));
  statusLeft = 550;
  resize(statusBar);
  expect(offset(panel)).toEqual(['-200px', '45px']);
  expect(savedPosition()).toEqual({ x: -0.2, y: 0 });

  // Hidden bars (even with a stale rect), normal-flow bars, and absent bars add no clearance.
  for (const [property, value] of [['display', 'none'], ['visibility', 'hidden'], ['opacity', '0'], ['position', 'static']]) {
    statusBar.style.setProperty(property, value);
    workspace.trigger('css-change');
    expect(offset(panel)).toEqual(['-200px', '0px']);
    statusBar.style.removeProperty(property);
    statusBar.style.position = 'fixed';
    workspace.trigger('css-change');
    expect(offset(panel)).toEqual(['-200px', '45px']);
  }
  // A theme can move the fixed bar to the top; it must not consume the bottom workspace.
  statusBottom = statusHeight;
  workspace.trigger('css-change');
  expect(offset(panel)).toEqual(['-200px', '0px']);
  expect(panel.style.getPropertyValue('--claudian-zen-bottom-clearance')).toBe('0px');
  // A full-height side strip also must not collapse the panel's available height.
  statusHeight = 800;
  statusBottom = 800;
  workspace.trigger('css-change');
  expect(offset(panel)).toEqual(['-200px', '0px']);
  expect(panel.style.getPropertyValue('--claudian-zen-bottom-clearance')).toBe('0px');
  statusBar.remove();
  workspace.trigger('layout-change');
  expect(offset(panel)).toEqual(['-200px', '0px']);
  expect(savedPosition()).toEqual({ x: -0.2, y: 0 });
  expect(observers.every(observer => !observer.targets.has(statusBar))).toBe(true);
});

it('keeps the preview line on the main chat while a side chat is selected', async () => {
  const { tab, sessions, rightSplit, setCollapsed, sideChatChipHostEl } = await createZenFixture();
  tab.state.messages = [
    { id: 'u1', role: 'user', content: 'Remember A', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'Noted A', assistantMessageId: 'checkpoint-1', timestamp: 2 },
  ];
  setCollapsed(rightSplit, true);
  const panel = zenPanel()!;
  await waitFor(() => expect(preview()).not.toBe(''));
  const mainPreview = preview();

  const sideChat = tab.controllers.sideChatController;
  const started = sideChat.handleCommandSubmission('Explore B', []);
  await waitFor(() => expect(sessions.some(session => session.requests.length > 0)).toBe(true));
  const sideSession = sessions.find(session => session.requests.length > 0)!;
  expect(sideChat.destination).toBe('side');
  // Releasing the submit key is what lets zen notice the new destination.
  fireEvent.keyUp(tab.dom.inputEl as unknown as HTMLElement, { key: 'Enter' });
  const sidePanel = panel.querySelector('.claudian-side-chat-panel')!;
  expect(sidePanel.classList.contains('claudian-hidden')).toBe(false);
  expect(within(sidePanel as HTMLElement).getByRole('heading')).toBeDefined();

  // Side activity stays in the side panel; the drawer never switches to it.
  sideSession.emitText('Side progress');
  await waitFor(() => expect(sideChat.runtime!.state.currentTextContent).toContain('Side progress'));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  expect(preview()).toBe(mainPreview);
  expect(panel.querySelector('.claudian-zen-destination')).toBeNull();

  const disclosure = within(panel).getByRole('button', { name: 'Show conversation' });
  fireEvent.click(disclosure);
  fireEvent.click(disclosure);
  expect(sideChat.destination).toBe('side');

  fireEvent.keyDown(tab.dom.inputEl as unknown as HTMLElement, { key: 'Escape' });
  expect(sideSession.cancelCalls).toBe(1);
  expect(tab.state.isStreaming).toBe(false);
  await started;
  expect(sideChat.destination).toBe('side');
  expect(preview()).toBe(mainPreview);

  // Collapsed, the side chip sits below the composer rather than between it and the drawer.
  sideChat.collapse();
  const chip = panel.querySelector('.claudian-side-chat')!;
  expect(chip.parentElement!.classList.contains('claudian-zen-side-chat-chip-slot')).toBe(true);
  expect(panel.querySelector('.claudian-zen-composer')!.nextElementSibling).toBe(chip.parentElement);

  setCollapsed(rightSplit, false);
  expect(chip.parentElement).toBe(sideChatChipHostEl);
});

it('keeps the reader scroll intent through geometry-only scrolls after relocation', async () => {
  const { tab, rightSplit, setCollapsed } = await createZenFixture();
  seedHistory(tab);
  setCollapsed(rightSplit, true);
  fireEvent.click(within(zenPanel()!).getByRole('button', { name: 'Show conversation' }));
  // The reader moved away from new output.
  tab.state.autoScrollEnabled = false;

  setCollapsed(rightSplit, false);
  fireEvent.scroll(tab.dom.messagesEl);
  expect(tab.state.autoScrollEnabled).toBe(true);
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

  expect(tab.state.autoScrollEnabled).toBe(false);
});

it('keeps the last visible reading position when collapsing the sidebar hides the transcript', async () => {
  const { tab, rightSplit, setCollapsed } = await createZenFixture();
  seedHistory(tab);
  const messagesEl = tab.dom.messagesEl;
  let laidOut = true;
  Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, get: () => (laidOut ? 200 : 0) });
  Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, get: () => (laidOut ? 1000 : 0) });
  // Collapsing hides the sidebar before zen reads it, and a hidden scroller reports no offset.
  const collapse = () => {
    laidOut = false;
    messagesEl.scrollTop = 0;
    setCollapsed(rightSplit, true);
    laidOut = true;
  };
  fireEvent.wheel(messagesEl, { deltaY: -100 });
  messagesEl.scrollTop = 300;
  fireEvent.scroll(messagesEl);
  expect(tab.state.autoScrollEnabled).toBe(false);

  collapse();
  setCollapsed(rightSplit, false);
  expect(messagesEl.scrollTop).toBe(300);

  collapse();
  fireEvent.click(within(zenPanel()!).getByRole('button', { name: 'Show conversation' }));
  expect(messagesEl.scrollTop).toBe(300);
});

it('keeps a pending approval actionable while history is collapsed', async () => {
  const { tab, sessions, rightSplit, setCollapsed } = await createZenFixture();
  setCollapsed(rightSplit, true);
  const session = await sendFromZen(tab, sessions, 'Write a note');

  const approval = session.config.interactionPort.requestApproval({
    description: 'Write a note', input: {}, interactionId: 'approval-1',
    kind: 'approval', sessionInstanceId: session.sessionInstanceId,
    toolName: 'Write', turnId: session.activeTurnId,
  }, new AbortController().signal);

  await waitFor(() => expect(preview()).toBe('Needs your input'));
  const panel = zenPanel()!;
  expect(within(panel).getByRole('status').textContent).toBe('Needs your input');
  expect(within(panel).getByRole('button', { name: 'Show conversation' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(await within(panel).findByText('Allow once'));
  await expect(approval).resolves.toMatchObject({ decision: 'allow' });
  await waitFor(() => expect(preview()).not.toBe('Needs your input'));
  session.complete();
});

it('presents one source across multiple views and hands over when it reopens', async () => {
  const fixture = await createZenFixture();
  const left = await fixture.addView('left');
  fixture.setCollapsed(fixture.rightSplit, true);
  fixture.setCollapsed(fixture.leftSplit, true);

  expect(document.querySelectorAll('.claudian-zen')).toHaveLength(1);
  expect(zenPanel()!.contains(fixture.tab.dom.inputComposerEl)).toBe(true);
  expect(zenPanel()!.contains(left.tab.dom.messagesWrapperEl)).toBe(false);

  fixture.setCollapsed(fixture.rightSplit, false);
  expect(fixture.tab.dom.inputComposerEl.parentElement).toBe(fixture.activeInputSlotEl);
  expect(zenPanel()!.contains(left.tab.dom.inputComposerEl)).toBe(true);
  expect(zenPanel()!.contains(left.tab.dom.messagesWrapperEl)).toBe(true);

  fixture.setCollapsed(fixture.rightSplit, true);
  expect(zenPanel()!.contains(left.tab.dom.inputComposerEl)).toBe(true);

  fixture.setCollapsed(fixture.leftSplit, false);
  fixture.workspace.trigger('active-leaf-change', left.leaf);
  fixture.setCollapsed(fixture.leftSplit, true);
  expect(zenPanel()!.contains(fixture.tab.dom.inputComposerEl)).toBe(true);
});

it('releases every moved node and subscription on close and disposal', async () => {
  const fixture = await createZenFixture();
  const { tab, rootEl, rightSplit, setCollapsed, view, zen, workspace } = fixture;
  setCollapsed(rightSplit, true);
  expect(zenPanel()).not.toBeNull();

  view.stopZenModeSource();
  expect(zenPanel()).toBeNull();
  expect(rootEl.classList.contains('claudian-zen-host')).toBe(false);
  expect(tab.dom.inputComposerEl.parentElement).toBe(fixture.activeInputSlotEl);
  expect(tab.dom.contentEl.firstElementChild).toBe(tab.dom.messagesWrapperEl);

  view.startZenModeSource();
  expect(zenPanel()).not.toBeNull();
  zen.dispose();
  expect(zenPanel()).toBeNull();
  expect(workspace.listenerCount()).toBe(0);
  expect(screen.queryByRole('region', { name: 'Claudian chat' })).toBeNull();
});
