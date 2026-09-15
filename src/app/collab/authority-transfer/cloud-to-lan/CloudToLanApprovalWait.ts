import { attemptAuthorityRecovery, type AuthorityRecoveryOutcome } from '@/app/collab/authority-transfer/AuthorityRecoveryOutcome';

interface ApprovalObservation {
  readonly controller: AbortController;
  resource?: { dispose(): void };
  pending: Promise<void> | null;
  requested: boolean;
}

/** Shares project observation; events and connection recovery wake the durable transfer owner. */
export class CloudToLanApprovalWait {
  readonly #projects = new Map<string, ApprovalObservation>();
  readonly #running = new Set<Promise<void>>();
  #closed = false;

  constructor(
    private readonly check: (projectId: string, signal: AbortSignal) => Promise<AuthorityRecoveryOutcome>,
    private readonly observe: (projectId: string) => { dispose(): void } = () => ({ dispose() {} }),
  ) {}

  start(projectId: string): void {
    if (this.#closed) return;
    if (!this.#projects.has(projectId)) {
      const observation: ApprovalObservation = { controller: new AbortController(), pending: null, requested: false };
      this.#projects.set(projectId, observation);
      try { observation.resource = this.observe(projectId); }
      catch (error) { this.#projects.delete(projectId); throw error; }
    }
    this.notify(projectId);
  }

  notify(projectId: string): void {
    const observation = this.#projects.get(projectId);
    if (this.#closed || !observation) return;
    observation.requested = true;
    if (observation.pending) return;
    const pending = Promise.resolve().then(async () => {
      while (observation.requested && !observation.controller.signal.aborted) {
        observation.requested = false;
        const outcome = await attemptAuthorityRecovery(
          () => this.check(projectId, observation.controller.signal), observation.controller.signal,
        );
        if (outcome.kind === 'completed' || outcome.kind === 'idle') {
          this.#projects.delete(projectId);
          observation.resource?.dispose();
          return;
        }
      }
    }).catch(() => {
      // Durable state remains available to the next observation or explicit Resume.
    }).finally(() => {
      observation.pending = null;
      this.#running.delete(pending);
      if (observation.requested) this.notify(projectId);
    });
    observation.pending = pending;
    this.#running.add(pending);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const observation of this.#projects.values()) {
      observation.controller.abort();
      observation.resource?.dispose();
    }
    this.#projects.clear();
    await Promise.all(this.#running);
  }
}
