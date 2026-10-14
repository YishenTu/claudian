/** @jest-environment jsdom */
import '@/providers';

import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component, Notice } from 'obsidian';

import type { ChatMessage, Conversation, ToolCallInfo } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { ToolCallStream } from '@/features/chat/turns/ToolCallStream';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (classes, enabled) {
  for (const cls of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(cls, enabled);
};

// Shapes follow a captured DeepSeek round trip (.context/local/e2e-deepseek), trimmed to three rows.
const CALLER = 'conv-1791947029595-tl6xjrbsd';
const RECIPIENT = 'conv-1791946999103-cb11o0a4z';
const listResult = (extra: Record<string, unknown> = {}) => JSON.stringify({
  sessions: [
    { sessionId: CALLER, title: 'list the recent sessions, send a test msg to the l...', provider: 'deepseek', status: 'running', active: true, self: true },
    { sessionId: RECIPIENT, title: 'hi', provider: 'deepseek', status: 'idle', active: false },
    { sessionId: 'conv-1791775526480-y16u643yx', title: 'Fact-check four pipeline target clinical data c...', provider: 'claude', status: 'awaiting-user', active: false },
  ],
  truncated: true,
  ...extra,
});
const MESSAGE = 'Test message from another Claudian session.\nNo reply needed — this is just a delivery check.';

function setup(known: readonly string[] = [CALLER, RECIPIENT]) {
  document.body.replaceChildren();
  jest.mocked(Notice).mockClear();
  const messagesEl = document.body.createDiv();
  const openConversation = jest.fn(async (_id: string) => undefined);
  const records = new Map(known.map(id => [id, { id, providerId: 'deepseek', title: id } as Conversation]));
  const loaded: string[][] = [];
  const host = {
    app: {}, settings: { mediaFolder: '' },
    ensureConversationMetadataLoaded: async (ids: readonly string[]) => { loaded.push([...ids]); },
    getCachedConversation: (id: string) => records.get(id) ?? null,
    getConversationSummary: (id: string) => records.get(id) ?? null,
  };
  const renderer = new MessageRenderer(host as never, new Component(), messagesEl,
    undefined, undefined, undefined, undefined, openConversation);
  return { messagesEl, renderer, openConversation, loaded, records };
}

const assistant = (toolCalls: ToolCallInfo[]): ChatMessage => ({
  id: 'response', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls,
});

function expand(container: HTMLElement, name: RegExp): HTMLElement {
  const header = within(container).getByRole('button', { name });
  fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  return header.closest<HTMLElement>('.claudian-tool-call')!;
}

it('replays a destination listing with status badges, self marker and session links', async () => {
  const h = setup();
  try {
    h.renderer.renderMessages([assistant([{
      id: 'list', name: 'claudian_list_destinations', input: { limit: 10 }, status: 'completed', result: listResult(),
    }])], () => '');
    const card = expand(h.messagesEl, /List destinations/);

    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // The caller's own row is marked and is not a link to itself.
    expect(within(rows[0]).getByText('This session')).toBeTruthy();
    expect(within(rows[0]).queryByRole('button')).toBeNull();
    // Rows show only the title; provider and status stay in the tooltip and the agent's result.
    for (const row of rows.slice(1)) expect(row.textContent).not.toMatch(/Running|Awaiting input|This session|DeepSeek Harness|Claude Code/);
    expect(within(card).getByText('More sessions not shown')).toBeTruthy();

    const link = within(rows[1]).getByRole('button', { name: 'hi' });
    expect(link.getAttribute('type')).toBe('button');
    // List rows carry no hover labels: no tooltip on the link, the row, or the list.
    expect(card.querySelector('.claudian-session-tool [title], .claudian-session-tool [aria-label]')).toBeNull();
    fireEvent.click(link);
    await waitFor(() => expect(h.openConversation).toHaveBeenCalledWith(RECIPIENT));
    expect((await axe(h.messagesEl)).violations).toEqual([]);
  } finally { h.renderer.dispose(); }
});

it('notes the provider catalog without listing it, and tolerates listings without the newer row fields', () => {
  const h = setup();
  try {
    const legacy = JSON.stringify({
      sessions: [{ sessionId: RECIPIENT, title: 'hi', provider: 'deepseek' }],
      providers: [{ provider: 'claude', default: true, models: [
        { id: 'claude-sonnet-4-5', default: true, reasoning: { options: ['low', 'high'], default: 'high' } },
        { id: 'claude-haiku-4-5' },
      ] }],
    });
    h.renderer.renderMessages([assistant([{
      id: 'list', name: 'claudian_list_destinations', input: { includeProviders: true }, status: 'completed', result: legacy,
    }])], () => '');
    const card = expand(h.messagesEl, /List destinations/);
    expect(within(card).getByRole('button', { name: 'hi' })).toBeTruthy();
    expect(within(card).queryByText(/This session|Running|Awaiting input|not shown/)).toBeNull();
    // The agent receives the catalog; the user sees only that it was included.
    expect(within(card).getByText('Included available providers and models')).toBeTruthy();
    expect(within(card).queryByText(/claude-sonnet-4-5|Claude Code|Reasoning/)).toBeNull();
    expect(within(card).queryByRole('list', { name: 'Providers' })).toBeNull();
  } finally { h.renderer.dispose(); }
});

it.each([
  ['claudian_list_destinations', { limit: 10 }, /List destinations/],
  ['claudian_send_message', { sessionId: RECIPIENT, text: MESSAGE }, /Message session/],
])('shows the error text of a failed %s call', (name, input, header) => {
  const h = setup();
  const error = 'Session tools are only available in Claudian main chat sessions with the default tool policy.';
  try {
    h.renderer.renderMessages([assistant([{ id: 'failed', name, input, status: 'error', result: error }])], () => '');
    const card = expand(h.messagesEl, header);
    expect(within(card).getByText(error)).toBeTruthy();
    expect(within(card).queryByRole('listitem')).toBeNull();
  } finally { h.renderer.dispose(); }
});

it('streams a live send card whose recipient, requested model and message come from the result', async () => {
  const h = setup();
  const state = new ChatState();
  const stream = new ToolCallStream({
    state, plugin: { app: {}, settings: {} } as never,
    indicator: { show: () => undefined }, getMessagesEl: () => h.messagesEl, scrollToBottom: () => undefined,
  });
  const message = assistant([]);
  const contentEl = h.renderer.addMessage(message).createDiv();
  state.currentContentEl = contentEl;
  try {
    stream.use({ type: 'tool_use', id: 'send', name: 'claudian_send_message', input: {
      sessionId: RECIPIENT, text: MESSAGE, model: 'deepseek-pro', reasoning: 'low',
    } }, message);
    stream.flush();
    stream.complete({ type: 'tool_result', id: 'send', content: JSON.stringify({
      sessionId: RECIPIENT, title: 'hi', provider: 'deepseek', status: 'queued',
    }) }, message);

    const card = expand(h.messagesEl, /Message session/);
    // Delivery state and provider are not shown; the model string already names the provider.
    expect(within(card).queryByText(/Queued|Started|Delivery|DeepSeek Harness/)).toBeNull();
    expect(within(card).getByText('deepseek-pro')).toBeTruthy();
    expect(within(card).getByText('low')).toBeTruthy();
    // The full message keeps its line break as plain text.
    expect(within(card).getByText((_, el) => el?.textContent === MESSAGE && el.children.length === 0)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'hi' }));
    await waitFor(() => expect(h.openConversation).toHaveBeenCalledWith(RECIPIENT));
    expect((await axe(h.messagesEl)).violations).toEqual([]);
  } finally { stream.cancelAll(); h.renderer.dispose(); }
});

it('names the recipient by its current title when an older send result lacks one, and by id when unknown', () => {
  const h = setup();
  h.records.set(RECIPIENT, { id: RECIPIENT, providerId: 'deepseek', title: 'hi' } as Conversation);
  try {
    h.renderer.renderMessages([assistant([
      {
        id: 'send', name: 'claudian_send_message', input: { sessionId: RECIPIENT, text: 'Hello' }, status: 'completed',
        result: JSON.stringify({ sessionId: RECIPIENT, status: 'started' }),
      },
      {
        id: 'send-gone', name: 'claudian_send_message', input: { sessionId: 'conv-gone', text: 'Hello' }, status: 'completed',
        result: JSON.stringify({ sessionId: 'conv-gone', status: 'started' }),
      },
    ])], () => '');
    const [card, goneCard] = within(h.messagesEl).getAllByRole('button', { name: /Message session/ }).map(header => {
      fireEvent.click(header);
      return header.closest<HTMLElement>('.claudian-tool-call')!;
    });
    // A message that started immediately needs no delivery line.
    expect(within(card).queryByText(/Started|Delivery/)).toBeNull();
    expect(within(card).getByRole('button', { name: 'hi' })).toBeTruthy();
    expect(within(card).queryByText(RECIPIENT)).toBeNull();
    expect(within(goneCard).getByRole('button', { name: 'conv-gone' })).toBeTruthy();
  } finally { h.renderer.dispose(); }
});

it('labels a recipient the send created as a new session, not by its placeholder title', async () => {
  const h = setup();
  try {
    h.renderer.renderMessages([assistant([{
      id: 'send-new', name: 'claudian_send_message', status: 'completed',
      input: { text: MESSAGE, provider: 'deepseek', model: 'deepseek:deepseek-official/deepseek-flash' },
      result: JSON.stringify({ sessionId: RECIPIENT, title: 'Oct 14, 11:33 AM', provider: 'deepseek', status: 'started' }),
    }])], () => '');
    const card = expand(h.messagesEl, /Message session/);
    expect(within(card).queryByText('Oct 14, 11:33 AM')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'New session' }));
    await waitFor(() => expect(h.openConversation).toHaveBeenCalledWith(RECIPIENT));
    expect(within(card).getByText('deepseek:deepseek-official/deepseek-flash')).toBeTruthy();
  } finally { h.renderer.dispose(); }
});

it('reports a session that no longer exists instead of opening it', async () => {
  const h = setup([CALLER]);
  try {
    h.renderer.renderMessages([assistant([{
      id: 'list', name: 'claudian_list_destinations', input: {}, status: 'completed', result: listResult(),
    }])], () => '');
    const card = expand(h.messagesEl, /List destinations/);
    fireEvent.click(within(card).getByRole('button', { name: 'hi' }));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('That session no longer exists.'));
    // The lookup loads the record before deciding it is gone.
    expect(h.loaded).toEqual([[RECIPIENT]]);
    expect(h.openConversation).not.toHaveBeenCalled();
  } finally { h.renderer.dispose(); }
});

it('shows which session and turns a read returned, not the transcript, and names a pending read by its current title', async () => {
  const h = setup();
  h.records.set(RECIPIENT, { id: RECIPIENT, providerId: 'deepseek', title: 'hi' } as Conversation);
  try {
    h.renderer.renderMessages([assistant([
      {
        id: 'read', name: 'claudian_read_session', input: { sessionId: RECIPIENT, beforeTurn: 6 }, status: 'completed',
        result: JSON.stringify({
          sessionId: RECIPIENT, title: 'hi', provider: 'deepseek', status: 'idle',
          content: '# hi\n\n## T2 user\nsecret prompt', fromTurn: 2, toTurn: 5, totalTurns: 7,
        }),
      },
      { id: 'read-pending', name: 'claudian_read_session', input: { sessionId: RECIPIENT }, status: 'running' },
      {
        id: 'read-empty', name: 'claudian_read_session', input: { sessionId: RECIPIENT }, status: 'completed',
        result: JSON.stringify({ sessionId: RECIPIENT, title: 'hi', provider: 'deepseek', status: 'running', content: '# hi\n', fromTurn: 0, toTurn: 0, totalTurns: 0 }),
      },
    ])], () => '');
    const [card, pending, empty] = within(h.messagesEl).getAllByRole('button', { name: /Read session/ }).map(header => {
      fireEvent.click(header);
      return header.closest<HTMLElement>('.claudian-tool-call')!;
    });
    expect(within(card).getByText('2–5 of 7')).toBeTruthy();
    expect(card.textContent).not.toContain('secret prompt');
    fireEvent.click(within(card).getByRole('button', { name: 'hi' }));
    await waitFor(() => expect(h.openConversation).toHaveBeenCalledWith(RECIPIENT));
    expect(within(pending).getByRole('button', { name: 'hi' })).toBeTruthy();
    expect(within(empty).getByText('None yet')).toBeTruthy();
    expect((await axe(h.messagesEl)).violations).toEqual([]);
  } finally { h.renderer.dispose(); }
});

it('shows how a send was delivered, and names an interrupt without a message as a stop', () => {
  const h = setup();
  const result = (status: string) => JSON.stringify({ sessionId: RECIPIENT, title: 'hi', provider: 'deepseek', status });
  try {
    h.renderer.renderMessages([assistant([
      { id: 'steer', name: 'claudian_send_message', status: 'completed', input: { sessionId: RECIPIENT, text: 'Also check X', mode: 'steer' }, result: result('steered') },
      { id: 'redirect', name: 'claudian_send_message', status: 'completed', input: { sessionId: RECIPIENT, text: 'Do Y instead', mode: 'interrupt' }, result: result('interrupted') },
      { id: 'stop', name: 'claudian_send_message', status: 'completed', input: { sessionId: RECIPIENT, mode: 'interrupt' }, result: result('interrupted') },
      { id: 'queue', name: 'claudian_send_message', status: 'completed', input: { sessionId: RECIPIENT, text: 'Plain' }, result: result('queued') },
    ])], () => '');
    const headers = within(h.messagesEl).getAllByRole('button', { name: /Message session|Stop session/ });
    expect(headers.map(header => header.textContent?.match(/Message session|Stop session/)?.[0])).toEqual(['Message session', 'Message session', 'Stop session', 'Message session']);
    const cards = headers.map(header => { fireEvent.click(header); return header.closest<HTMLElement>('.claudian-tool-call')!; });
    expect(within(cards[0]).getByText('Steer into running turn')).toBeTruthy();
    expect(within(cards[1]).getByText('Interrupt current work')).toBeTruthy();
    expect(within(cards[2]).getByText('Interrupt current work')).toBeTruthy();
    expect(within(cards[2]).queryByText('Message')).toBeNull();
    // A plain send stays as before: no delivery line.
    expect(within(cards[3]).queryByText(/Steer|Interrupt|Mode/)).toBeNull();
  } finally { h.renderer.dispose(); }
});
