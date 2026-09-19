import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';

function message(text: string, uuid: SDKUserMessage['uuid']): SDKUserMessage {
  return {
    type: 'user', uuid, session_id: 'session', parent_tool_use_id: null,
    message: { role: 'user', content: text },
  };
}

describe('MessageChannel', () => {
  it('preserves native identity when input arrives before the SDK reader', async () => {
    const channel = new MessageChannel();
    const input = message('hello', '11111111-1111-1111-1111-111111111111');
    channel.enqueue(input);
    expect(await channel[Symbol.asyncIterator]().next()).toEqual({ value: input, done: false });
    channel.close();
  });

  it('delivers complete messages in order without merging or replacing input', async () => {
    const channel = new MessageChannel();
    const iterator = channel[Symbol.asyncIterator]();
    const first = message('first', '11111111-1111-1111-1111-111111111111');
    const second = message('second', '22222222-2222-2222-2222-222222222222');
    const pending = iterator.next();
    channel.enqueue(first);
    channel.enqueue(second);
    expect(await pending).toEqual({ value: first, done: false });
    expect(await iterator.next()).toEqual({ value: second, done: false });
    channel.close();
  });

  it('ends a waiting reader on close and rejects later input', async () => {
    const channel = new MessageChannel();
    const iterator = channel[Symbol.asyncIterator]();
    const pending = iterator.next();
    channel.close();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(() => channel.enqueue(message('late', undefined))).toThrow('closed');
  });

  it('discards undelivered input when the owning query closes', async () => {
    const channel = new MessageChannel();
    channel.enqueue(message('cancelled', undefined));
    channel.close();
    expect(await channel[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
  });
});
