import { type CollabProjectId } from '@claudian-collab/protocol';

import type { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import type {
  CollabLocalMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import type { GitNetworkEnvironment } from '@/app/collab/git/GitCommandRunner';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import type { PublishGitNetworkPort } from '@/app/collab/publish/NativeGitPublishRepository';
import {
  type PublishProjectContext,
  type PublishProjectPort,
} from '@/app/collab/publish/PublishCoordinator';
import type { CollabAuthorityControlPort } from '@/app/collab/remote-authority/CollabAuthorityControlPort';
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
    || membership.member.id !== context.memberId
    || membership.member.personalRef !== context.personalRef
    || membership.authority.gitRemoteUrl !== context.remoteUrl
  ) {
    throw projectError('stale-project-selection', 'publish-membership-changed');
  }
  return membership;
}

function isProjectConnectionReset(error: unknown): boolean {
  return error instanceof CollabError
    && error.code === 'cancelled'
    && error.safeContext.reason === 'projection-project-connection-reset';
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
    const repositoryPath = await this.workspace.resolveManagedProjectPath(project.workspacePath);
    await this.repositories.assertLocalRepositoryIdentity(repositoryPath, {
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId,
    });
    return {
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId,
      remoteUrl: membership.authority.gitRemoteUrl,
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
    const loadedMembership = await this.projects.loadMembership(expected.projectId);
    const membership = assertMembershipMatches(expected, loadedMembership);
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
    private readonly assertControlReachable: (
      control: CollabAuthorityControlPort,
      projectId: CollabProjectId,
      signal?: AbortSignal,
    ) => Promise<void> = () => Promise.resolve(),
  ) {
    this.networkEnvironment = new CollabAuthorityGitNetworkEnvironment(vaultRoot);
  }

  async withNetwork<T>(
    context: PublishProjectContext,
    operation: (network: GitNetworkEnvironment | undefined, remoteUrl: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.withNetworkGeneration(context, operation, signal);
    } catch (error) {
      if (!isProjectConnectionReset(error)) throw error;
      return this.withNetworkGeneration(
        await this.refreshAuthorityGeneration(context),
        operation,
        signal,
      );
    }
  }

  private async refreshAuthorityGeneration(
    context: PublishProjectContext,
  ): Promise<PublishProjectContext> {
    const membership = await this.projects.loadMembership(context.projectId);
    if (
      !membership
      || membership.project.id !== context.projectId
      || membership.member.id !== context.memberId
      || membership.member.personalRef !== context.personalRef
    ) {
      throw projectError('stale-project-selection', 'publish-membership-changed');
    }
    return { ...context, remoteUrl: membership.authority.gitRemoteUrl };
  }

  private async withNetworkGeneration<T>(
    context: PublishProjectContext,
    operation: (network: GitNetworkEnvironment | undefined, remoteUrl: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const loadedMembership = await this.projects.loadMembership(context.projectId);
    const membership = assertMembershipMatches(context, loadedMembership);
    const work = this.sessions.acquire(context.projectId);
    const generation = work.generation;
    const authority = await work.ensureAuthoritySession<CollabAuthoritySession>(
      () => this.authoritySessions.create(membership),
    );
    work.assertGeneration(generation);
    if (authority.git.headers.length === 0) {
      throw projectError('host-stopped', 'publish-host-endpoint-unavailable');
    }
    try {
      await this.assertControlReachable(authority.control, context.projectId, signal);
    } catch (error) {
      work.assertGeneration(generation);
      throw error;
    }
    work.assertGeneration(generation);
    const network = await this.networkEnvironment.resolve(context.projectId, authority.git);
    work.assertGeneration(generation);
    let result: T;
    try {
      result = await operation(network, authority.git.remoteUrl);
    } catch (error) {
      try {
        await this.assertControlReachable(authority.control, context.projectId, signal);
      } catch (controlError) {
        work.assertGeneration(generation);
        throw controlError;
      }
      work.assertGeneration(generation);
      throw error;
    }
    work.assertGeneration(generation);
    return result;
  }
}
