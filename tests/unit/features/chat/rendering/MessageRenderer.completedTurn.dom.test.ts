/** @jest-environment jsdom */

import '@/providers';

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.appendText = function (text) { this.append(document.createTextNode(text)); };
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };

function setup(providerId = 'claude') {
  const messagesEl = document.body.createDiv();
  const fork = jest.fn().mockResolvedValue(undefined);
  const settings = { mediaFolder: '', showMessageTimestamps: true };
  const renderer = new MessageRenderer(
    { app: {}, settings } as any,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any,
    messagesEl, undefined, fork, () => ProviderRegistry.getCapabilities(providerId),
  );
  return { renderer, messagesEl, fork, settings };
}

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'Fix this', timestamp: 1, userMessageId: 'native-u1' },
  { id: 'a1', role: 'assistant', content: 'Checking the code.', timestamp: 2,
    contentBlocks: [{ type: 'text', content: 'Checking the code.' }] },
  { id: 'a2', role: 'assistant', content: 'Fixed the bug.', timestamp: 3,
    assistantMessageId: 'native-a2', durationSeconds: 65, completedAt: 5,
    contentBlocks: [
      { type: 'thinking', content: 'Check the edge case.' },
      { type: 'text', content: 'Fixed the bug.' },
    ] },
];

beforeEach(() => {
  document.body.replaceChildren();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

it('collapses completed history above the answer and puts copy, fork, time below it', async () => {
  const { renderer, messagesEl, fork } = setup();
  renderer.renderMessages(messages, () => 'Hello');
  await Promise.resolve();
  const header = within(messagesEl).getByRole('button', { name: 'Worked for 01:05' });
  expect(header.getAttribute('aria-expanded')).toBe('false');
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  expect(history.hidden).toBe(true);
  expect(history.textContent).toContain('Checking the code.');
  expect(history.textContent).toContain('Check the edge case.');
  expect(history.textContent).not.toContain('Fixed the bug.');
  fireEvent.click(header);
  expect(history.hidden).toBe(false);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(header);
  expect(history.hidden).toBe(true);

  const answer = messagesEl.querySelector<HTMLElement>('[data-message-id="a2"]')!;
  const copy = within(answer).getByRole('button', { name: 'Copy message' });
  const forkButton = within(answer).getByRole('button', { name: 'Fork conversation' });
  const time = copy.parentElement!.querySelector('.claudian-message-timestamp')!;
  expect(copy.parentElement).toBe(forkButton.parentElement);
  expect(copy.parentElement).toBe(time.parentElement);
  expect(Array.from(copy.parentElement!.children)).toEqual([copy, forkButton, time]);
  fireEvent.click(copy);
  fireEvent.click(forkButton);
  await Promise.resolve();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Fixed the bug.');
  expect(fork).toHaveBeenCalledWith('a2');
  const user = messagesEl.querySelector<HTMLElement>('[data-message-id="u1"]')!;
  expect(within(user).getByRole('button', { name: 'Copy message' }).nextElementSibling)
    .toBe(user.querySelector('.claudian-message-timestamp'));
  expect((await axe(answer)).violations).toEqual([]);
  renderer.dispose();
});

it('keeps live output in place until completion, then preserves the same content elements', async () => {
  const { renderer, messagesEl } = setup();
  const msg: ChatMessage = { id: 'live', role: 'assistant', content: 'Done.', timestamp: 4,
    contentBlocks: [{ type: 'thinking', content: 'Working' }, { type: 'text', content: 'Done.' }] };
  const el = renderer.addMessage(msg);
  const content = el.querySelector<HTMLElement>('.claudian-message-content')!;
  const work = content.createDiv({ cls: 'claudian-thinking-block', text: 'Working' });
  const answer = content.createDiv({ cls: 'claudian-text-block', text: 'Done.' });
  expect(within(messagesEl).queryByRole('button', { name: /Worked/ })).toBeNull();
  expect(work.parentElement).toBe(content);
  msg.durationSeconds = 0;
  renderer.finalizeResponse(msg, [msg]);
  const header = within(messagesEl).getByRole('button', { name: 'Worked for 00:00' });
  expect(work.parentElement!.hidden).toBe(true);
  expect(answer.parentElement).toBe(content);
  header.focus();
  expect(document.activeElement).toBe(header);
  expect(header.getAttribute('type')).toBe('button');
  renderer.dispose();
});

it('leaves interrupted and unsuccessful output expanded', () => {
  for (const interrupted of [true, false]) {
    const { renderer } = setup();
    const msg: ChatMessage = { id: `failed-${interrupted}`, role: 'assistant', content: 'Partial', timestamp: 4,
      isInterrupt: interrupted, contentBlocks: [{ type: 'text', content: 'Partial' }] };
    const el = renderer.addMessage(msg);
    el.querySelector('.claudian-message-content')!.createDiv({ cls: 'claudian-text-block', text: 'Partial' });
    renderer.finalizeResponse(msg, [msg], interrupted);
    expect(within(el).queryByRole('button', { name: /Worked/ })).toBeNull();
    expect(within(el).getByRole('button', { name: 'Copy message' })).toBeDefined();
    renderer.dispose();
  }
});

it('copies retired interruption markup as ordinary message text', async () => {
  const { renderer, messagesEl } = setup();
  const marker = '<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>';
  renderer.renderStoredMessage({ id: 'legacy', role: 'assistant', timestamp: 5,
    content: `Partial answer\n\n${marker}` });
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Copy message' }));
  await Promise.resolve();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`Partial answer\n\n${marker}`);
  expect(messagesEl.querySelectorAll('.claudian-interrupted')).toHaveLength(0);
  expect(await axe(messagesEl)).toHaveNoViolations();
  renderer.dispose();
});

it('keeps separate completed turns and refreshes timestamps in their own action rows', () => {
  const { renderer, messagesEl, settings } = setup();
  renderer.renderMessages([...messages,
    { id: 'u2', role: 'user', content: 'Next', timestamp: 6 },
    { id: 'a3', role: 'assistant', content: 'Next answer', timestamp: 7, durationSeconds: 90, completedAt: 10 },
  ], () => 'Hello');
  const headers = within(messagesEl).getAllByRole('button', { name: /Worked for/ });
  expect(headers.map(header => header.textContent)).toEqual(['Worked for 01:05', 'Worked for 01:30']);
  settings.showMessageTimestamps = false;
  renderer.refreshMessageTimestamps();
  expect(messagesEl.querySelectorAll('.claudian-message-timestamp')).toHaveLength(0);
  settings.showMessageTimestamps = true;
  renderer.refreshMessageTimestamps();
  renderer.refreshMessageTimestamps();
  const times = messagesEl.querySelectorAll('.claudian-message-timestamp');
  expect(times).toHaveLength(4);
  for (const time of times) expect(time.parentElement!.lastElementChild).toBe(time);
  renderer.dispose();
});

it.each([true, false])('keeps the final answer visible with fallback tools (content blocks: %s)', async (withBlocks) => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'fallback', role: 'assistant', content: 'The final answer.', timestamp: 10, durationSeconds: 5,
    ...(withBlocks ? { contentBlocks: [{ type: 'text' as const, content: 'The final answer.' }] } : {}),
    toolCalls: [{ id: 'read', name: 'Read', input: { file_path: 'README.md' }, status: 'completed', result: 'File contents' }],
  });
  await Promise.resolve();
  const header = within(messagesEl).getByRole('button', { name: 'Worked for 00:05' });
  const history = document.getElementById(header.getAttribute('aria-controls')!)!;
  expect(history.textContent).not.toContain('The final answer.');
  expect(within(messagesEl).getByText('The final answer.').closest('[hidden]')).toBeNull();
  expect(history.querySelector('.claudian-tool-call')).not.toBeNull();
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Copy message' }));
  await Promise.resolve();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('The final answer.');
  renderer.dispose();
});

it('keeps Claude replay output expanded when a user-role interrupt follows it', () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([
    messages[0],
    { ...messages[2], durationSeconds: undefined, content: 'Partial answer',
      contentBlocks: [{ type: 'thinking', content: 'Still working' }, { type: 'text', content: 'Partial answer' }] },
    { id: 'interrupt', role: 'user', content: '[Request interrupted by user]', timestamp: 4, isInterrupt: true },
  ], () => 'Hello');
  expect(within(messagesEl).queryByRole('button', { name: /^Worked/ })).toBeNull();
  expect(within(messagesEl).getByText('Partial answer').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Interrupted')).toBeDefined();
  renderer.dispose();
});

it('offers fork on the final live response of a multi-message turn', async () => {
  const { renderer, messagesEl, fork } = setup();
  for (const message of messages) {
    const el = renderer.addMessage(message);
    if (message.role === 'assistant') {
      const text = el.querySelector('.claudian-message-content')!.createDiv({ cls: 'claudian-text-block' });
      await renderer.renderContent(text, message.content);
    }
  }
  renderer.finalizeResponse(messages[2], messages);
  const response = messagesEl.querySelector<HTMLElement>('[data-message-id="a2"]')!;
  fireEvent.click(within(response).getByRole('button', { name: 'Fork conversation' }));
  await Promise.resolve();
  expect(fork).toHaveBeenCalledWith('a2');
  renderer.dispose();
});

it('offers full-session fork only on the latest reply and removes it when another turn starts', async () => {
  const { renderer, messagesEl, fork } = setup('opencode');
  const latest: ChatMessage = { id: 'a3', role: 'assistant', content: 'Latest answer', timestamp: 7,
    assistantMessageId: 'native-a3' };
  renderer.renderMessages([...messages, { id: 'u2', role: 'user', content: 'Next', timestamp: 6 }, latest], () => 'Hello');
  const buttons = within(messagesEl).getAllByRole('button', { name: 'Fork conversation' });
  expect(buttons).toHaveLength(1);
  expect(buttons[0].closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a3');
  expect(buttons[0].getAttribute('type')).toBe('button');
  fireEvent.click(buttons[0]);
  await Promise.resolve();
  expect(fork).toHaveBeenCalledWith('a3');
  expect((await axe(messagesEl)).violations).toEqual([]);
  renderer.addMessage({ id: 'u3', role: 'user', content: 'Continue', timestamp: 8 });
  expect(within(messagesEl).queryByRole('button', { name: 'Fork conversation' })).toBeNull();
  renderer.dispose();
});

it('shows one task notification disclosure between the initial and automatic replies', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([
    { id: 'initial', role: 'assistant', content: 'Waiting for completion.', timestamp: 1,
      durationSeconds: 5, contentBlocks: [{ type: 'text', content: 'Waiting for completion.' }] },
    { id: 'automatic', role: 'assistant', isAutomaticResponse: true, content: 'The sleep finished successfully.', timestamp: 25,
      contentBlocks: [
        { type: 'task_notification', content: 'Background command completed (exit code 0).' },
        { type: 'thinking', content: 'Check the completed task.' },
        { type: 'text', content: 'The sleep finished successfully.' },
      ] },
  ], () => 'Hello');
  await Promise.resolve();

  const header = within(messagesEl).getByRole('button', { name: 'Task notification' });
  expect(header.getAttribute('type')).toBe('button');
  expect(header.getAttribute('aria-expanded')).toBe('false');
  const result = within(messagesEl).getByText('Background command completed (exit code 0).');
  expect(result.closest('[hidden]')).not.toBeNull();
  expect(within(messagesEl).getByText('Waiting for completion.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('The sleep finished successfully.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getAllByRole('button', { name: /^Worked/ })).toHaveLength(1);
  expect(within(messagesEl).getByRole('button', { name: 'Worked for 00:05' })).toBeDefined();
  fireEvent.click(header);
  expect(result.closest('[hidden]')).toBeNull();
  expect(header.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(header);
  expect(result.closest('[hidden]')).not.toBeNull();
  header.focus();
  expect(document.activeElement).toBe(header);
  expect((await axe(messagesEl)).violations).toEqual([]);
  renderer.dispose();
});

it('preserves requested work before a notification arriving in the same response', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'requested-with-notification', role: 'assistant', timestamp: 1,
    content: 'Initial reply.\n\nFollow-up reply.', durationSeconds: 5,
    contentBlocks: [
      { type: 'thinking', content: 'Initial reasoning.' },
      { type: 'text', content: 'Initial reply.' },
      { type: 'task_notification', content: 'The background result.' },
      { type: 'text', content: 'Follow-up reply.' },
    ],
  });
  await Promise.resolve();
  const work = within(messagesEl).getByRole('button', { name: 'Worked for 00:05' });
  expect(within(messagesEl).getByRole('button', { name: 'Task notification' }).closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Initial reply.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Follow-up reply.').closest('[hidden]')).toBeNull();
  fireEvent.click(work);
  expect(within(messagesEl).getByText('Initial reasoning.').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it('keeps a requested response disclosure separate when a notification precedes its first output', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'requested-after-notification', role: 'assistant', timestamp: 1,
    content: 'The requested answer.', durationSeconds: 5,
    contentBlocks: [
      { type: 'task_notification', content: 'Old task result.' },
      { type: 'thinking', content: 'Reasoning about the new request.' },
      { type: 'text', content: 'The requested answer.' },
    ],
  });
  await Promise.resolve();
  const notification = within(messagesEl).getByRole('button', { name: 'Task notification' });
  const work = within(messagesEl).getByRole('button', { name: 'Worked for 00:05' });
  fireEvent.click(notification);
  expect(within(messagesEl).getByText('Old task result.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Reasoning about the new request.').closest('[hidden]')).not.toBeNull();
  fireEvent.click(work);
  expect(within(messagesEl).getByText('Reasoning about the new request.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('The requested answer.').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it('finalizes each automatic response when multiple task notifications arrive consecutively', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([
    { id: 'first-automatic', role: 'assistant', isAutomaticResponse: true, timestamp: 1, content: 'First follow-up.',
      contentBlocks: [
        { type: 'task_notification', content: 'First result.' },
        { type: 'thinking', content: 'Processing the first result.' },
        { type: 'text', content: 'First follow-up.' },
      ] },
    { id: 'second-automatic', role: 'assistant', isAutomaticResponse: true, timestamp: 2, content: 'Second follow-up.',
      contentBlocks: [
        { type: 'task_notification', content: 'Second result.' },
        { type: 'text', content: 'Second follow-up.' },
      ] },
  ], () => 'Hello');
  await Promise.resolve();
  expect(within(messagesEl).getAllByRole('button', { name: 'Task notification' })).toHaveLength(2);
  expect(within(messagesEl).getByText('Processing the first result.').closest('[hidden]')).not.toBeNull();
  expect(within(messagesEl).getByText('First follow-up.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Second follow-up.').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it('keeps requested work on both sides of a mid-response notification in its own disclosure', async () => {
  const { renderer, messagesEl } = setup();
  renderer.renderStoredMessage({
    id: 'requested-mid-response', role: 'assistant', timestamp: 1,
    content: 'The requested answer.', durationSeconds: 5,
    contentBlocks: [
      { type: 'thinking', content: 'Work before notification.' },
      { type: 'task_notification', content: 'Old task result.' },
      { type: 'thinking', content: 'Work after notification.' },
      { type: 'text', content: 'The requested answer.' },
    ],
  });
  await Promise.resolve();
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Task notification' }));
  expect(within(messagesEl).getByText('Work after notification.').closest('[hidden]')).not.toBeNull();
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Worked for 00:05' }));
  expect(within(messagesEl).getByText('Work before notification.').closest('[hidden]')).toBeNull();
  expect(within(messagesEl).getByText('Work after notification.').closest('[hidden]')).toBeNull();
  renderer.dispose();
});

it.each(['claude', 'pi', 'opencode', 'codex'])('shows native throughput for %s on replay', async (provider) => {
  const { renderer, messagesEl } = setup(provider);
  const response = { ...messages[2], turnStats: { outputTokens: 125, durationMs: 2500 } };
  renderer.renderMessages([messages[0], response], () => 'Hello');
  const stat = within(messagesEl).getByText('50.0 tok/s');
  expect(stat.parentElement).toBe(within(messagesEl).getAllByRole('button', { name: 'Copy message' }).at(-1)!.parentElement);
  // Obsidian renders aria-label tooltips; a title would add a duplicate browser tooltip.
  expect(stat.getAttribute('aria-label')).toBe('125 tokens · 2.5s');
  expect(stat.hasAttribute('title')).toBe(false);
  expect((await axe(messagesEl)).violations).toEqual([]);
  renderer.dispose();
});

it.each([
  ['grok', { outputTokens: 125, durationMs: 2500 }],
  ['claude', undefined],
])('omits unavailable or unsupported throughput (%s, %j)', (provider, turnStats) => {
  const { renderer, messagesEl } = setup(provider as string);
  renderer.renderMessages([messages[0], { ...messages[2], turnStats } as ChatMessage], () => 'Hello');
  expect(within(messagesEl).queryByText(/tok\/s/)).toBeNull();
  renderer.dispose();
});

it.each([
  [2888, 118846, '24.3 tok/s', '2,888 tokens · 1m 58.8s'],
  [300, 119960, '2.5 tok/s', '300 tokens · 2m 0s'],
  [90, 3000, '30.0 tok/s', '90 tokens · 3s'],
])('summarizes %i tokens over %ims in the tooltip', (outputTokens, durationMs, rate, tooltip) => {
  const { renderer, messagesEl } = setup();
  renderer.renderMessages([messages[0], { ...messages[2], turnStats: { outputTokens, durationMs } }], () => 'Hello');
  expect(within(messagesEl).getByText(rate).getAttribute('aria-label')).toBe(tooltip);
  renderer.dispose();
});

it('keeps time after throughput when timestamps are refreshed or toggled', () => {
  const { renderer, messagesEl, settings } = setup();
  renderer.renderMessages([messages[0], { ...messages[2], turnStats: { outputTokens: 158, durationMs: 10000 } }], () => 'Hello');
  const stat = within(messagesEl).getByText('15.8 tok/s');
  const toolbar = stat.parentElement!;
  const copy = within(toolbar).getByRole('button', { name: 'Copy message' });
  const fork = within(toolbar).getByRole('button', { name: 'Fork conversation' });
  const expectOrder = () => {
    expect(Array.from(toolbar.children)).toEqual([copy, fork, stat, toolbar.querySelector('.claudian-message-timestamp')]);
  };
  expectOrder();
  renderer.refreshMessageTimestamps();
  expectOrder();
  settings.showMessageTimestamps = false;
  renderer.refreshMessageTimestamps();
  expect(Array.from(toolbar.children)).toEqual([copy, fork, stat]);
  settings.showMessageTimestamps = true;
  renderer.refreshMessageTimestamps();
  renderer.refreshMessageTimestamps();
  expectOrder();
  renderer.dispose();
});
