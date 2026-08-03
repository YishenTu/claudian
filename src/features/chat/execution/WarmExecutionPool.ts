export const DEFAULT_MAX_WARM_AGENT_PROCESSES = 5;
export const MIN_WARM_AGENT_PROCESSES = 5;
export const MAX_WARM_AGENT_PROCESSES = 10;

export function normalizeWarmExecutionLimit(configured: unknown): number {
  const finite = typeof configured === 'number' && Number.isFinite(configured)
    ? Math.trunc(configured)
    : DEFAULT_MAX_WARM_AGENT_PROCESSES;
  return Math.max(
    MIN_WARM_AGENT_PROCESSES,
    Math.min(MAX_WARM_AGENT_PROCESSES, finite),
  );
}

export interface WarmExecutionOwner {
  readonly id: string;
  canCool(): boolean;
  cool(): Promise<void>;
}

interface WarmExecutionEntry {
  owner: WarmExecutionOwner;
  lastUsed: number;
}

export class WarmExecutionCapacityError extends Error {
  constructor(readonly limit: number) {
    super(
      `The concurrent running session limit (${limit}) is currently in use. `
      + 'Finish or stop a session before starting another.',
    );
    this.name = 'WarmExecutionCapacityError';
  }
}

/**
 * Application-scoped LRU ownership pool for persistent chat execution sessions.
 * Runtime tabs remain independent from this resource limit.
 */
export class WarmExecutionPool {
  private readonly entries = new Map<string, WarmExecutionEntry>();
  private operationTail: Promise<void> = Promise.resolve();
  private usageSequence = 0;

  constructor(private readonly getConfiguredLimit: () => number) {}

  acquire(owner: WarmExecutionOwner): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.entries.get(owner.id);
      if (existing) {
        existing.owner = owner;
        existing.lastUsed = this.nextUsageSequence();
        await this.coolExcessOwners(this.getLimit());
        return;
      }

      const limit = this.getLimit();
      while (this.entries.size >= limit) {
        const victim = this.findCoolingCandidate();
        if (!victim) {
          throw new WarmExecutionCapacityError(limit);
        }

        await victim.owner.cool();
        this.entries.delete(victim.owner.id);
      }

      this.entries.set(owner.id, {
        owner,
        lastUsed: this.nextUsageSequence(),
      });
    });
  }

  release(ownerId: string): void {
    this.entries.delete(ownerId);
  }

  has(ownerId: string): boolean {
    return this.entries.has(ownerId);
  }

  getWarmCount(): number {
    return this.entries.size;
  }

  reconcileLimit(): Promise<boolean> {
    return this.enqueue(() => this.coolExcessOwners(this.getLimit()));
  }

  notifyOwnerMayCool(ownerId: string): Promise<boolean> {
    if (!this.entries.has(ownerId) || this.entries.size <= this.getLimit()) {
      return Promise.resolve(this.entries.size <= this.getLimit());
    }
    return this.reconcileLimit();
  }

  touch(ownerId: string): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.entries.get(ownerId);
      if (!entry) return;
      entry.lastUsed = this.nextUsageSequence();
      await this.coolExcessOwners(this.getLimit());
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail
      .catch(() => undefined)
      .then(operation);
    this.operationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private findCoolingCandidate(): WarmExecutionEntry | null {
    let candidate: WarmExecutionEntry | null = null;
    for (const entry of this.entries.values()) {
      if (!entry.owner.canCool()) continue;
      if (!candidate || entry.lastUsed < candidate.lastUsed) {
        candidate = entry;
      }
    }
    return candidate;
  }

  private async coolExcessOwners(limit: number): Promise<boolean> {
    while (this.entries.size > limit) {
      const victim = this.findCoolingCandidate();
      if (!victim) return false;
      await victim.owner.cool();
      this.entries.delete(victim.owner.id);
    }
    return true;
  }

  private getLimit(): number {
    return normalizeWarmExecutionLimit(this.getConfiguredLimit());
  }

  private nextUsageSequence(): number {
    this.usageSequence += 1;
    return this.usageSequence;
  }
}
