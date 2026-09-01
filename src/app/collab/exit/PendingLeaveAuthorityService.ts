import type {
  CollabManagerResponsibilityOfferResponse,
  CollabProjectMembershipOperationMap,
  LeaveProjectResponse,
} from '@claudian-collab/protocol';

import type {
  CloudPendingLeaveRecord,
  LanPendingLeaveRecord,
  PendingLeaveAuthorityReplay,
  PendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';
import {
  isCloudPendingLeaveRecord,
  isLanPendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';
import type { HostTransitionCandidateResolver } from '@/app/collab/HostTransitionCandidateResolver';
import {
  type CollabTrustedHost,
  PinnedCollabHttpClient,
} from '@/app/collab/lan/CollabHttpClient';
import type { MembershipTerminationResponse } from '@/app/collab/lan/LanCollabControlOperations';
import {
  type LeaveProjectInput,
  MembershipControlClient,
} from '@/app/collab/membership/MembershipControlClient';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';
import type { CollabCloudProjectSnapshot, CollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CONTROL_TIMEOUT_MS = 10_000;

export interface PendingLeaveAuthorityClientPort {
  leaveProject(input: LeaveProjectInput): Promise<MembershipTerminationResponse>;
  readSnapshot(
    projectId: string,
    memberCredential: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabLanProjectSnapshot>;
}

export interface CloudPendingLeaveAuthorityClientPort {
  getManagerResponsibilityOffer(
    request: CollabProjectMembershipOperationMap['getManagerResponsibilityOffer']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabManagerResponsibilityOfferResponse>;
  leaveProject(
    request: CollabProjectMembershipOperationMap['leaveProject']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<LeaveProjectResponse>;
  listProjectMembers(
    request: CollabProjectMembershipOperationMap['listProjectMembers']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectMembershipOperationMap['listProjectMembers']['response']>;
  readPersonalRefOid(
    personalRef: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string>;
  readSnapshot(
    projectId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabCloudProjectSnapshot>;
}

export interface PendingLeaveAuthorityServiceOptions {
  readonly createClient?: (
    record: LanPendingLeaveRecord,
  ) => PendingLeaveAuthorityClientPort;
  readonly createCloudClient?: (
    record: CloudPendingLeaveRecord,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<CloudPendingLeaveAuthorityClientPort & { dispose(): void }>;
  readonly hostTransitionCandidates?: Pick<HostTransitionCandidateResolver, 'resolve'>;
}

export interface PreparePendingLeaveInput {
  readonly managerResponsibilityOfferId?: string;
  readonly pending: PendingLeaveRecord;
  readonly signal?: AbortSignal;
}

export type PendingLeaveAuthorityPreparation =
  | {
    readonly authorityReplay: PendingLeaveAuthorityReplay;
    readonly memberRole: 'manager' | 'member';
  }
  | {
    readonly memberRole: 'manager' | 'member';
    readonly request: CollabProjectMembershipOperationMap['leaveProject']['request'];
  };

export interface SettlePendingLeaveInput {
  readonly pending: PendingLeaveRecord;
  readonly signal?: AbortSignal;
}

export interface ResolvePendingLeaveHostInput extends SettlePendingLeaveInput {
  readonly failure: unknown;
}

export class PendingLeaveAuthorityService {
  private readonly createClient: NonNullable<PendingLeaveAuthorityServiceOptions['createClient']>;

  constructor(private readonly options: PendingLeaveAuthorityServiceOptions = {}) {
    this.createClient = options.createClient ?? (record => {
      const transport = new PinnedCollabHttpClient(storedTrust(record), CONTROL_TIMEOUT_MS);
      const membership = new MembershipControlClient(transport);
      const project = new ProjectControlClient(transport);
      return {
        leaveProject: input => membership.leaveProject(input),
        readSnapshot: (projectId, memberCredential, requestOptions) => (
          project.readSnapshot(projectId, memberCredential, requestOptions)
        ),
      };
    });
  }

  async prepare(input: PreparePendingLeaveInput): Promise<PendingLeaveAuthorityPreparation> {
    if (isCloudPendingLeaveRecord(input.pending)) {
      return this.prepareCloud({ ...input, pending: input.pending });
    }
    const { pending } = input;
    if (pending.authorityReplay) {
      return { authorityReplay: pending.authorityReplay, memberRole: pending.localRole };
    }
    return this.readCurrentLanPreparation(
      pending,
      null,
      input.managerResponsibilityOfferId ?? null,
      input.signal,
    );
  }

  async refresh(input: SettlePendingLeaveInput): Promise<PendingLeaveAuthorityPreparation> {
    if (isCloudPendingLeaveRecord(input.pending)) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'cloud-pending-leave-recovery-barrier-required' },
      });
    }
    return this.readCurrentLanPreparation(
      input.pending,
      input.pending.authorityReplay?.idempotencyManagerMemberId ?? null,
      input.pending.authorityReplay?.managerResponsibilityOfferId ?? null,
      input.signal,
    );
  }

  async recoverRejected(
    input: SettlePendingLeaveInput,
  ): Promise<{ readonly memberRole: 'manager' | 'member' }> {
    const { pending } = input;
    if (!isCloudPendingLeaveRecord(pending) || pending.request === null) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'cloud-pending-leave-rejected-request-missing' },
      });
    }
    return this.withCloudClient(pending, input.signal, async client => {
      const requestOptions = input.signal ? { signal: input.signal } : {};
      const snapshot = await client.readSnapshot(pending.projectId, requestOptions);
      if (
        snapshot.project.id !== pending.projectId
        || snapshot.project.authorityGeneration !== pending.authorityGeneration
        || snapshot.currentMember.id !== pending.memberId
        || snapshot.currentMember.personalRef !== pending.personalRef
      ) throw integrityError('cloud-pending-leave-recovery-snapshot-mismatch');
      const listed = await client.listProjectMembers(
        { projectId: pending.projectId },
        requestOptions,
      );
      const matching = listed.projectId === pending.projectId
        ? listed.members.filter(member => member.memberId === pending.memberId)
        : [];
      if (
        matching.length !== 1
        || matching[0]?.bindingState !== 'bound'
        || matching[0].role !== snapshot.currentMember.role
      ) {
        throw integrityError('cloud-pending-leave-recovery-member-mismatch');
      }
      return { memberRole: matching[0].role };
    });
  }

  async settle(
    input: SettlePendingLeaveInput,
  ): Promise<MembershipTerminationResponse | LeaveProjectResponse> {
    const { pending } = input;
    if (isCloudPendingLeaveRecord(pending)) {
      if (pending.request === null) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'cloud-pending-leave-request-missing' },
        });
      }
      const result = await this.withCloudClient(pending, input.signal, client => (
        client.leaveProject(
          pending.request,
          input.signal ? { signal: input.signal } : {},
        )
      ));
      if (
        result.projectId !== pending.projectId
        || result.memberId !== pending.memberId
        || result.status !== 'left'
      ) throw integrityError('cloud-pending-leave-response-mismatch');
      return result;
    }
    const replay = pending.authorityReplay;
    if (!replay) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'pending-leave-replay-preconditions-missing' },
      });
    }
    return this.createClient(pending).leaveProject({
      expectedHostMemberId: replay.expectedHostMemberId,
      expectedMemberId: pending.memberId,
      idempotencyKey: pending.idempotencyKey,
      idempotencyManagerMemberId: replay.idempotencyManagerMemberId,
      memberCredential: pending.memberCredential,
      ...(replay.managerResponsibilityOfferId === null ? {} : {
        managerResponsibilityOfferId: replay.managerResponsibilityOfferId,
      }),
      projectId: pending.projectId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async resolveHost(input: ResolvePendingLeaveHostInput): Promise<CollabTrustedHost> {
    if (!isLanPendingLeaveRecord(input.pending)) {
      if (input.failure instanceof Error) throw input.failure;
      throw new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'cloud-pending-leave-endpoint-is-immutable' },
      });
    }
    if (!this.options.hostTransitionCandidates) {
      if (input.failure instanceof Error) throw input.failure;
      throw new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'pending-leave-host-resolution-failed' },
      });
    }
    return this.options.hostTransitionCandidates.resolve({
      failure: input.failure,
      pinnedCaCertificatePem: input.pending.hostCaCertificatePem,
      projectId: input.pending.projectId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  private async prepareCloud(
    input: PreparePendingLeaveInput & { readonly pending: CloudPendingLeaveRecord },
  ): Promise<Extract<PendingLeaveAuthorityPreparation, { readonly request: unknown }>> {
    const { pending, signal } = input;
    if (pending.request !== null) {
      return { memberRole: pending.localRole, request: pending.request };
    }
    return this.withCloudClient(pending, signal, async client => {
      const requestOptions = signal ? { signal } : {};
      const snapshot = await client.readSnapshot(pending.projectId, requestOptions);
      if (
        snapshot.project.id !== pending.projectId
        || snapshot.project.authorityGeneration !== pending.authorityGeneration
        || snapshot.currentMember.id !== pending.memberId
        || snapshot.currentMember.personalRef !== pending.personalRef
      ) throw integrityError('cloud-pending-leave-snapshot-mismatch');

      const listed = await client.listProjectMembers(
        { projectId: pending.projectId },
        requestOptions,
      );
      if (listed.projectId !== pending.projectId) {
        throw integrityError('cloud-pending-leave-member-list-mismatch');
      }
      const matching = listed.members.filter(member => member.memberId === pending.memberId);
      if (
        matching.length !== 1
        || matching[0]?.bindingState !== 'bound'
        || matching[0].role !== snapshot.currentMember.role
      ) {
        throw integrityError('cloud-pending-leave-member-identity-mismatch');
      }
      const current = matching[0];
      const managers = listed.members.filter(member => member.role === 'manager');
      let expectedOfferRevision: number | null = null;
      let managerResponsibilityOfferId: string | null = null;
      if (current.role === 'manager' && managers.length === 1) {
        const offerId = input.managerResponsibilityOfferId;
        if (!offerId) {
          throw new CollabError({
            code: 'manager-responsibility-pending',
            safeContext: { reason: 'cloud-pending-leave-successor-required' },
          });
        }
        const { offer } = await client.getManagerResponsibilityOffer({
          offerId,
          projectId: pending.projectId,
        }, requestOptions);
        if (
          offer.offerId !== offerId
          || offer.purpose !== 'manager-leave'
          || offer.sourceManagerMemberId !== pending.memberId
          || offer.state !== 'acknowledged'
          || offer.managerSetGenerationAtOffer !== listed.managerSetGeneration
          || !listed.members.some(member => (
            member.memberId === offer.targetMemberId
            && member.role === 'member'
            && member.membershipRevision === offer.targetMembershipRevisionAtOffer
          ))
        ) {
          throw new CollabError({
            code: 'manager-responsibility-pending',
            safeContext: { reason: 'cloud-pending-leave-successor-invalid' },
          });
        }
        expectedOfferRevision = offer.revision;
        managerResponsibilityOfferId = offer.offerId;
      }
      const expectedPersonalRefOid = await client.readPersonalRefOid(
        pending.personalRef,
        requestOptions,
      );
      return {
        memberRole: current.role,
        request: {
          expectedManagerSetGeneration: listed.managerSetGeneration,
          expectedMembershipRevision: current.membershipRevision,
          expectedOfferRevision,
          expectedPersonalRefOid,
          idempotencyKey: pending.idempotencyKey,
          managerResponsibilityOfferId,
          projectId: pending.projectId,
        },
      };
    });
  }

  private async withCloudClient<T>(
    pending: CloudPendingLeaveRecord,
    signal: AbortSignal | undefined,
    operation: (client: CloudPendingLeaveAuthorityClientPort) => Promise<T>,
  ): Promise<T> {
    const create = this.options.createCloudClient;
    if (!create) {
      throw new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'cloud-pending-leave-client-unavailable' },
      });
    }
    const client = await create(pending, signal ? { signal } : {});
    try {
      return await operation(client);
    } finally {
      client.dispose();
    }
  }

  private async readCurrentLanPreparation(
    pending: LanPendingLeaveRecord,
    idempotencyManagerMemberId: string | null,
    managerResponsibilityOfferId: string | null,
    signal?: AbortSignal,
  ): Promise<Extract<PendingLeaveAuthorityPreparation, { readonly authorityReplay: unknown }>> {
    const snapshot = await this.createClient(pending).readSnapshot(
      pending.projectId,
      pending.memberCredential,
      signal ? { signal } : {},
    );
    if (
      snapshot.project.id !== pending.projectId
      || snapshot.currentMember.id !== pending.memberId
    ) {
      throw integrityError('pending-leave-snapshot-mismatch');
    }
    if (snapshot.project.hostMemberId === pending.memberId) {
      throw new CollabError({
        code: 'host-transfer-pending',
        safeContext: { reason: 'pending-leave-host-transfer-required' },
      });
    }
    return {
      authorityReplay: {
        expectedHostMemberId: snapshot.project.hostMemberId,
        idempotencyManagerMemberId,
        managerResponsibilityOfferId,
      },
      memberRole: snapshot.currentMember.role,
    };
  }
}

function integrityError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    safeContext: { reason },
  });
}

function storedTrust(record: LanPendingLeaveRecord): CollabTrustedHost {
  return {
    caCertificatePem: record.hostCaCertificatePem,
    caFingerprint: record.hostCaFingerprint,
    endpoint: record.hostEndpoint,
    projectId: record.projectId,
  };
}
