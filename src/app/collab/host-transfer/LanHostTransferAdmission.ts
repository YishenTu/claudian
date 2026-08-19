import { type CollabOperationId, type CollabProjectId } from '@claudian/collab-protocol';

import type { HostTransferAdmissionPort } from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface LanHostTransferAdmissionHostPort {
  closeProjectForHostTransfer(projectId: CollabProjectId): Promise<void>;
  completeProjectHostTransfer(projectId: CollabProjectId): Promise<void>;
  quiesceProjectForHostTransfer(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<void>;
  reopenProjectBeforeHostTransfer(projectId: CollabProjectId): Promise<void>;
}

export interface LanHostTransferAdmissionOptions {
  readonly assertAcceptanceSettled: () => Promise<void>;
  readonly finalizeOldAuthority: () => Promise<void>;
}

function admissionError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

export class LanHostTransferAdmission implements HostTransferAdmissionPort {
  constructor(
    private readonly projectId: CollabProjectId,
    private readonly transferId: CollabOperationId,
    private readonly host: LanHostTransferAdmissionHostPort,
    private readonly options: LanHostTransferAdmissionOptions,
  ) {}

  quiesceAndDrain(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertIdentity(projectId, transferId);
    return this.host.quiesceProjectForHostTransfer(projectId, signal);
  }

  async assertAcceptanceSettled(projectId: CollabProjectId): Promise<void> {
    this.assertProject(projectId);
    await this.options.assertAcceptanceSettled();
  }

  closeActiveAuthority(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    this.assertIdentity(projectId, transferId);
    return this.host.closeProjectForHostTransfer(projectId);
  }

  reopenBeforeRelinquishment(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    this.assertIdentity(projectId, transferId);
    return this.host.reopenProjectBeforeHostTransfer(projectId);
  }

  async finalizeOldAuthority(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    this.assertIdentity(projectId, transferId);
    await this.options.finalizeOldAuthority();
    await this.host.completeProjectHostTransfer(projectId);
  }

  private assertIdentity(projectId: CollabProjectId, transferId: CollabOperationId): void {
    this.assertProject(projectId);
    if (transferId !== this.transferId) {
      throw admissionError('host-transfer-admission-transfer-mismatch');
    }
  }

  private assertProject(projectId: CollabProjectId): void {
    if (projectId !== this.projectId) {
      throw admissionError('host-transfer-admission-project-mismatch');
    }
  }
}
