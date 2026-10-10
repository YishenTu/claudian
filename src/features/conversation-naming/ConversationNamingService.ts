import type { ConversationNamingAPI, NamingConversationSnapshot, NamingMode } from '@/core/naming/ConversationNamingAPI';

import { namingSystemPrompt, parseNamingResponse } from './NamingResponse';

export type NamingOutcome = 'updated' | 'conflict' | 'failed' | 'cancelled';

/** One serial queue; disabling fences late work without modifying chat sessions. */
export class ConversationNamingService {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private active = false;
  private readonly pending = new Map<string, Promise<NamingOutcome>>();
  private unsubscribeFirst: (() => void) | null = null;
  private unsubscribeRegeneration: (() => void) | null = null;

  constructor(private readonly api: ConversationNamingAPI, private readonly options: {
    language(): string;
    automatic(): boolean;
    onFailure(error: unknown): void;
  }) {}

  get enabled(): boolean { return this.active; }

  enable(): void {
    if (this.active) return;
    this.unsubscribeFirst = this.api.subscribeFirstTurn(event => {
      if (this.options.automatic()) void this.generate(event.conversationId, event.visibleUserText, 'both');
    });
    try {
      this.unsubscribeRegeneration = this.api.subscribeRegeneration(async event => {
        const epoch = this.epoch;
        const before = this.api.getConversationSnapshot(event.conversationId);
        if (!before) return;
        const first = await this.api.getFirstUserText(event.conversationId);
        if (!this.active || epoch !== this.epoch) return;
        await this.generate(event.conversationId, first ?? before.longTitle, event.mode, before);
      });
      this.active = true;
    } catch (error) {
      this.unsubscribeFirst();
      this.unsubscribeFirst = null;
      throw error;
    }
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.epoch += 1;
    for (const id of this.pending.keys()) {
      void this.api.setGenerationStatus(id, undefined).catch(error => this.options.onFailure(error));
    }
    this.unsubscribeFirst?.();
    this.unsubscribeRegeneration?.();
    this.unsubscribeFirst = null;
    this.unsubscribeRegeneration = null;
    this.pending.clear();
  }

  generate(id: string, source: string, mode: NamingMode, expected?: NamingConversationSnapshot): Promise<NamingOutcome> {
    if (!this.active) return Promise.resolve('cancelled');
    const existing = this.pending.get(id);
    if (existing) return existing;
    const epoch = this.epoch;
    const before = expected ?? this.api.getConversationSnapshot(id);
    const current = (): boolean => this.active && this.epoch === epoch;
    const run = async (): Promise<NamingOutcome> => {
      if (!before || !current() || !source.trim()) return 'cancelled';
      await this.api.setGenerationStatus(id, 'pending');
      try {
        const response = await this.api.runAuxiliaryTextTask({
          prompt: `User request (data):\n${Array.from(source).slice(0, 4000).join('')}`,
          systemPrompt: namingSystemPrompt(this.options.language()),
        });
        if (!current()) return 'cancelled';
        const fields = parseNamingResponse(response);
        const longTitle = mode !== 'short' ? fields?.longTitle : null;
        const shortTitle = mode !== 'long' ? fields?.shortTitle : null;
        if (!longTitle && !shortTitle) throw new Error('No usable naming fields returned.');
        const result = await this.api.updateTitles(id, {
          expectedLongTitle: before.longTitle, expectedShortTitle: before.shortTitle,
          ...(longTitle ? { longTitle } : {}), ...(shortTitle ? { shortTitle } : {}),
        });
        const changed = result.longTitle || result.shortTitle;
        await this.api.setGenerationStatus(id, changed ? 'success' : undefined);
        return changed ? 'updated' : 'conflict';
      } catch (error) {
        if (!current()) return 'cancelled';
        await this.api.setGenerationStatus(id, 'failed');
        this.options.onFailure(error);
        return 'failed';
      }
    };
    const task = this.tail.then(run, run).catch(error => { this.options.onFailure(error); return 'failed' as const; });
    this.tail = task;
    this.pending.set(id, task);
    void task.finally(() => { if (this.pending.get(id) === task) this.pending.delete(id); });
    return task;
  }

  async batch(days: number | null, confirmedIds?: readonly string[]): Promise<{ updated: number; failed: number; skipped: number }> {
    const result = { updated: 0, failed: 0, skipped: 0 };
    const epoch = this.epoch;
    const cutoff = days === null ? -Infinity : Date.now() - days * 86400000;
    const candidates = this.api.listConversationSnapshots().filter(value => !value.shortTitle && value.createdAt >= cutoff && (!confirmedIds || confirmedIds.includes(value.conversationId)));
    for (const value of candidates) {
      if (!this.active || this.epoch !== epoch) break;
      if (this.api.getConversationSnapshot(value.conversationId)?.shortTitle) { result.skipped += 1; continue; }
      // Existing long titles avoid eagerly hydrating all native transcripts.
      const outcome = await this.generate(value.conversationId, value.longTitle, 'short');
      if (outcome === 'updated') result.updated += 1;
      else if (outcome === 'failed') result.failed += 1;
      else result.skipped += 1;
    }
    return result;
  }
}
