/** @jest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

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
import type { ClaudianSettings, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { ZenModeController } from '@/features/chat/zen/ZenModeController';

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
    const tabContentEl = viewContainerEl.createDiv({ cls: 'claudian-tab-content-container' });
    const inputFooterEl = viewContainerEl.createDiv({ cls: 'claudian-input-footer' });
    const sideChatChipHostEl = inputFooterEl.createDiv({ cls: 'claudian-side-chat-chip-slot' });
    const activeInputSlotEl = inputFooterEl.createDiv({ cls: 'claudian-active-input-slot' });
    const tab: AssembledTabRuntime = await createTabRuntime({
      plugin,
      component: Object.assign(new Component(), { registerDomEvent: () => undefined, registerEvent: () => undefined }) as never,
      containerEl: tabContentEl,
      conversation, getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
    });
    tab.state.currentConversationId = conversation.id;
    tab.dom.contentEl.removeClass('claudian-hidden');
    cleanups.push(() => destroyTab(tab));

    const leaf: Leaf = { getRoot: () => split ?? layout.rootSplit, view: null };
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin, app, leaf, viewContainerEl, tabContentEl, inputFooterEl, sideChatChipHostEl, activeInputSlotEl,
      activeInputTabId: null,
      containerEl: viewContainerEl,
      isWideSessionLayout: false,
      viewLifecycleRevision: 1,
      initializedTabWorkspaceLifecycleRevision: ready ? 1 : -1,
      tabManager: {
        getActiveTab: () => tab,
        getTab: (id: string) => id === tab.id ? tab : null,
        getTabCount: () => 1,
      },
    });
    leaf.view = view;
    layout.leaves.push(leaf);
    view.updateInputLocation();
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

  fixture.view.initializedTabWorkspaceLifecycleRevision = 1;
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
  fireEvent.keyDown(tab.dom.inputEl as unknown as HTMLElement, { key: 'Escape' });

  expect(session.cancelCalls).toBe(1);
  await waitFor(() => expect(preview()).toBe('Interrupted'));
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
