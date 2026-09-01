import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityTransferStatus,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  AuthorityTransferImportedTargetIdentity,
} from '@/app/collab/authority-transfer/AuthorityTransferImportedTargetIdentity';
import type {
  AuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  authorityTransferClaimantStatus,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import type {
  AuthorityProjectionTransitionPort,
} from '@/app/collab/AuthorityProjectionTransitionCoordinator';
import type {
  CollabLocalLanMembershipRecord,
  CollabLocalMembershipRecord,
  CollabLocalProjectIndex,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  cloudProjectGitRemoteUrl,
  validateCloudServerUrl,
} from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface AuthorityTransferConvergenceProjects {
  loadMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord | null>;
  repairIndexFromMemberships(): Promise<CollabLocalProjectIndex>;
  saveMembership(record: CollabLocalMembershipRecord): Promise<void>;
}

interface AuthorityTransferConvergenceWorkspace {
  resolveManagedProjectPath(workspacePath: string): Promise<string>;
}

interface AuthorityTransferConvergenceGit {
  rotate(input: {
    readonly newRemoteUrl: string;
    readonly newServerUrl: string | null;
    readonly oldRemoteUrl: string;
    readonly oldServerUrl: string | null;
    readonly projectId: CollabProjectId;
    readonly repositoryPath: string;
  }): Promise<void>;
}

export interface AuthorityTransferLocalConvergenceOptions {
  readonly activity: {
    transitionProject(projectId: CollabProjectId, operation: () => Promise<void>): Promise<void>;
  };
  readonly authorityProjectionTransitions: AuthorityProjectionTransitionPort;
  readonly git: AuthorityTransferConvergenceGit;
  readonly now?: () => Date;
  readonly projects: AuthorityTransferConvergenceProjects;
  readonly workspace: AuthorityTransferConvergenceWorkspace;
}

export interface LanToCloudHostConvergenceInput {
  readonly snapshot: CollabProjectSnapshot;
  readonly status: CollabAuthorityTransferStatus;
}

type LanToCloudMemberProjection = Pick<
  CollabProjectSnapshot['currentMember'],
  'displayName' | 'id' | 'personalRef' | 'role'
>;

export interface CloudToLanHostConvergenceInput {
  readonly endpoint: string;
  readonly hostCaCertificatePem: string;
  readonly hostCaFingerprint: string;
  readonly identity: AuthorityTransferImportedTargetIdentity;
  readonly memberCredential: string;
  readonly status: CollabAuthorityTransferStatus;
}

function convergenceError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function lanRemoteUrl(endpoint: string, projectId: CollabProjectId): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw convergenceError('authority-transfer-target-endpoint-invalid');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.port.length === 0
  ) throw convergenceError('authority-transfer-target-endpoint-invalid');
  return `${parsed.origin}/v1/git/${projectId}/repository.git`;
}

function cloudRemoteUrl(serverUrl: string, projectId: CollabProjectId): string {
  try {
    return cloudProjectGitRemoteUrl(serverUrl, projectId);
  } catch {
    throw convergenceError('authority-transfer-cloud-url-invalid');
  }
}

function assertCompleted(
  status: CollabAuthorityTransferStatus,
  direction: CollabAuthorityTransferStatus['direction'],
): void {
  if (
    status.direction !== direction
    || status.phase !== 'completed'
    || status.state !== 'completed'
    || status.relinquishmentProof === null
  ) throw convergenceError('authority-transfer-convergence-status-incomplete');
}

function assertSnapshot(
  membership: CollabLocalMembershipRecord,
  snapshot: CollabProjectSnapshot,
): void {
  if (
    snapshot.project.id !== membership.project.id
    || snapshot.project.name !== membership.project.name
    || snapshot.currentMember.id !== membership.member.id
    || snapshot.currentMember.personalRef !== membership.member.personalRef
  ) throw convergenceError('authority-transfer-convergence-snapshot-mismatch');
}

export class AuthorityTransferLocalConvergence {
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityTransferLocalConvergenceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async lanToCloudHost(input: LanToCloudHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'lan-to-cloud');
    return this.transitionProject(
      input.status.projectId,
      () => this.lanToCloud(input, true),
    );
  }

  async lanToCloudHostOffline(status: CollabAuthorityTransferStatus): Promise<void> {
    assertCompleted(status, 'lan-to-cloud');
    return this.transitionProject(status.projectId, async () => {
      const membership = await this.requireMembership(status.projectId);
      if (status.relinquishmentProof?.sourceHostMemberId !== membership.member.id) {
        throw convergenceError('authority-transfer-source-member-mismatch');
      }
      await this.convergeLanMembershipToCloud(
        membership,
        status,
        membership.member,
        membership.lastEventSequence,
        true,
      );
    });
  }

  async lanToCloudMember(input: LanToCloudHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'lan-to-cloud');
    return this.transitionProject(
      input.status.projectId,
      () => this.lanToCloud(input, false),
    );
  }

  async cloudToLanHost(input: CloudToLanHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'cloud-to-lan');
    return this.transitionProject(
      input.status.projectId,
      () => this.cloudToLan(input, true),
    );
  }

  async cloudToLanMember(input: CloudToLanHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'cloud-to-lan');
    return this.transitionProject(
      input.status.projectId,
      () => this.cloudToLan(input, false),
    );
  }

  async recoverConvertedClaimant(record: AuthorityTransferClaimantRecord): Promise<void> {
    const status = authorityTransferClaimantStatus(record);
    if (!status) throw convergenceError('authority-transfer-claimant-status-missing');
    assertCompleted(status, status.direction);
    return this.transitionProject(record.projectId, async () => {
      const membership = await this.requireMembership(record.projectId);
      if (membership.member.id !== record.memberId) {
        throw convergenceError('authority-transfer-claimant-member-conflict');
      }
      if (status.direction === 'lan-to-cloud') {
        const serverUrl = validateCloudServerUrl(
          status.targetUrl,
          'authorityTransferTargetUrl',
        );
        if (
          !isCollabLocalCloudMembership(membership)
          || membership.authority.authorityGeneration
            !== status.targetAuthority.generation
          || membership.authority.serverUrl !== serverUrl
          || membership.authority.gitRemoteUrl
            !== cloudRemoteUrl(status.targetUrl, record.projectId)
        ) throw convergenceError('authority-transfer-cloud-membership-conflict');
        await this.finish(record.projectId, 'cloud');
        return;
      }
      if (record.variant !== 'source-issued') {
        throw convergenceError('authority-transfer-claimant-direction-invalid');
      }
      const lanTarget = record.lanTarget;
      const targetCredential = record.targetCredential;
      if (!lanTarget || !targetCredential || !isCollabLocalLanMembership(membership)) {
        throw convergenceError('authority-transfer-lan-membership-conflict');
      }
      const endpoint = new URL(lanTarget.endpoint).origin;
      if (
        membership.authority.endpoint !== endpoint
        || membership.authority.gitRemoteUrl !== lanRemoteUrl(lanTarget.endpoint, record.projectId)
        || membership.authority.hostCaCertificatePem !== lanTarget.caCertificatePem
        || membership.authority.hostCaFingerprint !== lanTarget.caFingerprint
        || membership.member.credential !== targetCredential
        || membership.hostOwnership.autoStart
        || membership.hostOwnership.ownsAuthority
      ) throw convergenceError('authority-transfer-lan-membership-conflict');
      await this.finish(record.projectId, 'lan');
    });
  }

  private transitionProject(
    projectId: CollabProjectId,
    operation: () => Promise<void>,
  ): Promise<void> {
    return this.options.activity.transitionProject(projectId, () => (
      this.options.authorityProjectionTransitions.run(projectId, operation)
    ));
  }

  private async lanToCloud(
    input: LanToCloudHostConvergenceInput,
    sourceOwnsAuthority: boolean,
  ): Promise<void> {
    const membership = await this.requireMembership(input.status.projectId);
    assertSnapshot(membership, input.snapshot);
    if (
      input.snapshot.project.authorityKind !== 'cloud'
      || input.snapshot.project.authorityGeneration !== input.status.targetAuthority.generation
    ) throw convergenceError('authority-transfer-convergence-generation-mismatch');
    await this.convergeLanMembershipToCloud(
      membership,
      input.status,
      input.snapshot.currentMember,
      input.snapshot.eventSequence,
      sourceOwnsAuthority,
    );
  }

  private async convergeLanMembershipToCloud(
    membership: CollabLocalMembershipRecord,
    status: CollabAuthorityTransferStatus,
    member: LanToCloudMemberProjection,
    lastEventSequence: number,
    sourceOwnsAuthority: boolean,
  ): Promise<void> {
    const newRemoteUrl = cloudRemoteUrl(status.targetUrl, status.projectId);
    const serverUrl = validateCloudServerUrl(
      status.targetUrl,
      'authorityTransferTargetUrl',
    );
    if (isCollabLocalLanMembership(membership)) {
      const oldRemoteUrl = membership.authority.gitRemoteUrl;
      if (
        !oldRemoteUrl
        || membership.hostOwnership.ownsAuthority !== sourceOwnsAuthority
      ) {
        throw convergenceError('authority-transfer-source-membership-invalid');
      }
      await this.rotate(membership, oldRemoteUrl, newRemoteUrl, serverUrl);
      await this.options.projects.saveMembership({
        authority: {
          authorityGeneration: status.targetAuthority.generation,
          bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
          gitRemoteUrl: newRemoteUrl,
          kind: 'cloud',
          serverUrl,
          wireVersion: COLLAB_PROTOCOL_VERSION,
        },
        createdAt: membership.createdAt,
        lastEventSequence,
        ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }),
        member: {
          displayName: member.displayName,
          id: member.id,
          personalRef: member.personalRef,
          role: member.role,
        },
        project: membership.project,
        schemaVersion: membership.schemaVersion,
        updatedAt: this.timestamp(membership.updatedAt),
      });
    } else {
      if (
        membership.authority.authorityGeneration
          !== status.targetAuthority.generation
        || membership.authority.gitRemoteUrl !== newRemoteUrl
        || membership.authority.serverUrl !== serverUrl
      ) throw convergenceError('authority-transfer-cloud-membership-conflict');
    }
    await this.finish(status.projectId, 'cloud');
  }

  private async cloudToLan(
    input: CloudToLanHostConvergenceInput,
    targetOwnsAuthority: boolean,
  ): Promise<void> {
    const membership = await this.requireMembership(input.status.projectId);
    const identity = input.identity;
    if (
      identity.project.id !== membership.project.id
      || identity.project.name !== membership.project.name
      || identity.currentMember.id !== membership.member.id
      || identity.currentMember.personalRef !== membership.member.personalRef
      || identity.authorityGeneration !== input.status.targetAuthority.generation
    ) throw convergenceError('authority-transfer-convergence-target-identity-mismatch');
    const newRemoteUrl = lanRemoteUrl(input.endpoint, input.status.projectId);
    if (isCollabLocalCloudMembership(membership)) {
      await this.rotate(membership, membership.authority.gitRemoteUrl, newRemoteUrl, null);
      const candidate: CollabLocalLanMembershipRecord = {
        authority: {
          endpoint: new URL(input.endpoint).origin,
          gitRemoteUrl: newRemoteUrl,
          hostCaCertificatePem: input.hostCaCertificatePem,
          hostCaFingerprint: input.hostCaFingerprint,
          kind: 'lan',
        },
        createdAt: membership.createdAt,
        hostOwnership: {
          autoStart: targetOwnsAuthority,
          ownsAuthority: targetOwnsAuthority,
        },
        lastEventSequence: identity.eventSequence,
        ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }),
        member: {
          credential: input.memberCredential,
          displayName: identity.currentMember.displayName,
          id: identity.currentMember.id,
          personalRef: identity.currentMember.personalRef,
          role: identity.currentMember.role,
        },
        project: membership.project,
        schemaVersion: membership.schemaVersion,
        updatedAt: this.timestamp(membership.updatedAt),
      };
      await this.options.projects.saveMembership(candidate);
    } else if (
      membership.authority.endpoint !== new URL(input.endpoint).origin
      || membership.authority.gitRemoteUrl !== newRemoteUrl
      || membership.authority.hostCaCertificatePem !== input.hostCaCertificatePem
      || membership.authority.hostCaFingerprint !== input.hostCaFingerprint
      || membership.member.credential !== input.memberCredential
      || membership.hostOwnership.autoStart !== targetOwnsAuthority
      || membership.hostOwnership.ownsAuthority !== targetOwnsAuthority
    ) {
      throw convergenceError('authority-transfer-lan-membership-conflict');
    }
    await this.finish(input.status.projectId, 'lan');
  }

  private async finish(projectId: CollabProjectId, authorityKind: 'cloud' | 'lan'): Promise<void> {
    const index = await this.options.projects.repairIndexFromMemberships();
    if (index.projects.find(project => project.id === projectId)?.authorityKind !== authorityKind) {
      throw convergenceError('authority-transfer-index-convergence-failed');
    }
  }

  private async requireMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord> {
    const membership = await this.options.projects.loadMembership(projectId);
    if (!membership || membership.project.id !== projectId) {
      throw convergenceError('authority-transfer-membership-missing');
    }
    return membership;
  }

  private rotate(
    membership: CollabLocalMembershipRecord,
    oldRemoteUrl: string,
    newRemoteUrl: string,
    newServerUrl: string | null,
  ): Promise<void> {
    return this.options.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    ).then(repositoryPath => this.options.git.rotate({
      newRemoteUrl,
      newServerUrl,
      oldRemoteUrl,
      oldServerUrl: isCollabLocalCloudMembership(membership)
        ? membership.authority.serverUrl
        : null,
      projectId: membership.project.id,
      repositoryPath,
    }));
  }

  private timestamp(previous: string): string {
    const current = this.now().toISOString();
    return Date.parse(current) >= Date.parse(previous) ? current : previous;
  }
}
