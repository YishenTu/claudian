/** @vitest-environment jsdom */
import '@/providers';

import type { UnscopedExecutionEvent } from '@test/helpers/ChatExecutionHarness';
import { createFixture } from '@test/helpers/ChatInputHarness';
import { createTestSession } from '@test/helpers/ConversationPorts';
import { useTranscriptGeometry } from '@test/helpers/dom/transcriptGeometry';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { parseCodexSessionContent } from '@test/helpers/providers/codex/parseCodexSessionContent';
import { testDate, testTime } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/rendering/subagents/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import { StreamController } from '@/features/chat/turns/StreamController';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  document.body.replaceChildren();
});

const INTERRUPTED = 'Interrupted · What should Claudian do instead?';

function visibleText(element: HTMLElement): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[hidden], .claudian-hidden') && node.textContent?.trim()) parts.push(node.textContent.trim());
  }
  // Line breaks within a text block read as spaces.
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** What a reader sees: the transcript collapsed, and the interrupted body expanded. */
function inspect(root: HTMLElement) {
  const headers = within(root).queryAllByRole('button', { name: INTERRUPTED });
  const collapsed = Array.from(root.querySelectorAll<HTMLElement>('.claudian-message'), visibleText).filter(Boolean).join(' ');
  if (headers.length !== 1) return { headers: headers.length, collapsed, body: null };
  fireEvent.click(headers[0]);
  const body = visibleText(document.getElementById(headers[0].getAttribute('aria-controls')!)!);
  fireEvent.click(headers[0]);
  return { headers: 1, collapsed, body };
}

const boundary = { type: 'assistant_message_started' } as const;
const text = (value: string) => ({ type: 'text_delta' as const, text: value });
const agentMessage = (message: string) => ({ type: 'event_msg', payload: { type: 'agent_message', message } });
/** A session notification that arrives during the run, after the event before it. */
const notification = 'notification';

/** Runs a requested turn through the real execution and rendering stack, emitting `events` and then stopping it. */
async function stopTurn(events: readonly (UnscopedExecutionEvent | typeof notification)[]) {
  const messagesEl = document.body.createDiv();
  const session = createTestSession();
  const state = new ChatState({}, undefined, session.turns);
  const plugin = await createChatFeatureHost({ settings: { mediaFolder: '', showMessageTimestamps: false } });
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  const subagents = new SubagentManager(() => undefined);
  const streamController = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  cleanups.push(() => { streamController.dispose(); subagents.clear(); renderer.dispose(); });
  const fixture = (await createFixture({ session, state, renderer, streamController, getMessagesEl: () => messagesEl,
    getTabProviderId: () => 'codex' }));

  let notifications = 0;
  const host = { state, renderer, createMessageId: () => `notification-${++notifications}` };
  const response = fixture.holdNextResponse();
  const sending = fixture.controller.sendMessage({ content: 'Read the note' });
  const run = await response.started;
  let scope = (await fixture.emit(run, boundary)).scope;
  for (const event of events) {
    if (event === notification) renderSessionTaskNotification(host, 'Job finished.', scope);
    else scope = (await fixture.emit(run, event)).scope;
  }
  run.emit({ type: 'cancelled', reason: 'Stopped' });
  await sending;
  await Promise.resolve();

  return { messagesEl, state, renderer };
}

// Codex and OpenCode start a new assistant message mid-turn; a Stop after a later one, even
// before it shows any output, still stops the whole native turn, as Codex history records it
// under one `turn_id`.
it.each([
  ['with output', [boundary, text('Second partial.')], 'First message. Second partial.', [agentMessage('Second partial.')]],
  ['before output', [boundary], 'First message.', []],
  ['after blank output', [boundary, text('   ')], 'First message.', [agentMessage('   ')]],
  ['after two boundaries', [boundary, boundary], 'First message.', []],
  ['after two boundaries and blank output', [boundary, boundary, text('   ')], 'First message.', [agentMessage('   ')]],
  // Thinking streams into a buffer the response flushes at its end.
  ['after thinking', [boundary, { type: 'thinking_delta', text: 'Weighing it.' }], expect.stringMatching(/^First message\. Thought\b/), null],
  // The turn ends at its last output, whatever notifications and output-free messages follow it.
  ['after a notification and output', [notification, text('Last output.')], 'First message. Task notification Last output.', null],
  ['after a notification and blank output', [notification, text('   ')], 'First message. Task notification', null],
  ['after a notification and blank thinking', [notification, { type: 'thinking_delta', text: '   ' }], 'First message. Task notification', null],
  ['after a notification and a boundary', [notification, boundary], 'First message. Task notification', null],
] as const)('folds every assistant message of a stopped turn, live and on rerender and Codex reload (%s)', async (_name, tail, body, codexTail) => {
  const { messagesEl, state, renderer } = await stopTurn([text('First message.'), ...tail]);
  const expected = { headers: 1, collapsed: `Read the note ${INTERRUPTED}`, body };
  const live = inspect(messagesEl);
  expect(live).toEqual(expected);

  renderer.renderMessages(state.messages, () => 'Welcome');
  await Promise.resolve();
  expect(inspect(messagesEl)).toEqual(live);

  if (!codexTail) return;
  const codex = parseCodexSessionContent([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Read the note' } },
    agentMessage('First message.'),
    ...codexTail,
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn', reason: 'interrupted' } },
  ].map((record, seconds) => JSON.stringify({ timestamp: testTime({ seconds }), ...record })).join('\n'));
  renderer.renderMessages(codex, () => 'Welcome');
  await Promise.resolve();
  expect(inspect(messagesEl)).toEqual(live);
});

// A notification the turn received before any output ends it, whatever blank output followed.
it.each([
  ['nothing after it', [], 'Task notification'],
  ['output after it', [text('Last output.')], 'Task notification Last output.'],
  ['blank output after it', [text('   ')], 'Task notification'],
  ['blank thinking after it', [{ type: 'thinking_delta', text: '   ' }], 'Task notification'],
] as const)('folds a turn whose only notification preceded its stop, live and on rerender (%s)', async (_name, tail, body) => {
  const { messagesEl, state, renderer } = await stopTurn([notification, ...tail]);
  const expected = { headers: 1, collapsed: `Read the note ${INTERRUPTED}`, body };
  expect(inspect(messagesEl)).toEqual(expected);
  renderer.renderMessages(state.messages, () => 'Welcome');
  await Promise.resolve();
  expect(inspect(messagesEl)).toEqual(expected);
});

// Replay shows a turn stopped before any output as the indicator alone.
it('shows only the indicator for a turn stopped after blank thinking alone, live and on rerender', async () => {
  const { messagesEl, state, renderer } = await stopTurn([{ type: 'thinking_delta', text: '   ' }]);
  const expected = { headers: 0, collapsed: `Read the note ${INTERRUPTED}`, body: null };
  expect(inspect(messagesEl)).toEqual(expected);
  renderer.renderMessages(state.messages, () => 'Welcome');
  await Promise.resolve();
  expect(inspect(messagesEl)).toEqual(expected);
});

// Issue #2189: another session's message arrives without moving a reader scrolled up, while the
// user's own send still lands at the bottom. Streamed text grows its row, so following is visible.
it.each([true, false])('keeps a scrolled-up reader in place for a session message but not for their own send (auto-scroll %s)', async autoScroll => {
  vi.useFakeTimers();
  cleanups.push(() => vi.useRealTimers());
  const fixture = await createFixture();
  const { state, renderer } = fixture.deps;
  const messagesEl = fixture.deps.getMessagesEl()!;
  fixture.plugin.settings.enableAutoScroll = autoScroll;
  const geometry = useTranscriptGeometry(messagesEl, { rowHeight: row => 100 + (row.textContent?.length ?? 0) });
  for (let index = 0; index < 6; index++) {
    state.addMessage({ id: `u${index}`, role: 'user', content: `Prompt ${index}`, timestamp: testDate().getTime() });
    state.addMessage({ id: `a${index}`, role: 'assistant', content: `Answer ${index}`, timestamp: testDate().getTime(),
      completedAt: testDate().getTime(), contentBlocks: [{ type: 'text', content: `Answer ${index}` }] });
  }
  renderer.renderMessages(state.messages, () => 'Welcome');
  const reply = async (send: () => Promise<void>) => {
    const response = fixture.holdNextResponse();
    const sending = send();
    const run = await response.started;
    const atHandoff = messagesEl.scrollTop;
    await fixture.emit(run, text('A reply long enough to grow its row past the follow threshold.'));
    await vi.advanceTimersByTimeAsync(200);
    geometry.layout();
    run.complete();
    await sending;
    await vi.advanceTimersByTimeAsync(200);
    geometry.layout();
    return atHandoff;
  };
  fireEvent.wheel(messagesEl, { deltaY: -100 });
  messagesEl.scrollTop = 200;
  fireEvent.scroll(messagesEl);

  const sessionHandoff = await reply(() => fixture.controller.sendSessionMessage(
    { from: 'Sender', sessionId: 'sender', text: 'Please inspect this' },
    { assertBeforeHandoff: () => undefined, onUnsent: () => undefined },
  ));
  expect(within(messagesEl).getByText('Please inspect this')).toBeTruthy();
  expect([sessionHandoff, messagesEl.scrollTop]).toEqual([200, 200]);

  const userHandoff = await reply(() => fixture.controller.sendMessage({ content: 'Read the note' }));
  expect(userHandoff).toBeGreaterThan(200);
  // The send lands at the bottom; the reply streamed after it is followed only with auto-scroll on.
  expect(messagesEl.scrollTop === geometry.bottom()).toBe(autoScroll);
});
