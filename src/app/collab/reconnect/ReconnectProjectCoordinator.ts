import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import type {
  CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { rotateTrustedCollabOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import type { HostTransitionProofClientPort } from '@/app/collab/HostTransitionCandidateResolver';
import {
  type CollabHostTrustStore,
  CollabHttpClient,
  type CollabHttpOperationOptions,
  type CollabTrustedEndpointCandidate,
  type CollabTrustedHost,
  type PinnedCollabHttpClient,
} from '@/app/collab/lan/CollabHttpClient';
import {
  InvitationCodec,
  type LanCollabInvitation,
} from '@/app/collab/lan/InvitationCodec';
import { MembershipControlClient } from '@/app/collab/membership/MembershipControlClient';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { type CollabLocalProjectSummary, type CollabOperationOptions, type CollabReconnectProjectRequest, type CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type ReconnectProjectsPort = Pick<
  CollabLocalProjectRepository,
  'loadMembership' | 'saveMembership'
>;

export interface ReconnectProjectFoundationPort {
  readonly local: {
    readonly projects: ReconnectProjectsPort;
    readonly workspace: Pick<CollabWorkspaceService, 'resolveManagedProjectPath'>;
  };
  requireGitFoundation(): Promise<CollabGitFoundation>;
}

interface ReconnectHttpClientPort {
  bootstrapInvitation(
    invitation: LanCollabInvitation,
    options?: CollabOperationOptions,
  ): Promise<PinnedCollabHttpClient>;
  bootstrapTrustedEndpoint(
    candidate: CollabTrustedEndpointCandidate,
    options?: CollabHttpOperationOptions,
  ): Promise<PinnedCollabHttpClient>;
}

export interface ReconnectDiscoveredProjectRequest {
  readonly candidates: readonly CollabTrustedEndpointCandidate[];
  readonly projectId: string;
}

interface DiscoveredCandidateValidation {
  readonly candidate?: CollabTrustedEndpointCandidate;
  readonly error?: CollabError;
  readonly membership?: CollabLocalLanMembershipRecord;
}

interface HostTrustTransitionVerifierPort {
  verifyChain(input: {
    readonly expectedCurrentCaFingerprint?: string;
    readonly pinnedCaCertificatePem: string;
    readonly projectId: string;
    readonly proofs: readonly CollabHostTrustTransitionProof[];
  }): string;
}

const DISCOVERED_ENDPOINT_TIMEOUT_MS = 2_000;
const MAX_DISCOVERED_CANDIDATES = 8;

export interface ReconnectProjectCoordinatorOptions {
  readonly createHttpClient?: (trustStore: CollabHostTrustStore) => ReconnectHttpClientPort;
  readonly invitationCodec?: InvitationCodec;
  readonly hostTransitionProofClient?: HostTransitionProofClientPort;
  readonly hostTrustTransitionVerifier?: HostTrustTransitionVerifierPort;
  readonly now?: () => Date;
  readonly vaultRoot: string;
}

function reconnectError(
  code:
    | 'authorization-denied'
    | 'authentication-failed'
    | 'authority-integrity-error'
    | 'cancelled'
    | 'endpoint-unreachable'
    | 'membership-revoked'
    | 'operation-failed'
    | 'project-not-found'
    | 'tls-ca-mismatch'
    | 'tls-untrusted',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'tls-ca-mismatch'
      || code === 'tls-untrusted'
      || code === 'authority-integrity-error'
      ? ['open-diagnostics']
      : code === 'authorization-denied'
        || code === 'authentication-failed'
        || code === 'membership-revoked'
        || code === 'project-not-found'
        ? []
        : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw reconnectError('cancelled', 'reconnect-cancelled');
  }
}

function remoteUrl(endpoint: string, projectId: string): string {
  return `${endpoint}/v1/git/${projectId}/repository.git`;
}

function summary(record: CollabLocalLanMembershipRecord): CollabLocalProjectSummary {
  return {
    authorityKind: record.authority.kind,
    connectionStatus: 'connected',
    health: 'healthy',
    hostStatus: record.hostOwnership.ownsAuthority ? 'stopped' : 'not-host',
    id: record.project.id,
    name: record.project.name,
    role: record.member.role,
    workspacePath: record.project.workspacePath,
  };
}

class ReconnectTrustStore implements CollabHostTrustStore {
  constructor(
    private readonly membership: CollabLocalLanMembershipRecord,
    private readonly candidate: CollabTrustedEndpointCandidate,
  ) {}

  read(projectId: string): Promise<CollabTrustedHost | null> {
    if (projectId !== this.membership.project.id) return Promise.resolve(null);
    const authority = this.membership.authority;
    if (
      !authority.endpoint
      || !authority.hostCaCertificatePem
      || !authority.hostCaFingerprint
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      caCertificatePem: authority.hostCaCertificatePem,
      caFingerprint: authority.hostCaFingerprint,
      endpoint: authority.endpoint,
      projectId,
    });
  }

  save(trust: CollabTrustedHost): Promise<'ca-mismatch' | 'saved'> {
    const authority = this.membership.authority;
    const valid = trust.projectId === this.membership.project.id
      && trust.projectId === this.candidate.projectId
      && trust.endpoint === this.candidate.endpoint
      && trust.caFingerprint === this.candidate.caFingerprint
      && trust.caFingerprint === authority.hostCaFingerprint
      && trust.caCertificatePem === authority.hostCaCertificatePem;
    return Promise.resolve(valid ? 'saved' : 'ca-mismatch');
  }
}

export class ReconnectProjectCoordinator {
  private readonly createHttpClient: (
    trustStore: CollabHostTrustStore,
  ) => ReconnectHttpClientPort;
  private readonly invitationCodec: InvitationCodec;
  private readonly hostTransitionProofClient: HostTransitionProofClientPort | null;
  private readonly hostTrustTransitionVerifier: HostTrustTransitionVerifierPort;
  private readonly now: () => Date;
  private readonly operationQueue = new SerialTaskQueue();

  constructor(
    private readonly foundation: ReconnectProjectFoundationPort,
    private readonly options: ReconnectProjectCoordinatorOptions,
  ) {
    this.invitationCodec = options.invitationCodec ?? new InvitationCodec();
    this.hostTransitionProofClient = options.hostTransitionProofClient ?? null;
    this.hostTrustTransitionVerifier = options.hostTrustTransitionVerifier
      ?? new HostTrustTransitionService();
    this.createHttpClient = options.createHttpClient
      ?? (trustStore => new CollabHttpClient(trustStore, {
        invitationCodec: this.invitationCodec,
      }));
    this.now = options.now ?? (() => new Date());
  }

  reconnectProject(
    request: CollabReconnectProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.operationQueue.run(() => this.reconnectProjectUnlocked(request, options));
  }

  reconnectDiscoveredProject(
    request: ReconnectDiscoveredProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.operationQueue.run(
      () => this.reconnectDiscoveredProjectUnlocked(request, options),
    );
  }

  private async reconnectProjectUnlocked(
    request: CollabReconnectProjectRequest,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    try {
      throwIfCancelled(options.signal);
      const invitation = this.invitationCodec.decode(request.encodedInvitation.trim());
      if (invitation.projectId !== request.projectId) {
        throw reconnectError('project-not-found', 'reconnect-project-mismatch');
      }
      const membership = await this.loadReconnectMembership(request.projectId, invitation);
      if (membership.authority.hostCaFingerprint !== invitation.caFingerprint) {
        throw reconnectError('tls-ca-mismatch', 'reconnect-ca-mismatch');
      }
      throwIfCancelled(options.signal);
      const http = this.createHttpClient(new ReconnectTrustStore(
        membership,
        invitation,
      ));
      const pinned = await http.bootstrapInvitation(invitation, options);
      const refreshed = await new MembershipControlClient(pinned).refreshEndpoint({
        invitation,
        memberCredential: membership.member.credential,
        projectId: membership.project.id,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (
        refreshed.endpoint !== invitation.endpoint
        || refreshed.caFingerprint !== invitation.caFingerprint
      ) {
        throw reconnectError('operation-failed', 'reconnect-response-mismatch');
      }
      return await this.commitReconnect(membership, invitation, options);
    } catch (error) {
      return this.failure(error);
    }
  }

  private async reconnectDiscoveredProjectUnlocked(
    request: ReconnectDiscoveredProjectRequest,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    try {
      throwIfCancelled(options.signal);
      if (
        request.candidates.length === 0
        || request.candidates.length > MAX_DISCOVERED_CANDIDATES
      ) {
        throw reconnectError('operation-failed', 'reconnect-candidate-count-invalid');
      }
      const candidates = this.normalizeDiscoveredCandidates(request);
      const membership = await this.loadReconnectMembership(
        request.projectId,
        candidates[0],
      );
      const validations = await Promise.all(candidates.map(candidate => (
        this.validateDiscoveredCandidate(membership, candidate, options)
      )));
      throwIfCancelled(options.signal);
      const valid = validations.flatMap(result => (
        result.candidate ? [result.candidate] : []
      ));
      const authorityErrors = validations.flatMap(result => (
        result.error && this.isAuthorityError(result.error) ? [result.error] : []
      ));
      if (valid.length > 1 || (valid.length === 1 && authorityErrors.length > 0)) {
        throw reconnectError(
          'authority-integrity-error',
          'multiple-host-endpoints-confirmed',
        );
      }
      if (valid.length === 0) {
        if (authorityErrors[0]) throw authorityErrors[0];
        throw reconnectError('endpoint-unreachable', 'discovered-endpoint-unverified');
      }
      const selected = validations.find(result => result.candidate === valid[0]);
      if (!selected?.membership) {
        throw reconnectError('operation-failed', 'reconnect-trust-transition-missing');
      }
      return await this.commitReconnect(selected.membership, valid[0], options);
    } catch (error) {
      return this.failure(error);
    }
  }

  private isAuthorityError(error: CollabError): boolean {
    return error.code === 'authentication-failed'
      || error.code === 'authorization-denied'
      || error.code === 'membership-revoked'
      || error.code === 'tls-ca-mismatch'
      || error.code === 'tls-untrusted';
  }

  private normalizeDiscoveredCandidates(
    request: ReconnectDiscoveredProjectRequest,
  ): readonly CollabTrustedEndpointCandidate[] {
    const candidates = new Map<string, CollabTrustedEndpointCandidate>();
    for (const candidate of request.candidates) {
      if (candidate.projectId !== request.projectId) {
        throw reconnectError('project-not-found', 'reconnect-project-mismatch');
      }
      const endpoint = this.invitationCodec.normalizeEndpoint(candidate.endpoint);
      candidates.set(endpoint, { ...candidate, endpoint });
    }
    return [...candidates.values()];
  }

  private async validateDiscoveredCandidate(
    membership: CollabLocalLanMembershipRecord,
    candidate: CollabTrustedEndpointCandidate,
    options: CollabOperationOptions,
  ): Promise<DiscoveredCandidateValidation> {
    try {
      const trustedMembership = await this.resolveCandidateTrust(
        membership,
        candidate,
        options,
      );
      throwIfCancelled(options.signal);
      const http = this.createHttpClient(new ReconnectTrustStore(
        trustedMembership,
        candidate,
      ));
      const requestOptions: CollabHttpOperationOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DISCOVERED_ENDPOINT_TIMEOUT_MS,
      };
      const pinned = await http.bootstrapTrustedEndpoint(candidate, requestOptions);
      const confirmed = await new MembershipControlClient(pinned).confirmEndpoint({
        caFingerprint: candidate.caFingerprint,
        endpoint: candidate.endpoint,
        memberCredential: trustedMembership.member.credential,
        projectId: trustedMembership.project.id,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DISCOVERED_ENDPOINT_TIMEOUT_MS,
      });
      if (
        confirmed.endpoint !== candidate.endpoint
        || confirmed.caFingerprint !== candidate.caFingerprint
      ) {
        throw reconnectError('operation-failed', 'reconnect-response-mismatch');
      }
      return { candidate, membership: trustedMembership };
    } catch (error) {
      return {
        error: error instanceof CollabError
          ? error
          : reconnectError('endpoint-unreachable', 'discovered-endpoint-unverified'),
      };
    }
  }

  private async resolveCandidateTrust(
    membership: CollabLocalLanMembershipRecord,
    candidate: CollabTrustedEndpointCandidate,
    options: CollabOperationOptions,
  ): Promise<CollabLocalLanMembershipRecord> {
    const authority = membership.authority;
    if (candidate.caFingerprint === authority.hostCaFingerprint) return membership;
    if (
      !authority.hostCaCertificatePem
      || !authority.hostCaFingerprint
      || !this.hostTransitionProofClient
    ) {
      throw reconnectError('tls-ca-mismatch', 'reconnect-ca-mismatch');
    }
    const proofs = await this.hostTransitionProofClient.fetchHostTransitions(candidate, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: DISCOVERED_ENDPOINT_TIMEOUT_MS,
    });
    throwIfCancelled(options.signal);
    const currentCaCertificatePem = this.hostTrustTransitionVerifier.verifyChain({
      expectedCurrentCaFingerprint: candidate.caFingerprint,
      pinnedCaCertificatePem: authority.hostCaCertificatePem,
      projectId: membership.project.id,
      proofs,
    });
    return {
      ...membership,
      authority: {
        ...authority,
        hostCaCertificatePem: currentCaCertificatePem,
        hostCaFingerprint: candidate.caFingerprint,
      },
    };
  }

  private async loadReconnectMembership(
    projectId: string,
    candidate: CollabTrustedEndpointCandidate,
  ): Promise<CollabLocalLanMembershipRecord> {
    if (candidate.projectId !== projectId) {
      throw reconnectError('project-not-found', 'reconnect-project-mismatch');
    }
    const membership = await this.foundation.local.projects.loadMembership(projectId);
    if (!membership || !isCollabLocalLanMembership(membership)) {
      throw reconnectError('project-not-found', 'reconnect-membership-missing');
    }
    if (membership.hostOwnership.ownsAuthority) {
      throw reconnectError('authorization-denied', 'host-project-reconnect-not-supported');
    }
    const authority = membership.authority;
    if (
      !authority.endpoint
      || !authority.gitRemoteUrl
      || !authority.hostCaCertificatePem
      || !authority.hostCaFingerprint
    ) {
      throw reconnectError('tls-untrusted', 'reconnect-trust-missing');
    }
    return membership;
  }

  private async commitReconnect(
    membership: CollabLocalLanMembershipRecord,
    candidate: CollabTrustedEndpointCandidate,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    throwIfCancelled(options.signal);
    const git = await this.foundation.requireGitFoundation();
    const repositoryPath = await this.foundation.local.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    );
    await git.repositories.assertLocalRepositoryIdentity(repositoryPath, {
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId: membership.project.id,
    });
    const authority = membership.authority;
    const gitRemoteUrl = remoteUrl(candidate.endpoint, candidate.projectId);
    await rotateTrustedCollabOrigin(git.repositories, {
      newRemoteUrl: gitRemoteUrl,
      oldRemoteUrl: authority.gitRemoteUrl!,
      projectId: membership.project.id,
      repositoryPath,
    });
    const updated: CollabLocalLanMembershipRecord = {
      ...membership,
      authority: {
        ...authority,
        endpoint: candidate.endpoint,
        gitRemoteUrl,
        hostCaCertificatePem: authority.hostCaCertificatePem,
        hostCaFingerprint: candidate.caFingerprint,
      },
      updatedAt: this.now().toISOString(),
    };
    await this.foundation.local.projects.saveMembership(updated);
    return { status: 'success', value: summary(updated) };
  }

  private failure(error: unknown): CollabResult<CollabLocalProjectSummary> {
    if (error instanceof CollabError && error.code === 'cancelled') {
      return { durableProgress: false, status: 'cancelled' };
    }
    return {
      error: error instanceof CollabError
        ? error
        : reconnectError('operation-failed', 'reconnect-project-failed'),
      status: 'failure',
    };
  }
}
