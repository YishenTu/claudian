import { randomUUID } from 'node:crypto';

import { type CollabMember, type CollabOperationId, type CollabProjectId } from '@claudian/collab-protocol';

import type {
  CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import type {
  DemoteManagerResponse,
  MembershipTerminationResponse,
  PromoteManagerResponse,
} from '@/app/collab/lan/LanCollabControlOperations';
import type {
  ManagerResponsibilityOperationPort,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import {
  type CancelManagerResponsibilityOfferInput,
  type CreateInvitationInput,
  type CreateManagerResponsibilityOfferInput,
  type DemoteManagerInput,
  type ManagerResponsibilityOfferInput,
  MembershipControlClient,
  type PromoteManagerInput,
  type RemoveMemberInput,
  type RevokeInvitationInput,
} from '@/app/collab/membership/MembershipControlClient';
import type {
  CollabLanProjectSnapshot,
  CollabManagerResponsibilityOfferSummary,
  CollabProjectSnapshot,
} from '@/core/collab';
import { type CollabCancelManagerResponsibilityOfferRequest, type CollabCoordinationSnapshot, type CollabCreateManagerResponsibilityOfferRequest, type CollabDemoteManagerRequest, type CollabInvitationView, type CollabOperationOptions, type CollabPromoteManagerRequest, type CollabRemoveMemberRequest, isCollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CONTROL_TIMEOUT_MS = 10_000;

export interface CollabMembershipSnapshotPort {
  readCoordinationSnapshot(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabCoordinationSnapshot>;
}

export interface CollabMembershipControlClientPort {
  acknowledgeManagerResponsibility(
    input: ManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  createInvitation(input: CreateInvitationInput): Promise<CollabInvitationView>;
  createManagerResponsibilityOffer(
    input: CreateManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  cancelManagerResponsibilityOffer(
    input: CancelManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  declineManagerResponsibility(
    input: ManagerResponsibilityOfferInput,
  ): Promise<CollabManagerResponsibilityOfferSummary>;
  getManagerResponsibilityOffer(input: {
    readonly memberCredential: string;
    readonly offerId: string;
    readonly projectId: string;
    readonly signal?: AbortSignal;
  }): Promise<CollabManagerResponsibilityOfferSummary>;
  demoteManager(input: DemoteManagerInput): Promise<DemoteManagerResponse>;
  promoteManager(input: PromoteManagerInput): Promise<PromoteManagerResponse>;
  removeMember(input: RemoveMemberInput): Promise<MembershipTerminationResponse>;
  revokeInvitation(input: RevokeInvitationInput): Promise<void>;
}

export interface CollabMembershipStoredHostTrust {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: string;
}

export interface CollabMembershipServiceOptions {
  readonly createClient?: (
    trust: CollabMembershipStoredHostTrust,
  ) => CollabMembershipControlClientPort;
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
  readonly managerResponsibilityOperations: ManagerResponsibilityOperationPort;
  readonly managerReceipts: CollabMembershipManagerReceiptPort;
  readonly pendingLeaves: CollabMembershipPendingLeavePort;
}

interface MembershipSession {
  readonly client: CollabMembershipControlClientPort;
  readonly membership: CollabLocalLanMembershipRecord;
}

interface ManagerResponsibilityReconciliationRequest {
  readonly offerId: CollabOperationId;
  readonly projectId: CollabProjectId;
}

function membershipError(
  code: 'host-stopped' | 'project-not-found',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'host-stopped' ? ['restart-host', 'retry'] : ['retry'],
    safeContext: { reason },
  });
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
  private readonly createClient: NonNullable<CollabMembershipServiceOptions['createClient']>;
  private readonly createIdempotencyKey: NonNullable<
    CollabMembershipServiceOptions['createIdempotencyKey']
  >;
  constructor(
    private readonly projects: Pick<CollabLocalProjectRepository, 'loadMembership'>,
    private readonly snapshots: CollabMembershipSnapshotPort,
    options: CollabMembershipServiceOptions = {},
    private readonly safety: CollabMembershipSafetyContext,
  ) {
    this.createClient = options.createClient ?? (trust => new MembershipControlClient(
      new PinnedCollabHttpClient(trust, CONTROL_TIMEOUT_MS),
    ));
    this.createIdempotencyKey = options.createIdempotencyKey ?? (kind => (
      `${kind}-${randomUUID().replaceAll('-', '')}`
    ));
  }

  async listMembers(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<readonly CollabMember[]> {
    const result = await this.snapshots.readCoordinationSnapshot(projectId, options);
    if (result.snapshot.project.id !== projectId) {
      throw membershipError('project-not-found', 'membership-snapshot-project-mismatch');
    }
    return result.snapshot.members;
  }

  async createInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabInvitationView> {
    const session = await this.loadSession(projectId);
    return session.client.createInvitation({
      idempotencyKey: this.createIdempotencyKey('create-invitation'),
      memberCredential: session.membership.member.credential,
      projectId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async revokeInvitation(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const session = await this.loadSession(projectId);
    await session.client.revokeInvitation({
      idempotencyKey: this.createIdempotencyKey('revoke-invitation'),
      memberCredential: session.membership.member.credential,
      memberId: session.membership.member.id,
      projectId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async promoteManager(
    request: CollabPromoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const session = await this.loadSession(request.projectId);
    await session.client.promoteManager({
      idempotencyKey: administrationIntentKey(
        'promote-manager',
        request.intentId,
        this.createIdempotencyKey,
      ),
      managerResponsibilityOfferId: request.managerResponsibilityOfferId,
      memberCredential: session.membership.member.credential,
      projectId: request.projectId,
      targetMemberId: request.targetMemberId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await this.refreshProjection(request.projectId, options);
  }

  async demoteManager(
    request: CollabDemoteManagerRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const session = await this.loadSession(request.projectId);
    await session.client.demoteManager({
      idempotencyKey: administrationIntentKey(
        'demote-manager',
        request.intentId,
        this.createIdempotencyKey,
      ),
      memberCredential: session.membership.member.credential,
      projectId: request.projectId,
      targetMemberId: request.targetMemberId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await this.refreshProjection(request.projectId, options);
  }

  async removeMember(
    request: CollabRemoveMemberRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const session = await this.loadSession(request.projectId);
    await session.client.removeMember({
      idempotencyKey: administrationIntentKey(
        'remove-member',
        request.intentId,
        this.createIdempotencyKey,
      ),
      memberCredential: session.membership.member.credential,
      memberId: request.memberId,
      projectId: request.projectId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await this.refreshProjection(request.projectId, options);
  }

  async createManagerResponsibilityOffer(
    request: CollabCreateManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const session = await this.loadSession(request.projectId);
    const summary = await session.client.createManagerResponsibilityOffer({
      idempotencyKey: administrationIntentKey(
        'manager-responsibility-offer',
        request.intentId,
        this.createIdempotencyKey,
      ),
      memberCredential: session.membership.member.credential,
      projectId: request.projectId,
      purpose: request.purpose,
      targetMemberId: request.targetMemberId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
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
    const session = await this.loadSession(request.projectId);
    const offered = await session.client.getManagerResponsibilityOffer({
      memberCredential: session.membership.member.credential,
      offerId: request.offerId,
      projectId: request.projectId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (offered.targetMemberId !== session.membership.member.id) {
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
    const acknowledged = await session.client.acknowledgeManagerResponsibility({
      expectedTargetMemberId: session.membership.member.id,
      idempotencyKey: `manager-ack-${request.offerId}`,
      memberCredential: session.membership.member.credential,
      offerId: request.offerId,
      projectId: request.projectId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
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
        offerId: offer.offerId,
        projectId: snapshot.project.id,
      }, options);
      await this.safety.managerReceipts.remove(snapshot.project.id);
      return declined;
    }
    return this.acknowledgeManagerResponsibilityUnlocked({
      offerId: offer.offerId,
      projectId: snapshot.project.id,
    }, options);
  }

  private async declineManagerResponsibilityUnlocked(
    request: ManagerResponsibilityReconciliationRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const session = await this.loadSession(request.projectId);
    const summary = await session.client.declineManagerResponsibility({
      expectedTargetMemberId: session.membership.member.id,
      idempotencyKey: `manager-decline-${request.offerId}`,
      memberCredential: session.membership.member.credential,
      offerId: request.offerId,
      projectId: request.projectId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await this.safety.managerReceipts.save(request.projectId, summary);
    return summary;
  }

  async cancelManagerResponsibilityOffer(
    request: CollabCancelManagerResponsibilityOfferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabManagerResponsibilityOfferSummary> {
    const session = await this.loadSession(request.projectId);
    return session.client.cancelManagerResponsibilityOffer({
      idempotencyKey: `manager-cancel-${request.offerId}`,
      memberCredential: session.membership.member.credential,
      offerId: request.offerId,
      projectId: request.projectId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  private async refreshProjection(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<void> {
    await this.snapshots.readCoordinationSnapshot(projectId, options).catch(() => undefined);
  }

  private async loadSession(projectId: CollabProjectId): Promise<MembershipSession> {
    const membership = await this.projects.loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== projectId
    ) {
      throw membershipError('project-not-found', 'membership-control-membership-missing');
    }
    const endpoint = membership.authority.endpoint;
    const caCertificatePem = membership.authority.hostCaCertificatePem;
    const caFingerprint = membership.authority.hostCaFingerprint;
    if (!endpoint || !caCertificatePem || !caFingerprint) {
      throw membershipError('host-stopped', 'membership-control-host-unavailable');
    }
    return {
      client: this.createClient({
        caCertificatePem,
        caFingerprint,
        endpoint,
        projectId,
      }),
      membership,
    };
  }
}
