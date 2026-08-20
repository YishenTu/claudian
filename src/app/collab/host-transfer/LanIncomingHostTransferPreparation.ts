import { randomBytes } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';

import { type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import type {
  IncomingHostTransferPreparationPort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import type { HostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import type { IncomingHostTransferCoordinator } from '@/app/collab/host-transfer/IncomingHostTransferCoordinator';
import type { HostTransferProvisionalRegistration } from '@/app/collab/lan/HostTransferProvisionalRouter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const RECEIVER_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface IncomingMembership {
  readonly project: {
    readonly id: CollabProjectId;
    readonly workspacePath: string;
  };
  readonly member: {
    readonly id: CollabMemberId;
    readonly personalRef: string;
  };
}

interface ProvisionalHostPort {
  startProvisionalTransfer(registration: HostTransferProvisionalRegistration): Promise<{
    readonly caCertificatePem: string;
    readonly caFingerprint: string;
    readonly endpoint: string;
    readonly transferId: CollabOperationId;
  }>;
  stopProvisionalTransfer(transferId: CollabOperationId): Promise<void>;
}

export interface LanIncomingHostTransferPreparationOptions {
  readonly createReceiverCredential?: () => string;
  readonly lanHost: ProvisionalHostPort;
  readonly loadMembership: (projectId: CollabProjectId) => Promise<IncomingMembership | null>;
  readonly projectsFolder: string;
  readonly repositories: Pick<GitRepositoryService, 'assertLocalRepositoryIdentity'>;
  readonly workspace: Pick<
    CollabWorkspaceService,
    | 'removeReservedProjectsFolderChild'
    | 'reserveProjectsFolderChild'
    | 'resolveManagedProjectPath'
  >;
}

function preparationError(
  reason: string,
  code: 'authorization-denied' | 'cancelled' | 'operation-failed' | 'workspace-boundary-invalid'
    = 'operation-failed',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'cancelled' ? ['retry'] : ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw preparationError('host-transfer-target-preparation-cancelled', 'cancelled');
}

export class LanIncomingHostTransferPreparation implements IncomingHostTransferPreparationPort {
  private readonly createReceiverCredential: () => string;
  private coordinator: Pick<
    IncomingHostTransferCoordinator,
    'activate' | 'cancel' | 'complete' | 'confirm' | 'stage'
  > | null = null;

  constructor(private readonly options: LanIncomingHostTransferPreparationOptions) {
    this.createReceiverCredential = options.createReceiverCredential
      ?? (() => randomBytes(32).toString('base64url'));
  }

  bindCoordinator(
    coordinator: Pick<
      IncomingHostTransferCoordinator,
      'activate' | 'cancel' | 'complete' | 'confirm' | 'stage'
    >,
  ): void {
    if (this.coordinator && this.coordinator !== coordinator) {
      throw preparationError('host-transfer-target-coordinator-already-bound');
    }
    this.coordinator = coordinator;
  }

  async assertEligible(
    input: Parameters<IncomingHostTransferPreparationPort['assertEligible']>[0],
  ): Promise<void> {
    throwIfCancelled(input.signal);
    this.assertIdentity(input.projectId, input.transferId);
    const membership = await this.requireMembership(input.projectId);
    if (membership.member.id !== input.targetMemberId) {
      throw preparationError('host-transfer-target-member-mismatch', 'authorization-denied');
    }
    const workspacePath = await this.options.workspace.resolveManagedProjectPath(
      membership.project.workspacePath,
    );
    await this.options.repositories.assertLocalRepositoryIdentity(workspacePath, {
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId: input.projectId,
    });
    throwIfCancelled(input.signal);
  }

  async startProvisional(
    input: Parameters<IncomingHostTransferPreparationPort['startProvisional']>[0],
  ): Promise<Awaited<ReturnType<IncomingHostTransferPreparationPort['startProvisional']>>> {
    throwIfCancelled(input.signal);
    this.assertIdentity(input.projectId, input.transferId);
    const coordinator = this.requireCoordinator();
    const stagingDirectoryName = this.stagingName(input.transferId);
    const ownership = this.ownership(input.projectId, input.transferId, stagingDirectoryName);
    const staging = await this.options.workspace.reserveProjectsFolderChild(
      this.options.projectsFolder,
      ownership,
    );
    const existing = await lstat(staging.absolutePath).catch(() => null);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw preparationError('host-transfer-staging-boundary-invalid', 'workspace-boundary-invalid');
    }
    if (!existing) await mkdir(staging.absolutePath, { mode: 0o700 });
    const receiverCredential = this.createReceiverCredential();
    this.assertReceiverCredential(receiverCredential);
    try {
      const listener = await this.options.lanHost.startProvisionalTransfer({
        coordinator,
        projectId: input.projectId,
        receiverCredential,
        transferId: input.transferId,
      });
      throwIfCancelled(input.signal);
      return Object.freeze({
        endpoint: listener.endpoint,
        receiverCredential,
        stagingDirectoryName,
        targetCaCertificatePem: listener.caCertificatePem,
        targetCaFingerprint: listener.caFingerprint,
      });
    } catch (error) {
      await this.options.lanHost.stopProvisionalTransfer(input.transferId).catch(() => undefined);
      await this.options.workspace.removeReservedProjectsFolderChild(
        this.options.projectsFolder,
        ownership,
      ).catch(() => undefined);
      throw error;
    }
  }

  async restoreProvisional(record: HostTransferRecoveryRecord): Promise<void> {
    const coordinator = this.requireCoordinator();
    this.assertRecord(record);
    const staging = await this.options.workspace.reserveProjectsFolderChild(
      this.options.projectsFolder,
      this.ownership(record.projectId, record.transferId, record.stagingDirectoryName!),
    );
    const existing = await lstat(staging.absolutePath).catch(() => null);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw preparationError('host-transfer-staging-boundary-invalid', 'workspace-boundary-invalid');
    }
    if (!existing) await mkdir(staging.absolutePath, { mode: 0o700 });
    const listener = await this.options.lanHost.startProvisionalTransfer({
      coordinator,
      projectId: record.projectId,
      receiverCredential: record.receiverCredential!,
      transferId: record.transferId,
    });
    if (
      listener.endpoint !== record.targetEndpoint
      || listener.caCertificatePem !== record.targetCaCertificatePem
      || listener.caFingerprint !== record.targetCaFingerprint
    ) {
      await this.options.lanHost.stopProvisionalTransfer(record.transferId).catch(() => undefined);
      throw preparationError('host-transfer-provisional-listener-drift');
    }
  }

  async cancelProvisional(record: HostTransferRecoveryRecord): Promise<void> {
    this.assertCleanupRecord(record);
    await this.options.lanHost.stopProvisionalTransfer(record.transferId);
    const removed = await this.options.workspace.removeReservedProjectsFolderChild(
      this.options.projectsFolder,
      this.ownership(record.projectId, record.transferId, record.stagingDirectoryName!),
    );
    // The terminal journal makes an absent operation-owned staging marker an
    // idempotent replay after a crash between cleanup and its checkpoint.
    void removed;
  }

  async completeProvisional(record: HostTransferRecoveryRecord): Promise<void> {
    this.assertCleanupRecord(record);
    await this.options.lanHost.stopProvisionalTransfer(record.transferId);
    await this.options.workspace.removeReservedProjectsFolderChild(
      this.options.projectsFolder,
      this.ownership(record.projectId, record.transferId, record.stagingDirectoryName!),
    );
  }

  async restoreTerminalReceipt(record: HostTransferRecoveryRecord): Promise<void> {
    this.assertTerminalReceipt(record);
    const listener = await this.options.lanHost.startProvisionalTransfer({
      coordinator: this.requireCoordinator(),
      projectId: record.projectId,
      receiverCredentialHash: record.receiverCredentialHash!,
      transferId: record.transferId,
    });
    if (
      listener.endpoint !== record.targetEndpoint
      || listener.caCertificatePem !== record.targetCaCertificatePem
      || listener.caFingerprint !== record.targetCaFingerprint
    ) {
      await this.options.lanHost.stopProvisionalTransfer(record.transferId).catch(() => undefined);
      throw preparationError('host-transfer-terminal-receipt-listener-drift');
    }
  }

  async confirmTerminalReceipt(record: HostTransferRecoveryRecord): Promise<void> {
    this.assertTerminalReceipt(record);
    await this.options.lanHost.stopProvisionalTransfer(record.transferId);
  }

  private async requireMembership(projectId: CollabProjectId): Promise<IncomingMembership> {
    const membership = await this.options.loadMembership(projectId);
    if (!membership || membership.project.id !== projectId) {
      throw preparationError('host-transfer-target-project-missing', 'authorization-denied');
    }
    return membership;
  }

  private requireCoordinator(): Pick<
    IncomingHostTransferCoordinator,
    'activate' | 'cancel' | 'complete' | 'confirm' | 'stage'
  > {
    if (!this.coordinator) throw preparationError('host-transfer-target-coordinator-unbound');
    return this.coordinator;
  }

  private assertTerminalReceipt(record: HostTransferRecoveryRecord): void {
    this.assertIdentity(record.projectId, record.transferId);
    if (
      !record.receiverCredentialHash
      || record.receiverCredential !== null
      || record.stagingDirectoryName !== null
      || !record.targetEndpoint
      || !record.targetCaCertificatePem
      || !record.targetCaFingerprint
    ) throw preparationError('host-transfer-terminal-receipt-invalid');
  }

  private assertRecord(record: HostTransferRecoveryRecord): void {
    this.assertIdentity(record.projectId, record.transferId);
    this.assertReceiverCredential(record.receiverCredential ?? '');
    if (record.stagingDirectoryName !== this.stagingName(record.transferId)) {
      throw preparationError('host-transfer-staging-name-invalid', 'workspace-boundary-invalid');
    }
    if (
      !record.targetEndpoint
      || !record.targetCaCertificatePem
      || !record.targetCaFingerprint
    ) throw preparationError('host-transfer-provisional-record-invalid');
  }

  private assertCleanupRecord(record: HostTransferRecoveryRecord): void {
    this.assertIdentity(record.projectId, record.transferId);
    if (record.receiverCredential !== null) {
      this.assertReceiverCredential(record.receiverCredential);
    } else if (!record.receiverCredentialHash) {
      throw preparationError('host-transfer-terminal-credential-missing');
    }
    if (record.stagingDirectoryName !== this.stagingName(record.transferId)) {
      throw preparationError('host-transfer-staging-name-invalid', 'workspace-boundary-invalid');
    }
    if (
      !record.targetEndpoint
      || !record.targetCaCertificatePem
      || !record.targetCaFingerprint
    ) throw preparationError('host-transfer-provisional-record-invalid');
  }

  private assertIdentity(projectId: string, transferId: string): void {
    if (!isCollabProjectId(projectId) || !isCollabOpaqueId(transferId)) {
      throw preparationError('host-transfer-target-identity-invalid');
    }
  }

  private assertReceiverCredential(credential: string): void {
    if (
      !RECEIVER_CREDENTIAL_PATTERN.test(credential)
      || Buffer.from(credential, 'base64url').byteLength !== 32
    ) throw preparationError('host-transfer-receiver-credential-invalid');
  }

  private stagingName(transferId: string): string {
    return `.claudian-host-transfer-${transferId}`;
  }

  private ownership(projectId: string, transferId: string, childName: string) {
    return {
      childName,
      operationId: transferId,
      projectId,
      purpose: 'host-transfer-staging' as const,
    };
  }
}
