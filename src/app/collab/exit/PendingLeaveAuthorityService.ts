import type {
  PendingLeaveAuthorityReplay,
  PendingLeaveRecord,
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
import type { CollabProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CONTROL_TIMEOUT_MS = 10_000;

export interface PendingLeaveAuthorityClientPort {
  leaveProject(input: LeaveProjectInput): Promise<MembershipTerminationResponse>;
  readSnapshot(
    projectId: string,
    memberCredential: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectSnapshot>;
}

export interface PendingLeaveAuthorityServiceOptions {
  readonly createClient?: (
    record: PendingLeaveRecord,
  ) => PendingLeaveAuthorityClientPort;
  readonly hostTransitionCandidates?: Pick<HostTransitionCandidateResolver, 'resolve'>;
}

export interface PreparePendingLeaveInput {
  readonly managerResponsibilityOfferId?: string;
  readonly pending: PendingLeaveRecord;
  readonly signal?: AbortSignal;
}

export interface PendingLeaveAuthorityPreparation {
  readonly authorityReplay: PendingLeaveAuthorityReplay;
  readonly memberRole: 'manager' | 'member';
}

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
    const { pending } = input;
    if (pending.authorityReplay) {
      return { authorityReplay: pending.authorityReplay, memberRole: pending.localRole };
    }
    return this.readCurrentPreparation(
      pending,
      null,
      input.managerResponsibilityOfferId ?? null,
      input.signal,
    );
  }

  async refresh(input: SettlePendingLeaveInput): Promise<PendingLeaveAuthorityPreparation> {
    return this.readCurrentPreparation(
      input.pending,
      input.pending.authorityReplay?.idempotencyManagerMemberId ?? null,
      input.pending.authorityReplay?.managerResponsibilityOfferId ?? null,
      input.signal,
    );
  }

  async settle(input: SettlePendingLeaveInput): Promise<MembershipTerminationResponse> {
    const { pending } = input;
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

  private async readCurrentPreparation(
    pending: PendingLeaveRecord,
    idempotencyManagerMemberId: string | null,
    managerResponsibilityOfferId: string | null,
    signal?: AbortSignal,
  ): Promise<PendingLeaveAuthorityPreparation> {
    const snapshot = await this.createClient(pending).readSnapshot(
      pending.projectId,
      pending.memberCredential,
      signal ? { signal } : {},
    );
    if (
      snapshot.project.id !== pending.projectId
      || snapshot.currentMember.id !== pending.memberId
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'pending-leave-snapshot-mismatch' },
      });
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

function storedTrust(record: PendingLeaveRecord): CollabTrustedHost {
  return {
    caCertificatePem: record.hostCaCertificatePem,
    caFingerprint: record.hostCaFingerprint,
    endpoint: record.hostEndpoint,
    projectId: record.projectId,
  };
}
