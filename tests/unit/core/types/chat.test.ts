import {
  type ChatMessage,
  isCanonicalUserMessage,
  settleInterruptedTurn,
} from '@/core/types';

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    content: 'Hello',
    timestamp: 1,
    ...overrides,
  };
}

describe('isCanonicalUserMessage', () => {
  it.each([
    ['ordinary user input', createMessage(), true],
    ['interrupt marker', createMessage({ isInterrupt: true }), false],
    ['rebuilt context', createMessage({ isRebuiltContext: true }), false],
    ['assistant output', createMessage({ role: 'assistant' }), false],
  ] as const)('classifies %s', (_label, message, expected) => {
    expect(isCanonicalUserMessage(message)).toBe(expected);
  });
});

describe('settleInterruptedTurn', () => {
  it.each([true, false])('gives one interrupted turn the provenance of its first segment and no completion (automatic: %s)', automatic => {
    const segment = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
      id, role: 'assistant', content: id, timestamp: 1, durationSeconds: 3, completedAt: 4,
      turnStats: { outputTokens: 5, durationMs: 6 }, ...extra,
    });
    // Splits can mislabel later segments, in either direction.
    const segments = [segment('first', automatic ? { isAutomaticResponse: true } : {}),
      segment('compaction', { isAutomaticResponse: !automatic }), segment('last', { isAutomaticResponse: !automatic })];

    settleInterruptedTurn(segments);

    expect(segments.map(({ id, isAutomaticResponse, durationSeconds, completedAt, turnStats }) =>
      ({ id, isAutomaticResponse, durationSeconds, completedAt, turnStats }))).toEqual([
      { id: 'first' }, { id: 'compaction' }, { id: 'last' },
    ].map(expected => ({ ...expected, isAutomaticResponse: automatic ? true : undefined,
      durationSeconds: undefined, completedAt: undefined, turnStats: undefined })));
  });
});
