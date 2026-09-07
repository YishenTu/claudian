import { createHash } from 'node:crypto';

import {
  type AcknowledgeTransferredMembershipClaimRedemptionRequest,
  type ClaimTransferredMembershipRequest,
  type CollabProjectId,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  type GetProjectAuthorityTransferRequest,
  type GetTransferredMembershipClaimRequest,
} from '@claudian-collab/protocol';

import {
  verifyAuthorityTransferRedemptionReceipt,
} from '@/app/collab/authority-transfer/AuthorityTransferReceiptVerifier';
import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import type { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  LanAuthorityTransferActor,
  LanAuthorityTransferTargetActiveService,
  LanAuthorityTransferTerminalSourceService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type LanClaimRequest = Extract<
  ClaimTransferredMembershipRequest,
  { readonly credentialHash: string }
>;

function serviceError(
  code: 'authorization-denied' | 'durable-progress-recovery-required' | 'project-not-found',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'durable-progress-recovery-required'
      ? ['resume', 'open-diagnostics']
      : [],
    safeContext: { reason },
  });
}

export interface PersistentTerminalSourceServiceOptions {
  readonly authenticate: (credential: string) => Promise<LanAuthorityTransferActor>;
  readonly cleanupStaging: (record: AuthorityTransferRecord) => Promise<void>;
  readonly expiresAt: string;
  readonly now?: () => Date;
  readonly persistence: Pick<
    AuthorityTransferPersistence,
    | 'completeTerminalCleanup'
    | 'expireTerminalResponder'
    | 'load'
    | 'loadClaim'
    | 'scrubClaimWithVerifiedReceipt'
  >;
  readonly projectId: CollabProjectId;
  readonly transferId: string;
  readonly verifyRedemptionReceipt?: (
    receipt: CollabTransferredMembershipRedemptionReceipt,
    record: AuthorityTransferRecord,
  ) => Promise<void>;
}

/** Serves the bounded former-LAN source route after its writable authority fence. */
export class PersistentLanAuthorityTransferTerminalSourceService
implements LanAuthorityTransferTerminalSourceService {
  readonly expiresAt: string;
  private readonly now: () => Date;
  private readonly verifyRedemptionReceipt: NonNullable<
    PersistentTerminalSourceServiceOptions['verifyRedemptionReceipt']
  >;

  constructor(private readonly options: PersistentTerminalSourceServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.expiresAt = options.expiresAt;
    this.verifyRedemptionReceipt = options.verifyRedemptionReceipt
      ?? verifyAuthorityTransferRedemptionReceipt;
  }

  async expire(): Promise<void> {
    const record = await this.options.persistence.load(this.options.projectId);
    if (
      !record
      || record.transferId !== this.options.transferId
      || record.localRole !== 'source'
      || record.status.state !== 'completed'
      || record.status.relinquishmentProof === null
    ) {
      throw serviceError(
        'durable-progress-recovery-required',
        'authority-transfer-terminal-source-unavailable',
      );
    }
    await this.options.persistence.expireTerminalResponder(
      this.options.projectId,
      this.options.transferId,
    );
    await this.options.cleanupStaging(record);
    await this.options.persistence.completeTerminalCleanup({
      operationIntentId: record.operationIntentId,
      projectId: record.projectId,
      stagingDirectoryName: record.stagingDirectoryName,
      transferId: record.transferId,
    });
  }

  authenticateMemberCredential(credential: string): Promise<LanAuthorityTransferActor> {
    return this.options.authenticate(credential);
  }

  async getProjectAuthorityTransfer(
    _actor: LanAuthorityTransferActor,
    request: GetProjectAuthorityTransferRequest,
  ) {
    return (await this.requireTerminal(request.projectId, request.transferId)).status;
  }

  async getTransferredMembershipClaim(
    actor: LanAuthorityTransferActor,
    request: GetTransferredMembershipClaimRequest,
  ) {
    await this.requireTerminal(request.projectId, request.transferId);
    return this.options.persistence.loadClaim(
      request.projectId,
      request.transferId,
      actor.memberId,
    );
  }

  async acknowledgeTransferredMembershipClaimRedemption(
    actor: LanAuthorityTransferActor,
    request: AcknowledgeTransferredMembershipClaimRedemptionRequest,
  ) {
    const record = await this.requireTerminal(request.projectId, request.transferId);
    if (request.receipt.memberId !== actor.memberId) {
      throw serviceError('authorization-denied', 'authority-transfer-receipt-member-mismatch');
    }
    await this.verifyRedemptionReceipt(request.receipt, record);
    const acknowledgedAt = this.now().toISOString();
    await this.options.persistence.scrubClaimWithVerifiedReceipt({
      acknowledgedAt,
      receipt: request.receipt,
    });
    return {
      acknowledgedAt,
      memberId: actor.memberId,
      projectId: request.projectId,
      receiptId: request.receipt.receiptId,
      transferId: request.transferId,
    };
  }

  private async requireTerminal(
    projectId: CollabProjectId,
    transferId: string,
  ): Promise<AuthorityTransferRecord> {
    if (projectId !== this.options.projectId) {
      throw serviceError('project-not-found', 'authority-transfer-route-not-found');
    }
    const record = await this.options.persistence.load(projectId);
    if (
      !record
      || record.transferId !== transferId
      || transferId !== this.options.transferId
      || record.localRole !== 'source'
      || record.status.state !== 'completed'
      || record.status.relinquishmentProof === null
      || record.terminalResponder?.state !== 'active'
      || record.status.expiresAt !== this.options.expiresAt
      || this.now().getTime() >= Date.parse(this.options.expiresAt)
    ) {
      throw serviceError(
        'durable-progress-recovery-required',
        'authority-transfer-terminal-source-unavailable',
      );
    }
    return record;
  }
}

export interface PersistentTargetActiveServiceOptions {
  readonly bind: (
    request: LanClaimRequest,
  ) => Promise<CollabTransferredMembershipRedemptionReceipt>;
  readonly expire: () => Promise<void>;
  readonly expiresAt: string;
  readonly projectId: CollabProjectId;
  readonly targetAuthorityGeneration: number;
  readonly transferId: string;
}

/** Adapts the target authority's atomic claim-hash binding and receipt signer. */
export class PersistentLanAuthorityTransferTargetActiveService
implements LanAuthorityTransferTargetActiveService {
  readonly expiresAt: string;

  constructor(private readonly options: PersistentTargetActiveServiceOptions) {
    this.expiresAt = options.expiresAt;
  }

  expire(): Promise<void> {
    return this.options.expire();
  }

  async claimTransferredMembership(
    request: LanClaimRequest,
  ): Promise<CollabTransferredMembershipRedemptionReceipt> {
    if (
      request.projectId !== this.options.projectId
      || request.transferId !== this.options.transferId
    ) throw serviceError('project-not-found', 'authority-transfer-route-not-found');
    const receipt = decodeCollabTransferredMembershipRedemptionReceipt(
      await this.options.bind(request),
    );
    if (
      receipt.projectId !== request.projectId
      || receipt.transferId !== request.transferId
      || receipt.operationIntentId !== request.idempotencyKey
      || receipt.targetAuthorityGeneration !== this.options.targetAuthorityGeneration
      || receipt.claimSha256 !== createHash('sha256')
        .update(request.claim, 'utf8')
        .digest('hex')
    ) {
      throw serviceError(
        'durable-progress-recovery-required',
        'authority-transfer-target-receipt-mismatch',
      );
    }
    return receipt;
  }
}
