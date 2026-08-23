import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabLocalProjectIndex,
} from '@/app/collab/CollabLocalProjectRepository';
import type { LocalCleanupRecord } from '@/app/collab/exit/LocalCleanupRecord';
import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import type { RetirementRecord } from '@/app/collab/retirement/RetirementRecord';
import { type CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RetirementLocalRecoveryStore {
  loadIndex(): Promise<CollabLocalProjectIndex>;
  loadRetirementRecord(projectId: CollabProjectId): Promise<RetirementRecord | null>;
  listRetirementAcknowledgementProjectIds(): Promise<readonly CollabProjectId[]>;
}

export interface RetirementLocalRecoveryPendingLeaves {
  load(projectId: CollabProjectId): Promise<PendingLeaveRecord | null>;
}

export interface RetirementLocalRecoveryCleanupRecords {
  listProjectIds(): Promise<readonly CollabProjectId[]>;
  load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null>;
}

export interface RetirementLocalRecoveryFinalizer {
  finalize(
    intent: { readonly choice: 'delete-files' | 'keep-files'; readonly projectId: CollabProjectId },
    options?: CollabOperationOptions,
  ): Promise<void>;
}

/**
 * Reconciles the two crash boundaries that cannot be represented by the Project
 * index alone: a durable retirement record before the Retired index write, and
 * an applied cleanup journal after the index/private projection was removed.
 */
export class RetirementLocalRecovery {
  constructor(
    private readonly store: RetirementLocalRecoveryStore,
    private readonly pendingLeaves: RetirementLocalRecoveryPendingLeaves,
    private readonly cleanupRecords: RetirementLocalRecoveryCleanupRecords,
    private readonly handler: { resume(projectId: CollabProjectId): Promise<void> },
    private readonly finalizer: RetirementLocalRecoveryFinalizer,
  ) {}

  async resume(options: CollabOperationOptions = {}): Promise<void> {
    const [index, journalProjectIds, acknowledgementProjectIds] = await Promise.all([
      this.store.loadIndex(),
      this.cleanupRecords.listProjectIds(),
      this.store.listRetirementAcknowledgementProjectIds(),
    ]);
    const indexed = new Set(index.projects.map(project => project.id));
    const journaled = new Set(journalProjectIds);
    const acknowledgementOnly = new Set(acknowledgementProjectIds);
    let firstError: unknown;
    for (const project of index.projects) {
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      const [retirement, pendingLeave, cleanupRecord] = await Promise.all([
        this.store.loadRetirementRecord(project.id),
        journaled.has(project.id) ? this.pendingLeaves.load(project.id) : Promise.resolve(null),
        journaled.has(project.id) ? this.cleanupRecords.load(project.id) : Promise.resolve(null),
      ]).catch(error => {
        firstError ??= error;
        return [null, null, null] as const;
      });
      if (
        project.lifecycle === 'retired'
        && cleanupRecord?.purpose === 'retire'
        && cleanupRecord.phase === 'choice-applied'
      ) {
        await this.finalizer.finalize({
          choice: cleanupRecord.choice,
          projectId: project.id,
        }, options).catch(error => {
          firstError ??= error;
        });
        continue;
      }
      if (retirement === null && (pendingLeave || project.lifecycle !== 'retired')) continue;
      await this.handler.resume(project.id).catch(error => {
        firstError ??= error;
      });
    }

    for (const projectId of journalProjectIds) {
      if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
      if (indexed.has(projectId)) continue;
      const [retirement, pendingLeave, cleanupRecord] = await Promise.all([
        this.store.loadRetirementRecord(projectId),
        this.pendingLeaves.load(projectId),
        this.cleanupRecords.load(projectId),
      ]).catch(error => {
        firstError ??= error;
        return [null, null, null] as const;
      });
      if (retirement && !acknowledgementOnly.has(projectId)) {
        await this.handler.resume(projectId).catch(error => {
          firstError ??= error;
        });
        continue;
      }
      if (pendingLeave || !cleanupRecord) continue;
      if (cleanupRecord.purpose === 'retire' && cleanupRecord.phase === 'choice-applied') {
        await this.finalizer.finalize({
          choice: cleanupRecord.choice,
          projectId,
        }, options).catch(error => {
          firstError ??= error;
        });
        continue;
      }
      if (cleanupRecord.purpose !== 'retire' || cleanupRecord.phase !== 'choice-applied') {
        firstError ??= new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume', 'open-diagnostics'],
          safeContext: { reason: 'orphaned-retired-cleanup-incomplete' },
        });
        continue;
      }
    }
    if (firstError instanceof Error) throw firstError;
    if (firstError) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume'],
        safeContext: { reason: 'retirement-local-recovery-incomplete' },
      });
    }
  }

}
