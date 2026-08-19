import { readFile } from 'node:fs/promises';

import { type CollabProjectId } from '@claudian/collab-protocol';

import {
  resolveCollabVaultPath,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import type {
  CollabLocalProjectRepository} from '@/app/collab/CollabLocalProjectRepository';
import {
  type CollabLocalMembershipRecord
} from '@/app/collab/CollabLocalProjectRepository';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import {
  collabStoppedHostRemoteUrl,
  type GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import type { PublishGitNetworkPort } from '@/app/collab/publish/NativeGitPublishRepository';
import {
  type PublishProjectContext,
  type PublishProjectPort,
} from '@/app/collab/publish/PublishCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function projectError(
  code: 'host-stopped' | 'project-not-found' | 'stale-project-selection',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'host-stopped' ? ['restart-host', 'retry'] : ['retry'],
    safeContext: { reason },
  });
}

function assertMembershipMatches(
  context: PublishProjectContext,
  membership: CollabLocalMembershipRecord | null,
): CollabLocalMembershipRecord {
  if (!membership) throw projectError('project-not-found', 'publish-membership-missing');
  if (
    membership.project.id !== context.projectId
    || membership.hostOwnership.ownsAuthority !== context.allowHostRemoteRepair
    || membership.member.id !== context.memberId
    || membership.member.personalRef !== context.personalRef
    || membershipRemoteUrl(membership) !== context.remoteUrl
  ) {
    throw projectError('stale-project-selection', 'publish-membership-changed');
  }
  return membership;
}

function membershipRemoteUrl(membership: CollabLocalMembershipRecord): string | null {
  return membership.authority.gitRemoteUrl
    ?? (membership.hostOwnership.ownsAuthority
      ? collabStoppedHostRemoteUrl(membership.project.id)
      : null);
}

export class LocalPublishProjectPort implements PublishProjectPort {
  constructor(
    private readonly projects: CollabLocalProjectRepository,
    private readonly workspace: Pick<CollabWorkspaceService, 'resolveManagedProjectPath'>,
    private readonly repositories: Pick<GitRepositoryService, 'assertLocalRepositoryIdentity'>,
  ) {}

  async load(projectId: CollabProjectId): Promise<PublishProjectContext> {
    const index = await this.projects.loadIndex();
    if (index.selectedProjectId !== projectId) {
      throw projectError('stale-project-selection', 'publish-project-not-selected');
    }
    const project = index.projects.find(candidate => candidate.id === projectId);
    const membership = await this.projects.loadMembership(projectId);
    if (!project || !membership) {
      throw projectError('project-not-found', 'publish-local-project-missing');
    }
    if (
      project.workspacePath !== membership.project.workspacePath
    ) {
      throw projectError('project-not-found', 'publish-local-project-incomplete');
    }
    const remoteUrl = membershipRemoteUrl(membership);
    if (!remoteUrl) {
      throw projectError('host-stopped', 'publish-host-endpoint-unavailable');
    }
    const repositoryPath = await this.workspace.resolveManagedProjectPath(project.workspacePath);
    await this.repositories.assertLocalRepositoryIdentity(repositoryPath, {
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId,
    });
    return {
      allowHostRemoteRepair: membership.hostOwnership.ownsAuthority,
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId,
      remoteUrl,
      repositoryPath,
    };
  }

  async revalidate(expected: PublishProjectContext): Promise<void> {
    const index = await this.projects.loadIndex();
    if (index.selectedProjectId !== expected.projectId) {
      throw projectError('stale-project-selection', 'publish-project-selection-changed');
    }
    const project = index.projects.find(candidate => candidate.id === expected.projectId);
    if (!project) throw projectError('project-not-found', 'publish-index-entry-missing');
    const membership = assertMembershipMatches(
      expected,
      await this.projects.loadMembership(expected.projectId),
    );
    if (project.workspacePath !== membership.project.workspacePath) {
      throw projectError('stale-project-selection', 'publish-workspace-record-changed');
    }
    const repositoryPath = await this.workspace.resolveManagedProjectPath(project.workspacePath);
    await this.repositories.assertLocalRepositoryIdentity(repositoryPath, {
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId: membership.project.id,
    });
    if (repositoryPath !== expected.repositoryPath) {
      throw projectError('stale-project-selection', 'publish-workspace-path-changed');
    }
  }
}

export class LocalPublishGitNetworkPort implements PublishGitNetworkPort {
  constructor(
    private readonly vaultRoot: string,
    private readonly projects: CollabLocalProjectRepository,
    private readonly isLocalHostRunning: (projectId: CollabProjectId) => boolean = () => false,
    private readonly assertControlReachable: (
      projectId: CollabProjectId,
    ) => Promise<void> = () => Promise.resolve(),
  ) {}

  async withNetwork<T>(
    context: PublishProjectContext,
    operation: (network?: GitNetworkEnvironment) => Promise<T>,
  ): Promise<T> {
    const membership = assertMembershipMatches(
      context,
      await this.projects.loadMembership(context.projectId),
    );
    const caCertificatePem = membership.authority.hostCaCertificatePem;
    if (
      membership.hostOwnership.ownsAuthority
      && !this.isLocalHostRunning(context.projectId)
    ) {
      throw projectError('host-stopped', 'publish-local-host-not-running');
    }
    if (
      !membership.authority.endpoint
      || !caCertificatePem
      || !membership.authority.hostCaFingerprint
    ) {
      throw projectError('host-stopped', 'publish-host-endpoint-unavailable');
    }
    await this.assertControlReachable(context.projectId);
    const relativeCaPath = `.claudian/collab/projects/${context.projectId}/git-ca.pem`;
    const existingCaPath = await resolveCollabVaultPath(this.vaultRoot, relativeCaPath);
    const existingCa = await readFile(existingCaPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existingCa !== caCertificatePem) {
      await writeCollabFileAtomically(this.vaultRoot, relativeCaPath, caCertificatePem, {
        mode: 0o600,
      });
    }
    const sslCaInfoPath = await resolveCollabVaultPath(
      this.vaultRoot,
      relativeCaPath,
      { mustExist: true },
    );
    return operation({
      authorizationHeader: `Basic ${Buffer.from(
        `${membership.member.id}:${membership.member.credential}`,
      ).toString('base64')}`,
      sslCaInfoPath,
    });
  }
}
