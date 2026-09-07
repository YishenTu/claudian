import type { CollabProjectId } from '@claudian-collab/protocol';

import type { LocalProjectExitCoordinator } from '@/app/collab/exit/LocalProjectExitCoordinator';
import type { PendingLeaveJournalPort } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import type {
  CollabProjectLifecycleAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';

export interface PendingLeaveWorkerResult {
  readonly attempted: readonly CollabProjectId[];
  readonly failed: readonly CollabProjectId[];
}

export class PendingLeaveWorker {
  private inFlight: Promise<PendingLeaveWorkerResult> | null = null;

  constructor(
    private readonly pendingLeaves: Pick<PendingLeaveJournalPort, 'list'>,
    private readonly exits: Pick<LocalProjectExitCoordinator, 'resume'>,
    private readonly projectRecoveryAdmission: CollabProjectLifecycleAdmission,
  ) {}

  async runOnce(signal?: AbortSignal): Promise<PendingLeaveWorkerResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.runPass(signal);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async runPass(signal?: AbortSignal): Promise<PendingLeaveWorkerResult> {
    const attempted: CollabProjectId[] = [];
    const failed: CollabProjectId[] = [];
    for (const pending of await this.pendingLeaves.list()) {
      if (signal?.aborted) break;
      attempted.push(pending.projectId);
      try {
        await this.projectRecoveryAdmission(
          pending.projectId,
          async () => {
            await this.exits.resume(
              pending.projectId,
              signal ? { signal } : {},
            );
          },
        );
      } catch {
        failed.push(pending.projectId);
      }
    }
    return { attempted, failed };
  }
}
