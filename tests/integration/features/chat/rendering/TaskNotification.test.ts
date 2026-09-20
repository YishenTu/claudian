/** @jest-environment jsdom */

import '@/providers';

import { fireEvent, within } from '@testing-library/dom';
import { MarkdownRenderer } from 'obsidian';

import type { ProviderBackgroundEventScope, ProviderBackgroundOutputEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import {
  providerOutputEventToStreamChunk,
  StreamController,
} from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { ClaudeExecutionEventNormalizer } from '@/providers/claude/execution/ClaudeExecutionEventNormalizer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };

beforeEach(() => {
  document.body.replaceChildren();
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it('renders a native completion and its follow-up through the real chat stream pipeline', async () => {
  const messagesEl = document.body.createDiv();
  const plugin = { app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any, messagesEl);
  const state = new ChatState();
  const subagentManager = new SubagentManager(() => undefined);
  const stream = new StreamController({
    plugin, state, renderer, subagentManager,
    getMessagesEl: () => messagesEl, updateQueueIndicator: () => undefined,
  });
  const message: ChatMessage = {
    id: 'automatic', role: 'assistant', isAutomaticResponse: true, timestamp: 1, content: '', contentBlocks: [],
  };
  const element = renderer.addMessage(message);
  state.currentContentEl = element.querySelector<HTMLElement>('.claudian-message-content');
  const scope: ProviderBackgroundEventScope = {
    kind: 'background', sessionInstanceId: 'session', turnId: 'background', sequence: 1,
  };
  const normalizer = new ClaudeExecutionEventNormalizer();
  try {
    for (const native of [
      { type: 'system', subtype: 'task_notification', session_id: 'session', task_id: 'task',
        status: 'completed', summary: 'There are 22 Markdown files.', uuid: 'notification' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Agent complete: 22 files.' }] } },
    ]) {
      for (const event of normalizer.normalize(native as any, 'background')) {
        if (event.type !== 'output') continue;
        const chunk = providerOutputEventToStreamChunk({ ...event.event, scope } as ProviderBackgroundOutputEvent);
        if (chunk) await stream.handleStreamChunk(chunk, message);
      }
    }
    await stream.finalizeCurrentTextBlock(message);
    renderer.finalizeResponse(message, [message]);

    const header = within(messagesEl).getByRole('button', { name: 'Task notification' });
    const result = within(messagesEl).getByText('There are 22 Markdown files.');
    expect(result.closest('[hidden]')).not.toBeNull();
    expect(within(messagesEl).getByText('Agent complete: 22 files.').closest('[hidden]')).toBeNull();
    fireEvent.click(header);
    expect(result.closest('[hidden]')).toBeNull();
    expect(message.contentBlocks).toEqual([
      { type: 'task_notification', content: 'There are 22 Markdown files.' },
      { type: 'text', content: 'Agent complete: 22 files.' },
    ]);
    expect(within(messagesEl).queryByRole('button', { name: /^Worked/ })).toBeNull();
  } finally {
    stream.dispose();
    subagentManager.clear();
    renderer.dispose();
  }
});
