/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component } from 'obsidian';

import type { ChatMessage, StreamChunk } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { StreamController } from '@/features/chat/turns/StreamController';

let host: HTMLElement;
let state: ChatState;
let renderer: MessageRenderer;
let stream: StreamController;
let subagents: SubagentManager;
let message: ChatMessage;
let settings: { mediaFolder: string; expandFileEditsByDefault: boolean };

beforeEach(async () => {
  vi.useFakeTimers();
  host = document.body.createDiv();
  const plugin = await createChatFeatureHost({ settings: { expandFileEditsByDefault: false } });
  settings = plugin.settings;
  renderer = new MessageRenderer(plugin, new Component(), host);
  state = new ChatState();
  message = { id: 'reply', role: 'assistant', content: '', timestamp: testDate().getTime() };
  state.currentContentEl = renderer.addMessage(message).querySelector<HTMLElement>('.claudian-message-content')!;
  subagents = new SubagentManager(() => undefined);
  stream = new StreamController({ plugin, state, renderer, subagentManager: subagents,
    getMessagesEl: () => host, updateQueueIndicator: () => undefined });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  stream.dispose();
  subagents.clear();
  state.dispose();
  renderer.dispose();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const chunks: Array<[string, StreamChunk, RegExp | null]> = [
  ['text', { type: 'text', content: 'Next output' }, /Next output/],
  ['thinking', { type: 'thinking', content: 'Considering the next step' }, /Thinking/],
  ['warning', { type: 'notice', level: 'warning', content: 'Command blocked' }, /Warning.*Command blocked/],
  ['error', { type: 'error', content: 'Something went wrong' }, /Error.*Something went wrong/],
  ['done', { type: 'done' }, null],
];

it.each(chunks)('flushes pending tool cards in transcript order before %s', async (_name, next, following) => {
  for (const [id, name, input] of [
    ['read', 'Read', { file_path: 'a.md' }],
    ['grep', 'Grep', { pattern: 'needle' }],
    ['glob', 'Glob', { pattern: '*.md' }],
  ] as const) {
    await stream.handleStreamChunk({ type: 'tool_use', id, name, input }, message);
  }
  expect(message.toolCalls?.map(tool => [tool.id, tool.status])).toEqual([
    ['read', 'running'], ['grep', 'running'], ['glob', 'running'],
  ]);
  expect(message.contentBlocks).toEqual([
    { type: 'tool_use', toolId: 'read' }, { type: 'tool_use', toolId: 'grep' }, { type: 'tool_use', toolId: 'glob' },
  ]);
  const toolButtons = () => within(host).queryAllByRole('button', { name: /^(Read|Grep|Glob):/ });
  expect(toolButtons()).toHaveLength(0);
  await stream.handleStreamChunk(next, message);
  await vi.advanceTimersByTimeAsync(20);
  const cards = toolButtons();
  expect(cards.map(button => button.textContent)).toEqual([
    expect.stringContaining('Read'), expect.stringContaining('Grep'), expect.stringContaining('Glob'),
  ]);
  expect(cards[0].textContent).toContain('a.md');
  expect(cards[1].textContent).toContain('needle');
  expect(cards[2].textContent).toContain('*.md');
  const followingOutput = following ? within(host).getByText(following) : null;
  expect(followingOutput === null || Boolean(cards[2].compareDocumentPosition(followingOutput) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  await stream.handleStreamChunk({ type: 'done' }, message);
  expect(toolButtons()).toEqual(cards);
});

it('renders an early result as one completed card with its persisted output', async () => {
  await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, message);
  expect(within(host).queryByRole('button', { name: /^Read:/ })).toBeNull();
  await stream.handleStreamChunk({ type: 'tool_result', id: 'read', content: 'File contents here' }, message);
  expect(message.toolCalls).toEqual([expect.objectContaining({ id: 'read', status: 'completed', result: 'File contents here' })]);
  const header = within(host).getByRole('button', { name: /^Read: note.md/ });
  expect(within(header).getByLabelText('Status: completed')).toBeDefined();
  fireEvent.click(header);
  expect(within(host).getByText('File contents here')).toBeDefined();
  await stream.handleStreamChunk({ type: 'done' }, message);
  expect(within(host).getAllByRole('button', { name: /^Read: note.md/ })).toEqual([header]);
});

it.each([false, true])('flushes real Write, Edit and patch cards with configured expansion (%s)', async expanded => {
  settings.expandFileEditsByDefault = expanded;
  await stream.handleStreamChunk({ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'write.md', content: 'Created text' } }, message);
  await stream.handleStreamChunk({ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'edit.md', old_string: 'Before', new_string: 'After' } }, message);
  await stream.handleStreamChunk({ type: 'tool_use', id: 'patch', name: 'apply_patch', input: {
    patch: '*** Begin Patch\n*** Update File: patch.md\n@@\n-old\n+Patched text\n*** End Patch',
  } }, message);
  expect(within(host).queryAllByRole('button')).toHaveLength(0);
  await stream.handleStreamChunk({ type: 'text', content: 'Changes prepared' }, message);
  await vi.advanceTimersByTimeAsync(20);
  for (const name of [/^Write: write.md/, /^Edit: edit.md/, /^apply_patch:/]) {
    const header = within(host).getByRole('button', { name });
    expect(header.getAttribute('aria-expanded')).toBe(String(expanded));
    if (!expanded) fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.compareDocumentPosition(within(host).getByText('Changes prepared')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(message.toolCalls?.map(tool => tool.name)).toEqual(['Write', 'Edit', 'apply_patch']);
});

it('renders buffered task progress through the real TodoWrite card', async () => {
  await stream.handleStreamChunk({ type: 'tool_use', id: 'todo', name: 'TodoWrite', input: {
    todos: [{ content: 'Review changes', activeForm: 'Reviewing changes', status: 'pending' }],
  } }, message);
  expect(message.contentBlocks).toEqual([{ type: 'tool_use', toolId: 'todo' }]);
  expect(within(host).queryByText('Review changes')).toBeNull();
  await stream.handleStreamChunk({ type: 'done' }, message);
  const header = within(host).getByRole('button', { name: /Tasks/ });
  fireEvent.click(header);
  expect(within(host).getByText('Review changes')).toBeDefined();
  vi.useRealTimers();
  expect(await axe(host)).toHaveNoViolations();
});

it('finalizes alternating text, thinking and tool blocks into copyable transcript order', async () => {
  await stream.handleStreamChunk({ type: 'text', content: 'First text' }, message);
  await stream.handleStreamChunk({ type: 'thinking', content: 'First reasoning' }, message);
  await stream.handleStreamChunk({ type: 'text', content: 'Second text' }, message);
  await stream.handleStreamChunk({ type: 'thinking', content: 'Second reasoning' }, message);
  await stream.handleStreamChunk({ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }, message);
  await stream.handleStreamChunk({ type: 'done' }, message);
  expect(state.currentThinkingState).toBeNull();
  expect(state.currentTextContent).toBe('');
  expect(message.contentBlocks).toEqual([
    { type: 'text', content: 'First text' }, { type: 'thinking', content: 'First reasoning', durationSeconds: 0 },
    { type: 'text', content: 'Second text' }, { type: 'thinking', content: 'Second reasoning', durationSeconds: 0 },
    { type: 'tool_use', toolId: 'read' },
  ]);
  const thoughts = within(host).getAllByRole('button', { name: 'Thought for 0s' });
  for (const header of thoughts) fireEvent.click(header);
  await Promise.resolve();
  const ordered = ['First text', 'First reasoning', 'Second text', 'Second reasoning'].map(text => within(host).getByText(text));
  ordered.push(within(host).getByRole('button', { name: /^Read: note.md/ }));
  expect(ordered.slice(1).every((node, index) => Boolean(ordered[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  for (const button of within(host).getAllByRole('button', { name: 'Copy message' })) fireEvent.click(button);
  expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(1, 'First text');
  expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(2, 'Second text');
});
