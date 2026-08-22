import { randomUUID } from 'node:crypto';

import { collabMemberRef, type CollabProjectId } from '@claudian/collab-protocol';

import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import type { CollabRetiredProjectProjectionSeed } from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import {
  decodeLocalCleanupRecord,
  type LocalCleanupRecord,
} from '@/app/collab/exit/LocalCleanupRecord';
import type { LocalProjectCleanupPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import type { PendingLeaveRecord } from '@/app/collab/exit/PendingLeaveRecord';
import type {
  RetirementAcknowledgementScheduler,
  RetirementClientStore,
} from '@/app/collab/retirement/RetirementAcknowledgementWorker';
import {
  decodeRetirementRecord,
  type RetirementRecord,
} from '@/app/collab/retirement/RetirementRecord';
import type { CollabRetirementResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type RetirementDeliverySource = 'event' | 'response' | 'terminal-fallback';

export interface RetirementClientProjectionStore extends RetirementClientStore {
  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null>;
  loadWorkspacePath(projectId: CollabProjectId): Promise<string | null>;
  transitionProjectToRetired(
    record: RetirementRecord,
    projectionSeed?: CollabRetiredProjectProjectionSeed,
  ): Promise<void>;
}

export interface RetirementClientActivityPort {
  closeProject(projectId: CollabProjectId): Promise<void>;
  drainProject(projectId: CollabProjectId): Promise<void>;
}

export interface RetirementClientHandlerOptions {
  readonly createOperationId?: () => string;
  readonly now?: () => Date;
  readonly publish?: (projectId: CollabProjectId) => void;
  readonly pendingLeaves?: {
    load(projectId: CollabProjectId): Promise<PendingLeaveRecord | null>;
    remove(projectId: CollabProjectId): Promise<boolean>;
  };
  readonly pendingLeaveCleanup?: Pick<LocalProjectCleanupPort, 'resume'>;
  readonly pendingLeaveCleanupRecords?: {
    load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null>;
  };
  readonly retiredCleanupRecords?: {
    load(projectId: CollabProjectId): Promise<LocalCleanupRecord | null>;
    save(record: LocalCleanupRecord): Promise<void>;
  };
}

export class RetirementClientHandler {
  private readonly acknowledgementsScheduled = new Set<CollabProjectId>();
  private readonly activityClosed = new Set<CollabProjectId>();
  private readonly createOperationId: () => string;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly now: () => Date;
  private readonly operations = new Map<CollabProjectId, Promise<void>>();
  private readonly publish?: (projectId: CollabProjectId) => void;
  private readonly pendingLeaves?: RetirementClientHandlerOptions['pendingLeaves'];
  private readonly pendingLeaveCleanup?: RetirementClientHandlerOptions['pendingLeaveCleanup'];
  private readonly pendingLeaveCleanupRecords?: RetirementClientHandlerOptions[
    'pendingLeaveCleanupRecords'
  ];
  private readonly retiredCleanupRecords?: RetirementClientHandlerOptions['retiredCleanupRecords'];

  constructor(
    private readonly store: RetirementClientProjectionStore,
    private readonly activity: RetirementClientActivityPort,
    private readonly acknowledgements: RetirementAcknowledgementScheduler,
    private readonly cleanup: LocalProjectCleanupPort,
    options: RetirementClientHandlerOptions = {},
  ) {
    this.createOperationId = options.createOperationId
      ?? (() => `retire-${randomUUID().replaceAll('-', '')}`);
    this.now = options.now ?? (() => new Date());
    this.publish = options.publish;
    this.pendingLeaves = options.pendingLeaves;
    this.pendingLeaveCleanup = options.pendingLeaveCleanup;
    this.pendingLeaveCleanupRecords = options.pendingLeaveCleanupRecords;
    this.retiredCleanupRecords = options.retiredCleanupRecords;
  }

  handle(result: CollabRetirementResult, _source: RetirementDeliverySource): Promise<void> {
    return this.enqueue(result.projectId, () => this.handleUnlocked(result));
  }

  async resume(projectId: CollabProjectId): Promise<void> {
    return this.enqueue(projectId, async () => {
      const record = await this.store.loadRetirementRecord(projectId);
      if (!record) throw new CollabError({ code: 'project-not-found' });
      const pendingLeave = await this.pendingLeaves?.load(projectId) ?? null;
      if (pendingLeave && await this.adoptPendingLeaveCleanup(pendingLeave)) {
        await this.seedCompletedRetirementCleanup(
          pendingLeave,
          record.createdAt,
        );
      }
      await this.store.transitionProjectToRetired(
        record,
        pendingLeave ? this.projectionSeedFromPendingLeave(pendingLeave) : undefined,
      );
      await this.pendingLeaves?.remove(projectId);
      await this.converge(record);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.allSettled([...this.operations.values()]).then(() => undefined);
    return this.closePromise;
  }

  private async handleUnlocked(result: CollabRetirementResult): Promise<void> {
    const existing = await this.store.loadRetirementRecord(result.projectId);
    if (existing) {
      if (existing.retiredAt !== result.retiredAt) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'retirement-result-changed' },
        });
      }
      const pendingLeave = await this.pendingLeaves?.load(result.projectId) ?? null;
      if (pendingLeave && await this.adoptPendingLeaveCleanup(pendingLeave)) {
        await this.seedCompletedRetirementCleanup(
          pendingLeave,
          existing.createdAt,
        );
      }
      await this.store.transitionProjectToRetired(
        existing,
        pendingLeave ? this.projectionSeedFromPendingLeave(pendingLeave) : undefined,
      );
      await this.pendingLeaves?.remove(result.projectId);
      await this.converge(existing);
      return;
    }
    const membership = await this.store.loadMembership(result.projectId);
    if (membership && !isCollabLocalLanMembership(membership)) {
      throw new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'retirement-client-lan-only' },
      });
    }
    const pendingLeave = membership
      ? null
      : await this.pendingLeaves?.load(result.projectId) ?? null;
    if (!membership && !pendingLeave) throw new CollabError({ code: 'project-not-found' });
    const createdAt = maxTimestamp(this.now().toISOString(), result.retiredAt);
    const pendingLeaveCleanupComplete = pendingLeave
      ? await this.adoptPendingLeaveCleanup(pendingLeave)
      : false;
    const record = decodeRetirementRecord({
      acknowledgedAt: null,
      acknowledgementStatus: 'pending',
      cleanupOperationId: this.createOperationId(),
      cleanupStatus: pendingLeaveCleanupComplete ? 'complete' : 'pending',
      createdAt,
      hostCaCertificatePem: membership?.authority.hostCaCertificatePem
        ?? pendingLeave?.hostCaCertificatePem,
      hostCaFingerprint: membership?.authority.hostCaFingerprint
        ?? pendingLeave?.hostCaFingerprint,
      hostEndpoint: membership?.authority.endpoint ?? pendingLeave?.hostEndpoint,
      kind: 'retirement',
      memberCredential: membership?.member.credential ?? pendingLeave?.memberCredential,
      memberId: membership?.member.id ?? pendingLeave?.memberId,
      projectId: result.projectId,
      retiredAt: result.retiredAt,
      schemaVersion: 1,
      updatedAt: createdAt,
    });
    const projectionSeed: CollabRetiredProjectProjectionSeed = membership
      ? {
          authorityKind: membership.authority.kind,
          createdAt: membership.createdAt,
          name: membership.project.name,
          workspacePath: membership.project.workspacePath,
        }
      : {
          ...this.projectionSeedFromPendingLeave(pendingLeave!),
        };
    if (pendingLeave && pendingLeaveCleanupComplete) {
      await this.seedCompletedRetirementCleanup(pendingLeave, createdAt);
    }
    await this.store.transitionProjectToRetired(record, projectionSeed);
    await this.pendingLeaves?.remove(result.projectId);
    await this.converge(record);
  }

  private async adoptPendingLeaveCleanup(
    pendingLeave: PendingLeaveRecord,
  ): Promise<boolean> {
    if (pendingLeave.localCleanupComplete) return true;
    const leaveCleanup = await this.pendingLeaveCleanupRecords?.load(pendingLeave.projectId)
      ?? null;
    if (!leaveCleanup) return false;
    if (
      leaveCleanup.purpose !== 'leave'
      || leaveCleanup.operationId !== pendingLeave.operationId
      || leaveCleanup.markerNonce !== pendingLeave.cleanupMarkerNonce
      || leaveCleanup.memberId !== pendingLeave.memberId
      || leaveCleanup.workspacePath !== pendingLeave.workspacePath
      || leaveCleanup.choice !== pendingLeave.cleanupChoice
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'pending-leave-cleanup-identity-conflict' },
      });
    }
    if (leaveCleanup.phase !== 'complete') {
      if (!this.pendingLeaveCleanup) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume', 'open-diagnostics'],
          safeContext: { reason: 'pending-leave-cleanup-resumer-missing' },
        });
      }
      const result = await this.pendingLeaveCleanup.resume(pendingLeave.projectId);
      if (result.status !== 'complete') return false;
    }
    return true;
  }

  private async seedCompletedRetirementCleanup(
    pendingLeave: PendingLeaveRecord,
    timestamp: string,
  ): Promise<void> {
    if (!this.retiredCleanupRecords) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume', 'open-diagnostics'],
        safeContext: { reason: 'retirement-cleanup-journal-missing' },
      });
    }
    const existing = await this.retiredCleanupRecords.load(pendingLeave.projectId);
    if (existing) {
      if (
        existing.purpose !== 'retire'
        || existing.phase !== 'choice-applied'
        || existing.choice !== pendingLeave.cleanupChoice
        || existing.memberId !== pendingLeave.memberId
        || existing.workspacePath !== pendingLeave.workspacePath
      ) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'retirement-cleanup-journal-conflict' },
        });
      }
      return;
    }
    await this.retiredCleanupRecords.save(decodeLocalCleanupRecord({
      choice: pendingLeave.cleanupChoice,
      createdAt: timestamp,
      kind: 'local-cleanup',
      markerNonce: pendingLeave.cleanupMarkerNonce,
      memberId: pendingLeave.memberId,
      operationId: pendingLeave.operationId,
      phase: 'choice-applied',
      projectId: pendingLeave.projectId,
      purpose: 'retire',
      schemaVersion: 1,
      updatedAt: timestamp,
      workspacePath: pendingLeave.workspacePath,
    }));
  }

  private projectionSeedFromPendingLeave(
    record: PendingLeaveRecord,
  ): CollabRetiredProjectProjectionSeed {
    return {
      authorityKind: 'lan',
      createdAt: record.projectCreatedAt,
      name: record.projectName,
      workspacePath: record.workspacePath,
    };
  }

  private async converge(initial: RetirementRecord): Promise<void> {
    const projectId = initial.projectId;
    if (!this.activityClosed.has(projectId)) {
      await this.activity.closeProject(projectId);
      this.activityClosed.add(projectId);
    }
    if (!this.acknowledgementsScheduled.has(projectId)) {
      this.acknowledgementsScheduled.add(projectId);
      this.acknowledgements.schedule(projectId);
    }
    if (initial.cleanupStatus === 'complete') {
      this.publish?.(projectId);
      return;
    }
    await this.activity.drainProject(projectId);
    const timestamp = maxTimestamp(this.now().toISOString(), initial.createdAt);
    await this.store.updateRetirementRecord(projectId, current => decodeRetirementRecord({
      ...current,
      cleanupStatus: 'running',
      updatedAt: timestamp,
    }));
    try {
      const workspacePath = await this.store.loadWorkspacePath(projectId);
      if (!workspacePath) throw new CollabError({ code: 'project-not-found' });
      const result = await this.cleanup.cleanup({
        choice: 'keep-files',
        memberId: initial.memberId,
        operationId: initial.cleanupOperationId,
        personalRef: collabMemberRef(initial.memberId),
        projectId,
        purpose: 'retire',
        workspacePath,
      }, {});
      if (result.status === 'cancelled') return;
      await this.store.updateRetirementRecord(projectId, current => decodeRetirementRecord({
        ...current,
        cleanupStatus: 'complete',
        updatedAt: maxTimestamp(this.now().toISOString(), current.updatedAt),
      }));
    } catch (error) {
      await this.store.updateRetirementRecord(projectId, current => decodeRetirementRecord({
        ...current,
        cleanupStatus: 'failed',
        updatedAt: maxTimestamp(this.now().toISOString(), current.updatedAt),
      }));
      this.publish?.(projectId);
      throw error;
    }
    this.publish?.(projectId);
  }

  private enqueue(projectId: CollabProjectId, operation: () => Promise<void>): Promise<void> {
    if (this.closed) {
      return Promise.reject(new CollabError({
        code: 'cancelled',
        safeContext: { reason: 'retirement-client-handler-closed' },
      }));
    }
    const preceding = this.operations.get(projectId) ?? Promise.resolve();
    const pending = preceding.catch(() => undefined).then(operation);
    this.operations.set(projectId, pending);
    const clear = () => {
      if (this.operations.get(projectId) === pending) this.operations.delete(projectId);
    };
    void pending.then(clear, clear);
    return pending;
  }
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
