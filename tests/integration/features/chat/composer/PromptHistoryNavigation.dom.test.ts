/** @jest-environment jsdom */
import '@/providers';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';
import { installSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, Component } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { type ChatMessage, type ClaudianSettings, type Conversation, isCanonicalUserMessage } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { PromptHistoryNavigation } from '@/features/chat/composer/PromptHistoryNavigation';
import { activateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
const hiddenStyle = document.head.appendChild(document.createElement('style'));
hiddenStyle.textContent = readFileSync(join(process.cwd(), 'src/style/base/visibility.css'), 'utf8');
afterAll(() => hiddenStyle.remove());
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
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
afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

async function createView(provisional = false, options: { managed?: boolean; draft?: boolean } = {}) {
  const backend = new FakeSideBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref() {} });
  Object.assign(app.workspace, { getActiveViewOfType: () => null, getActiveFile: () => null, on: () => ({}), offref() {} });
  Object.assign(app, { metadataCache: { on: () => ({}), offref() {} } });
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const settings = {
    model: 'claude-sonnet-4-5', effortLevel: 'high', permissionMode: 'manual',
    enableAutoTitleGeneration: false, excludedTags: [], mediaFolder: '', systemPrompt: '', userName: '',
    providerConfigs: { claude: {
      ...claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'high']), promptSuggestions: true,
    } },
  } as unknown as ClaudianSettings;
  const conversation = {
    id: 'conversation-1', providerId: 'claude', selectedModel: 'claude-sonnet-4-5',
    sessionId: 'main-session', messages: [], title: 'Existing conversation',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  } as unknown as Conversation;
  const saved: unknown[] = [];
  const conversations = new Map([
    [conversation.id, conversation],
    ['other-conversation', { ...conversation, id: 'other-conversation', sessionId: 'other-session' }],
  ]);
  const plugin = {
    app, settings,
    providerHost: {
      app, settings, executionLifecycleRegistry: lifecycle,
      getResolvedProviderCliPath: async () => '/bin/claude', getActiveEnvironmentVariables: () => '',
    },
    executionPersistence: {
      registerExecutionBinding() {}, releaseExecutionBinding() {},
      assertConversationExecutionAuthority: async () => {},
      persistExecutionSnapshot: async (...args: unknown[]) => { saved.push(structuredClone(args)); return true; },
      recordConversationActivity: async () => {},
    },
    getSessionSnapshotDirectory: () => '/tmp/claudian-sessions', getCommittedSettings: () => settings,
    getActiveEnvironmentVariables: () => '', getConversationSummary: (id: string) => conversations.get(id),
    getConversationSync: (id: string) => conversations.get(id), getCachedConversation: (id: string) => conversations.get(id),
    getConversationById: async (id: string) => conversations.get(id), findConversationAcrossViews: () => null,
    getConversationList: () => [conversation], renameConversation: async () => {},
    updateConversation: async (_id: string, patch: unknown) => { saved.push(structuredClone(patch)); },
    mutateSettings: async (mutate: (value: ClaudianSettings) => void) => mutate(settings),
    chatModelSelection: { beginIntent: () => 1, commitIntent: async () => true },
  } as unknown as ChatFeatureHost;
  const pool = installSessionRuntimePool(plugin);
  const component = new Component();
  const containerEl = document.body.createDiv();
  const manager = options.managed ? new TabManager(plugin, containerEl, component as never, {}, new VaultMentionDataProvider(app)) : null;
  const tab = manager ? (await manager.createTab(conversation.id))! : await createTabRuntime({
    plugin, conversation: options.draft ? undefined : conversation, component, containerEl,
    mentionDataProvider: new VaultMentionDataProvider(app), getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true, lifecycleState: provisional ? 'provisional' : 'open',
    openConversation: async () => {}, startNewConversation: async () => {},
  });
  tab.hydrationState = 'ready';
  if (!options.draft) {
    await tab.executionCoordinator.bindConversation({ conversationId: conversation.id, providerId: 'claude' });
    await tab.executionCoordinator.prepare();
  }
  jest.spyOn(tab.dom.messagesEl, 'getClientRects').mockImplementation(() =>
    (tab.dom.contentEl.classList.contains('claudian-hidden') ? [] : [{}]) as unknown as DOMRectList);
  activateTab(tab);
  tab.dom.inputEl.focus();
  return { get tab() { return manager?.getActiveTab() ?? tab; }, backend, saved, conversation, manager, plugin,
    dispose: async () => { if (manager) await manager.destroy(); else await destroyTab(tab); await pool.dispose(); await lifecycle.dispose(); },
  };
}

type View = Awaited<ReturnType<typeof createView>>;
function textbox(view: View): HTMLElement { return within(view.tab.dom.inputEl).getByRole('textbox'); }
function key(view: View, name: string, options: KeyboardEventInit = {}): KeyboardEvent & { inputPrevented: boolean } {
  const event = Object.assign(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true, ...options }), { inputPrevented: false });
  const observe = () => { event.inputPrevented = event.defaultPrevented; };
  view.tab.dom.inputEl.addEventListener('keydown', observe, true);
  textbox(view).dispatchEvent(event);
  view.tab.dom.inputEl.removeEventListener('keydown', observe, true);
  return event;
}
function type(view: View, text: string): void {
  fireEvent.paste(textbox(view), { clipboardData: { getData: () => text, files: [] } });
}
function user(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content, timestamp: testDate().getTime(), ...extra };
}

function accessibilityFingerprints(result: Awaited<ReturnType<typeof axe>>): string[] {
  const checks = (values: typeof result.violations[number]['nodes'][number]['any']) => values
    .map(check => ({ id: check.id, data: check.data })).sort((left, right) => left.id.localeCompare(right.id));
  return result.violations.flatMap(violation => violation.nodes.map(node => JSON.stringify({
    rule: violation.id, target: node.target,
    any: checks(node.any), all: checks(node.all), none: checks(node.none),
  }))).sort();
}

async function completeTurn(view: View, text: string): Promise<string> {
  type(view, text);
  const pending = view.tab.controllers.inputController.sendMessage();
  await waitFor(() => expect(view.backend.latest.getStatus()).toBe('executing'));
  const turnId = view.backend.latest.activeTurnId;
  view.backend.latest.emitText('Completed answer'); view.backend.latest.complete();
  await pending;
  return turnId;
}

it('resets recalled history when the first send promotes the same presentation to a conversation', async () => {
  const view = await createView(false, { draft: true });
  let entered!: () => void;
  let release!: (conversation: Conversation) => void;
  const creationEntered = new Promise<void>(resolve => { entered = resolve; });
  const created = new Promise<Conversation>(resolve => { release = resolve; });
  view.plugin.createConversation = async () => { entered(); return created; };
  let pending: Promise<void> | undefined;
  try {
    expect(view.tab.state.messages).toEqual([]);
    const input = view.tab.dom.inputEl;
    const navigator = view.tab.controllers.promptHistoryNavigation;
    type(view, 'Promotion prompt');
    pending = view.tab.controllers.inputController.sendMessage();
    await creationEntered;
    await waitFor(() => expect(view.tab.state.messages.filter(isCanonicalUserMessage))
      .toEqual([expect.objectContaining({ content: 'Promotion prompt' })]));
    expect(input.value).toBe('');
    expect(view.tab.state.currentConversationId).toBeNull();
    key(view, 'ArrowUp');
    expect(input.value).toBe('Promotion prompt');
    release(view.conversation);
    await waitFor(() => expect(view.tab.state.currentConversationId).toBe(view.conversation.id));
    expect(view.tab.session.conversationId).toBe(view.conversation.id);
    expect(view.tab.dom.inputEl).toBe(input);
    expect(view.tab.controllers.promptHistoryNavigation).toBe(navigator);
    key(view, 'Escape');
    expect(input.value).toBe('Promotion prompt');
  } finally {
    release(view.conversation);
    try { await pending; } finally { await view.dispose(); }
  }
});

it.each([false, true])('restores history before the actual View Scope consumes Escape (Main busy: %s)', async busy => {
  const view = await createView();
  let pending: Promise<void> | undefined;
  try {
    view.tab.state.messages = [user('previous', 'Previous prompt')];
    if (busy) {
      type(view, 'Running prompt');
      pending = view.tab.controllers.inputController.sendMessage();
    }
    await waitFor(() => expect(view.backend.latest.getStatus()).toBe(busy ? 'executing' : 'idle'));
    expect(view.tab.state.isStreaming).toBe(busy);
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe(busy ? 'Running prompt' : 'Previous prompt');
    const native = view.backend.latest;
    const cancellations = native.cancelCalls;
    const root = createClaudianView({ host: view.plugin, containerEl: view.tab.dom.contentEl,
      contentEl: view.tab.dom.contentEl, tabManager: { getActiveTab: () => view.tab } });
    root.wireEventHandlers();
    const handler = root.scope.handlers.find((entry: { key: string }) => entry.key === 'Escape');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    // Obsidian consumes a false-returning Scope handler before the same event reaches the DOM.
    expect(handler.func(event)).toBe(false);
    event.preventDefault();
    textbox(view).dispatchEvent(event);
    expect(view.tab.dom.inputEl.value).toBe('');
    expect(native.cancelCalls).toBe(cancellations);
    expect(native.getStatus()).toBe(busy ? 'executing' : 'idle');
    if (busy) {
      native.emitText('Completed answer'); native.complete();
      await pending;
    }
  } finally { await view.dispose(); }
});

it('recalls and resends visible user text through the real input controller and persistence port', async () => {
  const view = await createView();
  try {
    type(view, 'Earlier prompt');
    key(view, 'Enter');
    await waitFor(() => expect(view.backend.latest.requests).toHaveLength(1));
    view.backend.latest.emitText('First answer'); view.backend.latest.complete();
    await waitFor(() => expect(view.tab.state.isStreaming).toBe(false));
    expect(view.tab.dom.inputEl.value).toBe('');
    await Promise.resolve();
    const baselineAccessibility = await axe(view.tab.dom.inputComposerEl);
    expect(baselineAccessibility).toHaveNoViolations();
    expect(accessibilityFingerprints(baselineAccessibility)).toEqual([]);
    const allowedAttributes = { runOnly: { type: 'rule' as const, values: ['aria-allowed-attr'] } };
    expect(accessibilityFingerprints(await axe(view.tab.dom.inputComposerEl, allowedAttributes))).toEqual([]);
    expect(key(view, 'ArrowUp').defaultPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('Earlier prompt');
    expect(textbox(view).textContent).toBe('Earlier prompt');
    // Recall preserves the real multiline textbox and the complete composer's accessibility.
    await Promise.resolve();
    const recalledAccessibility = await axe(view.tab.dom.inputComposerEl);
    expect(recalledAccessibility).toHaveNoViolations();
    expect(accessibilityFingerprints(recalledAccessibility)).toEqual([]);
    expect(accessibilityFingerprints(await axe(view.tab.dom.inputComposerEl, allowedAttributes))).toEqual([]);
    const focusedTextbox = within(view.tab.dom.inputComposerEl).getByRole('textbox', { name: 'Message' });
    expect(within(view.tab.dom.inputComposerEl).getAllByRole('textbox')).toEqual([focusedTextbox]);
    expect(focusedTextbox).toBe(textbox(view));
    expect(focusedTextbox.getAttribute('aria-multiline')).toBe('true');
    expect(focusedTextbox.textContent).toBe('Earlier prompt');
    try {
      focusedTextbox.setAttribute('aria-checked', 'false');
      const withFault = await axe(view.tab.dom.inputComposerEl, allowedAttributes);
      expect(accessibilityFingerprints(withFault)).toEqual([JSON.stringify({
        rule: 'aria-allowed-attr', target: ['.cm-content'],
        any: [], all: [{ id: 'aria-allowed-attr', data: ['aria-checked="false"'] }], none: [],
      })]);
    } finally {
      focusedTextbox.removeAttribute('aria-checked');
    }
    expect(await axe(view.tab.dom.inputComposerEl)).toHaveNoViolations();
    view.saved.length = 0;
    key(view, 'Enter');
    await waitFor(() => expect(view.backend.latest.requests).toHaveLength(2));
    expect(view.backend.latest.requests[1].input).toEqual([{ type: 'text', text: 'Earlier prompt' }]);
    view.backend.latest.emitText('Second answer'); view.backend.latest.complete();
    await waitFor(() => expect(view.tab.state.isStreaming).toBe(false));
    expect(view.tab.state.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Earlier prompt', 'Earlier prompt']);
    await waitFor(() => expect(view.saved).toContainEqual(expect.objectContaining({ messages: expect.any(Array) })));
    const snapshots = view.saved.flatMap(value => Array.isArray(value) ? value : [value])
      .filter((value): value is { messages: ChatMessage[] } => typeof value === 'object' && value !== null
        && 'messages' in value && Array.isArray(value.messages));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)!.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Earlier prompt', 'Earlier prompt']);
  } finally { await view.dispose(); }
});

it.each([
  { name: 'whitespace', text: ' \n ', options: {} },
  { name: 'non-empty draft', text: 'Draft', options: {} },
  { name: 'Shift', text: '', options: { shiftKey: true } },
  { name: 'Alt', text: '', options: { altKey: true } },
  { name: 'Control', text: '', options: { ctrlKey: true } },
  { name: 'Meta', text: '', options: { metaKey: true } },
  { name: 'event composition', text: '', options: { isComposing: true } },
])('leaves $name ArrowUp to the editor', async ({ text, options }) => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    if (text) type(view, text);
    expect(key(view, 'ArrowUp', options).inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe(text);
  } finally { await view.dispose(); }
});

it('leaves selection, empty history, initial Down, and inactive Escape to native behavior', async () => {
  const view = await createView();
  try {
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    view.tab.state.messages = [user('one', 'Existing prompt')];
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('');
    view.tab.dom.inputEl.focus();
    type(view, 'Selected draft');
    view.tab.dom.inputEl.selectionStart = 0;
    view.tab.dom.inputEl.selectionEnd = 8;
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('Selected draft');
  } finally { await view.dispose(); }
});

it('navigates in order, leaves the oldest boundary native, and restores the empty draft at the newest boundary', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('old', 'First\nmultiline'), user('new', 'Latest prompt')];
    expect(key(view, 'ArrowUp').inputPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('Latest prompt');
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('First\nmultiline');
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('First\nmultiline');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    key(view, 'ArrowDown');
    expect(view.tab.dom.inputEl.value).toBe('Latest prompt');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    key(view, 'ArrowUp');
    expect(key(view, 'Escape').inputPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('');
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('');
  } finally { await view.dispose(); }
});

it('moves the caret natively inside recalled multiline text and navigates only from its first or last line', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('old', 'Older prompt'), user('new', 'First line\nSecond line')];
    const input = view.tab.dom.inputEl;
    key(view, 'ArrowUp');
    expect(input.value).toBe('First line\nSecond line');
    expect(input.selectionStart).toBe(input.value.length);
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    expect(input.selectionStart).toBeLessThan('First line\n'.length);
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    expect(input.selectionStart).toBeGreaterThanOrEqual('First line\n'.length);
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    expect(key(view, 'ArrowUp').inputPrevented).toBe(true);
    expect(input.value).toBe('Older prompt');
    key(view, 'ArrowDown');
    expect(input.value).toBe('First line\nSecond line');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(true);
    expect(input.value).toBe('');
  } finally { await view.dispose(); }
});

it('moves through soft-wrapped rows of recalled text before navigating', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('old', 'Older prompt'), user('new', 'A long prompt that wraps')];
    const input = view.tab.dom.inputEl;
    // jsdom has no layout; stand in for the editor's rendered-row measurement.
    let caretRow = 3;
    input.isCaretOnEdgeRow = direction => (direction === 'up' ? caretRow === 1 : caretRow === 3);
    key(view, 'ArrowUp');
    expect(input.value).toBe('A long prompt that wraps');
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    caretRow = 2;
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    caretRow = 1;
    expect(key(view, 'ArrowUp').inputPrevented).toBe(true);
    expect(input.value).toBe('Older prompt');
  } finally { await view.dispose(); }
});

it('recalls only prompts shown before the branch point while editing an earlier prompt', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [
      user('first', 'First prompt', { userMessageId: 'u1' }),
      user('edited', 'Edited prompt', { userMessageId: 'u2' }),
      user('later', 'Later prompt', { userMessageId: 'u3' }),
    ];
    await view.tab.controllers.conversationController.navigateBranch('edited');
    expect(view.tab.controllers.conversationController.hasBranchDraft).toBe(true);
    const input = view.tab.dom.inputEl;
    expect(input.value).toBe('Edited prompt');
    input.focus();
    input.value = ''; fireEvent.input(input);
    key(view, 'ArrowUp');
    expect(input.value).toBe('First prompt');
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    view.tab.controllers.conversationController.cancelBranchDraft();
    input.focus();
    input.value = ''; fireEvent.input(input);
    key(view, 'ArrowUp');
    expect(input.value).toBe('Later prompt');
  } finally { await view.dispose(); }
});

it('recalls visible canonical user text with display and context fallbacks, excluding only hidden or noncanonical entries', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [
      user('raw', 'Raw fallback'),
      user('context', 'Context-visible text\n\n<context_files>private metadata</context_files>'),
      user('shown', 'Native wrapped text', { displayContent: 'Shown\nmultiline text' }),
      user('command', '/clear'),
      user('steer', 'Visible appended input'),
      user('hidden', 'Hidden native turn', { displayContent: '' }),
      user('image-only', '', { images: [{ id: 'image', name: 'image.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste' }] }),
      user('interrupt', 'Interrupted content', { isInterrupt: true }),
      user('rebuilt', 'Rebuilt content', { isRebuiltContext: true }),
      { id: 'assistant', role: 'assistant', content: 'Assistant text', timestamp: testDate().getTime() },
    ];
    for (const expected of ['Visible appended input', '/clear', 'Shown\nmultiline text', 'Context-visible text', 'Raw fallback']) {
      key(view, 'ArrowUp');
      expect(view.tab.dom.inputEl.value).toBe(expected);
      if (view.tab.ui.composerDropdown.isVisible()) key(view, 'Escape');
      // Leave recalled multiline text through its first line.
      if (expected.includes('\n')) key(view, 'ArrowUp');
    }
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
  } finally { await view.dispose(); }
});

it.each(['delete', 'edit'] as const)('withdraws stale recalled text after a transcript %s', async mutation => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('old', 'Retained prompt'), user('new', 'Obsolete prompt')];
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Obsolete prompt');
    view.tab.state.messages = mutation === 'delete' ? [user('old', 'Retained prompt')]
      : [user('old', 'Retained prompt'), user('new', 'Edited prompt')];
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('');
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe(mutation === 'delete' ? 'Retained prompt' : 'Edited prompt');
  } finally { await view.dispose(); }
});

it('abandons navigation after real user edits and retains the edited text on Escape or Down', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    type(view, ' edited');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt edited');
  } finally { await view.dispose(); }
});

it('resets on a conversation identity round trip without intervening keys', async () => {
  const view = await createView(false, { managed: true });
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    await view.manager!.openConversation('other-conversation');
    await view.manager!.openConversation(view.conversation.id);
    view.tab.dom.inputEl.focus();
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
    view.tab.dom.inputEl.value = ''; fireEvent.input(view.tab.dom.inputEl);
    view.tab.state.messages = [user('replacement', 'New conversation text')];
    // Inactive Escape moved focus to the transcript; a new recall starts from the composer again.
    view.tab.dom.inputEl.focus();
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('New conversation text');
  } finally { await view.dispose(); }
});

it('keeps IME suppression until compositionend despite input and identity resets', async () => {
  const view = await createView(false, { draft: true });
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    fireEvent.compositionStart(textbox(view));
    key(view, 'Escape', { isComposing: false });
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
    view.tab.dom.inputEl.focus();
    view.tab.dom.inputEl.value = '';
    fireEvent.input(view.tab.dom.inputEl);
    view.tab.session.runtime.selectDraft('claude', 'different-draft-model');
    view.tab.session.runtime.selectDraft('claude', 'claude-sonnet-4-5');
    expect(key(view, 'ArrowUp', { isComposing: false }).inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('');
    fireEvent.compositionEnd(textbox(view));
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
  } finally { await view.dispose(); }
});

it('treats recall like typing without admitting a provisional tab and opens a real command menu', async () => {
  const view = await createView(true);
  try {
    view.tab.state.messages = [user('one', '/ses')];
    expect(view.tab.lifecycleState).toBe('provisional');
    const changed = jest.spyOn(view.tab.controllers.sideChatController, 'handleComposerInput');
    const refreshed = jest.spyOn(view.tab.ui.promptSuggestion, 'refresh');
    key(view, 'ArrowUp');
    expect(view.tab.lifecycleState).toBe('provisional');
    expect(changed).toHaveBeenCalled();
    expect(refreshed).toHaveBeenCalled();
    await waitFor(() => expect(within(view.tab.dom.inputContainerEl).getByRole('option', { name: /\/sessions/ })).toBeDefined());
    expect(view.tab.ui.composerDropdown.isVisible()).toBe(true);
    key(view, 'ArrowDown');
    expect(view.tab.dom.inputEl.value).toBe('/ses');
    key(view, 'Escape');
    expect(view.tab.ui.composerDropdown.isVisible()).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('/ses');
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('');
  } finally { await view.dispose(); }
});

it('gives the actual resume picker and toolbar menu priority over active history Escape', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    const modelButton = within(view.tab.dom.inputWrapper).getByRole('button', { name: /Model: / });
    fireEvent.click(modelButton);
    expect(modelButton.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(modelButton.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(modelButton);
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
    view.tab.dom.inputEl.focus();
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('');
    view.tab.dom.inputEl.focus();
    view.tab.dom.inputEl.value = '/resume';
    key(view, 'Enter');
    await waitFor(() => expect(within(view.tab.dom.inputContainerEl).getByRole('listbox', { name: 'Resume conversation' })).toBeDefined());
    view.tab.dom.inputEl.value = '';
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('');
    key(view, 'Escape');
    expect(within(view.tab.dom.inputContainerEl).queryByRole('listbox', { name: 'Resume conversation' })).toBeNull();
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
  } finally { await view.dispose(); }
});

it('updates the actual Side draft preview on recall and draft restoration without starting a child', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('side-preview', '/side Explore another approach')];
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputWrapper.classList.contains('claudian-input-side-chat-preview')).toBe(true);
    expect(view.tab.controllers.sideChatController.runtime).toBeNull();
    expect(view.backend.sessions).toHaveLength(1);
    key(view, 'ArrowDown');
    expect(view.tab.dom.inputEl.value).toBe('');
    expect(view.tab.dom.inputWrapper.classList.contains('claudian-input-side-chat-preview')).toBe(false);
    expect(view.tab.controllers.sideChatController.runtime).toBeNull();
  } finally { await view.dispose(); }
});

it('removes owned history keyboard and composition listeners when the real tab is destroyed', async () => {
  const view = await createView();
  try {
    const keydown = jest.spyOn(PromptHistoryNavigation.prototype, 'handleKeydown');
    const reset = jest.spyOn(PromptHistoryNavigation.prototype, 'reset');
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    expect(keydown).toHaveBeenCalled();
    fireEvent.compositionStart(textbox(view)); fireEvent.compositionEnd(textbox(view));
    expect(reset).toHaveBeenCalled();
    const retainedInput = view.tab.dom.inputEl;
    await view.dispose();
    keydown.mockClear(); reset.mockClear();
    fireEvent.keyDown(retainedInput, { key: 'ArrowUp' });
    fireEvent.compositionStart(retainedInput); fireEvent.compositionEnd(retainedInput);
    expect(keydown).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  } finally { await view.dispose(); }
});

it('preserves real prediction acceptance priority and refreshes the ghost after restoring recalled text', async () => {
  const view = await createView();
  try {
    const turnId = await completeTurn(view, 'Original prompt');
    view.backend.latest.emitSessionEvent({ type: 'prompt_suggestion', originatingTurnId: turnId, suggestion: 'Suggested next prompt' });
    await waitFor(() => expect(within(view.tab.dom.inputEl).getByText('Suggested next prompt')).toBeDefined());
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Original prompt');
    expect(within(view.tab.dom.inputEl).queryByText('Suggested next prompt')).toBeNull();
    key(view, 'ArrowDown');
    expect(within(view.tab.dom.inputEl).getByText('Suggested next prompt')).toBeDefined();
    key(view, 'Tab');
    expect(view.tab.dom.inputEl.value).toBe('Suggested next prompt');
    expect(view.backend.latest.requests).toHaveLength(1);
  } finally { await view.dispose(); }
});

it('never recalls parent or child text in Side and resets history on a real Main-Side-Main round trip', async () => {
  const view = await createView();
  try {
    await completeTurn(view, 'Parent prompt');
    const parent = view.backend.latest;
    await completeTurn(view, '/side Independent child prompt');
    expect(view.backend.sessions).toHaveLength(2);
    expect(parent.requests).toHaveLength(1);
    expect(view.tab.controllers.sideChatController.destination).toBe('side');
    expect(key(view, 'ArrowUp').inputPrevented).toBe(false);
    key(view, 'Escape');
    view.tab.dom.inputEl.focus();
    expect(view.tab.dom.inputEl.value).toBe('');
    view.tab.controllers.sideChatController.collapse();
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
    view.tab.controllers.sideChatController.expand();
    view.tab.controllers.sideChatController.collapse();
    key(view, 'Escape');
    view.tab.dom.inputEl.focus();
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
    expect(key(view, 'ArrowDown').inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
    view.tab.dom.inputEl.value = ''; fireEvent.input(view.tab.dom.inputEl);
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Parent prompt');
  } finally { await view.dispose(); }
});

it('does not recall when an earlier capturing listener consumed the key', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    view.tab.dom.inputComposerEl.addEventListener('keydown', event => event.preventDefault(), { capture: true, once: true });
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('');
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
  } finally { await view.dispose(); }
});
