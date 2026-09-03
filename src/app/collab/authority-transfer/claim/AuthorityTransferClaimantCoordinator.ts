import { createHash, randomBytes } from 'node:crypto';

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
  type AuthorityTransferClaimantLanTarget,
  type AuthorityTransferClaimantRecord,
  type AuthorityTransferClaimantStore,
  type CloudToLanManagerClaimantPredecessor,
  createAuthorityTransferClaimantRecord,
  createManagerReissuedAuthorityTransferClaimantRecord,
  type ManagerReissuedAuthorityTransferClaimantRecord,
  type SourceIssuedAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
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
  claimTransferredMembership(
    record: AuthorityTransferClaimantRecord,
    request: ClaimTransferredMembershipRequest,
    options: CollabOperationOptions,
  ): Promise<CollabTransferredMembershipRedemptionReceipt>;
  confirmTargetBinding?(
    record: ManagerReissuedAuthorityTransferClaimantRecord,
    proof: 'receipt' | 'existing-binding',
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus>;
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
  readonly lanTarget?: AuthorityTransferClaimantLanTarget | null;
  readonly now?: () => Date;
  readonly source?: AuthorityTransferClaimantSource;
  readonly store: AuthorityTransferClaimantStore;
  readonly target: AuthorityTransferClaimantTarget;
}

export interface StartAuthorityTransferClaimantInput {
  readonly managerPredecessor?: CloudToLanManagerClaimantPredecessor | null;
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
  lanTarget: AuthorityTransferClaimantLanTarget | null,
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

/** Owns both bounded claimant variants without treating a reissue as source custody. */
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
    if (existing) {
      if (!sameManagerReissuedAttempt(existing, input)) {
        throw claimantError('authority-transfer-claimant-attempt-conflict');
      }
    } else {
      const candidate = createManagerReissuedAuthorityTransferClaimantRecord({
        ...input,
        operationIntentId: input.operationIntentId
          ?? `manager-reissued-${randomBytes(16).toString('hex')}`,
      });
      await this.options.store.save(candidate);
    }
    await this.resume(input.descriptor.projectId, options);
  }

  async resume(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const record = await this.options.store.load(projectId);
    if (!record) throw claimantError('authority-transfer-claimant-record-missing');
    if (record.variant === 'manager-reissued') {
      await this.resumeManagerReissued(record, options);
      return;
    }
    await this.resumeSourceIssued(record, options);
  }

  private async resumeSourceIssued(
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
          case 'credential-persisted':
            await this.complete(record, options);
            return;
          case 'target-claimed':
            record = await this.advanceSource(record, 'source-acknowledged');
            continue;
          case 'source-acknowledged':
          case 'membership-converged':
            break;
        }
      }
      switch (record.phase) {
        case 'prepared': {
          const claim = await source.getClaim(record, options);
          record = await this.advanceSource(record, 'claim-retained', { claim });
          break;
        }
        case 'claim-retained': {
          const targetCredential = record.status.targetAuthority.kind === 'lan'
            ? this.createCredential()
            : null;
          record = await this.advanceSource(record, 'credential-persisted', {
            targetCredential,
          });
          break;
        }
        case 'credential-persisted': {
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
          record = await this.advanceSource(record, 'target-claimed', { redemptionReceipt });
          break;
        }
        case 'target-claimed':
          await source.acknowledgeRedemption(record, options);
          record = await this.advanceSource(record, 'source-acknowledged');
          break;
        case 'source-acknowledged':
          await this.options.convergence.converge(record, options);
          record = await this.advanceSource(record, 'membership-converged');
          break;
        case 'membership-converged':
          record = await this.advanceSource(record, 'completed');
          break;
      }
    }
    await this.complete(record, options);
  }

  private async resumeManagerReissued(
    initial: ManagerReissuedAuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    let record = initial;
    while (record.phase !== 'completed') {
      assertNotCancelled(options);
      switch (record.phase) {
        case 'redemption-prepared': {
          if (this.now().getTime() >= Date.parse(record.descriptor.expiresAt)) {
            const targetStatus = await this.confirmManagerTargetBinding(
              record,
              'existing-binding',
              options,
            );
            record = await this.advanceManager(record, 'target-confirmed', {
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
          record = await this.advanceManager(record, 'target-claimed', {
            redemptionReceipt,
          });
          break;
        }
        case 'target-claimed': {
          const targetStatus = await this.confirmManagerTargetBinding(
            record,
            'receipt',
            options,
          );
          record = await this.advanceManager(record, 'target-confirmed', {
            convergenceProof: 'receipt',
            targetStatus,
          });
          break;
        }
        case 'target-confirmed':
          await this.options.convergence.converge(record, options);
          record = await this.advanceManager(record, 'membership-converged');
          break;
        case 'membership-converged':
          record = await this.advanceManager(record, 'completed');
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

  private confirmManagerTargetBinding(
    record: ManagerReissuedAuthorityTransferClaimantRecord,
    proof: 'receipt' | 'existing-binding',
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    const confirm = this.options.target.confirmTargetBinding?.bind(this.options.target);
    if (!confirm) {
      throw claimantError('authority-transfer-claimant-target-confirmation-unavailable');
    }
    return confirm(record, proof, options);
  }

  private async advanceSource(
    previous: SourceIssuedAuthorityTransferClaimantRecord,
    phase: SourceIssuedAuthorityTransferClaimantRecord['phase'],
    update: Readonly<{
      claim?: CollabTransferredMembershipClaim;
      redemptionReceipt?: CollabTransferredMembershipRedemptionReceipt;
      targetCredential?: string | null;
    }> = {},
  ): Promise<SourceIssuedAuthorityTransferClaimantRecord> {
    const record = advanceAuthorityTransferClaimantRecord(previous, {
      ...update,
      phase,
      updatedAt: this.monotonicTimestamp(previous.updatedAt),
    });
    await this.options.store.save(record);
    if (record.variant !== 'source-issued') {
      throw claimantError('authority-transfer-claimant-variant-invalid');
    }
    return record;
  }

  private async advanceManager(
    previous: ManagerReissuedAuthorityTransferClaimantRecord,
    phase: ManagerReissuedAuthorityTransferClaimantRecord['phase'],
    update: Readonly<{
      convergenceProof?: 'receipt' | 'existing-binding';
      redemptionReceipt?: CollabTransferredMembershipRedemptionReceipt;
      targetStatus?: CollabAuthorityTransferStatus;
    }> = {},
  ): Promise<ManagerReissuedAuthorityTransferClaimantRecord> {
    const record = advanceAuthorityTransferClaimantRecord(previous, {
      ...update,
      phase,
      updatedAt: this.monotonicTimestamp(previous.updatedAt),
    });
    await this.options.store.save(record);
    if (record.variant !== 'manager-reissued') {
      throw claimantError('authority-transfer-claimant-variant-invalid');
    }
    return record;
  }

  private monotonicTimestamp(previous: string): string {
    const current = this.now();
    return current.getTime() < Date.parse(previous) ? previous : current.toISOString();
  }
}
