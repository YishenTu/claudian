import {
  type ChatMessage,
  isCanonicalUserMessage,
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
