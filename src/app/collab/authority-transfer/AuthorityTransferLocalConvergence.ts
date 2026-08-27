import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabAuthorityTransferStatus,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  AuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
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
  canonicalCloudOrigin,
  cloudProjectGitRemoteUrl,
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
    readonly oldRemoteUrl: string;
    readonly projectId: CollabProjectId;
    readonly repositoryPath: string;
  }): Promise<void>;
}

export interface AuthorityTransferLocalConvergenceOptions {
  readonly activity: {
    transitionProject(projectId: CollabProjectId, operation: () => Promise<void>): Promise<void>;
  };
  readonly git: AuthorityTransferConvergenceGit;
  readonly now?: () => Date;
  readonly projects: AuthorityTransferConvergenceProjects;
  readonly workspace: AuthorityTransferConvergenceWorkspace;
}

export interface LanToCloudHostConvergenceInput {
  readonly developmentActorId: string;
  readonly snapshot: CollabProjectSnapshot;
  readonly status: CollabAuthorityTransferStatus;
}

export interface CloudToLanHostConvergenceInput {
  readonly endpoint: string;
  readonly hostCaCertificatePem: string;
  readonly hostCaFingerprint: string;
  readonly memberCredential: string;
  readonly snapshot: CollabProjectSnapshot;
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
    return this.options.activity.transitionProject(
      input.status.projectId,
      () => this.lanToCloud(input, true),
    );
  }

  async lanToCloudMember(input: LanToCloudHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'lan-to-cloud');
    return this.options.activity.transitionProject(
      input.status.projectId,
      () => this.lanToCloud(input, false),
    );
  }

  async cloudToLanHost(input: CloudToLanHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'cloud-to-lan');
    return this.options.activity.transitionProject(
      input.status.projectId,
      () => this.cloudToLan(input, true),
    );
  }

  async cloudToLanMember(input: CloudToLanHostConvergenceInput): Promise<void> {
    assertCompleted(input.status, 'cloud-to-lan');
    return this.options.activity.transitionProject(
      input.status.projectId,
      () => this.cloudToLan(input, false),
    );
  }

  async recoverConvertedClaimant(record: AuthorityTransferClaimantRecord): Promise<void> {
    assertCompleted(record.status, record.status.direction);
    return this.options.activity.transitionProject(record.projectId, async () => {
      const membership = await this.requireMembership(record.projectId);
      if (membership.member.id !== record.memberId) {
        throw convergenceError('authority-transfer-claimant-member-conflict');
      }
      if (record.status.direction === 'lan-to-cloud') {
        const serverUrl = canonicalCloudOrigin(
          record.status.targetUrl,
          'authorityTransferTargetUrl',
        );
        if (
          !isCollabLocalCloudMembership(membership)
          || membership.authority.developmentActorId !== record.memberId
          || (membership.authority.authorityGeneration ?? 1)
            !== record.status.targetAuthority.generation
          || membership.authority.serverUrl !== serverUrl
          || membership.authority.gitRemoteUrl
            !== cloudRemoteUrl(record.status.targetUrl, record.projectId)
        ) throw convergenceError('authority-transfer-cloud-membership-conflict');
        await this.finish(record.projectId, 'cloud');
        return;
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

  private async lanToCloud(
    input: LanToCloudHostConvergenceInput,
    sourceOwnsAuthority: boolean,
  ): Promise<void> {
    const membership = await this.requireMembership(input.status.projectId);
    assertSnapshot(membership, input.snapshot);
    const newRemoteUrl = cloudRemoteUrl(input.status.targetUrl, input.status.projectId);
    const serverUrl = canonicalCloudOrigin(
      input.status.targetUrl,
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
      await this.rotate(membership, oldRemoteUrl, newRemoteUrl);
      await this.options.projects.saveMembership({
        authority: {
          authorityGeneration: input.status.targetAuthority.generation,
          bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
          developmentActorId: input.developmentActorId,
          gitRemoteUrl: newRemoteUrl,
          kind: 'cloud',
          serverUrl,
          wireVersion: COLLAB_PROTOCOL_VERSION,
        },
        createdAt: membership.createdAt,
        lastEventSequence: input.snapshot.eventSequence,
        ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }),
        member: {
          displayName: input.snapshot.currentMember.displayName,
          id: input.snapshot.currentMember.id,
          personalRef: input.snapshot.currentMember.personalRef,
          role: input.snapshot.currentMember.role,
        },
        project: membership.project,
        schemaVersion: membership.schemaVersion,
        updatedAt: this.timestamp(membership.updatedAt),
      });
    } else {
      if (
        membership.authority.developmentActorId !== input.developmentActorId
        || (membership.authority.authorityGeneration ?? 1)
          !== input.status.targetAuthority.generation
        || membership.authority.gitRemoteUrl !== newRemoteUrl
        || membership.authority.serverUrl !== serverUrl
      ) throw convergenceError('authority-transfer-cloud-membership-conflict');
    }
    await this.finish(input.status.projectId, 'cloud');
  }

  private async cloudToLan(
    input: CloudToLanHostConvergenceInput,
    targetOwnsAuthority: boolean,
  ): Promise<void> {
    const membership = await this.requireMembership(input.status.projectId);
    assertSnapshot(membership, input.snapshot);
    const newRemoteUrl = lanRemoteUrl(input.endpoint, input.status.projectId);
    if (isCollabLocalCloudMembership(membership)) {
      await this.rotate(membership, membership.authority.gitRemoteUrl, newRemoteUrl);
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
        lastEventSequence: input.snapshot.eventSequence,
        ...(membership.lifecycle === undefined ? {} : { lifecycle: membership.lifecycle }),
        member: {
          credential: input.memberCredential,
          displayName: input.snapshot.currentMember.displayName,
          id: input.snapshot.currentMember.id,
          personalRef: input.snapshot.currentMember.personalRef,
          role: input.snapshot.currentMember.role,
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
  ): Promise<void> {
    return this.options.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    ).then(repositoryPath => this.options.git.rotate({
      newRemoteUrl,
      oldRemoteUrl,
      projectId: membership.project.id,
      repositoryPath,
    }));
  }

  private timestamp(previous: string): string {
    const current = this.now().toISOString();
    return Date.parse(current) >= Date.parse(previous) ? current : previous;
  }
}
