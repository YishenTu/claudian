import { MessageChannel } from '@/core/agent/MessageChannel';
import type { GeminiUserMessage } from '@/core/agent/types';

function createTextUserMessage(content: string): GeminiUserMessage {
  return {
    prompt: content,
    sessionId: '',
  };
}

function createImageUserMessage(data = 'image-data'): GeminiUserMessage {
  return {
    prompt: '',
    images: [
      {
        mediaType: 'image/png',
        data,
      },
    ],
    sessionId: '',
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

      expect(first.value.prompt).toBe('first');

      channel.enqueue(createTextUserMessage('second'));
      channel.enqueue(createTextUserMessage('third'));
      channel.setSessionId('session-abc');
      channel.onTurnComplete();

      const merged = await iterator.next();
      expect(merged.value.prompt).toBe('second\n\nthird');
      expect(merged.value.sessionId).toBe('session-abc');
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
      expect(queued.value.images).toEqual(attachmentTwo.images);
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
      expect(merged.value.prompt).toBe('short');
      expect(warnings.some((msg) => msg.includes('Merged content exceeds'))).toBe(true);
    });

    it('delivers message when enqueue is called before next (no deadlock)', async () => {
      channel.enqueue(createTextUserMessage('early message'));

      const iterator = channel[Symbol.asyncIterator]();
      const result = await iterator.next();

      expect(result.done).toBe(false);
      expect(result.value.prompt).toBe('early message');
    });

    it('handles multiple enqueues before first next (queued separately)', async () => {
      channel.enqueue(createTextUserMessage('first'));
      channel.enqueue(createTextUserMessage('second'));

      const iterator = channel[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.prompt).toBe('first');

      channel.onTurnComplete();

      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value.prompt).toBe('second');
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
      for (let i = 0; i < 10; i++) {
        channel.enqueue(createTextUserMessage(`msg-${i}`));
      }

      expect(warnings.filter((msg) => msg.includes('Queue full'))).not.toHaveLength(0);
      expect(channel.getQueueLength()).toBe(8);
    });
  });

  describe('close resolves pending consumer', () => {
    it('resolves pending next() with done:true when closed', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const pendingPromise = iterator.next();
      channel.close();
      const result = await pendingPromise;
      expect(result.done).toBe(true);
    });
  });

  describe('queue overflow during active turn', () => {
    it('drops text when queue is full during active turn', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('first'));
      await firstPromise;

      channel.enqueue(createTextUserMessage('queued-text'));

      for (let i = 0; i < 8; i++) {
        channel.enqueue(createImageUserMessage(`img-${i}`));
      }

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

      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('turn-1'));
      await firstPromise;

      channel.enqueue(createTextUserMessage('turn-2'));

      const secondPromise = iterator.next();
      channel.onTurnComplete();

      const result = await secondPromise;
      expect(result.done).toBe(false);
      expect(result.value.prompt).toBe('turn-2');
      expect(channel.isTurnActive()).toBe(true);
    });
  });

  describe('text extraction from content blocks', () => {
    it('handles empty content gracefully', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue(createTextUserMessage('first'));
      await firstPromise;

      const emptyMessage: GeminiUserMessage = {
        prompt: '',
        sessionId: '',
      };
      channel.enqueue(emptyMessage);

      channel.onTurnComplete();

      const result = await iterator.next();
      expect(result.value.prompt).toBe('');
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
    it('should extract text from prompt during active turn', async () => {
      const ch = new MessageChannel();
      const iterator = ch[Symbol.asyncIterator]();

      ch.enqueue(createTextUserMessage('initial'));
      await iterator.next();

      ch.enqueue(createTextUserMessage('Hello'));
      ch.enqueue(createTextUserMessage('World'));

      ch.onTurnComplete();
      const result = await iterator.next();
      expect(result.value.prompt).toBe('Hello\n\nWorld');
    });
  });

  describe('turn management', () => {
    it('should track turn state correctly', async () => {
      expect(channel.isTurnActive()).toBe(false);

      const iterator = channel[Symbol.asyncIterator]();
      channel.enqueue(createTextUserMessage('test'));

      const firstPromise = iterator.next();
      const result = await firstPromise;

      expect(result.done).toBe(false);
      expect(channel.isTurnActive()).toBe(true);

      channel.onTurnComplete();
      expect(channel.isTurnActive()).toBe(false);
    });
  });
});
