import { type CollabProjectId } from '@claudian/collab-protocol';

import type { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import type {
  CollabLocalProjectRepository} from '@/app/collab/CollabLocalProjectRepository';
import {
  type CollabLocalMembershipRecord,
  isCollabLocalLanMembership,
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
import { CollabAuthorityGitNetworkEnvironment } from '@/app/collab/remote-authority/CollabAuthorityGitNetworkEnvironment';
import type { CollabAuthoritySession } from '@/app/collab/remote-authority/CollabAuthoritySession';
import type { CollabAuthoritySessionFactory } from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';
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
    || allowsHostRemoteRepair(membership) !== context.allowHostRemoteRepair
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
    ?? (isCollabLocalLanMembership(membership) && membership.hostOwnership.ownsAuthority
      ? collabStoppedHostRemoteUrl(membership.project.id)
      : null);
}

function allowsHostRemoteRepair(membership: CollabLocalMembershipRecord): boolean {
  return isCollabLocalLanMembership(membership) && membership.hostOwnership.ownsAuthority;
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
      allowHostRemoteRepair: allowsHostRemoteRepair(membership),
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
  private readonly networkEnvironment: CollabAuthorityGitNetworkEnvironment;

  constructor(
    private readonly vaultRoot: string,
    private readonly projects: CollabLocalProjectRepository,
    private readonly sessions: CollabProjectWorkSessionRegistry,
    private readonly authoritySessions: CollabAuthoritySessionFactory,
    private readonly isLocalHostRunning: (projectId: CollabProjectId) => boolean = () => false,
    private readonly assertControlReachable: (
      projectId: CollabProjectId,
    ) => Promise<void> = () => Promise.resolve(),
  ) {
    this.networkEnvironment = new CollabAuthorityGitNetworkEnvironment(vaultRoot);
  }

  async withNetwork<T>(
    context: PublishProjectContext,
    operation: (network?: GitNetworkEnvironment) => Promise<T>,
  ): Promise<T> {
    const membership = assertMembershipMatches(
      context,
      await this.projects.loadMembership(context.projectId),
    );
    const authority = await this.sessions.acquire(context.projectId)
      .ensureAuthoritySession<CollabAuthoritySession>(
        () => this.authoritySessions.create(membership),
      );
    if (authority.git.remoteUrl !== context.remoteUrl) {
      throw projectError('stale-project-selection', 'publish-authority-session-changed');
    }
    if (
      isCollabLocalLanMembership(membership)
      && membership.hostOwnership.ownsAuthority
      && !this.isLocalHostRunning(context.projectId)
    ) {
      throw projectError('host-stopped', 'publish-local-host-not-running');
    }
    if (authority.git.headers.length === 0) {
      throw projectError('host-stopped', 'publish-host-endpoint-unavailable');
    }
    await this.assertControlReachable(context.projectId);
    return operation(await this.networkEnvironment.resolve(context.projectId, authority.git));
  }
}
