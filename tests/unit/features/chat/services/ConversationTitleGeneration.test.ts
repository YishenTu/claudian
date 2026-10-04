import { fallbackConversationTitle } from '@/features/chat/services/ConversationTitleGeneration';

describe('fallbackConversationTitle', () => {
  it('uses the first sentence', () => {
    expect(fallbackConversationTitle('How do I set up React? I need help.')).toBe('How do I set up React');
  });

  it('truncates long titles to 50 chars', () => {
    const title = fallbackConversationTitle('A'.repeat(100));

    expect(title.length).toBeLessThanOrEqual(53); // 50 + '...'
    expect(title).toContain('...');
  });

  it('keeps messages without sentence breaks', () => {
    expect(fallbackConversationTitle('Hello world')).toBe('Hello world');
  });
});
