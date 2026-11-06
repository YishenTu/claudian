import { testDate } from '@test/helpers/testClock';

import type { StreamChunk } from '@/core/types';
import { parseCodexSessionTurns } from '@/providers/codex/history/CodexHistoryStore';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

it.each([
  ['indented code', '    const note = 1;\n    print(note);'],
  ['tab-indented code', '\tconst note = 1;\n\tprint(note);'],
  ['trailing hard break', 'Keep this line break.  \n'],
  ['leading blank line', '\n    const note = 1;\n'],
])('restores native assistant Markdown source for %s', (_label, text) => {
  const chunks: StreamChunk[] = [];
  const router = new CodexNotificationRouter(chunk => chunks.push(chunk), '/workspace');
  router.beginTurn();
  router.handleNotification('item/completed', { item: { type: 'agentMessage', id: 'answer', text } });
  expect(chunks.flatMap(chunk => chunk.type === 'text' ? [chunk.content] : []).join('')).toBe(text);

  const payloads = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: text } },
  ];
  const messages = parseCodexSessionTurns(payloads.map(payload => JSON.stringify({ timestamp: testDate().toISOString(), ...payload })).join('\n'))
    .flatMap(turn => turn.messages);
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe(text);
  expect(messages[0].contentBlocks).toEqual([{ type: 'text', content: text }]);
});

it('does not turn whitespace-only native assistant records into visible messages', () => {
  const messages = parseCodexSessionTurns(JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ' \n\t ' }],
  } })).flatMap(turn => turn.messages);
  expect(messages).toEqual([]);
});
