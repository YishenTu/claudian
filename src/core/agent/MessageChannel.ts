/**
 * Message Channel
 *
 * Queue-based async iterable for persistent queries.
 * Handles message queuing, turn management, and text merging.
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  MESSAGE_CHANNEL_CONFIG,
  type PendingMessage,
  type PendingTextMessage,
} from './types';

/**
 * MessageChannel - Queue-based async iterable for persistent queries.
 *
 * Rules:
 * - Single in-flight turn at a time
 * - Text-only messages merge with \n\n while a turn is active
 * - Attachment messages (with images) queue one at a time; newer replaces older while turn is active
 * - Overflow policy: drop newest and warn
 */
export class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: PendingMessage[] = [];
  private turnActive = false;
  private closed = false;
  private resolveNext: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private currentSessionId: string | null = null;
  private onWarning: (message: string) => void;

  constructor(onWarning: (message: string) => void = () => {}) {
    this.onWarning = onWarning;
  }

  /** Set the session ID for outgoing messages. */
  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /** Check if a turn is currently active. */
  isTurnActive(): boolean {
    return this.turnActive;
  }

  /** Check if the channel is closed. */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Enqueue a message. If a turn is active:
   * - Text-only: merge with queued text (up to MAX_MERGED_CHARS)
   * - With attachments: replace any existing queued attachment (one at a time)
   */
  enqueue(message: SDKUserMessage): void {
    if (this.closed) {
      throw new Error('MessageChannel is closed');
    }

    const hasAttachments = this.messageHasAttachments(message);

    if (!this.turnActive) {
      if (this.resolveNext) {
        // Consumer is waiting - deliver immediately and mark turn active
        this.turnActive = true;
        const resolve = this.resolveNext;
        this.resolveNext = null;
        resolve({ value: message, done: false });
      } else {
        // No consumer waiting yet - queue for later pickup by next()
        // Don't set turnActive here; next() will set it when it dequeues
        if (this.queue.length >= MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES) {
          this.onWarning(`[MessageChannel] Queue full (${MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES}), dropping newest`);
          return;
        }
        if (hasAttachments) {
          this.queue.push({ type: 'attachment', message });
        } else {
          this.queue.push({ type: 'text', content: this.extractTextContent(message) });
        }
      }
      return;
    }

    // Turn is active - queue the message
    if (hasAttachments) {
      // Non-text messages are deferred as-is (one at a time)
      // Find existing attachment message or add new one
      const existingIdx = this.queue.findIndex(m => m.type === 'attachment');
      if (existingIdx >= 0) {
        // Replace existing (newer takes precedence for attachments)
        this.queue[existingIdx] = { type: 'attachment', message };
        this.onWarning('[MessageChannel] Attachment message replaced (only one can be queued)');
      } else {
        this.queue.push({ type: 'attachment', message });
      }
      return;
    }

    // Text-only - merge with existing text in queue
    const textContent = this.extractTextContent(message);
    const existingTextIdx = this.queue.findIndex(m => m.type === 'text');

    if (existingTextIdx >= 0) {
      const existing = this.queue[existingTextIdx] as PendingTextMessage;
      const mergedContent = existing.content + '\n\n' + textContent;

      // Check merged size
      if (mergedContent.length > MESSAGE_CHANNEL_CONFIG.MAX_MERGED_CHARS) {
        this.onWarning(`[MessageChannel] Merged content exceeds ${MESSAGE_CHANNEL_CONFIG.MAX_MERGED_CHARS} chars, dropping newest`);
        return;
      }

      existing.content = mergedContent;
    } else {
      // No existing text - add new
      if (this.queue.length >= MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES) {
        this.onWarning(`[MessageChannel] Queue full (${MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES}), dropping newest`);
        return;
      }
      this.queue.push({ type: 'text', content: textContent });
    }
  }

  /** Signal that the current turn has completed. */
  onTurnComplete(): void {
    this.turnActive = false;

    // Check if there's a queued message to send
    if (this.queue.length > 0 && this.resolveNext) {
      const pending = this.queue.shift()!;
      this.turnActive = true;
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: this.pendingToMessage(pending), done: false });
    }
  }

  /** Close the channel. */
  close(): void {
    this.closed = true;
    this.queue = [];
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
    }
  }

  /** Reset the channel for reuse. */
  reset(): void {
    this.queue = [];
    this.turnActive = false;
    this.closed = false;
    this.resolveNext = null;
  }

  /** Get the number of queued messages. */
  getQueueLength(): number {
    return this.queue.length;
  }

  /** AsyncIterable implementation. */
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
        }

        // If there's a queued message and no active turn, return it
        if (this.queue.length > 0 && !this.turnActive) {
          const pending = this.queue.shift()!;
          this.turnActive = true;
          return Promise.resolve({ value: this.pendingToMessage(pending), done: false });
        }

        // Wait for next message
        return new Promise((resolve) => {
          this.resolveNext = resolve;
        });
      },
    };
  }

  private messageHasAttachments(message: SDKUserMessage): boolean {
    if (!message.message?.content) return false;
    if (typeof message.message.content === 'string') return false;
    return message.message.content.some((block: { type: string }) => block.type === 'image');
  }

  private extractTextContent(message: SDKUserMessage): string {
    if (!message.message?.content) return '';
    if (typeof message.message.content === 'string') return message.message.content;
    return message.message.content
      .filter((block: { type: string }): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block: { type: 'text'; text: string }) => block.text)
      .join('\n\n');
  }

  private pendingToMessage(pending: PendingMessage): SDKUserMessage {
    if (pending.type === 'attachment') {
      return pending.message;
    }

    // Text-only - create a new SDKUserMessage
    return {
      type: 'user',
      message: {
        role: 'user',
        content: pending.content,
      },
      parent_tool_use_id: null,
      session_id: this.currentSessionId || '',
    };
  }
}
