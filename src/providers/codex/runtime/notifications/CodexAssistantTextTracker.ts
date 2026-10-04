import type { CitationGroup, StreamChunk } from '@/core/types';
import {
  normalizeCodexMemoryCitation,
  stripCodexMemoryCitationMarkup,
} from '@/providers/codex/normalization/CodexMemoryCitation';
import type { AgentMessageItem } from '@/providers/codex/runtime/codexAppServerTypes';

import { asRecord, firstString } from './codexNotificationValues';

/**
 * Deduplicates assistant text that arrives as deltas, completed agent messages,
 * raw response messages, and turn-level event messages.
 *
 * Completion text is compared against what already streamed for the same message,
 * the current segment (text since the last tool boundary), or the whole turn.
 */
export class CodexAssistantTextTracker {
  #startedMessageIds = new Set<string>();
  #streamedTextByMessageId = new Map<string, string>();
  #emittedCitationIds = new Set<string>();
  #emittedCitationKeys = new Set<string>();
  #turnText = '';
  #segmentId: string | undefined;
  #segmentText = '';

  constructor(private readonly emit: (chunk: StreamChunk) => void) {}

  reset(): void {
    this.#startedMessageIds.clear();
    this.#streamedTextByMessageId.clear();
    this.#emittedCitationIds.clear();
    this.#emittedCitationKeys.clear();
    this.#turnText = '';
    this.endSegment();
  }

  /** A visible tool card separates assistant text segments. */
  endSegment(): void {
    this.#segmentId = undefined;
    this.#segmentText = '';
  }

  appendDelta(itemId: string, delta: string): void {
    const previousText = this.#streamedTextByMessageId.get(itemId) ?? '';
    this.#streamedTextByMessageId.set(itemId, previousText + delta);
    if (delta) {
      this.#claimSegment(itemId);
      this.#segmentText += delta;
      this.#turnText += delta;
    }
    this.emit({ type: 'text', content: delta });
  }

  startMessage(itemId: string): void {
    if (this.#startedMessageIds.has(itemId)) {
      return;
    }

    this.#startedMessageIds.add(itemId);
    this.#claimSegment(itemId);
    this.emit({ type: 'assistant_message_start', itemId });
  }

  completeMessage(item: AgentMessageItem): void {
    this.startMessage(item.id);

    const visibleText = stripCodexMemoryCitationMarkup(item.text);
    if (visibleText) {
      this.#emitMissingMessageText(visibleText, item.id);
    }

    this.#emitMemoryCitation(item.memoryCitation, item.id);
  }

  /** Raw response messages carry no item ID; they complete the current segment. */
  completeRawMessage(item: Record<string, unknown>): void {
    const rawText = item.type === 'message'
      ? readAssistantMessageText(item)
      : firstString(item.text, item.message);
    const text = stripCodexMemoryCitationMarkup(rawText);
    const missingText = normalizeCompletionText(text, this.#segmentText);
    if (text) {
      this.#segmentText = text;
      if (this.#segmentId) {
        this.#streamedTextByMessageId.set(this.#segmentId, text);
      }
    }
    if (!missingText) {
      return;
    }

    this.#turnText += missingText;
    this.emit({ type: 'text', content: missingText });
  }

  /** Turn-level agent message events complete the whole turn's text. */
  completeTurnMessage(rawText: string, memoryCitation: unknown): void {
    const text = stripCodexMemoryCitationMarkup(rawText);
    const missingText = normalizeCompletionText(text, this.#turnText);
    if (missingText) {
      this.#turnText += missingText;
      this.#segmentText += missingText;
      if (this.#segmentId) {
        this.#streamedTextByMessageId.set(this.#segmentId, this.#segmentText);
      }
      this.emit({ type: 'text', content: missingText });
    }
    this.#emitMemoryCitation(memoryCitation);
  }

  /** Message IDs split segments; text without one joins the current segment. */
  #claimSegment(itemId: string): void {
    if (!itemId || this.#segmentId === itemId) {
      return;
    }
    if (this.#segmentId) {
      this.#segmentText = '';
    }
    this.#segmentId = itemId;
  }

  #emitMissingMessageText(text: string, itemId: string): void {
    const streamedText = this.#streamedTextByMessageId.get(itemId) ?? '';
    const missingText = normalizeCompletionText(text, streamedText);
    if (text) {
      this.#streamedTextByMessageId.set(itemId, text);
    }
    if (!missingText) {
      return;
    }

    this.#claimSegment(itemId);
    this.#segmentText = text;
    this.#turnText += missingText;
    this.emit({ type: 'text', content: missingText });
  }

  #emitMemoryCitation(value: unknown, itemId?: string): void {
    if (itemId && this.#emittedCitationIds.has(itemId)) {
      return;
    }
    const citations = normalizeCodexMemoryCitation(value);
    if (!citations) {
      return;
    }

    if (itemId) {
      this.#emittedCitationIds.add(itemId);
    }
    const citationKey = buildMemoryCitationKey(citations);
    if (this.#emittedCitationKeys.has(citationKey)) {
      return;
    }

    this.#emittedCitationKeys.add(citationKey);
    this.emit({ type: 'citations', citations });
  }
}

function buildMemoryCitationKey(citations: CitationGroup): string {
  return citations.entries
    .map(entry => [entry.path, entry.lineStart, entry.lineEnd, entry.note].join('\0'))
    .join('\u0001');
}

function readAssistantMessageText(item: Record<string, unknown>): string {
  if (firstString(item.role) !== 'assistant') {
    return '';
  }
  if (!Array.isArray(item.content)) {
    return '';
  }

  return item.content
    .map((entry) => firstString(asRecord(entry)?.text))
    .join('');
}

function normalizeCompletionText(text: string, streamedText: string): string {
  if (!text) {
    return '';
  }
  if (!streamedText) {
    return text;
  }
  if (text.startsWith(streamedText)) {
    return text.slice(streamedText.length);
  }
  return text;
}
