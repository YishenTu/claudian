import type { CollabLanDiscoveryPort } from '@/app/collab/discovery/CollabLanDiscoveryService';
import type {
  PendingLeaveAuthorityReplay,
  PendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';
import type { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import {
  type CollabTrustedEndpointCandidate,
  type CollabTrustedHost,
  PinnedCollabHttpClient,
} from '@/app/collab/lan/CollabHttpClient';
import type { MembershipTerminationResponse } from '@/app/collab/lan/LanCollabControlOperations';
import {
  type LeaveProjectInput,
  MembershipControlClient,
} from '@/app/collab/membership/MembershipControlClient';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';
import type {
  HostTransitionProofClientPort,
} from '@/app/collab/reconnect/ReconnectProjectCoordinator';
import type { CollabProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CONTROL_TIMEOUT_MS = 10_000;
const DISCOVERED_ENDPOINT_TIMEOUT_MS = 2_000;
const REDISCOVERY_CODES = new Set([
  'endpoint-unreachable',
  'host-stopped',
  'local-network-permission-required',
  'offline',
  'operation-timeout',
  'tls-ca-mismatch',
  'tls-untrusted',
]);

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
    trust?: CollabTrustedHost,
  ) => PendingLeaveAuthorityClientPort;
  readonly discovery?: Pick<
    CollabLanDiscoveryPort,
    'discoverProjectCandidatesForTrustTransition'
  >;
  readonly proofClient?: HostTransitionProofClientPort;
  readonly trustTransitions?: Pick<HostTrustTransitionService, 'verifyChain'>;
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

interface VerifiedCandidate {
  readonly caCertificatePem: string;
  readonly candidate: CollabTrustedEndpointCandidate;
}

export class PendingLeaveAuthorityService {
  private readonly createClient: NonNullable<PendingLeaveAuthorityServiceOptions['createClient']>;

  constructor(private readonly options: PendingLeaveAuthorityServiceOptions = {}) {
    this.createClient = options.createClient ?? ((record, trust) => {
      const transport = new PinnedCollabHttpClient(trust ?? storedTrust(record), CONTROL_TIMEOUT_MS);
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
    return this.withTrustedClient(pending, client => client.leaveProject({
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
    }), input.signal);
  }

  private async readCurrentPreparation(
    pending: PendingLeaveRecord,
    idempotencyManagerMemberId: string | null,
    managerResponsibilityOfferId: string | null,
    signal?: AbortSignal,
  ): Promise<PendingLeaveAuthorityPreparation> {
    const snapshot = await this.withTrustedClient(pending, client => client.readSnapshot(
      pending.projectId,
      pending.memberCredential,
      signal ? { signal } : {},
    ), signal);
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

  private async withTrustedClient<T>(
    pending: PendingLeaveRecord,
    operation: (client: PendingLeaveAuthorityClientPort) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await operation(this.createClient(pending));
    } catch (error) {
      if (!(error instanceof CollabError) || !REDISCOVERY_CODES.has(error.code)) throw error;
      if (!this.options.discovery || !this.options.proofClient || !this.options.trustTransitions) {
        throw error;
      }
    }
    const verified = await this.discover(pending, signal);
    return operation(this.createClient(pending, {
      caCertificatePem: verified.caCertificatePem,
      caFingerprint: verified.candidate.caFingerprint,
      endpoint: verified.candidate.endpoint,
      projectId: pending.projectId,
    }));
  }

  private async discover(
    pending: PendingLeaveRecord,
    signal?: AbortSignal,
  ): Promise<VerifiedCandidate> {
    const { discovery, proofClient, trustTransitions } = this.options;
    if (!discovery || !proofClient || !trustTransitions) {
      throw new CollabError({ code: 'endpoint-unreachable', recoveryActions: ['retry'] });
    }
    const candidates = await discovery.discoverProjectCandidatesForTrustTransition(
      pending.projectId,
      signal ? { signal } : {},
    );
    const verified = (await Promise.all(candidates.map(async candidate => {
      if (candidate.projectId !== pending.projectId) return null;
      try {
        const proofs = await proofClient.fetchHostTransitions(candidate, {
          ...(signal ? { signal } : {}),
          timeoutMs: DISCOVERED_ENDPOINT_TIMEOUT_MS,
        });
        return {
          caCertificatePem: trustTransitions.verifyChain({
            expectedCurrentCaFingerprint: candidate.caFingerprint,
            pinnedCaCertificatePem: pending.hostCaCertificatePem,
            projectId: pending.projectId,
            proofs,
          }),
          candidate,
        } satisfies VerifiedCandidate;
      } catch {
        return null;
      }
    }))).flatMap(candidate => candidate ? [candidate] : []);
    if (verified.length !== 1) {
      throw new CollabError({
        code: verified.length > 1 ? 'authority-integrity-error' : 'endpoint-unreachable',
        recoveryActions: verified.length > 1 ? ['open-diagnostics'] : ['retry'],
        safeContext: {
          reason: verified.length > 1
            ? 'multiple-pending-leave-authorities-confirmed'
            : 'pending-leave-authority-unavailable',
        },
      });
    }
    return verified[0];
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
