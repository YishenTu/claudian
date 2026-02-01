import type { ChatMessage } from '@/core/types';
import { findRewindContext } from '@/features/chat/rewind';

describe('findRewindContext', () => {
  it('finds the nearest previous assistant UUID and detects a following response UUID', () => {
    const messages: ChatMessage[] = [
      { id: 'a0', role: 'assistant', content: 'no uuid', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'prev', timestamp: 2, sdkAssistantUuid: 'prev-a' },
      { id: 'u1', role: 'user', content: 'user', timestamp: 3, sdkUserUuid: 'user-u' },
      { id: 'a2', role: 'assistant', content: 'no uuid', timestamp: 4 },
      { id: 'a3', role: 'assistant', content: 'resp', timestamp: 5, sdkAssistantUuid: 'resp-a' },
    ];

    const ctx = findRewindContext(messages, 2);
    expect(ctx.prevAssistantUuid).toBe('prev-a');
    expect(ctx.hasResponse).toBe(true);
  });

  it('does not treat assistants after the next user message as a response', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: 'prev', timestamp: 1, sdkAssistantUuid: 'prev-a' },
      { id: 'u1', role: 'user', content: 'user', timestamp: 2, sdkUserUuid: 'user-u' },
      { id: 'a2', role: 'assistant', content: 'no uuid', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'next user', timestamp: 4, sdkUserUuid: 'user-u2' },
      { id: 'a3', role: 'assistant', content: 'later resp', timestamp: 5, sdkAssistantUuid: 'resp-a' },
    ];

    const ctx = findRewindContext(messages, 1);
    expect(ctx.prevAssistantUuid).toBe('prev-a');
    expect(ctx.hasResponse).toBe(false);
  });

  it('returns prevAssistantUuid as undefined when no prior assistant UUID exists', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'user', timestamp: 1, sdkUserUuid: 'user-u' },
      { id: 'a1', role: 'assistant', content: 'resp', timestamp: 2, sdkAssistantUuid: 'resp-a' },
    ];

    const ctx = findRewindContext(messages, 0);
    expect(ctx.prevAssistantUuid).toBeUndefined();
    expect(ctx.hasResponse).toBe(true);
  });

  it('returns hasResponse as false when no following assistant UUID exists', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: 'prev', timestamp: 1, sdkAssistantUuid: 'prev-a' },
      { id: 'u1', role: 'user', content: 'user', timestamp: 2, sdkUserUuid: 'user-u' },
      { id: 'a2', role: 'assistant', content: 'no uuid', timestamp: 3 },
    ];

    const ctx = findRewindContext(messages, 1);
    expect(ctx.prevAssistantUuid).toBe('prev-a');
    expect(ctx.hasResponse).toBe(false);
  });
});

