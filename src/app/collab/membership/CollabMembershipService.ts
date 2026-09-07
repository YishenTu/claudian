import { randomUUID } from 'node:crypto';

import { type CollabMemberId, type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabProjectLifecycleAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import type {
  ManagerResponsibilityOperationPort,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import type {
  CollabAuthorityMembershipControlPort,
} from '@/app/collab/remote-authority/CollabAuthorityMembershipControlPort';
import type {
  CollabLanProjectSnapshot,
  CollabManagerResponsibilityOfferSummary,
  CollabProjectSnapshot,
} from '@/core/collab';
import { type CollabCancelManagerResponsibilityOfferRequest, type CollabCoordinationSnapshot, type CollabCreateManagerResponsibilityOfferRequest, type CollabDemoteManagerRequest, type CollabInvitationView, type CollabOperationOptions, type CollabPromoteManagerRequest, type CollabRemoveMemberRequest, isCollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabMembershipSnapshotPort {
  readCoordinationSnapshot(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabCoordinationSnapshot>;
}

export interface CollabMembershipServiceOptions {
  readonly createIdempotencyKey?: (kind: string) => string;
}

export interface CollabMembershipPendingLeavePort {
  load(projectId: CollabProjectId): Promise<unknown>;
}

export interface CollabMembershipManagerReceiptPort {
  load(projectId: CollabProjectId): Promise<Pick<
    CollabManagerResponsibilityOfferSummary,
    'offerId' | 'status'
  > | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(
    projectId: CollabProjectId,
    summary: CollabManagerResponsibilityOfferSummary,
  ): Promise<void>;
}

export interface CollabMembershipSafetyContext {
  readonly managerResponsibilityAdmission: CollabProjectLifecycleAdmission;
  readonly managerResponsibilityOperations: ManagerResponsibilityOperationPort;
  readonly managerReceipts: CollabMembershipManagerReceiptPort;
  readonly pendingLeaves: CollabMembershipPendingLeavePort;
}

interface ManagerResponsibilityReconciliationRequest {
  readonly memberId: CollabMemberId;
  readonly offerId: CollabOperationId;
  readonly projectId: CollabProjectId;
}

function administrationIntentKey(
  kind: string,
  intentId: string | undefined,
  createIdempotencyKey: (kind: string) => string,
): string {
  if (intentId === undefined) return createIdempotencyKey(kind);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(intentId)) {
    throw new CollabError({
      code: 'operation-failed',
      recoveryActions: ['retry'],
      safeContext: { reason: `${kind}-intent-invalid` },
    });
  }
  return `${kind}-${intentId}`;
}

export class CollabMembershipService {
  private readonly createIdempotencyKey: NonNullable<
    CollabMembershipServiceOptions['createIdempotencyKey']
  >;
  constructor(
    private readonly control: CollabAuthorityMembershipControlPort,
    private readonly snapshots: CollabMembershipSnapshotPort,
    options: CollabMembershipServiceOptions = {},
    private readonly safety: CollabMembershipSafetyContext,
  ) {
    this.createIdempotencyKey = options.createIdempotencyKey ?? (kind => (
      `${kind}-${randomUUID().replaceAll('-', '')}`
    ));
  }

  async createInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabInvitationView> {
    return this.control.membership('createInvitation', {
      idempotencyKey: this.createIdempotencyKey('create-invitation'),
      projectId,
    }, options);
  }

  async revokeInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const coordination = await this.snapshots.readCoordinationSnapshot(projectId, options);
    await this.control.membership('revokeInvitation', {
      idempotencyKey: this.createIdempotencyKey('revoke-invitation'),
      memberId: coordination.snapshot.currentMember.id,
      projectId,
    }, options);
  }

  async promoteManager(
    request: CollabPromoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    await this.safety.managerResponsibilityAdmission(request.projectId, async () => {
      await this.control.membership('promoteManager', {
        idempotencyKey: administrationIntentKey(
          'promote-manager',
          request.intentId,
          this.createIdempotencyKey,
        ),
        managerResponsibilityOfferId: request.managerResponsibilityOfferId,
        projectId: request.projectId,
        targetMemberId: request.targetMemberId,
      }, options);
    });
    await this.refreshProjection(request.projectId, options);
  }

  async demoteManager(
    request: CollabDemoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    await this.control.membership('demoteManager', {
      idempotencyKey: administrationIntentKey(
        'demote-manager',
        request.intentId,
        this.createIdempotencyKey,
      ),
      projectId: request.projectId,
      targetMemberId: request.targetMemberId,
    }, options);
    await this.refreshProjection(request.projectId, options);
  }

  async removeMember(
    request: CollabRemoveMemberRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    await this.control.membership('removeMember', {
      idempotencyKey: administrationIntentKey(
        'remove-member',
        request.intentId,
        this.createIdempotencyKey,
      ),
      memberId: request.memberId,
      projectId: request.projectId,
    }, options);
    await this.refreshProjection(request.projectId, options);
  }

  async createManagerResponsibilityOffer(
    request: CollabCreateManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const summary = await this.control.membership('createManagerResponsibilityOffer', {
      idempotencyKey: administrationIntentKey(
        'manager-responsibility-offer',
        request.intentId,
        this.createIdempotencyKey,
      ),
      projectId: request.projectId,
      purpose: request.purpose,
      targetMemberId: request.targetMemberId,
    }, options);
    return summary;
  }

  private async acknowledgeManagerResponsibilityUnlocked(
    request: ManagerResponsibilityReconciliationRequest,
    options: CollabOperationOptions,
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    if (await this.safety.pendingLeaves.load(request.projectId)) {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'manager-responsibility-target-leaving' },
      });
    }
    const offered = await this.control.membership('getManagerResponsibilityOffer', {
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
    if (offered.targetMemberId !== request.memberId) {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'manager-responsibility-offer-not-acknowledgeable' },
      });
    }
    await this.safety.managerReceipts.save(request.projectId, offered);
    if (offered.status === 'acknowledged') return offered;
    if (offered.status !== 'offered') {
      throw new CollabError({
        code: 'manager-responsibility-pending',
        safeContext: { reason: 'manager-responsibility-offer-not-acknowledgeable' },
      });
    }
    const acknowledged = await this.control.membership('acknowledgeManagerResponsibility', {
      expectedTargetMemberId: request.memberId,
      idempotencyKey: `manager-ack-${request.offerId}`,
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
    await this.safety.managerReceipts.save(request.projectId, acknowledged);
    return acknowledged;
  }

  async reconcileManagerResponsibilitySnapshot(
    snapshot: CollabProjectSnapshot,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary | null> {
    return this.safety.managerResponsibilityOperations.run(snapshot.project.id, () => (
      this.reconcileManagerResponsibilitySnapshotUnlocked(snapshot, options)
    ));
  }

  private async reconcileManagerResponsibilitySnapshotUnlocked(
    snapshot: CollabProjectSnapshot,
    options: CollabOperationOptions,
  ): Promise<CollabManagerResponsibilityOfferSummary | null> {
    if (!isCollabLanProjectSnapshot(snapshot)) {
      throw new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'manager-responsibility-lan-only' },
      });
    }
    const lanSnapshot: CollabLanProjectSnapshot = snapshot;
    const offer = lanSnapshot.managerResponsibilityOffer;
    if (
      !offer
      || offer.targetMemberId !== snapshot.currentMember.id
      || (offer.status !== 'offered' && offer.status !== 'acknowledged')
    ) {
      await this.safety.managerReceipts.remove(snapshot.project.id);
      return null;
    }
    const receipt = await this.safety.managerReceipts.load(snapshot.project.id);
    if (receipt && receipt.offerId !== offer.offerId) {
      await this.safety.managerReceipts.remove(snapshot.project.id);
    }
    if (offer.status === 'acknowledged') {
      await this.safety.managerReceipts.save(snapshot.project.id, offer);
      return offer;
    }
    if (await this.safety.pendingLeaves.load(snapshot.project.id)) {
      const declined = await this.declineManagerResponsibilityUnlocked({
        memberId: snapshot.currentMember.id,
        offerId: offer.offerId,
        projectId: snapshot.project.id,
      }, options);
      await this.safety.managerReceipts.remove(snapshot.project.id);
      return declined;
    }
    return this.acknowledgeManagerResponsibilityUnlocked({
      memberId: snapshot.currentMember.id,
      offerId: offer.offerId,
      projectId: snapshot.project.id,
    }, options);
  }

  private async declineManagerResponsibilityUnlocked(
    request: ManagerResponsibilityReconciliationRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const summary = await this.control.membership('declineManagerResponsibility', {
      expectedTargetMemberId: request.memberId,
      idempotencyKey: `manager-decline-${request.offerId}`,
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
    await this.safety.managerReceipts.save(request.projectId, summary);
    return summary;
  }

  async cancelManagerResponsibilityOffer(
    request: CollabCancelManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    return this.control.membership('cancelManagerResponsibilityOffer', {
      idempotencyKey: `manager-cancel-${request.offerId}`,
      offerId: request.offerId,
      projectId: request.projectId,
    }, options);
  }

  private async refreshProjection(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<void> {
    await this.snapshots.readCoordinationSnapshot(projectId, options).catch(() => undefined);
  }

}
