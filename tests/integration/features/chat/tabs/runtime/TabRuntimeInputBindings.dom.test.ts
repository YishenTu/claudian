/** @jest-environment jsdom */
import '@/providers';

import { holdResponse } from '@test/helpers/ConversationPorts';
import { installSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { createHarness, releaseSideChatHarnesses } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, getByRole, waitFor } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { App, Component } from 'obsidian';

import type { ChatMessage, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
let tab: AssembledTabRuntime;
let plugin: ChatFeatureHost;
let harness: ReturnType<typeof createHarness>;
let releaseResponse: () => Promise<void>;

beforeEach(async () => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  harness = createHarness();
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref: () => undefined });
  const conversation = {
    id: 'conversation-1', providerId: 'claude', selectedModel: 'claude-sonnet-4-5',
    sessionId: 'main-session', messages: [],
  } as unknown as Conversation;
  plugin = {
    ...(harness.plugin as ChatFeatureHost), app,
    getCommittedSettings: () => plugin.settings,
    settings: {
      model: 'claude-sonnet-4-5', permissionMode: 'normal',
      keyboardNavigation: { focusInputKey: 'i', scrollUpKey: 'w', scrollDownKey: 's' },
      providerConfigs: { claude: { enabled: true, visibleModels: ['claude-sonnet-4-5'],
        discoveredModels: [{ value: 'claude-sonnet-4-5', label: 'Sonnet' }] } },
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => conversation,
    getConversationSync: () => conversation,
    getConversationList: () => [conversation],
    renameConversation: async () => undefined,
    updateConversation: async () => undefined,
    executionPersistence: {
      registerExecutionBinding: () => {}, releaseExecutionBinding: () => {},
      persistExecutionSnapshot: async () => true, assertConversationExecutionAuthority: async () => {},
      recordConversationActivity: async () => {},
    },
  } as unknown as ChatFeatureHost;
  installSessionRuntimePool(plugin);
  tab = await createTabRuntime({
    plugin, conversation, component: new Component(),
    containerEl: document.body.createDiv(),
    mentionDataProvider: new VaultMentionDataProvider(app),
    getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
    openConversation: async () => {}, startNewConversation: async () => {},
  });
  jest.useFakeTimers();
  releaseResponse = holdResponse(tab.session.turns);
  Object.defineProperties(tab.dom.messagesEl, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, writable: true, value: 1000 },
  });
  tab.dom.messagesEl.scrollTop = 500;
});

afterEach(async () => {
  await destroyTab(tab);
  jest.useRealTimers();
  globalThis.ResizeObserver = originalResizeObserver;
  await releaseSideChatHarnesses();
});

function setScrollHeight(height: number): void {
  Object.defineProperty(tab.dom.messagesEl, 'scrollHeight', { configurable: true, value: height });
}

async function streamText(): Promise<void> {
  await tab.controllers.streamController.handleStreamChunk(
    { type: 'text', content: 'continued' },
    { content: '', role: 'assistant' } as ChatMessage,
  );
}

it('routes Escape through the selected main session for published jobs-only work', async () => {
  await releaseResponse();
  await tab.executionCoordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  const native = harness.backend.latest;
  let working = true;
  Object.assign(native, { hasBackgroundWork: () => working });
  native.emitSessionEvent({ type: 'session_state_changed', snapshot: native.getSnapshot() });
  expect(tab.state.isStreaming).toBe(false);
  expect(tab.session.isWorking).toBe(true);
  expect(tab.session.hasMainBackgroundWork).toBe(true);
  const input = getByRole(tab.dom.inputComposerEl, 'textbox');
  expect(tab.controllers.sideChatController.destination).toBe('main');
  expect(tab.ui.composerDropdown.isVisible()).toBe(false);
  // An earlier capture listener (e.g. an open menu) that consumed Escape owns it.
  const consumeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') event.preventDefault(); };
  document.addEventListener('keydown', consumeEscape, true);
  try {
    fireEvent.keyDown(input, { key: 'Escape' });
  } finally {
    document.removeEventListener('keydown', consumeEscape, true);
  }
  expect(native.cancelCalls).toBe(0);
  expect(tab.session.hasMainBackgroundWork).toBe(true);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(native.cancelCalls).toBe(1);
  working = false;
  native.emitSessionEvent({ type: 'session_state_changed', snapshot: native.getSnapshot() });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(native.cancelCalls).toBe(1);
});

it('stops main background work with Escape without aborting a settling foreground turn', async () => {
  await releaseResponse();
  await tab.executionCoordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  const native = harness.backend.latest;
  Object.assign(native, { hasBackgroundWork: () => true });
  native.emitSessionEvent({ type: 'session_state_changed', snapshot: native.getSnapshot() });
  let releaseSettlement!: () => void;
  let settlementSignal!: AbortSignal;
  const settling = tab.session.turns.run(async signal => {
    settlementSignal = signal;
    tab.session.turns.beginResponse();
    tab.session.turns.settle();
    await new Promise<void>(resolve => { releaseSettlement = resolve; });
  });
  try {
    expect(tab.session.turns.isActive).toBe(true);
    expect(tab.session.turns.isInFlight).toBe(false);
    expect(tab.session.hasMainBackgroundWork).toBe(true);

    fireEvent.keyDown(getByRole(tab.dom.inputComposerEl, 'textbox'), { key: 'Escape' });

    expect(native.cancelCalls).toBe(1);
    expect(settlementSignal.aborted).toBe(false);
    expect(tab.session.turns.cancelRequested).toBe(false);
  } finally {
    releaseSettlement();
    await settling;
  }
});

it.each([false, true])('routes Escape to a working side chat when main background work is %s', async (mainBackground) => {
  await releaseResponse();
  jest.useRealTimers();
  // A completed main reply is the fork point the side chat starts from.
  tab.state.messages = [
    { id: 'u1', role: 'user', content: 'Remember A', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'Noted A', timestamp: 2, assistantMessageId: 'checkpoint-1' },
  ];
  await tab.executionCoordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  const mainNative = harness.backend.latest;
  Object.assign(mainNative, { hasBackgroundWork: () => mainBackground });
  mainNative.emitSessionEvent({ type: 'session_state_changed', snapshot: mainNative.getSnapshot() });
  expect(tab.session.hasMainBackgroundWork).toBe(mainBackground);
  const sideChat = tab.controllers.sideChatController;
  const started = sideChat.handleCommandSubmission('Explore B', []);
  await waitFor(() => expect(harness.backend.latest).not.toBe(mainNative));
  const sideNative = harness.backend.latest;
  await waitFor(() => expect(sideNative.requests).toHaveLength(1));
  expect(sideChat.destination).toBe('side');
  expect(sideChat.runtime?.isWorking).toBe(true);
  expect(tab.state.isStreaming).toBe(false);
  const input = getByRole(tab.dom.inputComposerEl, 'textbox');

  fireEvent.keyDown(input, { key: 'Escape' });

  expect(sideNative.cancelCalls).toBe(1);
  expect(mainNative.cancelCalls).toBe(0);
  await started;
});

it.each([
  { name: 'tool block', growth: 36, movement: 1 },
  { name: 'large code block', growth: 1529, movement: 8 },
  { name: 'shrink and grow', growth: 23, movement: -18 },
  { name: '20px boundary', growth: 21, movement: 1 },
])('keeps following through a layout scroll: $name', async ({ growth, movement }) => {
  expect(tab.state.isStreaming).toBe(true);
  expect(tab.state.autoScrollEnabled).toBe(true);
  // jsdom has no layout engine; supply the geometry observed when the browser delivers scroll.
  setScrollHeight(1000 + growth);
  tab.dom.messagesEl.scrollTop += movement;
  await streamText();
  fireEvent.scroll(tab.dom.messagesEl);
  jest.advanceTimersByTime(16);

  expect(tab.state.autoScrollEnabled).toBe(true);
  expect(tab.dom.messagesEl.scrollTop).toBe(1000 + growth);

  // Later frames must continue following, not only the frame already queued before scroll.
  setScrollHeight(1200 + growth);
  await streamText();
  jest.advanceTimersByTime(16);
  expect(tab.dom.messagesEl.scrollTop).toBe(1200 + growth);
});

function pressContent(button: number): void {
  // jsdom does not implement PointerEvent; the handler reads target, button, and clientX.
  fireEvent(tab.dom.messagesEl.createDiv(), new MouseEvent('pointerdown', { button, bubbles: true }));
}

it.each([
  ['wheel', () => fireEvent.wheel(tab.dom.messagesEl, { deltaY: -100 })],
  ['keydown', () => fireEvent.keyDown(tab.dom.messagesEl, { key: 'PageUp' })],
  ['touchmove', () => fireEvent.touchMove(tab.dom.messagesEl)],
  ['scrollbar pointerdown', () => {
    const messagesEl = tab.dom.messagesEl;
    Object.defineProperties(messagesEl, {
      offsetWidth: { configurable: true, value: 510 },
      clientWidth: { configurable: true, value: 500 },
    });
    jest.spyOn(messagesEl, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 510, 500));
    fireEvent(messagesEl, new MouseEvent('pointerdown', { clientX: 505, bubbles: true }));
  }],
  ['middle-button autoscroll', () => pressContent(1)],
  ['held drag selection', () => pressContent(0)],
] as const)(
  'pauses following for %s and resumes when the reader returns to the bottom',
  async (_name, startScroll) => {
    const messagesEl = tab.dom.messagesEl;
    startScroll();
    messagesEl.scrollTop = 250;
    fireEvent.scroll(messagesEl);
    setScrollHeight(1200);
    await streamText();
    jest.advanceTimersByTime(16);
    expect(tab.state.autoScrollEnabled).toBe(false);
    expect(messagesEl.scrollTop).toBe(250);

    messagesEl.scrollTop = 700;
    fireEvent.scroll(messagesEl);
    setScrollHeight(1400);
    await streamText();
    jest.advanceTimersByTime(16);
    expect(tab.state.autoScrollEnabled).toBe(true);
    expect(messagesEl.scrollTop).toBe(1400);
  },
);

it.each(['pointerup', 'pointercancel'])('keeps following through layout scrolls after %s', async (release) => {
  pressContent(0);
  fireEvent(document, new MouseEvent(release, { bubbles: true }));
  setScrollHeight(1036);
  tab.dom.messagesEl.scrollTop += 1;
  fireEvent.scroll(tab.dom.messagesEl);
  await streamText();
  jest.advanceTimersByTime(16);

  expect(tab.state.autoScrollEnabled).toBe(true);
  expect(tab.dom.messagesEl.scrollTop).toBe(1036);
});


it.each([
  ['owns a new turn', false],
  // A queued message whose continuation could not start leaves no turn in flight.
  ['waits behind an unstarted queued message', true],
])('cancels reference preparation that %s with Escape while leaving existing background work running', async (_name, queueFirst) => {
  const queued = 'queued follow-up';
  if (queueFirst) {
    tab.dom.inputEl.value = queued;
    await tab.controllers.inputController.sendMessage();
  }
  expect(tab.dom.inputEl.value).toBe('');
  await releaseResponse();
  jest.useRealTimers();
  expect(tab.session.turns.isActive).toBe(false);
  await tab.executionCoordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  const native = harness.backend.latest;
  Object.assign(native, { hasBackgroundWork: () => true });
  native.emitSessionEvent({ type: 'session_state_changed', snapshot: native.getSnapshot() });
  let resolveHistory!: (value: Conversation | null) => void;
  const history = new Promise<Conversation | null>(resolve => { resolveHistory = resolve; });
  const read = jest.fn(() => history);
  Object.assign(plugin, { getConversationById: read });
  const draft = '@[Source](claudian-session:conv-1-source)';
  const input = getByRole(tab.dom.inputComposerEl, 'textbox');
  tab.dom.inputEl.value = draft;
  const sending = tab.controllers.inputController.sendMessage();
  try {
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(tab.controllers.inputController.isPreparingMainTurn).toBe(true);
    expect(tab.session.turns.isInFlight).toBe(!queueFirst);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(native.cancelCalls).toBe(0);
    resolveHistory(null); await sending;
    expect(tab.dom.inputEl.value).toContain(draft);
    // Withdrawing the unstarted queued message returns it to the composer too.
    expect(tab.dom.inputEl.value.includes(queued)).toBe(queueFirst);
    expect(tab.session.hasMainBackgroundWork).toBe(true);
    // Once preparation has ended, the same user action reaches background Stop.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(native.cancelCalls).toBe(1);
  } finally { resolveHistory(null); await sending; }
});


it('lets Escape Stop discard a pending mailbox while no response is active', async () => {
  await releaseResponse();
  jest.useRealTimers();
  const mailbox = tab.session.runtime.mailbox!;
  // Navigation blocks dispatch without publishing a running response.
  let finishNavigation!: () => void;
  const navigation = tab.session.runtime.runConversationNavigation(() => new Promise<void>(resolve => { finishNavigation = resolve; }));
  expect(await mailbox.deliver({ message: { from: 'Other session', sessionId: 'other', text: 'Pending request' }, signal: new AbortController().signal })).toBe('queued');
  expect(tab.session.isWorking).toBe(false);
  expect(mailbox.hasPending).toBe(true);
  const input = getByRole(tab.dom.inputComposerEl, 'textbox');
  expect(await axe(input)).toHaveNoViolations();
  fireEvent.keyDown(input, { key: 'Escape' });
  try {
    expect(mailbox.hasPending).toBe(false);
    expect(harness.backend.sessions.every(session => session.requests.length === 0)).toBe(true);
  } finally { mailbox.clear(); finishNavigation(); await navigation; }
});


it('dispatches pending mailbox work after the last busy-main reference preparation releases admission', async () => {
  await tab.executionCoordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  const mailbox = tab.session.runtime.mailbox!;
  let rejectHistory!: (error: Error) => void;
  const history = new Promise<Conversation | null>((_resolve, reject) => { rejectHistory = reject; });
  const read = jest.fn((id: string) => id === 'conv-1-source' ? history : Promise.resolve(plugin.getConversationSync(id)));
  Object.assign(plugin, { getConversationById: read });
  tab.dom.inputEl.value = '@[Source](claudian-session:conv-1-source)';
  const preparing = tab.controllers.inputController.sendMessage();
  expect(read).toHaveBeenCalled();
  expect(tab.controllers.inputController.isPreparingMainTurn).toBe(true);
  expect(await mailbox.deliver({ message: { from: 'Other session', sessionId: 'other', text: 'Mailbox request' }, signal: new AbortController().signal })).toBe('queued');
  await releaseResponse();
  jest.useRealTimers();
  expect(tab.session.turns.isActive).toBe(false);
  expect(mailbox.hasPending).toBe(true);
  rejectHistory(new Error('Reference unavailable'));
  await preparing;
  try {
    await waitFor(() => expect(harness.backend.sessions.flatMap(session => session.requests)).toHaveLength(1), { onTimeout: error => error });
    expect(mailbox.hasPending).toBe(false);
    expect(tab.dom.inputEl.value).toBe('@[Source](claudian-session:conv-1-source)');
  } finally {
    mailbox.clear();
    harness.backend.sessions.forEach(session => session.complete());
    await tab.session.turns.drain();
  }
});


it('wakes the mailbox when the user withdraws their queued input', async () => {
  await tab.executionCoordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
  await tab.executionCoordinator.prepare();
  Object.assign(plugin, { getConversationById: async (id: string) => plugin.getConversationSync(id) });
  tab.dom.inputEl.value = 'User follow-up';
  await tab.controllers.inputController.sendMessage();
  const mailbox = tab.session.runtime.mailbox!;
  expect(await mailbox.deliver({ message: { from: 'Other session', sessionId: 'other', text: 'Mailbox request' }, signal: new AbortController().signal })).toBe('queued');
  await releaseResponse();
  jest.useRealTimers();
  expect(tab.session.turns.isActive).toBe(false);
  expect(mailbox.hasPending).toBe(true);
  expect(harness.backend.sessions.flatMap(session => session.requests)).toHaveLength(0);
  tab.controllers.inputController.queue.withdrawToComposer();
  try {
    await waitFor(() => expect(harness.backend.sessions.flatMap(session => session.requests)).toHaveLength(1));
    expect(mailbox.hasPending).toBe(false);
    expect(tab.dom.inputEl.value).toBe('User follow-up');
  } finally {
    mailbox.clear();
    harness.backend.sessions.forEach(session => session.complete());
    await tab.session.turns.drain();
  }
});
