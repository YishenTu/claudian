import { createHash, randomBytes } from 'node:crypto';

import type {
  ClaimTransferredMembershipRequest,
  CollabAuthorityTransferStatus,
  CollabMemberId,
  CollabProjectId,
  CollabTransferredMembershipClaim,
  CollabTransferredMembershipRedemptionReceipt,
} from '@claudian-collab/protocol';

import {
  advanceAuthorityTransferClaimantRecord,
  type AuthorityTransferClaimantLanTarget,
  type AuthorityTransferClaimantRecord,
  type AuthorityTransferClaimantStore,
  createAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferClaimantSource {
  getClaim(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<CollabTransferredMembershipClaim>;
  acknowledgeRedemption(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
}

export interface AuthorityTransferClaimantTarget {
  claimTransferredMembership(
    record: AuthorityTransferClaimantRecord,
    request: ClaimTransferredMembershipRequest,
    options: CollabOperationOptions,
  ): Promise<CollabTransferredMembershipRedemptionReceipt>;
}

export interface AuthorityTransferClaimantConvergence {
  converge(
    record: AuthorityTransferClaimantRecord,
    options: CollabOperationOptions,
  ): Promise<void>;
}

export interface AuthorityTransferClaimantCoordinatorOptions {
  readonly convergence: AuthorityTransferClaimantConvergence;
  readonly createCredential?: () => string;
  readonly lanTarget?: AuthorityTransferClaimantLanTarget | null;
  readonly now?: () => Date;
  readonly source: AuthorityTransferClaimantSource;
  readonly store: AuthorityTransferClaimantStore;
  readonly target: AuthorityTransferClaimantTarget;
}

export interface StartAuthorityTransferClaimantInput {
  readonly memberId: CollabMemberId;
  readonly operationIntentId: string;
  readonly status: CollabAuthorityTransferStatus;
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

function sameAttempt(
  record: AuthorityTransferClaimantRecord,
  input: StartAuthorityTransferClaimantInput,
  lanTarget: AuthorityTransferClaimantLanTarget | null,
): boolean {
  return record.projectId === input.status.projectId
    && record.transferId === input.status.transferId
    && record.memberId === input.memberId
    && record.operationIntentId === input.operationIntentId
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

/**
 * Owns an offline Member's restart-safe claim retrieval and target binding.
 * The source and target remain authoritative for claim and receipt validity;
 * this record only makes the claimant-side sequence durable.
 */
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
      if (!sameAttempt(existing, input, lanTarget)) {
        throw claimantError('authority-transfer-claimant-attempt-conflict');
      }
    } else {
      await this.options.store.save(createAuthorityTransferClaimantRecord({
        createdAt: this.now().toISOString(),
        lanTarget,
        memberId: input.memberId,
        operationIntentId: input.operationIntentId,
        status: input.status,
      }));
    }
    await this.resume(input.status.projectId, options);
  }

  async resume(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    let record = await this.options.store.load(projectId);
    if (!record) throw claimantError('authority-transfer-claimant-record-missing');
    while (record.phase !== 'completed') {
      assertNotCancelled(options);
      if (this.now().getTime() >= Date.parse(record.status.expiresAt)) {
        switch (record.phase) {
          case 'prepared':
          case 'claim-retained':
          case 'credential-persisted':
            await this.options.store.remove(projectId);
            return;
          case 'target-claimed':
            record = await this.advance(record, 'source-acknowledged');
            continue;
          case 'source-acknowledged':
          case 'membership-converged':
            break;
        }
      }
      switch (record.phase) {
        case 'prepared': {
          const claim = await this.options.source.getClaim(record, options);
          record = await this.advance(record, 'claim-retained', { claim });
          break;
        }
        case 'claim-retained': {
          const targetCredential = record.status.targetAuthority.kind === 'lan'
            ? this.createCredential()
            : null;
          record = await this.advance(record, 'credential-persisted', {
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
                  .update(Buffer.from(record.targetCredential, 'base64url'))
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
          record = await this.advance(record, 'target-claimed', { redemptionReceipt });
          break;
        }
        case 'target-claimed':
          await this.options.source.acknowledgeRedemption(record, options);
          record = await this.advance(record, 'source-acknowledged');
          break;
        case 'source-acknowledged':
          await this.options.convergence.converge(record, options);
          record = await this.advance(record, 'membership-converged');
          break;
        case 'membership-converged':
          record = await this.advance(record, 'completed');
          break;
      }
    }
    await this.options.store.remove(projectId);
  }

  private async advance(
    previous: AuthorityTransferClaimantRecord,
    phase: AuthorityTransferClaimantRecord['phase'],
    update: Partial<Pick<
      AuthorityTransferClaimantRecord,
      'claim' | 'redemptionReceipt' | 'targetCredential'
    >> = {},
  ): Promise<AuthorityTransferClaimantRecord> {
    const record = advanceAuthorityTransferClaimantRecord(previous, {
      ...update,
      phase,
      updatedAt: this.now().toISOString(),
    });
    await this.options.store.save(record);
    return record;
  }
}
