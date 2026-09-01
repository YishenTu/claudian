import { randomUUID } from 'node:crypto';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
} from '@claudian-collab/protocol';

import type {
  AuthorityProjectionTransitionPort,
} from '@/app/collab/AuthorityProjectionTransitionCoordinator';
import type { CollabGitFoundation } from '@/app/collab/ClaudianCollabService';
import type {
  CollabLocalCloudMembershipRecord,
  CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import {
  rotateCloudRelocationOrigin,
  rotateTrustedCollabOrigin,
} from '@/app/collab/git/CollabGitOriginPolicy';
import type { HostInstallationBindingService } from '@/app/collab/host-installation/HostInstallationBindingService';
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
import { decodeCloudManagementIntent } from '@/app/collab/membership/CloudManagementIntent';
import { MembershipControlClient } from '@/app/collab/membership/MembershipControlClient';
import { decodeCollabPendingProjectOperation } from '@/app/collab/PendingProjectOperation';
import {
  type CloudRelocationRecord,
  decodeCloudRelocationRecord,
} from '@/app/collab/reconnect/CloudRelocationRecord';
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import {
  cloudProjectGitRemoteUrl,
  validateCloudServerUrl,
} from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { type CollabLocalProjectSummary, type CollabOperationOptions, type CollabReconnectProjectRequest, type CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { toError } from '@/utils/error';

type ReconnectProjectsPort = Pick<
  CollabLocalProjectRepository,
  | 'listPendingOperationProjectIds'
  | 'loadMembership'
  | 'loadProjectDocument'
  | 'removeProjectDocument'
  | 'saveMembership'
  | 'saveProjectDocument'
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
  readonly expectedMembership?: CollabLocalLanMembershipRecord;
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
  readonly authorityProjectionTransitions: AuthorityProjectionTransitionPort;
  readonly cloudRelocation?: CloudRelocationOptions;
  readonly createHttpClient?: (trustStore: CollabHostTrustStore) => ReconnectHttpClientPort;
  readonly invitationCodec?: InvitationCodec;
  readonly hostTransitionProofClient?: HostTransitionProofClientPort;
  readonly hostTrustTransitionVerifier?: HostTrustTransitionVerifierPort;
  readonly hostInstallation: Pick<HostInstallationBindingService, 'inspect'>;
  readonly now?: () => Date;
  readonly vaultRoot: string;
}

export interface CloudRelocationActivityPort {
  activate(projectId: string, options?: CollabOperationOptions): Promise<void>;
  resume(projectId: string): Promise<void>;
  suspend(projectId: string): Promise<void>;
}

export interface CloudRelocationOptions {
  readonly activity: CloudRelocationActivityPort;
  readonly admit?: <T>(
    projectId: string,
    mode: 'continuation' | 'operation' | 'recovery',
    operation: () => Promise<T>,
  ) => Promise<T>;
  connect(
    binding: { readonly projectId: string; readonly serverUrl: string },
    options?: CollabOperationOptions,
  ): Promise<CloudAuthorityConnection>;
  readonly createOperationId?: () => string;
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

function summary(
  record: CollabLocalLanMembershipRecord,
  installationStatus: Awaited<ReturnType<HostInstallationBindingService['inspect']>>,
): CollabLocalProjectSummary {
  return {
    authorityKind: record.authority.kind,
    connectionStatus: 'connected',
    health: 'healthy',
    hostInstallationStatus: record.hostOwnership.ownsAuthority
      ? installationStatus === 'absent' ? 'not-host' : installationStatus
      : 'not-host',
    hostStatus: 'not-host',
    id: record.project.id,
    name: record.project.name,
    role: record.member.role,
    workspacePath: record.project.workspacePath,
  };
}

function cloudSummary(record: CollabLocalCloudMembershipRecord): CollabLocalProjectSummary {
  return {
    authorityKind: 'cloud',
    connectionStatus: 'connected',
    health: 'healthy',
    hostInstallationStatus: 'not-host',
    hostStatus: 'not-host',
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
  private cloudRelocation: CloudRelocationOptions | null;
  private createCloudRelocationOperationId: () => string;
  private readonly createHttpClient: (
    trustStore: CollabHostTrustStore,
  ) => ReconnectHttpClientPort;
  private readonly invitationCodec: InvitationCodec;
  private readonly hostTransitionProofClient: HostTransitionProofClientPort | null;
  private readonly hostTrustTransitionVerifier: HostTrustTransitionVerifierPort;
  private readonly now: () => Date;

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
    this.cloudRelocation = options.cloudRelocation ?? null;
    this.createCloudRelocationOperationId = options.cloudRelocation?.createOperationId
      ?? (() => `relocate-${randomUUID()}`);
  }

  bindCloudRelocation(options: CloudRelocationOptions): void {
    if (this.cloudRelocation) throw new Error('Cloud relocation is already bound');
    this.cloudRelocation = options;
    this.createCloudRelocationOperationId = options.createOperationId
      ?? (() => `relocate-${randomUUID()}`);
  }

  async resumeCloudRelocations(
    options: CollabOperationOptions = {},
  ): Promise<void> {
    let firstFailure: unknown = null;
    for (const projectId of await this.foundation.local.projects.listPendingOperationProjectIds()) {
      throwIfCancelled(options.signal);
      try {
        const pending = await this.foundation.local.projects.loadProjectDocument(
          projectId,
          'pending-operation',
          decodeCollabPendingProjectOperation,
        );
        if (pending?.kind !== 'cloud-relocation') continue;
        const operation = () => this.continueCloudRelocation(pending.record, options);
        const result = this.cloudRelocation?.admit
          ? await this.cloudRelocation.admit(projectId, 'recovery', operation)
          : await operation();
        if (result.status !== 'success') {
          throw result.status === 'failure' || result.status === 'recovery-required'
            ? result.error
            : reconnectError('cancelled', 'cloud-relocation-recovery-cancelled');
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        firstFailure ??= error;
      }
    }
    if (firstFailure !== null) {
      throw toError(firstFailure, 'Cloud relocation recovery failed.');
    }
  }

  reconnectProject(
    request: CollabReconnectProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.reconnectProjectUnlocked(request, options);
  }

  reconnectDiscoveredProject(
    request: ReconnectDiscoveredProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.reconnectDiscoveredProjectUnlocked(request, options);
  }

  private async reconnectProjectUnlocked(
    request: CollabReconnectProjectRequest,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    if ('authority' in request) {
      try {
        const pending = await this.foundation.local.projects.loadProjectDocument(
          request.projectId,
          'pending-operation',
          decodeCollabPendingProjectOperation,
        );
        const mode = pending?.kind === 'cloud-relocation'
          ? 'continuation' as const
          : 'operation' as const;
        const operation = () => this.reconnectCloudProjectUnlocked(request, options);
        return this.cloudRelocation?.admit
          ? await this.cloudRelocation.admit(request.projectId, mode, operation)
          : await operation();
      } catch (error) {
        return this.failure(error);
      }
    }
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
      return await this.commitReconnect(membership, membership, invitation, options);
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
      if (!selected.expectedMembership) {
        throw reconnectError('operation-failed', 'reconnect-projection-generation-missing');
      }
      return await this.commitReconnect(
        selected.expectedMembership,
        selected.membership,
        valid[0],
        options,
      );
    } catch (error) {
      return this.failure(error);
    }
  }

  private async reconnectCloudProjectUnlocked(
    request: Extract<CollabReconnectProjectRequest, { readonly authority: unknown }>,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    try {
      throwIfCancelled(options.signal);
      const relocation = this.requireCloudRelocation();
      const pending = await this.foundation.local.projects.loadProjectDocument(
        request.projectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      if (pending) {
        if (
          pending.kind !== 'cloud-relocation'
          || pending.record.newAuthority.serverUrl !== request.authority.serverUrl
        ) throw reconnectError('operation-failed', 'cloud-relocation-pending-mismatch');
        return this.continueCloudRelocation(pending.record, options);
      }
      const membership = await this.foundation.local.projects.loadMembership(request.projectId);
      if (!membership || !isCollabLocalCloudMembership(membership)) {
        throw reconnectError('project-not-found', 'cloud-relocation-membership-missing');
      }
      const serverUrl = validateCloudServerUrl(
        request.authority.serverUrl,
        'serverUrl',
      );
      if (serverUrl === membership.authority.serverUrl) {
        throw reconnectError('operation-failed', 'cloud-relocation-endpoint-unchanged');
      }
      const connection = await relocation.connect({
        projectId: request.projectId,
        serverUrl,
      }, options);
      let record: CloudRelocationRecord;
      try {
        const snapshot = await connection.readSnapshot(
          request.projectId,
          options.signal ? { signal: options.signal } : {},
        );
        const expectedRemoteUrl = cloudProjectGitRemoteUrl(serverUrl, request.projectId);
        if (
          connection.projectId !== request.projectId
          || connection.serverUrl !== serverUrl
          || connection.git.remoteUrl !== expectedRemoteUrl
          || snapshot.project.id !== request.projectId
          || snapshot.project.authorityGeneration
            !== membership.authority.authorityGeneration
          || snapshot.currentMember.status !== 'active'
          || snapshot.currentMember.id !== membership.member.id
          || snapshot.currentMember.personalRef !== membership.member.personalRef
        ) throw reconnectError(
          'authority-integrity-error',
          'cloud-relocation-candidate-mismatch',
        );
        const timestamp = this.now().toISOString();
        record = decodeCloudRelocationRecord({
          authorityGeneration: membership.authority.authorityGeneration,
          createdAt: timestamp,
          memberId: membership.member.id,
          newAuthority: {
            bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
            gitRemoteUrl: expectedRemoteUrl,
            serverUrl,
            wireVersion: COLLAB_PROTOCOL_VERSION,
          },
          oldAuthority: {
            bindingVersion: membership.authority.bindingVersion,
            gitRemoteUrl: membership.authority.gitRemoteUrl,
            serverUrl: membership.authority.serverUrl,
            wireVersion: membership.authority.wireVersion,
          },
          operationId: this.createCloudRelocationOperationId(),
          operationKind: 'cloud-relocation',
          personalRef: membership.member.personalRef,
          phase: 'prepared',
          projectId: request.projectId,
          schemaVersion: 1,
          updatedAt: timestamp,
        });
      } finally {
        connection.dispose();
      }
      await relocation.activity.suspend(record.projectId);
      try {
        const managementIntent = await this.foundation.local.projects.loadProjectDocument(
          record.projectId,
          'cloud-management-intent',
          decodeCloudManagementIntent,
        );
        if (managementIntent) {
          throw reconnectError(
            'operation-failed',
            'cloud-relocation-management-pending',
          );
        }
        await this.foundation.local.projects.saveProjectDocument(
          record.projectId,
          'pending-operation',
          record,
        );
      } catch (error) {
        await relocation.activity.resume(record.projectId);
        throw error;
      }
      return this.continueCloudRelocation(record, options, true);
    } catch (error) {
      return this.failure(error);
    }
  }

  private async continueCloudRelocation(
    initial: CloudRelocationRecord,
    options: CollabOperationOptions,
    alreadySuspended = false,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    const relocation = this.requireCloudRelocation();
    let record = initial;
    try {
      throwIfCancelled(options.signal);
      if (!alreadySuspended) await relocation.activity.suspend(record.projectId);
      return await this.options.authorityProjectionTransitions.run(
        record.projectId,
        async () => {
          let membership = await this.requireCloudRelocationMembership(record);
          const git = await this.foundation.requireGitFoundation();
          const repositoryPath = await this.foundation.local.workspace.resolveManagedProjectPath(
            membership.project.workspacePath,
          );
          await git.repositories.assertLocalRepositoryIdentity(repositoryPath, {
            memberId: record.memberId,
            personalRef: record.personalRef,
            projectId: record.projectId,
          });
          if (record.phase === 'prepared') {
            this.assertCloudRelocationBinding(membership, record.oldAuthority);
            await rotateCloudRelocationOrigin(git.repositories, {
              newRemoteUrl: record.newAuthority.gitRemoteUrl,
              newServerUrl: record.newAuthority.serverUrl,
              oldRemoteUrl: record.oldAuthority.gitRemoteUrl,
              oldServerUrl: record.oldAuthority.serverUrl,
              projectId: record.projectId,
              repositoryPath,
            });
            record = await this.updateCloudRelocation(record, 'origin-updated');
          }
          membership = await this.requireCloudRelocationMembership(record);
          if (record.phase === 'origin-updated') {
            if (this.matchesCloudRelocationBinding(membership, record.oldAuthority)) {
              membership = {
                ...membership,
                authority: {
                  authorityGeneration: record.authorityGeneration,
                  bindingVersion: record.newAuthority.bindingVersion,
                  gitRemoteUrl: record.newAuthority.gitRemoteUrl,
                  kind: 'cloud',
                  serverUrl: record.newAuthority.serverUrl,
                  wireVersion: record.newAuthority.wireVersion,
                },
                updatedAt: this.now().toISOString(),
              };
              await this.foundation.local.projects.saveMembership(membership);
            } else {
              this.assertCloudRelocationBinding(membership, record.newAuthority);
            }
            record = await this.updateCloudRelocation(record, 'membership-updated');
          }
          membership = await this.requireCloudRelocationMembership(record);
          this.assertCloudRelocationBinding(membership, record.newAuthority);
          await relocation.activity.activate(record.projectId, options);
          await relocation.activity.resume(record.projectId);
          await this.foundation.local.projects.removeProjectDocument(
            record.projectId,
            'pending-operation',
          );
          return { status: 'success' as const, value: cloudSummary(membership) };
        },
      );
    } catch (error) {
      return {
        durablePhase: 'committed',
        durableProgress: true,
        error: error instanceof CollabError
          ? error
          : reconnectError('operation-failed', 'cloud-relocation-incomplete'),
        operationId: record.operationId,
        status: 'recovery-required',
      };
    }
  }

  private requireCloudRelocation(): CloudRelocationOptions {
    if (!this.cloudRelocation) {
      throw reconnectError('operation-failed', 'cloud-relocation-unavailable');
    }
    return this.cloudRelocation;
  }

  private async requireCloudRelocationMembership(
    record: CloudRelocationRecord,
  ): Promise<CollabLocalCloudMembershipRecord> {
    const membership = await this.foundation.local.projects.loadMembership(record.projectId);
    if (
      !membership
      || !isCollabLocalCloudMembership(membership)
      || membership.project.id !== record.projectId
      || membership.member.id !== record.memberId
      || membership.member.personalRef !== record.personalRef
      || membership.authority.authorityGeneration !== record.authorityGeneration
    ) throw reconnectError(
      'authority-integrity-error',
      'cloud-relocation-local-identity-mismatch',
    );
    return membership;
  }

  private matchesCloudRelocationBinding(
    membership: CollabLocalCloudMembershipRecord,
    binding: CloudRelocationRecord['oldAuthority'],
  ): boolean {
    return membership.authority.kind === 'cloud'
      && membership.authority.bindingVersion === binding.bindingVersion
      && membership.authority.gitRemoteUrl === binding.gitRemoteUrl
      && membership.authority.serverUrl === binding.serverUrl
      && membership.authority.wireVersion === binding.wireVersion;
  }

  private assertCloudRelocationBinding(
    membership: CollabLocalCloudMembershipRecord,
    binding: CloudRelocationRecord['oldAuthority'],
  ): void {
    if (!this.matchesCloudRelocationBinding(membership, binding)) {
      throw reconnectError(
        'authority-integrity-error',
        'cloud-relocation-local-binding-mismatch',
      );
    }
  }

  private async updateCloudRelocation(
    record: CloudRelocationRecord,
    phase: CloudRelocationRecord['phase'],
  ): Promise<CloudRelocationRecord> {
    const updated = decodeCloudRelocationRecord({
      ...record,
      phase,
      updatedAt: this.now().toISOString(),
    });
    await this.foundation.local.projects.saveProjectDocument(
      record.projectId,
      'pending-operation',
      updated,
    );
    return updated;
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
      return { candidate, expectedMembership: membership, membership: trustedMembership };
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
    expectedMembership: CollabLocalLanMembershipRecord,
    membership: CollabLocalLanMembershipRecord,
    candidate: CollabTrustedEndpointCandidate,
    options: CollabOperationOptions,
  ): Promise<CollabResult<CollabLocalProjectSummary>> {
    return this.options.authorityProjectionTransitions.run(membership.project.id, async () => {
      throwIfCancelled(options.signal);
      const current = await this.foundation.local.projects.loadMembership(membership.project.id);
      if (JSON.stringify(current) !== JSON.stringify(expectedMembership)) {
        throw reconnectError('endpoint-unreachable', 'reconnect-projection-changed');
      }
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
      const installationStatus = updated.hostOwnership.ownsAuthority
        ? await this.options.hostInstallation.inspect(updated.project.id)
        : 'absent';
      return { status: 'success' as const, value: summary(updated, installationStatus) };
    });
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
