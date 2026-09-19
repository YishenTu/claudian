import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** The execution strategy owns turn admission; this channel preserves native input identity. */
export class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private closed = false;
  private resolveNext: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;

  enqueue(message: SDKUserMessage): void {
    if (this.closed) throw new Error('MessageChannel is closed');
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.resolveNext?.({ value: undefined, done: true });
    this.resolveNext = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        const message = this.queue.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        return new Promise(resolve => { this.resolveNext = resolve; });
      },
    };
  }
}
