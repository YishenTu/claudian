/** @jest-environment jsdom */
import '@/providers';

import { holdResponse } from '@test/helpers/ConversationPorts';
import { createHarness, releaseSideChatHarnesses } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent } from '@testing-library/dom';
import { App, Component } from 'obsidian';

import type { ChatMessage, Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { destroyTab } from '@/features/chat/tabs/TabLifecycle';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

const originalResizeObserver = globalThis.ResizeObserver;
let tab: AssembledTabRuntime;

beforeEach(async () => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const harness = createHarness();
  const app = new App();
  Object.assign(app.vault.adapter, { basePath: '/vault' });
  Object.assign(app.vault, { on: () => ({}), offref: () => undefined });
  const conversation = {
    id: 'conversation-1', providerId: 'claude', selectedModel: 'claude-sonnet-4-5',
    sessionId: 'main-session', messages: [],
  } as unknown as Conversation;
  const plugin = {
    ...(harness.plugin as ChatFeatureHost), app,
    getCommittedSettings: () => plugin.settings,
    settings: {
      model: 'claude-sonnet-4-5', permissionMode: 'normal',
      keyboardNavigation: { focusInputKey: 'i', scrollUpKey: 'w', scrollDownKey: 's' },
      providerConfigs: { claude: { enabled: true } },
    },
    getActiveEnvironmentVariables: () => '',
    getConversationSummary: () => conversation,
    getConversationSync: () => conversation,
    getConversationList: () => [conversation],
  } as unknown as ChatFeatureHost;
  tab = await createTabRuntime({
    plugin, conversation, component: new Component(),
    containerEl: document.body.createDiv(),
    mentionDataProvider: new VaultMentionDataProvider(app),
    getProviderCatalogConfig: () => null, isRuntimeLive: () => true,
  });
  jest.useFakeTimers();
  holdResponse(tab.session.turns);
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
