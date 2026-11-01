/** @vitest-environment jsdom */
import '@/providers';

import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { useClaudeSessionFiles } from '@test/helpers/providers/claudeHistory';
import { parseCodexSessionContent } from '@test/helpers/providers/codex/parseCodexSessionContent';
import { parseGrokHistoryContent } from '@test/helpers/providers/grokHistory';
import { testDate, testTime } from '@test/helpers/testClock';
import { waitFor, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { appendExecutionContext } from '@/core/prompt/promptContext';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import { mapOpencodeNativeMessages } from '@/providers/opencode/history/OpencodeHistoryStore';
import { parsePiSessionContent } from '@/providers/pi/history/PiHistoryStore';

const writeClaudeSession = useClaudeSessionFiles();

const prompt = 'ref @"Review"\n\n<context_sessions>\n<context_session title="Review" id="conv-1-ref" provider="codex" updated="updated" />\n</context_sessions>';

beforeEach(() => {

  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    el.createEl('p', { text: markdown });
  });
});

it.each(['claude', 'codex', 'opencode', 'pi', 'grok'] as const)('hides snapshot XML after %s native history reload', async provider => {
  let messages: ChatMessage[];
  switch (provider) {
    case 'claude':
      messages = (await loadSDKSessionMessages('/vault', 'session', undefined,
        writeClaudeSession([{ type: 'user', uuid: 'u', timestamp: testTime(), message: { content: prompt } }]))).messages;
      break;
    case 'codex':
      messages = parseCodexSessionContent(JSON.stringify({ timestamp: testTime(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }));
      break;
    case 'opencode':
      messages = mapOpencodeNativeMessages([{ id: 'u', type: 'user', time: { created: testDate().getTime() }, text: prompt }]);
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
  const renderer = new MessageRenderer(await createChatFeatureHost({ settings: { mediaFolder: '', showMessageTimestamps: false } }), new Component(), parent);
  try {
    renderer.renderStoredMessage(messages[0], messages, 0);
    await Promise.resolve();
    expect(within(parent).getByText('ref @"Review"')).toBeTruthy();
    expect(parent.textContent).not.toContain('context_sessions');
    expect(parent.textContent).not.toContain('private.md');
  } finally { renderer.dispose(); parent.remove(); }
});


it.each([
  {
    label: 'XML example with actual appended context',
    body: 'Explain this XML:\n\n```xml\n\n<editor_selection path="note.md">hello</editor_selection>\n```\nKeep the example.',
    appendContext: true,
    visibleExample: '<editor_selection path="note.md">hello</editor_selection>',
    finalInstruction: 'Keep the example.',
  },
  {
    label: 'context-free legacy bracket example',
    body: 'Explain legacy:\n\n```text\n[Current note: Notes/example.md]\n```\nKeep the final instruction.',
    appendContext: false,
    visibleExample: '[Current note: Notes/example.md]',
    finalInstruction: 'Keep the final instruction.',
  },
])('preserves $label through cold OpenCode history and the user bubble', async ({ body, appendContext, visibleExample, finalInstruction }) => {
  const nativePrompt = appendContext ? appendExecutionContext(body, { linkedContent: { path: 'Real.md' } }) : body;
  const rows = [{ id: 'u-code', type: 'user', time: { created: testDate().getTime() }, text: nativePrompt }];
  const messages = mapOpencodeNativeMessages(rows);
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe(body);
  expect(rows[0].text).toBe(nativePrompt);
  const parent = document.body.createDiv();
  const renderer = new MessageRenderer(await createChatFeatureHost({ settings: { mediaFolder: '', showMessageTimestamps: false } }), new Component(), parent);
  try {
    renderer.renderStoredMessage(messages[0], messages, 0);
    await waitFor(() => {
      const visible = parent.querySelector('.claudian-text-block')?.textContent ?? '';
      expect(visible).toContain(visibleExample);
      expect(visible.endsWith(finalInstruction)).toBe(true);
      expect(visible).not.toContain('Real.md');
    });
  } finally { renderer.dispose(); parent.remove(); }
});
