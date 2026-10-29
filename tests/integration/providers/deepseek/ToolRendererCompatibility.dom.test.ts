/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component } from 'obsidian';

import type { ProviderExecutionEvent } from '@/core/execution';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';
import { renderStoredWriteEdit } from '@/features/chat/rendering/tools/WriteEditRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { StreamController } from '@/features/chat/turns/StreamController';
import { loadDeepSeekHistory } from '@/providers/deepseek/history/DeepSeekHistoryStore';
import { DeepSeekOutput, type DeepSeekOutputEvent } from '@/providers/deepseek/normalization/DeepSeekOutput';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };
beforeEach(() => document.body.replaceChildren());

const cases = [
  { name: 'blank prior line', before: '', removed: 1 },
  { name: 'created file', before: null, removed: 0 },
  { name: 'ordinary replacement', before: 'before', removed: 1 },
];
describe.each(['live', 'history'] as const)('%s DeepSeek applied edit', mode => {
  it.each(cases)('renders the $name without losing its before-image', async ({ before, removed }) => {
    const time = testDate().getTime();
    const records = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'edit the note' }] } },
      { type: 'tool/call', data: { callId: 'edit', name: 'edit', arguments: JSON.stringify({ file_path: 'note.md', old_string: '', new_string: 'after' }) } },
      { type: 'tool/result', data: { message: { toolCallId: 'edit', content: [{ type: 'text', text: 'Edited note.md' }], isError: false }, meta: { diffs: [{ path: 'note.md', oldText: before, newText: 'after' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((record, index) => ({ ...record, seq: index + 1, time: time + index }));
    const messages = document.body.createDiv();
    const response: ChatMessage = { id: 'response', role: 'assistant', timestamp: time, content: '', contentBlocks: [] };
    let card: HTMLElement;
    let component: Component | undefined;
    let renderer: MessageRenderer | undefined;
    let stream: StreamController | undefined;
    try {
      if (mode === 'live') {
        const events: DeepSeekOutputEvent[] = [];
        const output = new DeepSeekOutput(event => events.push(event));
        for (const record of records) output.record(record);
        const state = new ChatState();
        const vault = { adapter: { basePath: '/workspace', list: async () => ({ files: [], folders: [] }) }, getAbstractFileByPath: () => null };
        const plugin = { app: { vault }, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
        component = new Component();
        component.load();
        renderer = new MessageRenderer(plugin, component, messages);
        stream = new StreamController({ plugin, state, renderer, subagentManager: new SubagentManager(() => undefined), getMessagesEl: () => messages, updateQueueIndicator: () => undefined });
        state.addMessage(response);
        state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
        for (const [sequence, event] of events.entries()) {
          const chunk = providerOutputEventToStreamChunk({ ...event, scope: { kind: 'requested', executionId: 'run', sessionInstanceId: 'session', turnId: 'turn', sequence } } as ProviderExecutionEvent);
          if (chunk) await stream.handleStreamChunk(chunk, response);
        }
        card = messages.querySelector<HTMLElement>('.claudian-write-edit-block')!;
        fireEvent.click(within(card).getByRole('button', { name: /^Edit: note\.md/ }));
      } else {
        const history = await loadDeepSeekHistory({ call: async method => {
          if (method !== 'session/page') throw new Error('Unexpected history endpoint ' + method);
          return { records: records.map(event => ({ type: 'event', event })), hasMore: false };
        } }, 'session', 5);
        card = renderStoredWriteEdit(messages, history.find(message => message.role === 'assistant')!.toolCalls![0], { initiallyExpanded: true });
      }
      expect(card).not.toBeNull();
      expect(card.querySelectorAll('.claudian-diff-delete')).toHaveLength(removed);
      expect(card.querySelectorAll('.claudian-diff-insert')).toHaveLength(1);
      expect(card.textContent).toContain('after');
      expect((await axe(card)).violations).toEqual([]);
    } finally {
      stream?.dispose();
      renderer?.dispose();
      component?.unload();
      messages.remove();
    }
  });
});
