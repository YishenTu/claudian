import { type CollabProjectId } from '@claudian/collab-protocol';

import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import type { HostTransferProjectionPort } from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface LocalHostTransferProjectionOptions {
  readonly loadMembership: (
    projectId: CollabProjectId,
  ) => Promise<CollabLocalMembershipRecord | null>;
  readonly now?: () => Date;
  readonly resolveWorkspace: (workspacePath: string) => Promise<string>;
  readonly rotateOrigin: (input: {
    readonly newRemoteUrl: string;
    readonly oldRemoteUrl: string;
    readonly projectId: CollabProjectId;
    readonly repositoryPath: string;
  }) => Promise<void>;
  readonly saveMembership: (membership: CollabLocalMembershipRecord) => Promise<void>;
}

function projectionError(reason: string): CollabError {
  return new CollabError({
    code: 'project-not-found',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function remoteUrl(endpoint: string, projectId: CollabProjectId): string {
  const parsed = new URL(endpoint);
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) throw projectionError('host-transfer-projection-endpoint-invalid');
  return `${endpoint}/v1/git/${projectId}/repository.git`;
}

export class LocalHostTransferProjection implements HostTransferProjectionPort {
  private readonly now: () => Date;

  constructor(private readonly options: LocalHostTransferProjectionOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async readPinnedSourceCa(projectId: CollabProjectId): Promise<string> {
    const membership = await this.requireMembership(projectId);
    const certificate = membership.authority.hostCaCertificatePem;
    if (!certificate) throw projectionError('host-transfer-projection-source-ca-missing');
    return certificate;
  }

  async promoteTargetHost(
    input: Parameters<HostTransferProjectionPort['promoteTargetHost']>[0],
  ): Promise<void> {
    const membership = await this.requireMembership(input.projectId);
    if (membership.member.id !== input.targetHostMemberId) {
      throw projectionError('host-transfer-projection-target-mismatch');
    }
    await this.rotate(membership, input.endpoint);
    await this.options.saveMembership({
      ...membership,
      authority: {
        ...membership.authority,
        endpoint: input.endpoint,
        gitRemoteUrl: remoteUrl(input.endpoint, input.projectId),
        hostCaCertificatePem: input.targetCaCertificatePem,
        hostCaFingerprint: input.targetCaFingerprint,
      },
      hostOwnership: { autoStart: true, ownsAuthority: true },
      lastEventSequence: input.eventSequence,
      updatedAt: this.now().toISOString(),
    });
  }

  async demoteSourceHost(
    input: Parameters<HostTransferProjectionPort['demoteSourceHost']>[0],
  ): Promise<void> {
    const membership = await this.requireMembership(input.projectId);
    await this.rotate(membership, input.endpoint);
    await this.options.saveMembership({
      ...membership,
      authority: {
        ...membership.authority,
        endpoint: input.endpoint,
        gitRemoteUrl: remoteUrl(input.endpoint, input.projectId),
        hostCaCertificatePem: input.targetCaCertificatePem,
        hostCaFingerprint: input.targetCaFingerprint,
      },
      hostOwnership: { autoStart: false, ownsAuthority: false },
      updatedAt: this.now().toISOString(),
    });
  }

  private async rotate(
    membership: CollabLocalMembershipRecord,
    endpoint: string,
  ): Promise<void> {
    const oldRemoteUrl = membership.authority.gitRemoteUrl;
    if (!oldRemoteUrl) throw projectionError('host-transfer-projection-origin-missing');
    await this.options.rotateOrigin({
      newRemoteUrl: remoteUrl(endpoint, membership.project.id),
      oldRemoteUrl,
      projectId: membership.project.id,
      repositoryPath: await this.options.resolveWorkspace(membership.project.workspacePath),
    });
  }

  private async requireMembership(projectId: CollabProjectId): Promise<CollabLocalMembershipRecord> {
    const membership = await this.options.loadMembership(projectId);
    if (!membership || membership.project.id !== projectId) {
      throw projectionError('host-transfer-projection-membership-missing');
    }
    return membership;
  }
}
