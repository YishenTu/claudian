import type { CollabProjectId } from '@claudian-collab/protocol';

import type { CollabOperationOptions } from '@/core/collab';

interface PendingFollow {
  attempts: number;
  timer: number | null;
}

/** Schedules one-hop recovery outside the session that observed the hint. */
export class AuthorityMigrationFollower {
  private readonly controller = new AbortController();
  private readonly pending = new Map<CollabProjectId, PendingFollow>();
  private readonly running = new Set<Promise<void>>();
  private readonly retryAfter = new Map<CollabProjectId, number>();

  constructor(private readonly options: {
    readonly follow: (projectId: CollabProjectId, options: CollabOperationOptions) => Promise<boolean>;
  }) {}

  notify(projectId: CollabProjectId): void {
    if (this.controller.signal.aborted || this.pending.has(projectId)
      || Date.now() < (this.retryAfter.get(projectId) ?? 0)) return;
    const pending: PendingFollow = { attempts: 0, timer: null };
    this.pending.set(projectId, pending);
    this.schedule(projectId, pending, 0);
  }

  beginClose(): void {
    this.controller.abort();
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) window.clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.retryAfter.clear();
  }

  async close(): Promise<void> {
    this.beginClose();
    await Promise.allSettled(this.running);
  }

  private schedule(projectId: CollabProjectId, pending: PendingFollow, delay: number): void {
    pending.timer = window.setTimeout(() => {
      pending.timer = null;
      const work = this.follow(projectId, pending);
      this.running.add(work);
      void work.finally(() => this.running.delete(work));
    }, delay);
  }

  private async follow(projectId: CollabProjectId, pending: PendingFollow): Promise<void> {
    pending.attempts += 1;
    try {
      await this.options.follow(projectId, { signal: this.controller.signal });
      this.pending.delete(projectId);
      this.retryAfter.delete(projectId);
    } catch {
      if (this.controller.signal.aborted) return;
      if (pending.attempts < 3) {
        this.schedule(projectId, pending, pending.attempts * 2_000);
      } else {
        this.pending.delete(projectId);
        this.retryAfter.set(projectId, Date.now() + 30_000);
      }
    }
  }
}
