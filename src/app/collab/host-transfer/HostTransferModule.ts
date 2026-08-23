import { type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';

import type { HostTransferAuthorityService } from '@/app/collab/authority/HostTransferAuthorityService';
import { HostTransferRepository } from '@/app/collab/authority/HostTransferRepository';
import type { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import type {
  CollabLocalLanMembershipRecord,
  CollabLocalMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import { rotateTrustedCollabOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { CollabHostTransferService } from '@/app/collab/host-transfer/CollabHostTransferService';
import type {
  HostTransferAuthorityPort,
  HostTransferRecoveryStorePort,
  HostTransferTargetTransportPort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import { IncomingHostTransferCoordinator } from '@/app/collab/host-transfer/IncomingHostTransferCoordinator';
import { IncomingHostTransferPackage } from '@/app/collab/host-transfer/IncomingHostTransferPackage';
import { LanHostTransferAdmission } from '@/app/collab/host-transfer/LanHostTransferAdmission';
import { LanHostTransferSourceIdentity } from '@/app/collab/host-transfer/LanHostTransferSourceIdentity';
import { LanIncomingHostTransferPreparation } from '@/app/collab/host-transfer/LanIncomingHostTransferPreparation';
import { LocalHostTransferProjection } from '@/app/collab/host-transfer/LocalHostTransferProjection';
import { NativeHostTransferPackagePreparation } from '@/app/collab/host-transfer/NativeHostTransferPackagePreparation';
import { OutgoingHostTransferCoordinator } from '@/app/collab/host-transfer/OutgoingHostTransferCoordinator';
import { OutgoingHostTransferRuntime } from '@/app/collab/host-transfer/OutgoingHostTransferRuntime';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import { HostTransferControlClient } from '@/app/collab/lan/HostTransferControlClient';
import { HostTransferTargetTransport } from '@/app/collab/lan/HostTransferTargetTransport';
import type { LanHostCoordinator } from '@/app/collab/lan/LanHostCoordinator';
import { type CollabCoordinationSnapshot, type CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface HostTransferModuleGitFoundation {
  readonly repositories: GitRepositoryService;
  readonly runner: GitCommandRunner;
}

type HostTransferControlPort = Pick<
  HostTransferControlClient,
  'accept' | 'cancel' | 'create' | 'decline'
>;

export interface CreateOutgoingHostTransferRuntimeInput {
  readonly accept: { recover(): Promise<void> };
  readonly authority: {
    readonly authorityDirectory: string;
    readonly database: SqlJsProjectDatabase;
  };
  readonly git: HostTransferModuleGitFoundation;
  readonly hostTransfers: HostTransferAuthorityService;
  readonly projectId: CollabProjectId;
  readonly repositoryPath: string;
}

export interface HostTransferModuleOptions {
  readonly activateTransferredAuthority: (input: {
    readonly projectId: CollabProjectId;
    readonly targetHostMemberId: string;
    readonly transferId: CollabOperationId;
  }) => Promise<{ readonly endpoint: string }>;
  readonly finalizeOldAuthority: (projectId: CollabProjectId) => Promise<void>;
  readonly lanHost: Pick<
    LanHostCoordinator,
    | 'closeProjectForHostTransfer'
    | 'completeProjectHostTransfer'
    | 'hostCaSigner'
    | 'quiesceProjectForHostTransfer'
    | 'reopenProjectBeforeHostTransfer'
    | 'startProject'
    | 'startProvisionalTransfer'
    | 'stopProvisionalTransfer'
  >;
  readonly createControlClient?: (
    membership: CollabLocalLanMembershipRecord,
  ) => HostTransferControlPort;
  readonly createTargetTransport?: () => HostTransferTargetTransportPort;
  readonly projects: Pick<
    CollabLocalProjectRepository,
    | 'ensureAuthorityDirectory'
    | 'hostTransferRecovery'
    | 'loadIndex'
    | 'loadMembership'
    | 'saveMembership'
  >;
  readonly requireGitFoundation: () => Promise<HostTransferModuleGitFoundation>;
  readonly snapshots: {
    readCoordinationSnapshot(
      projectId: CollabProjectId,
      options?: CollabOperationOptions,
    ): Promise<CollabCoordinationSnapshot>;
  };
  readonly workspace: Pick<
    CollabWorkspaceService,
    | 'removeReservedProjectsFolderChild'
    | 'reserveProjectsFolderChild'
    | 'resolveManagedProjectPath'
  >;
}

function compositionError(reason: string): CollabError {
  return new CollabError({
    code: 'workspace-boundary-invalid',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function projectsFolder(membership: CollabLocalMembershipRecord): string {
  const normalized = membership.project.workspacePath.replaceAll('\\', '/');
  const separator = normalized.lastIndexOf('/');
  if (separator < 1 || separator === normalized.length - 1) {
    throw compositionError('host-transfer-projects-folder-invalid');
  }
  return normalized.slice(0, separator);
}

export class HostTransferModule {
  readonly clientService: CollabHostTransferService;
  private readonly recovery: HostTransferRecoveryStorePort;

  constructor(private readonly options: HostTransferModuleOptions) {
    this.recovery = options.projects.hostTransferRecovery;
    const target = this.createTargetTransport();
    this.clientService = new CollabHostTransferService({
      createControlClient: membership => this.createControlClient(membership),
      createIncomingCoordinator: membership => this.createIncomingCoordinator(membership),
      projects: this.options.projects,
      recovery: this.recovery,
      resumeCompletedOutgoing: async record => {
        await this.options.finalizeOldAuthority(record.projectId);
        await this.options.lanHost.completeProjectHostTransfer(record.projectId);
        await target.confirmTerminal({
          endpoint: record.targetEndpoint!,
          receiverCredential: record.receiverCredential!,
          targetCaCertificatePem: record.targetCaCertificatePem!,
          targetCaFingerprint: record.targetCaFingerprint!,
          transferId: record.transferId,
        }).catch(() => undefined);
        await this.recovery.remove(record.projectId, 'outgoing');
      },
      resumeOutgoing: async projectId => {
        try {
          await this.options.lanHost.startProject(projectId);
        } catch (error) {
          if (
            error instanceof CollabError
            && error.code === 'durable-progress-recovery-required'
            && error.safeContext?.reason === 'host-transfer-post-relinquishment-recovery'
          ) return;
          throw error;
        }
      },
      snapshots: this.options.snapshots,
    });
  }

  createOutgoingRuntime(
    input: CreateOutgoingHostTransferRuntimeInput,
  ): OutgoingHostTransferRuntime {
    return new OutgoingHostTransferRuntime(
      input.projectId,
      transferId => {
        const admission = new LanHostTransferAdmission(
          input.projectId,
          transferId,
          this.options.lanHost,
          {
            assertAcceptanceSettled: () => input.accept.recover(),
            finalizeOldAuthority: () => this.options.finalizeOldAuthority(input.projectId),
          },
        );
        return new OutgoingHostTransferCoordinator(
          this.createAuthority(input),
          admission,
          new NativeHostTransferPackagePreparation({
            authorityDirectory: input.authority.authorityDirectory,
            database: input.authority.database,
            repositories: input.git.repositories,
            repositoryPath: input.repositoryPath,
            runner: input.git.runner,
          }),
          this.createTargetTransport(),
          new LanHostTransferSourceIdentity(this.options.lanHost, this.options.projects),
          this.createProjection(input.git),
          this.recovery,
        );
      },
      this.recovery,
    );
  }

  private async createIncomingCoordinator(
    membership: CollabLocalLanMembershipRecord,
  ): Promise<IncomingHostTransferCoordinator> {
    const git = await this.options.requireGitFoundation();
    const folder = projectsFolder(membership);
    const preparation = new LanIncomingHostTransferPreparation({
      lanHost: this.options.lanHost,
      loadMembership: projectId => this.options.projects.loadMembership(projectId),
      projectsFolder: folder,
      repositories: git.repositories,
      workspace: this.options.workspace,
    });
    const control = this.createControlClient(membership);
    const coordinator = new IncomingHostTransferCoordinator(
      {
        accept: request => control.accept({
          memberCredential: membership.member.credential,
          request,
        }),
      },
      preparation,
      new IncomingHostTransferPackage({
        ensureAuthorityDirectory: projectId => (
          this.options.projects.ensureAuthorityDirectory(projectId)
        ),
        projectsFolder: folder,
        readPinnedSourceCa: projectId => (
          this.createProjection(git).readPinnedSourceCa(projectId)
        ),
        repositories: git.repositories,
        resolveWorkingRepository: projectId => this.resolveWorkingRepository(projectId),
        runner: git.runner,
        workspace: this.options.workspace,
      }),
      { activate: input => this.options.activateTransferredAuthority(input) },
      this.createProjection(git),
      this.recovery,
    );
    preparation.bindCoordinator(coordinator);
    return coordinator;
  }

  private createControlClient(membership: CollabLocalLanMembershipRecord): HostTransferControlPort {
    if (this.options.createControlClient) return this.options.createControlClient(membership);
    const endpoint = membership.authority.endpoint;
    const caCertificatePem = membership.authority.hostCaCertificatePem;
    const caFingerprint = membership.authority.hostCaFingerprint;
    if (!endpoint || !caCertificatePem || !caFingerprint) {
      throw compositionError('host-transfer-trust-missing');
    }
    return new HostTransferControlClient(new PinnedCollabHttpClient({
      caCertificatePem,
      caFingerprint,
      endpoint,
      projectId: membership.project.id,
    }, 10_000));
  }

  private createProjection(
    git: HostTransferModuleGitFoundation,
  ): LocalHostTransferProjection {
    return new LocalHostTransferProjection({
      loadMembership: projectId => this.options.projects.loadMembership(projectId),
      resolveWorkspace: workspacePath => (
        this.options.workspace.resolveManagedProjectPath(workspacePath)
      ),
      rotateOrigin: transition => rotateTrustedCollabOrigin(
        git.repositories,
        transition,
      ),
      saveMembership: membership => this.options.projects.saveMembership(membership),
    });
  }

  private createAuthority(
    input: CreateOutgoingHostTransferRuntimeInput,
  ): HostTransferAuthorityPort {
    const repository = new HostTransferRepository();
    return {
      advance: request => input.hostTransfers.advance(request),
      getTransfer: transferId => input.authority.database.read(connection => (
        repository.get(connection, transferId)
      )),
      relinquish: request => input.hostTransfers.relinquish(request),
    };
  }

  private createTargetTransport(): HostTransferTargetTransportPort {
    return this.options.createTargetTransport?.() ?? new HostTransferTargetTransport();
  }

  private async resolveWorkingRepository(projectId: CollabProjectId): Promise<string> {
    const membership = await this.options.projects.loadMembership(projectId);
    if (!membership || membership.project.id !== projectId) {
      throw compositionError('host-transfer-membership-missing');
    }
    return this.options.workspace.resolveManagedProjectPath(membership.project.workspacePath);
  }
}
