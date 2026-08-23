import { randomUUID } from 'node:crypto';

import { type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';

import type { CollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import { classifyLocalContribution } from '@/app/collab/publish/LocalContributionClassifier';
import type {
  PublishProjectContext,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { type CollabConflictDescriptor, type CollabOperationOptions, type CollabProjectSnapshot, type CollabReconciliationOutcome, type CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type ReconciliationPlan =
  | { readonly kind: 'current' }
  | { readonly kind: 'fast-forward' }
  | { readonly kind: 'diverged' }
  | {
    readonly conflict: CollabConflictDescriptor;
    readonly kind: 'conflicting';
  };

export interface ReconciliationFastForwardResult {
  readonly kind: 'fast-forwarded';
  readonly snapshot: PublishRepositorySnapshot;
}

export interface ReconciliationProjectPort {
  load(projectId: CollabProjectId): Promise<PublishProjectContext>;
  revalidate(context: PublishProjectContext): Promise<void>;
}

export interface ReconciliationRepositoryPort {
  fetch(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
  inspect(
    context: PublishProjectContext,
    signal?: AbortSignal,
  ): Promise<PublishRepositorySnapshot>;
  fastForward(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<ReconciliationFastForwardResult>;
  plan(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<ReconciliationPlan>;
  pushPersonal(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ReconciliationControlPort {
  readSnapshot(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabProjectSnapshot>;
}

export interface ReconciliationPublicationStatePort {
  load(projectId: CollabProjectId): Promise<CollabPublicationStateRecord>;
  save(record: CollabPublicationStateRecord): Promise<void>;
}

export type ReconciliationUnsafeReason =
  'repository-lock';

export type ReconciliationSafety =
  | { readonly safe: true }
  | { readonly reason: ReconciliationUnsafeReason; readonly safe: false };

export interface ReconciliationSafetyPort {
  assertSafe(context: PublishProjectContext): Promise<void>;
  inspect(context: PublishProjectContext): Promise<ReconciliationSafety>;
}

export interface ReconciliationCoordinatorOptions {
  readonly createOperationId?: () => CollabOperationId;
}

function reconciliationError(
  code:
    | 'cancelled'
    | 'content-conflict'
    | 'operation-failed'
    | 'personal-ref-diverged'
    | 'repository-invalid'
    | 'working-tree-busy',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'content-conflict'
      ? ['review-conflicts']
      : code === 'personal-ref-diverged'
        ? ['reclone', 'open-diagnostics']
        : ['retry'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw reconciliationError('cancelled', 'reconciliation-cancelled');
  }
}

function requireHead(snapshot: PublishRepositorySnapshot): string {
  if (!snapshot.headOid) {
    throw reconciliationError('repository-invalid', 'reconciliation-head-missing');
  }
  return snapshot.headOid;
}

function assertPersonalRemoteReachable(snapshot: PublishRepositorySnapshot): void {
  if (
    !snapshot.personalRemoteOid
    || snapshot.personalBehindBy !== 0
    || snapshot.personalAheadBy < 0
    || (snapshot.personalAheadBy === 0 && snapshot.personalRemoteOid !== snapshot.headOid)
  ) {
    throw reconciliationError(
      'personal-ref-diverged',
      'reconciliation-personal-ref-diverged',
    );
  }
}

export class ReconciliationCoordinator {
  private readonly createOperationId: () => CollabOperationId;
  private readonly operationQueue = new SerialTaskQueue();

  constructor(
    private readonly projects: ReconciliationProjectPort,
    private readonly repository: ReconciliationRepositoryPort,
    private readonly control: ReconciliationControlPort,
    private readonly safety: ReconciliationSafetyPort,
    private readonly publicationState: ReconciliationPublicationStatePort,
    options: ReconciliationCoordinatorOptions = {},
  ) {
    this.createOperationId = options.createOperationId ?? randomUUID;
  }

  reconcile(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabReconciliationOutcome>> {
    return this.operationQueue.run(() => this.reconcileExclusive(projectId, options.signal));
  }

  private async reconcileExclusive(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<CollabResult<CollabReconciliationOutcome>> {
    try {
      throwIfCancelled(signal);
      const context = await this.projects.load(projectId);
      await this.projects.revalidate(context);
      let current = await this.repository.inspect(context, signal);

      throwIfCancelled(signal);
      await this.projects.revalidate(context);
      await this.repository.fetch(context, current, signal);
      current = await this.repository.inspect(context, signal);
      if (!current.workingTreeClean) {
        return this.deferred(projectId, requireHead(current));
      }
      assertPersonalRemoteReachable(current);
      const headOid = requireHead(current);
      const expectedPublicationState = await this.publicationState.load(projectId);
      const coordination = await this.control.readSnapshot(projectId, { signal });
      if (
        coordination.currentMember.id !== context.memberId
        || coordination.currentMember.personalRef !== context.personalRef
        || coordination.project.mainOid !== current.acceptedMainOid
      ) {
        throw new CollabError({
          code: 'authority-integrity-error',
          recoveryActions: ['open-diagnostics'],
          safeContext: { reason: 'reconciliation-snapshot-mismatch' },
        });
      }
      const ownRequest = coordination.openRequests.find(
        request => request.memberId === context.memberId,
      );
      const plan = current.includesAcceptedMain === true
        ? null
        : await this.repository.plan(
          context,
          current,
          this.createOperationId(),
          signal,
        );
      const acceptedRelation = plan === null
        ? headOid === current.acceptedMainOid ? 'current' : 'personal-ahead'
        : plan.kind === 'fast-forward'
          ? 'personal-behind'
          : plan.kind === 'current'
            ? headOid === current.acceptedMainOid ? 'current' : 'personal-ahead'
            : 'diverged';
      const classification = classifyLocalContribution({
        acceptedRelation,
        coordinationAuthoritative: true,
        hasConflictRecovery: false,
        hasOpenRequest: ownRequest !== undefined,
        hasPublicationRecovery: expectedPublicationState.operation !== null,
        personalAheadBy: current.personalAheadBy,
        personalBehindBy: current.personalBehindBy,
        workingTreeClean: current.workingTreeClean,
      });
      if (
        plan?.kind === 'conflicting'
        && ownRequest?.latestHeadOid === headOid
      ) {
        return {
          conflict: plan.conflict,
          error: reconciliationError('content-conflict', 'reconciliation-content-conflict'),
          status: 'conflict',
        };
      }
      if (classification.kind !== 'none') {
        return this.deferred(projectId, headOid);
      }
      const needsPersonalPush = current.personalAheadBy > 0;
      if (!classification.updateAvailable && !needsPersonalPush) {
        await this.updateBaseMain(expectedPublicationState, current.acceptedMainOid);
        return {
          status: 'success',
          value: { headOid, projectId, state: 'already-current' },
        };
      }
      if (classification.updateAvailable && plan?.kind !== 'fast-forward') {
        throw reconciliationError(
          'repository-invalid',
          'reconciliation-plan-classification-mismatch',
        );
      }
      if (!(await this.safety.inspect(context)).safe) {
        return this.deferred(projectId, headOid);
      }

      throwIfCancelled(signal);
      await this.projects.revalidate(context);
      await this.safety.assertSafe(context);
      await this.assertPublicationStateUnchanged(projectId, expectedPublicationState);
      if (classification.updateAvailable) {
        current = (await this.repository.fastForward(context, current, signal)).snapshot;
      }
      const integratedHead = requireHead(current);
      if (
        integratedHead !== current.acceptedMainOid
        || !current.workingTreeClean
      ) {
        throw reconciliationError(
          'repository-invalid',
          'reconciliation-fast-forward-not-exact-main',
        );
      }
      await this.updateBaseMain(expectedPublicationState, current.acceptedMainOid);

      throwIfCancelled(signal);
      await this.projects.revalidate(context);
      await this.repository.pushPersonal(context, current, signal);
      current = await this.repository.inspect(context, signal);
      if (
        current.headOid !== integratedHead
        || current.personalRemoteOid !== integratedHead
        || current.personalAheadBy !== 0
        || current.personalBehindBy !== 0
      ) {
        throw reconciliationError(
          'repository-invalid',
          'reconciliation-push-head-not-exact',
        );
      }

      return {
        status: 'success',
        value: {
          headOid: integratedHead,
          projectId,
          state: 'fast-forwarded',
        },
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  private deferred(
    projectId: CollabProjectId,
    headOid: string,
  ): CollabResult<CollabReconciliationOutcome> {
    return {
      status: 'success',
      value: { headOid, projectId, state: 'deferred' },
    };
  }

  private async assertPublicationStateUnchanged(
    projectId: CollabProjectId,
    expected: CollabPublicationStateRecord,
  ): Promise<void> {
    const current = await this.publicationState.load(projectId);
    if (
      current.projectId !== expected.projectId
      || current.schemaVersion !== expected.schemaVersion
      || current.baseMainOid !== expected.baseMainOid
      || current.updatedAt !== expected.updatedAt
      || current.operation !== null
    ) {
      throw reconciliationError(
        'repository-invalid',
        'reconciliation-publication-state-changed',
      );
    }
  }

  private async updateBaseMain(
    state: CollabPublicationStateRecord,
    acceptedMainOid: string,
  ): Promise<void> {
    if (state.baseMainOid === acceptedMainOid) return;
    await this.publicationState.save({
      ...state,
      baseMainOid: acceptedMainOid,
      updatedAt: new Date().toISOString(),
    });
  }

  private failure(error: unknown): CollabResult<CollabReconciliationOutcome> {
    const collabError = error instanceof CollabError
      ? error
      : reconciliationError('operation-failed', 'reconciliation-failed');
    if (collabError.code === 'cancelled') {
      return { durableProgress: false, status: 'cancelled' };
    }
    if (collabError.code === 'stale-project-selection') {
      return { error: collabError, staleKind: 'project-selection', status: 'stale' };
    }
    if (collabError.code === 'working-tree-busy') {
      return { error: collabError, staleKind: 'working-copy', status: 'stale' };
    }
    return { error: collabError, status: 'failure' };
  }

}
