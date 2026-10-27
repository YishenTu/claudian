/** @jest-environment jsdom */
import '@/providers';

import { createFixture } from '@test/helpers/ChatInputHarness';
import { createTestSession } from '@test/helpers/ConversationPorts';
import { parseCodexSessionContent } from '@test/helpers/providers/codex/parseCodexSessionContent';
import { testTime } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import type { ProviderExecutionEvent } from '@/core/execution';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { renderSessionTaskNotification } from '@/features/chat/turns/BackgroundTurnRenderer';
import { StreamController } from '@/features/chat/turns/StreamController';

HTMLElement.prototype.appendText = function (text) { this.append(document.createTextNode(text)); };
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

const cleanups: Array<() => void> = [];
beforeEach(() => {
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
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

const boundary = { type: 'assistant_message_started' };
const text = (value: string) => ({ type: 'text_delta', text: value });
const agentMessage = (message: string) => ({ type: 'event_msg', payload: { type: 'agent_message', message } });
/** A session notification that arrives during the run, after the event before it. */
const notification = 'notification';

/** Runs a requested turn through the real execution and rendering stack, emitting `events` and then stopping it. */
async function stopTurn(events: readonly unknown[]) {
  const messagesEl = document.body.createDiv();
  const session = createTestSession();
  const state = new ChatState({}, undefined, session.turns);
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  const subagents = new SubagentManager(() => undefined);
  const streamController = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined });
  cleanups.push(() => { streamController.dispose(); subagents.clear(); renderer.dispose(); });
  const fixture = createFixture({ session, state, renderer, streamController, getMessagesEl: () => messagesEl,
    getTabProviderId: () => 'codex' });

  let sequence = 0;
  const scope = () => ({ kind: 'requested' as const, sessionInstanceId: 'native', executionId: 'execution', turnId: 'turn', sequence });
  const emit = (event: Record<string, unknown>) => {
    sequence++;
    return fixture.controller.handleExecutionEvent({ ...event, scope: scope() } as ProviderExecutionEvent);
  };
  let notifications = 0;
  const host = { state, renderer, createMessageId: () => `notification-${++notifications}` };
  fixture.coordinator.execute.mockImplementationOnce(async () => {
    await emit({ type: 'turn_started', accepted: true });
    await emit(boundary);
    for (const event of events) {
      if (event === notification) renderSessionTaskNotification(host, 'Job finished.', scope());
      else await emit(event as Record<string, unknown>);
    }
    return { accepted: true, status: 'cancelled' };
  });
  await fixture.controller.sendMessage({ content: 'Read the note' });
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
