import { testDate } from '@test/helpers/testClock';

import { selectOpencodeTurnStats } from '@/providers/opencode/history/OpencodeTurnStats';

const messages = [
  { id: 'old-u', type: 'user', time: { created: 100 } },
  { id: 'old-a', type: 'assistant', time: { created: 200, completed: 300 }, finish: 'stop', tokens: { output: 900, reasoning: 10 } },
  { id: 'u', type: 'user', time: { created: 1000 } },
  { id: 'a', type: 'assistant', time: { created: 1200, completed: 2000 }, finish: 'tool-calls', tokens: { output: 20, reasoning: 80 } },
  { id: 'final', type: 'assistant', time: { created: 2500, completed: 3500 }, finish: 'stop', tokens: { output: 10, reasoning: 15 } },
  { id: 'idle', type: 'idle', time: { created: 3600 } },
  { id: 'late', type: 'assistant', time: { created: 3700, completed: 3800 }, finish: 'stop', tokens: { output: 500, reasoning: 0 } },
  { id: 'next-u', type: 'user', time: { created: 4000 } },
  { id: 'next-a', type: 'assistant', time: { created: 4200, completed: 4500 }, finish: 'stop', tokens: { output: 800, reasoning: 10 } },
];

it('selects only the requested native turn, including reasoning, up to its control entry', () => {
  expect(selectOpencodeTurnStats(messages, { userMessageId: 'u', startedAt: 999 }))
    .toEqual({ outputTokens: 125, durationMs: 2500 });
  // Without an admitted user ID, the latest user entry since the prompt started selects the turn.
  expect(selectOpencodeTurnStats(messages, { startedAt: 4000 })).toEqual({ outputTokens: 810, durationMs: 500 });
  expect(selectOpencodeTurnStats(messages, { startedAt: 5000 })).toBeUndefined();
  expect(selectOpencodeTurnStats(messages, { userMessageId: 'missing', startedAt: 0 })).toBeUndefined();
});

it('reports no statistics when a step lacks native token counts', () => {
  const damaged = messages.map(message => message.id === 'a' ? { ...message, tokens: { output: 20 } } : message);
  expect(selectOpencodeTurnStats(damaged, { userMessageId: 'u', startedAt: 999 })).toBeUndefined();
});


it.each(['completed', 'running', 'failed'])('keeps the selected user turn across %s compaction', status => {
  const start = testDate().getTime();
  const native = [
    { id: 'u', type: 'user', time: { created: start } },
    { id: 'a1', type: 'assistant', time: { created: start + 100, completed: start + 1000 },
      finish: 'tool-calls', tokens: { output: 10, reasoning: 2 } },
    { id: 'c', type: 'compaction', status, time: { created: start + 1100 } },
    { id: 'a2', type: 'assistant', time: { created: start + 1200, completed: start + 3000 },
      finish: 'stop', tokens: { output: 20, reasoning: 3 } },
    { id: 'idle', type: 'idle', time: { created: start + 3100 } },
    { id: 'late', type: 'assistant', time: { created: start + 3200, completed: start + 4000 },
      finish: 'stop', tokens: { output: 500, reasoning: 0 } },
  ];

  expect(selectOpencodeTurnStats(native, { userMessageId: 'u', startedAt: start - 1 }))
    .toEqual({ outputTokens: 35, durationMs: 3000 });
  expect(selectOpencodeTurnStats(native, { startedAt: start }))
    .toEqual({ outputTokens: 35, durationMs: 3000 });
});
