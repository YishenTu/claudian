/** @jest-environment jsdom */
import '@/providers';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { FakeSideBackend } from '@test/helpers/features/chat/SideChatSessionHarness';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, Component } from 'obsidian';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage, ClaudianSettings, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { PromptHistoryNavigation } from '@/features/chat/tabs/PromptHistoryNavigation';
import { activateTab, destroyTab } from '@/features/chat/tabs/TabLifecycle';
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

async function createView(provisional = false) {
  const backend = new FakeSideBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref() {} });
  Object.assign(app.workspace, { getActiveViewOfType: () => null });
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
    getActiveEnvironmentVariables: () => '', getConversationSummary: () => conversation,
    getConversationSync: () => conversation, getConversationById: async () => conversation,
    getConversationList: () => [conversation], renameConversation: async () => {},
    updateConversation: async (_id: string, patch: unknown) => { saved.push(structuredClone(patch)); },
    mutateSettings: async (mutate: (value: ClaudianSettings) => void) => mutate(settings),
    chatModelSelection: { beginIntent: () => 1, commitIntent: async () => true },
  } as unknown as ChatFeatureHost;
  const tab = await createTabRuntime({
    plugin, conversation, component: new Component(), containerEl: document.body.createDiv(),
    mentionDataProvider: new VaultMentionDataProvider(app), getProviderCatalogConfig: () => null,
    isRuntimeLive: () => true, lifecycleState: provisional ? 'provisional' : 'open',
  });
  tab.hydrationState = 'ready';
  await tab.executionCoordinator.bindConversation({ conversationId: conversation.id, providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  activateTab(tab);
  tab.dom.inputEl.focus();
  return { tab, backend, saved, conversation,
    dispose: async () => { await destroyTab(tab); await lifecycle.dispose(); },
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
    const knownFingerprints = ['.claudian-input', '.cm-content'].map(target => JSON.stringify({
      rule: 'aria-allowed-attr', target: [target],
      any: [], all: [{ id: 'aria-allowed-attr', data: ['aria-expanded="false"'] }], none: [],
    })).sort();
    expect(accessibilityFingerprints(baselineAccessibility)).toEqual(knownFingerprints);
    expect(key(view, 'ArrowUp').defaultPrevented).toBe(true);
    expect(view.tab.dom.inputEl.value).toBe('Earlier prompt');
    expect(textbox(view).textContent).toBe('Earlier prompt');
    // The existing dropdown binding writes aria-expanded on a textbox; recall must add no violations.
    await Promise.resolve();
    expect(accessibilityFingerprints(await axe(view.tab.dom.inputComposerEl)))
      .toEqual(accessibilityFingerprints(baselineAccessibility));
    const focusedTextbox = textbox(view);
    focusedTextbox.setAttribute('aria-checked', 'false');
    const withFault = await axe(view.tab.dom.inputComposerEl);
    expect(withFault.violations.map(violation => violation.id)).toEqual(baselineAccessibility.violations.map(violation => violation.id));
    expect(withFault.violations.flatMap(violation => violation.nodes.map(node => node.target)))
      .toEqual(baselineAccessibility.violations.flatMap(violation => violation.nodes.map(node => node.target)));
    expect(accessibilityFingerprints(withFault)).not.toEqual(knownFingerprints);
    focusedTextbox.removeAttribute('aria-checked');
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
    expect(view.tab.dom.inputEl.value).toBe('First\nmultiline');
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
  const view = await createView();
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    view.tab.session.bindConversation('other-conversation', 'claude');
    view.tab.session.bindConversation(view.conversation.id, 'claude');
    key(view, 'Escape');
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
    view.tab.dom.inputEl.value = ''; fireEvent.input(view.tab.dom.inputEl);
    view.tab.state.messages = [user('replacement', 'New conversation text')];
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('New conversation text');
  } finally { await view.dispose(); }
});

it('keeps IME suppression until compositionend despite input and identity resets', async () => {
  const view = await createView();
  try {
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    fireEvent.compositionStart(textbox(view));
    key(view, 'Escape', { isComposing: false });
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
    view.tab.dom.inputEl.focus();
    view.tab.dom.inputEl.value = '';
    fireEvent.input(view.tab.dom.inputEl);
    view.tab.session.bindConversation('other-conversation', 'claude');
    view.tab.session.bindConversation(view.conversation.id, 'claude');
    expect(key(view, 'ArrowUp', { isComposing: false }).inputPrevented).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('');
    fireEvent.compositionEnd(textbox(view));
    key(view, 'ArrowUp');
    expect(view.tab.dom.inputEl.value).toBe('Existing prompt');
  } finally { await view.dispose(); }
});

it('retains a provisional tab and runs input lifecycle when recall opens a real command menu', async () => {
  const view = await createView(true);
  try {
    view.tab.state.messages = [user('one', '/res')];
    expect(view.tab.lifecycleState).toBe('provisional');
    const changed = jest.spyOn(view.tab.controllers.sideChatController, 'handleComposerInput');
    const refreshed = jest.spyOn(view.tab.ui.promptSuggestion, 'refresh');
    key(view, 'ArrowUp');
    expect(view.tab.lifecycleState).toBe('open');
    expect(changed).toHaveBeenCalled();
    expect(refreshed).toHaveBeenCalled();
    await waitFor(() => expect(within(view.tab.dom.inputContainerEl).getByRole('option', { name: /\/resume/ })).toBeDefined());
    expect(view.tab.ui.composerDropdown.isVisible()).toBe(true);
    key(view, 'ArrowDown');
    expect(view.tab.dom.inputEl.value).toBe('/res');
    key(view, 'Escape');
    expect(view.tab.ui.composerDropdown.isVisible()).toBe(false);
    expect(view.tab.dom.inputEl.value).toBe('/res');
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
    const started = jest.spyOn(PromptHistoryNavigation.prototype, 'handleCompositionStart');
    const ended = jest.spyOn(PromptHistoryNavigation.prototype, 'handleCompositionEnd');
    view.tab.state.messages = [user('one', 'Existing prompt')];
    key(view, 'ArrowUp');
    expect(keydown).toHaveBeenCalled();
    fireEvent.compositionStart(textbox(view)); fireEvent.compositionEnd(textbox(view));
    expect(started).toHaveBeenCalled(); expect(ended).toHaveBeenCalled();
    const retainedInput = view.tab.dom.inputEl;
    await view.dispose();
    keydown.mockClear(); started.mockClear(); ended.mockClear();
    fireEvent.keyDown(retainedInput, { key: 'ArrowUp' });
    fireEvent.compositionStart(retainedInput); fireEvent.compositionEnd(retainedInput);
    expect(keydown).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
  } finally { await view.dispose(); }
});

it('preserves real prediction acceptance priority and refreshes the ghost after restoring recalled text', async () => {
  const view = await createView();
  try {
    const turnId = await completeTurn(view, 'Original prompt');
    view.backend.latest.emitSessionEvent({ type: 'prompt_suggestion', originatingTurnId: turnId, suggestion: 'Suggested next prompt' });
    expect(within(view.tab.dom.inputEl).getByText('Suggested next prompt')).toBeDefined();
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
