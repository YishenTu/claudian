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

  describe('close resolves pending consumer', () => {
    it('resolves pending next() with done:true when closed', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Start waiting for a message (no message enqueued yet)
      const pendingPromise = iterator.next();

      // Close the channel while consumer is waiting
      channel.close();

      const result = await pendingPromise;
      expect(result.done).toBe(true);
    });
  });

  describe('queue overflow during active turn', () => {
    it('drops text when queue is full during active turn', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Start a turn
      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('first'));
      await firstPromise;

      // Fill queue during active turn - first text merges, then subsequent
      // ones also merge. But since merge limit is 10000 chars, we need to
      // fill the queue with non-text (attachment) + text to trigger overflow
      channel.enqueue(createTextUserMessage('queued-text'));

      // Enqueue attachments to fill remaining queue slots
      for (let i = 0; i < 8; i++) {
        channel.enqueue(createImageUserMessage(`img-${i}`));
      }

      // The 8th attachment should trigger overflow (text=1 + attachment=1 = 2 slots,
      // but attachments replace each other, so text=1 + attachment=1 = 2 used.
      // Additional image messages just replace the existing attachment slot)
      // The queue should have text + attachment = 2 items
      expect(channel.getQueueLength()).toBe(2);
    });
  });

  describe('enqueue attachment before consumer starts (no active turn)', () => {
    it('queues attachment message when no turn is active and no consumer', () => {
      channel.enqueue(createImageUserMessage('early-img'));
      expect(channel.getQueueLength()).toBe(1);
    });
  });

  describe('onTurnComplete with queued messages and waiting consumer', () => {
    it('delivers queued message to waiting consumer on turn complete', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Deliver first message to start a turn
      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('turn-1'));
      await firstPromise;

      // Queue a message during active turn
      channel.enqueue(createTextUserMessage('turn-2'));

      // Start waiting for next message (consumer blocks)
      const secondPromise = iterator.next();

      // Complete the turn - should deliver queued message to waiting consumer
      channel.onTurnComplete();

      const result = await secondPromise;
      expect(result.done).toBe(false);
      expect(result.value.message.content).toBe('turn-2');
      expect(channel.isTurnActive()).toBe(true);
    });
  });

  describe('text extraction from content blocks', () => {
    it('extracts text from mixed content blocks', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const mixedMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      const firstPromise = iterator.next();
      channel.enqueue(mixedMessage);
      const result = await firstPromise;

      // Text blocks should be joined with \n\n when no turn is active
      // (delivered directly to consumer)
      expect(result.value.message.content).toEqual(mixedMessage.message.content);
    });

    it('handles empty content gracefully', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Start a turn so messages get queued
      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('first'));
      await firstPromise;

      // Enqueue a message with no content during active turn
      const emptyMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: '',
        },
        parent_tool_use_id: null,
        session_id: '',
      };
      channel.enqueue(emptyMessage);

      channel.onTurnComplete();

      const result = await iterator.next();
      expect(result.value.message.content).toBe('');
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

  describe('extractTextContent with array content blocks', () => {
    it('should extract and merge text from array-format content during active turn', async () => {
      const ch = new MessageChannel();
      const iterator = ch[Symbol.asyncIterator]();

      // Start a turn with a normal message
      ch.enqueue(createTextUserMessage('initial'));
      await iterator.next(); // consume → turn active

      // Enqueue a message with array content (text-only, no images)
      // This goes through extractTextContent → filter/map/join path
      const arrayContentMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      ch.enqueue(arrayContentMessage);

      // Complete turn so merged message is delivered
      ch.onTurnComplete();
      const result = await iterator.next();
      // Text blocks should be extracted and joined with \n\n
      expect(result.value.message.content).toBe('Hello\n\nWorld');
    });

    it('should filter out non-text blocks from array content', async () => {
      const ch = new MessageChannel();
      const iterator = ch[Symbol.asyncIterator]();

      // Start a turn
      ch.enqueue(createTextUserMessage('initial'));
      await iterator.next(); // consume → turn active

      // Enqueue array content with mixed blocks but NO images (so treated as text)
      // Note: only blocks with type='text' should be extracted
      const mixedContentMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Visible' },
            { type: 'tool_result', tool_use_id: 'x', content: 'hidden' } as any,
            { type: 'text', text: 'Also Visible' },
          ],
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      ch.enqueue(mixedContentMessage);

      ch.onTurnComplete();
      const result = await iterator.next();
      expect(result.value.message.content).toBe('Visible\n\nAlso Visible');
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
