/** @jest-environment jsdom */
import '@/providers';

import * as fs from 'node:fs/promises';

import { testDate, testTime } from '@test/helpers/testClock';
import { within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import { parseCodexSessionContent } from '@/providers/codex/history/CodexHistoryStore';
import { parseGrokHistoryContent } from '@/providers/grok/history/GrokHistoryStore';
import { mapOpencodeMessages } from '@/providers/opencode/history/OpencodeHistoryStore';
import { parsePiSessionContent } from '@/providers/pi/history/PiHistoryStore';

jest.mock('node:fs/promises');

const prompt = 'ref @"Review"\n\n<context_sessions>\n<context_session title="Review" id="conv-1-ref" provider="codex" updated="updated" path="/tmp/claudian-sessions/private.md" />\n</context_sessions>';

beforeEach(() => {
  HTMLElement.prototype.empty = function () { this.replaceChildren(); };
  HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };
  HTMLElement.prototype.removeClass = function (...names) { this.classList.remove(...names); };
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    el.createEl('p', { text: markdown });
  });
});

it.each(['claude', 'codex', 'opencode', 'pi', 'grok'] as const)('hides snapshot XML after %s native history reload', async provider => {
  let messages: ChatMessage[];
  switch (provider) {
    case 'claude':
      jest.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ type: 'user', uuid: 'u', timestamp: testTime(), message: { content: prompt } }));
      messages = (await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl')).messages;
      break;
    case 'codex':
      messages = parseCodexSessionContent(JSON.stringify({ timestamp: testTime(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }));
      break;
    case 'opencode':
      messages = mapOpencodeMessages([{ info: { id: 'u', role: 'user', time: { created: testDate().getTime() } }, parts: [{ id: 'p', type: 'text', text: prompt }] }]);
      break;
    case 'pi':
      messages = parsePiSessionContent(JSON.stringify({ type: 'message', id: 'u', message: { role: 'user', content: prompt } }));
      break;
    case 'grok':
      messages = parseGrokHistoryContent(JSON.stringify({ method: 'session/update', timestamp: testDate().getTime() / 1000, params: { sessionId: 's', update: { sessionUpdate: 'user_message_chunk', messageId: 'u', content: { type: 'text', text: prompt }, _meta: { promptIndex: 0 } } } }) + '\n' + JSON.stringify({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' } } }), 's').messages.filter(message => message.role === 'user');
      break;
  }
  expect(messages).toHaveLength(1);
  const parent = document.body.createDiv();
  const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '', showMessageTimestamps: false } } as never, new Component(), parent);
  try {
    renderer.renderStoredMessage(messages[0], messages, 0);
    await Promise.resolve();
    expect(within(parent).getByText('ref @"Review"')).toBeTruthy();
    expect(parent.textContent).not.toContain('context_sessions');
    expect(parent.textContent).not.toContain('private.md');
  } finally { renderer.dispose(); parent.remove(); }
});
