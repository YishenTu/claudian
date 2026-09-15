import { randomBytes, randomUUID } from 'node:crypto';

import { collabMemberRef, type CollabProjectId, isCollabOpaqueId, type LeaveProjectResponse } from '@claudian-collab/protocol';

import type {
  CollabProjectWorkSessionSuspension,
} from '@/app/collab/activity/CollabProjectWorkSession';
import {
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import type { LocalExitProjectStorePort } from '@/app/collab/exit/LocalExitStores';
import type { LocalProjectCleanupPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import { managerResponsibilityReceiptState } from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';
import type {
  PendingLeaveAuthorityPreparation,
  PreparePendingLeaveInput,
  ResolvePendingLeaveHostInput,
  SettlePendingLeaveInput,
} from '@/app/collab/exit/PendingLeaveAuthorityService';
import type {
  CloudPendingLeavePhase,
  CloudPendingLeaveRecord,
  LanPendingLeaveRecord,
  PendingLeavePhase,
  PendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';
import {
  COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION,
  COLLAB_PENDING_LEAVE_SCHEMA_VERSION,
  decodePendingLeaveRecord,
  isCloudPendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';
import type { MembershipTerminationResponse } from '@/app/collab/lan/LanCollabControlOperations';
import type { PendingLeaveJournalPort } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import type {
  CollabMembershipManagerReceiptPort,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import type {
  ManagerResponsibilityOperationPort,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import {
  type CollabLeaveProjectRequest,
  type CollabLocalCleanupStatus,
  type CollabOperationOptions,
  type CollabRetirementResult,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface LocalExitAuthorityPort {
  prepareLeave(
    input: PreparePendingLeaveInput,
  ): Promise<PendingLeaveAuthorityPreparation>;
  refreshLeave(
    input: SettlePendingLeaveInput,
  ): Promise<PendingLeaveAuthorityPreparation>;
  recoverRejectedLeave(
    input: SettlePendingLeaveInput,
  ): Promise<{ readonly memberRole: 'manager' | 'member' }>;
  resolveLeaveHost(
    input: ResolvePendingLeaveHostInput,
  ): Promise<{
    readonly caCertificatePem: string;
    readonly caFingerprint: string;
    readonly endpoint: string;
    readonly projectId: CollabProjectId;
  }>;
  settleLeave(
    input: SettlePendingLeaveInput,
  ): Promise<MembershipTerminationResponse | LeaveProjectResponse>;
}

export interface LocalExitActivityPort {
  completeProject(suspension: CollabProjectWorkSessionSuspension): Promise<void>;
  resumeProject(suspension: CollabProjectWorkSessionSuspension): Promise<void>;
  suspendProject(projectId: CollabProjectId): Promise<CollabProjectWorkSessionSuspension>;
}

export interface LocalProjectExitCoordinatorOptions {
  readonly createIdempotencyKey?: () => string;
  readonly createOperationId?: () => string;
  readonly managerResponsibilityOperations: ManagerResponsibilityOperationPort;
  readonly managerReceipts: Pick<CollabMembershipManagerReceiptPort, 'load'>;
  readonly now?: () => Date;
  readonly retirement?: {
    handle(
      result: CollabRetirementResult,
      source: 'terminal-fallback',
    ): Promise<void>;
  };
}

export type LocalProjectExitResult =
  | { readonly status: 'complete' }
  | { readonly status: 'queued' }
  | { readonly status: 'cancelled' };

interface LeaveAuthorityPhaseResult {
  readonly authorityConfirmed: boolean;
  readonly outcome?: LocalProjectExitResult;
  readonly pending: PendingLeaveRecord;
  readonly retirement?: CollabRetirementResult;
}

const OFFLINE_CODES = new Set([
  'offline',
  'host-stopped',
  'endpoint-unreachable',
  'local-network-permission-required',
  'operation-timeout',
]);

export class LocalProjectExitCoordinator {
   readonly #createIdempotencyKey: () => string;
   readonly #createOperationId: () => string;
   readonly #managerResponsibilityOperations: ManagerResponsibilityOperationPort;
  private readonly managerReceipts: Pick<CollabMembershipManagerReceiptPort, 'load'>;
  private readonly now: () => Date;
  private readonly operations = new Map<CollabProjectId, Promise<unknown>>();
  private readonly retirement?: LocalProjectExitCoordinatorOptions['retirement'];

  constructor(
    private readonly projects: LocalExitProjectStorePort,
    private readonly pendingLeaves: Pick<PendingLeaveJournalPort, 'load' | 'remove' | 'save'>,
    private readonly authority: LocalExitAuthorityPort,
    private readonly cleanup: LocalProjectCleanupPort,
    private readonly activity: LocalExitActivityPort,
    options: LocalProjectExitCoordinatorOptions,
  ) {
    this.#createIdempotencyKey = options.createIdempotencyKey
      ?? (() => `leave-${randomUUID().replaceAll('-', '')}`);
    this.#createOperationId = options.createOperationId
      ?? (() => `leave-${randomUUID().replaceAll('-', '')}`);
    this.#managerResponsibilityOperations = options.managerResponsibilityOperations;
    this.managerReceipts = options.managerReceipts;
    this.now = options.now ?? (() => new Date());
    this.retirement = options.retirement;
  }

  async leave(
    request: CollabLeaveProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<LocalProjectExitResult> {
    return this.enqueue(request.projectId, () => this.#leaveUnlocked(request, options));
  }

  async resume(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<LocalProjectExitResult> {
    return this.enqueue(projectId, () => this.#resumeUnlocked(projectId, options));
  }

   async #leaveUnlocked(
    request: CollabLeaveProjectRequest,
    options: CollabOperationOptions,
  ): Promise<LocalProjectExitResult> {
    const existing = await this.pendingLeaves.load(request.projectId);
    if (existing) {
      if (existing.cleanupChoice !== request.cleanupChoice) {
        throw new TypeError('Pending Leave cleanup choice cannot be changed');
      }
      return this.#settleAndCleanup(
        existing,
        request.managerResponsibilityOfferId,
        false,
        options,
      );
    }
    const membership = await this.projects.loadMembership(request.projectId);
    if (!membership) throw new CollabError({ code: 'project-not-found' });
    if (isCollabLocalCloudMembership(membership)) {
      const operationId = this.#createOperationId();
      const timestamp = this.now().toISOString();
      const pending = decodePendingLeaveRecord({
        authorityGeneration: membership.authority.authorityGeneration,
        authorityKind: 'cloud',
        cleanupChoice: request.cleanupChoice,
        cleanupMarkerNonce: randomBytes(32).toString('base64url'),
        createdAt: timestamp,
        idempotencyKey: this.#createIdempotencyKey(),
        kind: 'pending-leave',
        localCleanupComplete: false,
        localRole: membership.member.role,
        memberId: membership.member.id,
        operationId,
        personalRef: membership.member.personalRef,
        phase: 'queued',
        projectCreatedAt: membership.createdAt,
        projectName: membership.project.name,
        projectId: request.projectId,
        request: null,
        schemaVersion: COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION,
        serverUrl: membership.authority.serverUrl,
        updatedAt: timestamp,
        workspacePath: membership.project.workspacePath,
      });
      await this.pendingLeaves.save(pending);
      return this.#settleAndCleanup(
        pending,
        request.managerResponsibilityOfferId,
        false,
        options,
      );
    }
    if (!isCollabLocalLanMembership(membership)) {
      throw new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'local-exit-authority-unsupported' },
      });
    }
    if (membership.hostOwnership.ownsAuthority) {
      throw new CollabError({
        code: 'host-transfer-pending',
        safeContext: { reason: 'local-exit-host-transfer-required' },
      });
    }
    if (
      !membership.authority.endpoint
      || !membership.authority.hostCaCertificatePem
      || !membership.authority.hostCaFingerprint
    ) {
      throw new CollabError({
        code: 'host-stopped',
        safeContext: { reason: 'local-exit-pinned-host-trust-required' },
      });
    }
    const operationId = this.#createOperationId();
    const timestamp = this.now().toISOString();
    const pending = decodePendingLeaveRecord({
      authorityReplay: null,
      cleanupChoice: request.cleanupChoice,
      cleanupMarkerNonce: randomBytes(32).toString('base64url'),
      createdAt: timestamp,
      hostCaCertificatePem: membership.authority.hostCaCertificatePem,
      hostCaFingerprint: membership.authority.hostCaFingerprint,
      hostEndpoint: membership.authority.endpoint,
      idempotencyKey: operationId,
      kind: 'pending-leave',
      localCleanupComplete: false,
      localRole: membership.member.role,
      memberCredential: membership.member.credential,
      memberId: membership.member.id,
      operationId,
      phase: 'queued',
      projectCreatedAt: membership.createdAt,
      projectName: membership.project.name,
      projectId: request.projectId,
      schemaVersion: COLLAB_PENDING_LEAVE_SCHEMA_VERSION,
      updatedAt: timestamp,
      workspacePath: membership.project.workspacePath,
    });
    await this.pendingLeaves.save(pending);
    return this.#settleAndCleanup(
      pending,
      request.managerResponsibilityOfferId,
      false,
      options,
    );
  }

   async #resumeUnlocked(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<LocalProjectExitResult> {
    const pending = await this.pendingLeaves.load(projectId);
    if (!pending) throw new CollabError({ code: 'project-not-found' });
    return this.#settleAndCleanup(pending, undefined, true, options);
  }

   async #settleAndCleanup(
    initial: PendingLeaveRecord,
    managerResponsibilityOfferId: string | undefined,
    recovering: boolean,
    options: CollabOperationOptions,
  ): Promise<LocalProjectExitResult> {
    const authorityPhase = await this.#managerResponsibilityOperations.run(
      initial.projectId,
      () => this.#settleAuthorityPhase(
        initial,
        managerResponsibilityOfferId,
        recovering,
        options,
      ),
    );
    if (authorityPhase.retirement && this.retirement) {
      await this.retirement.handle(authorityPhase.retirement, 'terminal-fallback');
      return { status: 'complete' };
    }
    if (authorityPhase.outcome) return authorityPhase.outcome;
    const suspension = authorityPhase.pending.localCleanupComplete
      ? null
      : await this.activity.suspendProject(authorityPhase.pending.projectId);
    try {
      const result = await this.#managerResponsibilityOperations.run(
        authorityPhase.pending.projectId,
        () => this.#cleanupAfterDrain(
          authorityPhase.pending,
          authorityPhase.authorityConfirmed,
          recovering,
          options,
        ),
      );
      if (suspension) await this.activity.completeProject(suspension);
      return result;
    } catch (error) {
      if (suspension && this.#isOfflineCleanupEligibilityError(error)) {
        await this.activity.resumeProject(suspension);
      }
      throw error;
    }
  }

  async #settleAuthorityPhase(
    initial: PendingLeaveRecord,
    managerResponsibilityOfferId: string | undefined,
    recovering: boolean,
    options: CollabOperationOptions,
  ): Promise<LeaveAuthorityPhaseResult> {
    if (isCloudPendingLeaveRecord(initial)) {
      return this.#settleCloudAuthorityPhase(
        initial,
        managerResponsibilityOfferId,
        recovering,
        options,
      );
    }
    let pending = initial;
    let authorityConfirmed = pending.phase === 'confirmed';
    if (!authorityConfirmed) {
      pending = await this.transition(pending, 'submitting');
      try {
        if (!pending.authorityReplay) {
          const prepared = await this.#withPersistedHostContinuity(
            pending,
            current => this.authority.prepareLeave({
              ...(managerResponsibilityOfferId === undefined ? {} : {
                managerResponsibilityOfferId,
              }),
              pending: current,
              ...(options.signal ? { signal: options.signal } : {}),
            }),
            options,
          );
          pending = prepared.pending;
          const preparation = prepared.value;
          if (!('authorityReplay' in preparation)) {
            throw new CollabError({
              code: 'authority-integrity-error',
              safeContext: { reason: 'lan-pending-leave-preparation-invalid' },
            });
          }
          pending = await this.update(pending, {
            authorityReplay: preparation.authorityReplay,
            localRole: preparation.memberRole,
          });
        }
        try {
          const settled = await this.#withPersistedHostContinuity(
            pending,
            current => this.#settleAuthority(current, options),
            options,
          );
          pending = settled.pending;
        } catch (error) {
          pending = this.#requireLanPending(
            await this.pendingLeaves.load(pending.projectId) ?? pending,
          );
          if (this.#isDeterministicObsoleteOffer(pending, error)) {
            throw error;
          }
          if (!(error instanceof CollabError) || error.code !== 'stale-project-selection') {
            throw error;
          }
          const refreshed = await this.#withPersistedHostContinuity(
            pending,
            current => this.authority.refreshLeave({
              pending: current,
              ...(options.signal ? { signal: options.signal } : {}),
            }),
            options,
          );
          pending = refreshed.pending;
          const preparation = refreshed.value;
          if (!('authorityReplay' in preparation)) {
            throw new CollabError({
              code: 'authority-integrity-error',
              safeContext: { reason: 'lan-pending-leave-refresh-invalid' },
            });
          }
          pending = await this.update(pending, {
            authorityReplay: preparation.authorityReplay,
            localRole: preparation.memberRole,
          });
          const settled = await this.#withPersistedHostContinuity(
            pending,
            current => this.#settleAuthority(current, options),
            options,
          );
          pending = settled.pending;
        }
        pending = await this.transition(pending, 'confirmed');
        authorityConfirmed = true;
      } catch (error) {
        pending = this.#requireLanPending(
          await this.pendingLeaves.load(pending.projectId) ?? pending,
        );
        if (this.#isDeterministicObsoleteOffer(pending, error)) {
          await this.#clearObsoleteManagerLeave(pending);
          throw error;
        }
        const retirement = this.#retirementResult(pending.projectId, error);
        if (retirement && this.retirement) {
          return { authorityConfirmed, pending, retirement };
        }
        if (this.#isCancelled(error, options.signal)) {
          pending = await this.transition(pending, 'queued');
          return { authorityConfirmed, outcome: { status: 'cancelled' }, pending };
        }
        if (
          error instanceof CollabError
          && error.code === 'durable-progress-recovery-required'
          && pending.authorityReplay !== null
        ) {
          await this.transition(pending, 'recovery-required');
          await this.projects.markLeaving(pending.projectId, 'failed');
          throw error;
        }
        if (
          !recovering
          && pending.localRole === 'manager'
          && pending.authorityReplay !== null
          && this.#isUncertainAuthorityOutcome(error)
        ) {
          await this.transition(pending, 'recovery-required');
          await this.projects.markLeaving(pending.projectId, 'failed');
          throw error;
        }
        const hasUnresolvedManagerReceipt = pending.localRole === 'member'
          && await this.#hasUnresolvedManagerReceipt(pending.projectId);
        if (
          !this.#isOffline(error)
          || pending.localRole !== 'member'
          || hasUnresolvedManagerReceipt
        ) {
          if (recovering) {
            await this.transition(pending, 'recovery-required');
            await this.projects.markLeaving(pending.projectId, 'failed');
            throw error;
          }
          await this.pendingLeaves.remove(pending.projectId);
          throw error;
        }
        pending = await this.transition(pending, 'queued');
      }
    }
    return { authorityConfirmed, pending };
  }

  async #settleCloudAuthorityPhase(
    initial: CloudPendingLeaveRecord,
    managerResponsibilityOfferId: string | undefined,
    recovering: boolean,
    options: CollabOperationOptions,
  ): Promise<LeaveAuthorityPhaseResult> {
    let pending = initial;
    let authorityConfirmed = pending.phase === 'confirmed';
    if (authorityConfirmed) return { authorityConfirmed, pending };

    try {
      if (pending.request === null) {
        const preparation = await this.authority.prepareLeave({
          ...(managerResponsibilityOfferId === undefined ? {} : {
            managerResponsibilityOfferId,
          }),
          pending,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!('request' in preparation)) {
          throw new CollabError({
            code: 'authority-integrity-error',
            safeContext: { reason: 'cloud-pending-leave-preparation-invalid' },
          });
        }
        if (
          recovering
          && pending.localRole === 'member'
          && preparation.memberRole === 'manager'
        ) {
          pending = await this.#updateCloud(pending, {
            localRole: 'manager',
          });
          throw new CollabError({
            code: 'manager-responsibility-pending',
            recoveryActions: ['retry'],
            safeContext: { reason: 'cloud-pending-leave-manager-review-required' },
          });
        }
        pending = await this.#submitCloud(
          pending,
          preparation.memberRole,
          preparation.request,
        );
      }
      await this.authority.settleLeave({
        pending,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      pending = await this.#transitionCloud(pending, 'confirmed');
      authorityConfirmed = true;
    } catch (error) {
      pending = this.#requireCloudPending(
        await this.pendingLeaves.load(pending.projectId) ?? pending,
      );
      const retirement = this.#retirementResult(pending.projectId, error, true);
      if (retirement && this.retirement) {
        return { authorityConfirmed, pending, retirement };
      }
      if (error instanceof CloudAuthorityRejection && pending.request !== null) {
        const recovery = await this.authority.recoverRejectedLeave({
          pending,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        pending = await this.#resetRejectedCloud(pending, recovery.memberRole);
        if (recovery.memberRole === 'manager') {
          throw new CollabError({
            code: 'manager-responsibility-pending',
            recoveryActions: ['retry'],
            safeContext: { reason: 'cloud-pending-leave-manager-review-required' },
          });
        }
        return { authorityConfirmed, pending };
      }
      if (this.#isCancelled(error, options.signal)) {
        return {
          authorityConfirmed,
          outcome: { status: 'cancelled' },
          pending,
        };
      }
      if (pending.request !== null) {
        if (pending.localRole === 'manager' || !this.#isOffline(error)) {
          pending = await this.#transitionCloud(pending, 'recovery-required');
          await this.#markLeavingIfPresent(pending.projectId, 'failed');
          throw error;
        }
        return { authorityConfirmed, pending };
      }
      const hasUnresolvedManagerReceipt = pending.localRole === 'member'
        && await this.#hasUnresolvedManagerReceipt(pending.projectId);
      if (
        !this.#isOffline(error)
        || pending.localRole !== 'member'
        || hasUnresolvedManagerReceipt
      ) {
        throw error;
      }
    }
    return { authorityConfirmed, pending };
  }

   async #cleanupAfterDrain(
    initial: PendingLeaveRecord,
    authorityConfirmed: boolean,
    recovering: boolean,
    options: CollabOperationOptions,
  ): Promise<LocalProjectExitResult> {
    let pending = initial;
    if (!pending.localCleanupComplete) {
      if (!authorityConfirmed) {
        await this.#assertOfflineCleanupPermitted(pending, recovering);
      }
      await this.projects.markLeaving(pending.projectId, 'running');
      try {
        const result = await this.cleanup.cleanup({
          choice: pending.cleanupChoice,
          memberId: pending.memberId,
          operationId: pending.operationId,
          personalRef: collabMemberRef(pending.memberId),
          projectId: pending.projectId,
          purpose: 'leave',
          markerNonce: pending.cleanupMarkerNonce,
          workspacePath: pending.workspacePath,
        }, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (result.status === 'cancelled') {
          await this.projects.markLeaving(pending.projectId, 'pending');
          return { status: 'cancelled' };
        }
        pending = await this.#markCleanupComplete(pending);
      } catch (error) {
        await this.projects.markLeaving(pending.projectId, 'failed');
        throw error;
      }
    }
    await this.projects.removeProject(pending.projectId);
    await this.projects.purgePrivateState(pending.projectId);
    if (authorityConfirmed) {
      await this.pendingLeaves.remove(pending.projectId);
      return { status: 'complete' };
    }
    return { status: 'queued' };
  }

   async #assertOfflineCleanupPermitted(
    pending: PendingLeaveRecord,
    recovering: boolean,
  ): Promise<void> {
    const membership = await this.projects.loadMembership(pending.projectId);
    const hasUnresolvedManagerReceipt = await this.#hasUnresolvedManagerReceipt(
      pending.projectId,
    );
    if (
      membership
      && membership.member.id === pending.memberId
      && membership.member.role === 'member'
      && !hasUnresolvedManagerReceipt
    ) {
      return;
    }
    const error = new CollabError({
      code: 'manager-responsibility-pending',
      safeContext: { reason: 'offline-leave-role-not-confirmed-member' },
    });
    if (isCloudPendingLeaveRecord(pending)) {
      await this.#markLeavingIfPresent(pending.projectId, 'failed');
    } else if (recovering) {
      await this.transition(pending, 'recovery-required');
      await this.projects.markLeaving(pending.projectId, 'failed');
    } else {
      await this.pendingLeaves.remove(pending.projectId);
    }
    throw error;
  }

  private async transition(
    record: LanPendingLeaveRecord,
    phase: PendingLeavePhase,
  ): Promise<LanPendingLeaveRecord> {
    const updated = decodePendingLeaveRecord({
      ...record,
      phase,
      updatedAt: this.now().toISOString(),
    });
    if (isCloudPendingLeaveRecord(updated)) throw new TypeError('Expected LAN pending Leave');
    await this.pendingLeaves.save(updated);
    return updated;
  }

  async #transitionCloud(
    record: CloudPendingLeaveRecord,
    phase: Exclude<CloudPendingLeavePhase, 'queued'>,
  ): Promise<CloudPendingLeaveRecord> {
    if (record.request === null) {
      throw new TypeError('Cloud pending Leave request is not frozen');
    }
    const updated = decodePendingLeaveRecord({
      ...record,
      phase,
      updatedAt: this.now().toISOString(),
    });
    if (!isCloudPendingLeaveRecord(updated)) throw new TypeError('Expected Cloud pending Leave');
    await this.pendingLeaves.save(updated);
    return updated;
  }

  async #submitCloud(
    record: CloudPendingLeaveRecord,
    localRole: 'manager' | 'member',
    request: Exclude<CloudPendingLeaveRecord['request'], null>,
  ): Promise<CloudPendingLeaveRecord> {
    if (record.request !== null) throw new TypeError('Cloud pending Leave is already submitted');
    const updated = decodePendingLeaveRecord({
      ...record,
      localRole,
      phase: 'submitted',
      request,
      updatedAt: this.now().toISOString(),
    });
    if (!isCloudPendingLeaveRecord(updated)) throw new TypeError('Expected Cloud pending Leave');
    await this.pendingLeaves.save(updated);
    return updated;
  }

  async #updateCloud(
    record: CloudPendingLeaveRecord,
    patch: Pick<CloudPendingLeaveRecord, 'localRole'>,
  ): Promise<CloudPendingLeaveRecord> {
    const updated = decodePendingLeaveRecord({
      ...record,
      ...patch,
      updatedAt: this.now().toISOString(),
    });
    if (!isCloudPendingLeaveRecord(updated)) throw new TypeError('Expected Cloud pending Leave');
    await this.pendingLeaves.save(updated);
    return updated;
  }

  async #resetRejectedCloud(
    record: CloudPendingLeaveRecord,
    localRole: 'manager' | 'member',
  ): Promise<CloudPendingLeaveRecord> {
    const idempotencyKey = this.#createIdempotencyKey();
    if (idempotencyKey === record.idempotencyKey) {
      throw new TypeError('Cloud Leave recovery requires a fresh idempotency key');
    }
    const updated = decodePendingLeaveRecord({
      ...record,
      idempotencyKey,
      localRole,
      phase: 'queued',
      request: null,
      updatedAt: this.now().toISOString(),
    });
    if (!isCloudPendingLeaveRecord(updated)) throw new TypeError('Expected Cloud pending Leave');
    await this.pendingLeaves.save(updated);
    return updated;
  }

   #settleAuthority(
    pending: PendingLeaveRecord,
    options: CollabOperationOptions,
  ): Promise<MembershipTerminationResponse> {
    return this.authority.settleLeave({
      pending,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async #withPersistedHostContinuity<T>(
    pending: LanPendingLeaveRecord,
    operation: (current: LanPendingLeaveRecord) => Promise<T>,
    options: CollabOperationOptions,
  ): Promise<{ readonly pending: LanPendingLeaveRecord; readonly value: T }> {
    try {
      return { pending, value: await operation(pending) };
    } catch (failure) {
      const trust = await this.authority.resolveLeaveHost({
        failure,
        pending,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (trust.projectId !== pending.projectId) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'pending-leave-host-project-mismatch' },
        });
      }
      const updated = await this.update(pending, {
        hostCaCertificatePem: trust.caCertificatePem,
        hostCaFingerprint: trust.caFingerprint,
        hostEndpoint: trust.endpoint,
      });
      return { pending: updated, value: await operation(updated) };
    }
  }

  private async update(
    record: LanPendingLeaveRecord,
    patch: Partial<Pick<
      LanPendingLeaveRecord,
      | 'authorityReplay'
      | 'hostCaCertificatePem'
      | 'hostCaFingerprint'
      | 'hostEndpoint'
      | 'localCleanupComplete'
      | 'localRole'
    >>,
  ): Promise<LanPendingLeaveRecord> {
    const updated = decodePendingLeaveRecord({
      ...record,
      ...patch,
      updatedAt: this.now().toISOString(),
    });
    if (isCloudPendingLeaveRecord(updated)) throw new TypeError('Expected LAN pending Leave');
    await this.pendingLeaves.save(updated);
    return updated;
  }

  #requireCloudPending(record: PendingLeaveRecord): CloudPendingLeaveRecord {
    if (!isCloudPendingLeaveRecord(record)) throw new TypeError('Expected Cloud pending Leave');
    return record;
  }

  #requireLanPending(record: PendingLeaveRecord): LanPendingLeaveRecord {
    if (isCloudPendingLeaveRecord(record)) throw new TypeError('Expected LAN pending Leave');
    return record;
  }

  async #markCleanupComplete(record: PendingLeaveRecord): Promise<PendingLeaveRecord> {
    if (isCloudPendingLeaveRecord(record)) {
      return this.#updateCloudCleanup(record);
    }
    return this.update(record, { localCleanupComplete: true });
  }

  async #updateCloudCleanup(
    record: CloudPendingLeaveRecord,
  ): Promise<CloudPendingLeaveRecord> {
    const updated = decodePendingLeaveRecord({
      ...record,
      localCleanupComplete: true,
      updatedAt: this.now().toISOString(),
    });
    if (!isCloudPendingLeaveRecord(updated)) throw new TypeError('Expected Cloud pending Leave');
    await this.pendingLeaves.save(updated);
    return updated;
  }

  async #markLeavingIfPresent(
    projectId: CollabProjectId,
    cleanupStatus: CollabLocalCleanupStatus,
  ): Promise<void> {
    if (!await this.projects.loadMembership(projectId)) return;
    await this.projects.markLeaving(projectId, cleanupStatus);
  }

  async #hasUnresolvedManagerReceipt(projectId: CollabProjectId): Promise<boolean> {
    const receipt = await this.managerReceipts.load(projectId);
    if (!receipt) return false;
    const state = managerResponsibilityReceiptState(receipt);
    return state.status === 'offered' || state.status === 'acknowledged';
  }

  #isOfflineCleanupEligibilityError(error: unknown): boolean {
    return error instanceof CollabError
      && error.code === 'manager-responsibility-pending'
      && error.safeContext.reason === 'offline-leave-role-not-confirmed-member';
  }

  #retirementResult(
    projectId: CollabProjectId,
    error: unknown,
    requireRetirementId = false,
  ): CollabRetirementResult | null {
    if (!(error instanceof CollabError) || error.code !== 'project-retired') return null;
    const contextProjectId = error.safeContext.projectId;
    const retirementId = error.safeContext.operationId;
    const retiredAt = error.safeContext.retiredAt;
    if (
      contextProjectId !== projectId
      || typeof retiredAt !== 'string'
      || Number.isNaN(Date.parse(retiredAt))
      || new Date(retiredAt).toISOString() !== retiredAt
      || (requireRetirementId && !isCollabOpaqueId(retirementId))
      || (retirementId !== undefined && !isCollabOpaqueId(retirementId))
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'pending-leave-retirement-result-invalid' },
      });
    }
    return {
      projectId,
      retiredAt,
      ...(typeof retirementId === 'string' ? { retirementId } : {}),
    };
  }

   #isOffline(error: unknown): boolean {
    return error instanceof CollabError && OFFLINE_CODES.has(error.code);
  }

   #isUncertainAuthorityOutcome(error: unknown): boolean {
    // Once exact replay inputs are durable and mutation has started, every
    // transport failure is ambiguous: authority may have committed first.
    return this.#isOffline(error);
  }

  #isDeterministicObsoleteOffer(
    pending: LanPendingLeaveRecord,
    error: unknown,
  ): boolean {
    const replay = pending.authorityReplay;
    if (!replay || !(error instanceof CollabError)) return false;
    if (error.code === 'manager-responsibility-pending') return true;
    if (
      error.code !== 'stale-project-selection'
      || replay.managerResponsibilityOfferId === null
    ) return false;
    const reason = error.safeContext.reason;
    return typeof reason === 'string' && (
      reason.startsWith('manager-responsibility-')
      || reason.startsWith('membership-manager-offer-')
    );
  }

   async #clearObsoleteManagerLeave(pending: LanPendingLeaveRecord): Promise<void> {
    await this.projects.restoreActive(pending.projectId);
    await this.pendingLeaves.remove(pending.projectId);
  }

   #isCancelled(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true
      || (error instanceof CollabError && error.code === 'cancelled');
  }

  private enqueue<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
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
