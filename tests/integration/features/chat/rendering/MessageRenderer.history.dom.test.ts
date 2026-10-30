/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

let visibility: HTMLStyleElement;
let host: HTMLElement;
let renderer: MessageRenderer;
let settings: { mediaFolder: string; expandFileEditsByDefault: boolean };

beforeEach(async () => {
  visibility = document.head.appendChild(document.createElement('style'));
  visibility.textContent = '.claudian-hidden { display: none; }';
  host = document.body.createDiv();
  const plugin = await createChatFeatureHost({ settings: { expandFileEditsByDefault: false } });
  settings = plugin.settings;
  renderer = new MessageRenderer(plugin, new Component(), host);
});

afterEach(() => {
  renderer.dispose();
  host.remove();
  visibility.remove();
  vi.restoreAllMocks();
});

it('replaces history and its welcome greeting when the conversation becomes empty', async () => {
  renderer.renderMessages([
    { id: 'prompt', role: 'user', content: 'Earlier prompt', timestamp: testDate().getTime() },
    { id: 'answer', role: 'assistant', content: 'Earlier answer', timestamp: testDate().getTime() },
  ], () => 'Hello');
  await Promise.resolve();
  expect(within(host).getByText('Earlier prompt')).toBeDefined();
  expect(within(host).getByText('Earlier answer')).toBeDefined();
  expect(within(host).getByText('Claudian')).toBeDefined();
  expect(within(host).getByText('Hello')).toBeDefined();

  renderer.renderMessages([], () => 'Welcome back');
  expect(within(host).getByText('Claudian')).toBeDefined();
  expect(within(host).getByText('Welcome back')).toBeDefined();
  for (const stale of ['Earlier prompt', 'Earlier answer', 'Hello']) {
    expect(within(host).queryByText(stale)).toBeNull();
  }
  expect(within(host).queryByRole('button', { name: 'Copy message' })).toBeNull();
});

it('restores thinking duration labels and reveals the corresponding stored content', async () => {
  renderer.renderStoredMessage({
    id: 'thoughts', role: 'assistant', content: '', timestamp: testDate().getTime(),
    contentBlocks: [
      { type: 'thinking', content: 'Timed reasoning', durationSeconds: 42 },
      { type: 'thinking', content: 'Legacy reasoning' },
    ],
  });
  for (const [name, content] of [['Thought for 42s', 'Timed reasoning'], ['Thought', 'Legacy reasoning']]) {
    const header = within(host).getByRole('button', { name });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(header, { key: 'Enter' });
    await Promise.resolve();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(getComputedStyle(within(host).getByText(content)).display).not.toBe('none');
    expect(MarkdownRenderer.render).toHaveBeenCalledWith(expect.anything(), content, expect.anything(), '', expect.any(Component));
  }
  expect(await axe(host)).toHaveNoViolations();
});

it.each([false, true])('restores file edits using the conversation expansion setting (%s)', async expanded => {
  settings.expandFileEditsByDefault = expanded;
  const tools: ToolCallInfo[] = ['Edit', 'Write'].map(name => ({
    id: name, name, status: 'completed', input: { file_path: `${name}.md` },
    diffData: {
      filePath: `${name}.md`,
      diffLines: [{ type: 'insert', text: `${name} content`, newLineNum: 1 }],
      stats: { added: 1, removed: 0 },
    },
  }));
  tools.push({
    id: 'patch', name: 'apply_patch', status: 'completed',
    input: { patch: '*** Begin Patch\n*** Update File: patch.md\n@@\n-before\n+Patch content\n*** End Patch' },
    result: 'Applied patch',
  });
  renderer.renderStoredMessage({
    id: 'edits', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls: tools,
    contentBlocks: tools.map(tool => ({ type: 'tool_use', toolId: tool.id })),
  });
  for (const [name, content] of [[/^Edit: Edit.md/, 'Edit content'], [/^Write: Write.md/, 'Write content'], [/^apply_patch:/, 'Patch content']] as const) {
    const header = within(host).getByRole('button', { name });
    expect(header.getAttribute('aria-expanded')).toBe(String(expanded));
    expect(within(host).queryByText(content) !== null).toBe(expanded);
    if (!expanded) {
      fireEvent.keyDown(header, { key: 'Enter' });
    }
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(within(host).getByText(content)).toBeDefined();
  }
  expect(await axe(host)).toHaveNoViolations();
});
