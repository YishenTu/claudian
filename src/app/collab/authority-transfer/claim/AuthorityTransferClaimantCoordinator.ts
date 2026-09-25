import { createHash, randomBytes } from 'node:crypto';

import type { RedeemProjectRecoveryLinkResponse } from '@claudian-collab/protocol';
import type {
  ClaimTransferredMembershipRequest,
  CollabAuthorityTransferStatus,
  CollabMemberId,
  CollabProjectId,
  CollabTransferredMembershipClaim,
  CollabTransferredMembershipRedemptionReceipt,
  ReissueTransferredMembershipClaimResponse,
} from '@claudian-collab/protocol';

import {
  advanceAuthorityTransferClaimantRecord,
  type AuthorityTransferClaimantLANTarget,
  type AuthorityTransferClaimantRecord,
  type AuthorityTransferClaimantStore,
  type CloudToLANManagerClaimantPredecessor,
  createAuthorityTransferClaimantRecord,
  createManagerReissuedAuthorityTransferClaimantRecord,
  decodeAuthorityTransferClaimantRecord,
  type ManagerReissuedAuthorityTransferClaimantRecord,
  type SourceIssuedAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type { ProjectRecoveryClaimantRecord, ProjectRecoveryConvergenceIntent } from '@/app/collab/authority-transfer/claim/ProjectRecoveryClaimantRecord';
import type { ProjectRecoveryInvitation } from '@/app/collab/project/ProjectRecoveryInvitation';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferClaimantSource {
  getClaim(
    record: SourceIssuedAuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<CollabTransferredMembershipClaim>;
  acknowledgeRedemption(
    record: SourceIssuedAuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
}

export interface AuthorityTransferClaimantTarget {
  readonly cloudPrincipalId: string | null;
  redeemProjectRecoveryLink?(record: ProjectRecoveryClaimantRecord, options: CollabOperationOptions): Promise<RedeemProjectRecoveryLinkResponse>;
  confirmProjectRecoveryBinding?(record: ProjectRecoveryClaimantRecord, options: CollabOperationOptions): Promise<ProjectRecoveryConvergenceIntent>;
  claimTransferredMembership(
    record: AuthorityTransferClaimantRecord,
    request: ClaimTransferredMembershipRequest,
    options: CollabOperationOptions,
  ): Promise<CollabTransferredMembershipRedemptionReceipt>;
  confirmSourceTargetBinding?(
    record: SourceIssuedAuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
  confirmTargetBinding?(
    record: ManagerReissuedAuthorityTransferClaimantRecord,
    proof: 'receipt' | 'existing-binding',
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus | null>;
}

export interface AuthorityTransferClaimantConvergence {
  converge(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
}

export interface AuthorityTransferClaimantCoordinatorOptions {
  readonly complete?: (
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ) => Promise<void>;
  readonly convergence: AuthorityTransferClaimantConvergence;
  readonly createCredential?: () => string;
  readonly lanTarget?: AuthorityTransferClaimantLANTarget | null;
  readonly now?: () => Date;
  readonly source?: AuthorityTransferClaimantSource;
  readonly store: AuthorityTransferClaimantStore;
  readonly target: AuthorityTransferClaimantTarget;
}

export interface StartAuthorityTransferClaimantInput {
  readonly managerPredecessor?: CloudToLANManagerClaimantPredecessor | null;
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string;
  readonly status: CollabAuthorityTransferStatus;
}

export interface StartManagerReissuedAuthorityTransferClaimantInput {
  readonly descriptor: ReissueTransferredMembershipClaimResponse;
  readonly memberPersonalRef: string;
  readonly operationIntentId?: string;
  readonly serverUrl: string;
}

function claimantError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function assertNotCancelled(options: CollabOperationOptions): void {
  if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function sameSourceIssuedAttempt(
  record: AuthorityTransferClaimantRecord,
  input: StartAuthorityTransferClaimantInput,
  lanTarget: AuthorityTransferClaimantLANTarget | null,
): boolean {
  return record.variant === 'source-issued'
    && record.projectId === input.status.projectId
    && record.transferId === input.status.transferId
    && record.memberId === input.memberId
    && record.operationIntentId === input.operationIntentId
    && JSON.stringify(record.managerPredecessor)
      === JSON.stringify(input.managerPredecessor ?? null)
    && record.status.direction === input.status.direction
    && record.status.targetAuthority.kind === input.status.targetAuthority.kind
    && record.status.targetAuthority.generation === input.status.targetAuthority.generation
    && record.status.checkpointSha256 === input.status.checkpointSha256
    && (
      record.lanTarget === null
        ? lanTarget === null
        : lanTarget !== null
          && record.lanTarget.caCertificatePem === lanTarget.caCertificatePem
          && record.lanTarget.caFingerprint.replaceAll(':', '').toLocaleLowerCase('en-US')
            === lanTarget.caFingerprint.replaceAll(':', '').toLocaleLowerCase('en-US')
          && record.lanTarget.endpoint === lanTarget.endpoint
    );
}

function sameManagerReissuedAttempt(
  record: AuthorityTransferClaimantRecord,
  input: StartManagerReissuedAuthorityTransferClaimantInput,
): boolean {
  const descriptor = record.variant === 'manager-reissued'
    ? record.descriptor
    : null;
  return record.variant === 'manager-reissued'
    && record.memberPersonalRef === input.memberPersonalRef
    && record.serverUrl === input.serverUrl
    && descriptor?.claim === input.descriptor.claim
    && descriptor.claimGeneration === input.descriptor.claimGeneration
    && descriptor.createdAt === input.descriptor.createdAt
    && descriptor.expiresAt === input.descriptor.expiresAt
    && descriptor.memberId === input.descriptor.memberId
    && descriptor.projectId === input.descriptor.projectId
    && descriptor.secretReplayExpiresAt === input.descriptor.secretReplayExpiresAt
    && descriptor.targetAuthorityGeneration === input.descriptor.targetAuthorityGeneration
    && descriptor.transferId === input.descriptor.transferId;
}

/** Owns bounded claimant variants without treating a reissue as source custody. */
export class AuthorityTransferClaimantCoordinator {
  private readonly createCredential: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityTransferClaimantCoordinatorOptions) {
    this.createCredential = options.createCredential
      ?? (() => randomBytes(32).toString('base64url'));
    this.now = options.now ?? (() => new Date());
  }

  async start(
    input: StartAuthorityTransferClaimantInput,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    assertNotCancelled(options);
    const existing = await this.options.store.load(input.status.projectId);
    const lanTarget = this.options.lanTarget ?? null;
    if (existing) {
      if (!sameSourceIssuedAttempt(existing, input, lanTarget)) {
        throw claimantError('authority-transfer-claimant-attempt-conflict');
      }
    } else {
      await this.options.store.save(createAuthorityTransferClaimantRecord({
        cloudPrincipalId: this.options.target.cloudPrincipalId,
        createdAt: this.now().toISOString(),
        lanTarget,
        managerPredecessor: input.managerPredecessor ?? null,
        memberId: input.memberId,
        operationIntentId: input.operationIntentId,
        status: input.status,
      }));
    }
    await this.resume(input.status.projectId, options);
  }

  async startManagerReissued(
    input: StartManagerReissuedAuthorityTransferClaimantInput,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    assertNotCancelled(options);
    const existing = await this.options.store.load(input.descriptor.projectId);
    if (!existing || !sameManagerReissuedAttempt(existing, input)) {
      if (existing && (existing.projectId !== input.descriptor.projectId || existing.memberId !== input.descriptor.memberId
        || input.descriptor.targetAuthorityGeneration < (existing.variant === 'source-issued'
          ? existing.status.targetAuthority.generation : existing.variant === 'project-recovery' ? existing.invitation.link.authorityGeneration : existing.descriptor.targetAuthorityGeneration)
        || existing.variant === 'source-issued' && (existing.managerPredecessor !== null
          || input.descriptor.targetAuthorityGeneration === existing.status.targetAuthority.generation
            && ['source-acknowledged', 'membership-converged', 'completed'].includes(existing.phase))
        || existing.variant === 'manager-reissued'
          && input.descriptor.targetAuthorityGeneration === existing.descriptor.targetAuthorityGeneration
          && ['target-confirmed', 'membership-converged', 'completed'].includes(existing.phase))) {
        throw claimantError('authority-transfer-claimant-attempt-conflict');
      }
      const retainedAttempts = existing ? [
        ...(existing.variant !== 'source-issued' ? existing.retainedAttempts : []),
        existing.variant !== 'source-issued' ? { ...existing, retainedAttempts: [] } : existing,
      ] : [];
      // Explicit replacement preserves ambiguous requests; successful local convergence releases them.
      const retained = retainedAttempts.find(attempt => sameManagerReissuedAttempt(attempt, input));
      const cloudPrincipalId = this.options.target.cloudPrincipalId;
      if (cloudPrincipalId === null && !this.options.lanTarget) throw claimantError('authority-transfer-claimant-cloud-principal-missing');
      const candidate = retained ?? createManagerReissuedAuthorityTransferClaimantRecord({
        cloudPrincipalId,
        lanTarget: this.options.lanTarget ?? null,
        targetCredential: this.options.lanTarget ? this.createCredential() : null,
        ...input,
        operationIntentId: input.operationIntentId
          ?? `manager-reissued-${randomBytes(16).toString('hex')}`,
      });
      await this.options.store.save(decodeAuthorityTransferClaimantRecord({
        ...candidate, retainedAttempts: retainedAttempts.filter(attempt => attempt !== retained),
      }));
    }
    await this.resume(input.descriptor.projectId, options);
  }

  async startProjectRecovery(input: {
    invitation: ProjectRecoveryInvitation; memberId: string; memberPersonalRef: string;
    proofCredential: string; targetCredential?: string; operationIntentId?: string;
  }, options: CollabOperationOptions = {}): Promise<void> {
    assertNotCancelled(options);
    const projectId = input.invitation.link.projectId;
    const existing = await this.options.store.load(projectId);
    const same = (record: AuthorityTransferClaimantRecord): boolean =>
      record.variant === 'project-recovery' && JSON.stringify(record.invitation) === JSON.stringify(input.invitation)
      && record.memberId === input.memberId && record.memberPersonalRef === input.memberPersonalRef;
    if (!existing || !same(existing)) {
      const generation = existing?.variant === 'source-issued' ? existing.status.targetAuthority.generation
        : existing?.variant === 'manager-reissued' ? existing.descriptor.targetAuthorityGeneration : existing?.invitation.link.authorityGeneration;
      if (existing && (existing.memberId !== input.memberId || generation! > input.invitation.link.authorityGeneration
        || existing.variant === 'source-issued' && existing.managerPredecessor !== null)) throw claimantError('project-recovery-predecessor-conflict');
      const retainedAttempts = existing ? [
        ...(existing.variant === 'source-issued' ? [] : existing.retainedAttempts),
        existing.variant === 'source-issued' ? existing : { ...existing, retainedAttempts: [] },
      ] : [];
      const retained = retainedAttempts.find(same);
      const operationIntentId = input.operationIntentId ?? `recovery-${randomBytes(16).toString('hex')}`;
      const targetCredential = input.invitation.target.kind === 'lan' ? input.targetCredential ?? this.createCredential() : null;
      const timestamp = this.now().toISOString();
      const candidate = retained ?? {
        schemaVersion: 5, kind: 'authority-transfer-claimant', variant: 'project-recovery',
        projectId, memberId: input.memberId, memberPersonalRef: input.memberPersonalRef,
        operationIntentId, cloudPrincipalId: this.options.target.cloudPrincipalId, targetCredential,
        createdAt: timestamp, updatedAt: timestamp, phase: 'redemption-prepared', invitation: input.invitation,
        redemptionRequest: { projectId, idempotencyKey: operationIntentId, expectedAuthorityGeneration: input.invitation.link.authorityGeneration,
          recoveryLinkId: input.invitation.link.recoveryLinkId, token: input.invitation.link.token, proofCredential: input.proofCredential,
          ...(targetCredential === null ? {} : { targetCredentialHash: createHash('sha256').update(targetCredential, 'utf8').digest('hex') }) },
        redemptionReceipt: null, convergence: null,
      };
      await this.options.store.save(decodeAuthorityTransferClaimantRecord({ ...candidate,
        retainedAttempts: retainedAttempts.filter(attempt => attempt !== retained) }));
    }
    await this.resume(projectId, options);
  }

  async #resumeProjectRecovery(initial: ProjectRecoveryClaimantRecord, options: CollabOperationOptions): Promise<void> {
    let record = initial;
    while (record.phase !== 'completed') {
      assertNotCancelled(options);
      let update: Partial<ProjectRecoveryClaimantRecord>;
      switch (record.phase) {
        case 'redemption-prepared': {
          this.#assertTargetPrincipal(record);
          if (!this.options.target.redeemProjectRecoveryLink) throw claimantError('project-recovery-target-unavailable');
          const redemptionReceipt = await this.options.target.redeemProjectRecoveryLink(record, options);
          update = { phase: 'target-claimed', redemptionReceipt };
          break;
        }
        case 'target-claimed': {
          this.#assertTargetPrincipal(record);
          if (!this.options.target.confirmProjectRecoveryBinding) throw claimantError('project-recovery-target-unavailable');
          update = { phase: 'target-confirmed', convergence: await this.options.target.confirmProjectRecoveryBinding(record, options) };
          break;
        }
        case 'target-confirmed':
          await this.options.convergence.converge(record, options);
          update = { phase: 'membership-converged', retainedAttempts: [] };
          break;
        case 'membership-converged': update = { phase: 'completed' }; break;
      }
      const candidate = decodeAuthorityTransferClaimantRecord({ ...record, ...update, updatedAt: this.#monotonicTimestamp(record.updatedAt) });
      if (candidate.variant !== 'project-recovery') throw claimantError('project-recovery-variant-invalid');
      await this.options.store.save(candidate);
      record = candidate;
    }
    await this.complete(record, options);
  }

  async resume(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const record = await this.options.store.load(projectId);
    if (!record) throw claimantError('authority-transfer-claimant-record-missing');
    if (record.variant === 'project-recovery') {
      await this.#resumeProjectRecovery(record, options);
      return;
    }
    if (record.variant === 'manager-reissued') {
      await this.#resumeManagerReissued(record, options);
      return;
    }
    await this.#resumeSourceIssued(record, options);
  }

  async #resumeSourceIssued(
    initial: SourceIssuedAuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    const source = this.options.source;
    if (!source) throw claimantError('authority-transfer-claimant-source-unavailable');
    let record = initial;
    while (record.phase !== 'completed') {
      assertNotCancelled(options);
      if (this.now().getTime() >= Date.parse(record.status.expiresAt)) {
        switch (record.phase) {
          case 'prepared':
          case 'claim-retained':
            await this.complete(record, options);
            return;
          case 'credential-persisted':
            this.#assertTargetPrincipal(record);
            if (!this.options.target.confirmSourceTargetBinding) {
              throw claimantError('authority-transfer-claimant-target-confirmation-unavailable');
            }
            await this.options.target.confirmSourceTargetBinding(record, options);
            // Expiry ends source acknowledgement, but cannot disprove redemption.
            // Persist authenticated target evidence before changing local membership.
            record = await this.#advanceSource(record, 'source-acknowledged', {
              convergenceProof: 'existing-binding',
            });
            continue;
          case 'target-claimed':
            record = await this.#advanceSource(record, 'source-acknowledged');
            continue;
          case 'source-acknowledged':
          case 'membership-converged':
            break;
        }
      }
      switch (record.phase) {
        case 'prepared': {
          const claim = await source.getClaim(record, options);
          record = await this.#advanceSource(record, 'claim-retained', { claim });
          break;
        }
        case 'claim-retained': {
          const targetCredential = record.status.targetAuthority.kind === 'lan'
            ? this.createCredential()
            : null;
          record = await this.#advanceSource(record, 'credential-persisted', {
            targetCredential,
          });
          break;
        }
        case 'credential-persisted': {
          this.#assertTargetPrincipal(record);
          if (!record.claim) throw claimantError('authority-transfer-claimant-claim-missing');
          const request: ClaimTransferredMembershipRequest = record.targetCredential === null
            ? {
                claim: record.claim.claim,
                idempotencyKey: record.operationIntentId,
                projectId: record.projectId,
                transferId: record.transferId,
              }
            : {
                claim: record.claim.claim,
                credentialHash: createHash('sha256')
                  .update(record.targetCredential, 'utf8')
                  .digest('hex'),
                idempotencyKey: record.operationIntentId,
                projectId: record.projectId,
                transferId: record.transferId,
              };
          const redemptionReceipt = await this.options.target.claimTransferredMembership(
            record,
            request,
            options,
          );
          record = await this.#advanceSource(record, 'target-claimed', { redemptionReceipt });
          break;
        }
        case 'target-claimed':
          await source.acknowledgeRedemption(record, options);
          record = await this.#advanceSource(record, 'source-acknowledged');
          break;
        case 'source-acknowledged':
          await this.options.convergence.converge(record, options);
          record = await this.#advanceSource(record, 'membership-converged');
          break;
        case 'membership-converged':
          record = await this.#advanceSource(record, 'completed');
          break;
      }
    }
    await this.complete(record, options);
  }

  async #resumeManagerReissued(
    initial: ManagerReissuedAuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    let record = initial;
    while (record.phase !== 'completed') {
      assertNotCancelled(options);
      switch (record.phase) {
        case 'redemption-prepared': {
          this.#assertTargetPrincipal(record);
          if (this.now().getTime() >= Date.parse(record.descriptor.expiresAt)) {
            const targetStatus = await this.#confirmManagerTargetBinding(
              record,
              'existing-binding',
              options,
            );
            record = await this.#advanceManager(record, 'target-confirmed', {
              convergenceProof: 'existing-binding',
              targetStatus,
            });
            break;
          }
          const redemptionReceipt = await this.options.target.claimTransferredMembership(
            record,
            record.redemptionRequest,
            options,
          );
          record = await this.#advanceManager(record, 'target-claimed', {
            redemptionReceipt,
          });
          break;
        }
        case 'target-claimed': {
          this.#assertTargetPrincipal(record);
          const targetStatus = await this.#confirmManagerTargetBinding(
            record,
            'receipt',
            options,
          );
          record = await this.#advanceManager(record, 'target-confirmed', {
            convergenceProof: 'receipt',
            targetStatus,
          });
          break;
        }
        case 'target-confirmed':
          await this.options.convergence.converge(record, options);
          record = await this.#advanceManager(record, 'membership-converged');
          break;
        case 'membership-converged':
          record = await this.#advanceManager(record, 'completed');
          break;
      }
    }
    await this.complete(record, options);
  }

  private async complete(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (this.options.complete) {
      await this.options.complete(record, options);
      return;
    }
    await this.options.store.remove(record.projectId);
  }

  #assertTargetPrincipal(record: AuthorityTransferClaimantRecord): void {
    if (record.cloudPrincipalId !== this.options.target.cloudPrincipalId) {
      throw claimantError('authority-transfer-claimant-cloud-principal-mismatch');
    }
  }

  #confirmManagerTargetBinding(
    record: ManagerReissuedAuthorityTransferClaimantRecord,
    proof: 'receipt' | 'existing-binding',
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus | null> {
    const confirm = this.options.target.confirmTargetBinding?.bind(this.options.target);
    if (!confirm) {
      throw claimantError('authority-transfer-claimant-target-confirmation-unavailable');
    }
    return confirm(record, proof, options);
  }

  async #advanceSource(
    previous: SourceIssuedAuthorityTransferClaimantRecord,
    phase: SourceIssuedAuthorityTransferClaimantRecord['phase'],
    update: Readonly<{
      claim?: CollabTransferredMembershipClaim;
      convergenceProof?: 'existing-binding';
      redemptionReceipt?: CollabTransferredMembershipRedemptionReceipt;
      targetCredential?: string | null;
    }> = {},
  ): Promise<SourceIssuedAuthorityTransferClaimantRecord> {
    const record = advanceAuthorityTransferClaimantRecord(previous, {
      ...update,
      phase,
      updatedAt: this.#monotonicTimestamp(previous.updatedAt),
    });
    await this.options.store.save(record);
    if (record.variant !== 'source-issued') {
      throw claimantError('authority-transfer-claimant-variant-invalid');
    }
    return record;
  }

  async #advanceManager(
    previous: ManagerReissuedAuthorityTransferClaimantRecord,
    phase: ManagerReissuedAuthorityTransferClaimantRecord['phase'],
    update: Readonly<{
      convergenceProof?: 'receipt' | 'existing-binding';
      redemptionReceipt?: CollabTransferredMembershipRedemptionReceipt;
      targetStatus?: CollabAuthorityTransferStatus | null;
    }> = {},
  ): Promise<ManagerReissuedAuthorityTransferClaimantRecord> {
    const record = advanceAuthorityTransferClaimantRecord(previous, {
      ...update,
      ...(phase === 'membership-converged' ? { retainedAttempts: [] } : {}),
      phase,
      updatedAt: this.#monotonicTimestamp(previous.updatedAt),
    });
    await this.options.store.save(record);
    if (record.variant !== 'manager-reissued') {
      throw claimantError('authority-transfer-claimant-variant-invalid');
    }
    return record;
  }

  #monotonicTimestamp(previous: string): string {
    const current = this.now();
    return current.getTime() < Date.parse(previous) ? previous : current.toISOString();
  }
}
