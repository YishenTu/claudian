import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { MessageChannel } from '@/core/agent/MessageChannel';

// Helper to create SDK-format text user message
function createTextUserMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

// Helper to create SDK-format image user message
function createImageUserMessage(data = 'image-data'): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data,
          },
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

describe('MessageChannel', () => {
  let channel: MessageChannel;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    channel = new MessageChannel((message) => warnings.push(message));
  });

  afterEach(() => {
    channel.close();
  });

  describe('basic operations', () => {
    it('should initially not be closed', () => {
      expect(channel.isClosed()).toBe(false);
    });

    it('should initially have no active turn', () => {
      expect(channel.isTurnActive()).toBe(false);
    });

    it('should initially have empty queue', () => {
      expect(channel.getQueueLength()).toBe(0);
    });
  });

  describe('enqueue and iteration', () => {
    it('merges queued text messages and stamps the session ID', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('first'));
      const first = await firstPromise;

      expect(first.value.message.content).toBe('first');

      channel.enqueue(createTextUserMessage('second'));
      channel.enqueue(createTextUserMessage('third'));
      channel.setSessionId('session-abc');
      channel.onTurnComplete();

      const merged = await iterator.next();
      expect(merged.value.message.content).toBe('second\n\nthird');
      expect(merged.value.session_id).toBe('session-abc');
      expect(warnings).toHaveLength(0);
    });

    it('defers attachment messages and keeps the latest one', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('first'));
      await firstPromise;

      const attachmentOne = createImageUserMessage('image-one');
      const attachmentTwo = createImageUserMessage('image-two');

      channel.enqueue(attachmentOne);
      channel.enqueue(attachmentTwo);

      channel.onTurnComplete();

      const queued = await iterator.next();
      expect(queued.value.message.content).toEqual(attachmentTwo.message.content);
      expect(warnings.some((msg) => msg.includes('Attachment message replaced'))).toBe(true);
    });

    it('drops merged text when it exceeds the max length', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('first'));
      await firstPromise;

      const longText = 'x'.repeat(12000);
      channel.enqueue(createTextUserMessage('short'));
      channel.enqueue(createTextUserMessage(longText));

      channel.onTurnComplete();

      const merged = await iterator.next();
      expect(merged.value.message.content).toBe('short');
      expect(warnings.some((msg) => msg.includes('Merged content exceeds'))).toBe(true);
    });

    it('delivers message when enqueue is called before next (no deadlock)', async () => {
      // Enqueue BEFORE calling next() - this used to cause a deadlock
      channel.enqueue(createTextUserMessage('early message'));

      // Now call next() - it should pick up the queued message
      const iterator = channel[Symbol.asyncIterator]();
      const result = await iterator.next();

      expect(result.done).toBe(false);
      expect(result.value.message.content).toBe('early message');
    });

    it('handles multiple enqueues before first next (queued separately)', async () => {
      // Enqueue multiple messages before any next() call
      // When turnActive=false, messages queue separately (no merging)
      channel.enqueue(createTextUserMessage('first'));
      channel.enqueue(createTextUserMessage('second'));

      const iterator = channel[Symbol.asyncIterator]();

      // First next() gets first message, turns on turnActive
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.message.content).toBe('first');

      // Complete turn so second message can be delivered
      channel.onTurnComplete();

      // Second next() gets second message
      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value.message.content).toBe('second');
    });
  });

  describe('error handling', () => {
    it('throws error when enqueueing to closed channel', () => {
      channel.close();
      expect(() => channel.enqueue(createTextUserMessage('test'))).toThrow('MessageChannel is closed');
    });
  });

  describe('queue overflow', () => {
    it('drops newest messages when queue is full before consumer starts', () => {
      // Queue many messages before starting iteration (turnActive=false)
      for (let i = 0; i < 10; i++) {
        channel.enqueue(createTextUserMessage(`msg-${i}`));
      }

      // Queue full warning should be triggered
      expect(warnings.filter((msg) => msg.includes('Queue full'))).not.toHaveLength(0);

      // Verify the queue length is capped at MAX_QUEUED_MESSAGES (8)
      expect(channel.getQueueLength()).toBe(8);
    });
  });

  describe('close and reset', () => {
    it('should mark channel as closed', () => {
      channel.close();
      expect(channel.isClosed()).toBe(true);
    });

    it('should clear queue on close', () => {
      channel.enqueue(createTextUserMessage('test'));
      channel.close();
      expect(channel.getQueueLength()).toBe(0);
    });

    it('should reset channel state', () => {
      channel.enqueue(createTextUserMessage('test'));
      channel.reset();
      expect(channel.getQueueLength()).toBe(0);
      expect(channel.isClosed()).toBe(false);
      expect(channel.isTurnActive()).toBe(false);
    });

    it('should return done when iterating closed channel', async () => {
      channel.close();
      const iterator = channel[Symbol.asyncIterator]();
      const result = await iterator.next();
      expect(result.done).toBe(true);
    });
  });

  describe('turn management', () => {
    it('should track turn state correctly', async () => {
      expect(channel.isTurnActive()).toBe(false);

      const iterator = channel[Symbol.asyncIterator]();
      channel.enqueue(createTextUserMessage('test'));

      // Wait for message to be delivered
      const firstPromise = iterator.next();
      const result = await firstPromise;

      expect(result.done).toBe(false);
      expect(channel.isTurnActive()).toBe(true);

      channel.onTurnComplete();
      expect(channel.isTurnActive()).toBe(false);
    });
  });
});
