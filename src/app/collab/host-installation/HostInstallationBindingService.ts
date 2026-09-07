import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabAuthorityInstallationStatus,
  CollabLocalProjectRepository,
  OwnedAuthorityDirectoryCapability,
  ProvisionalAuthorityDirectoryCapability,
} from '@/app/collab/CollabLocalProjectRepository';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  type InstallationKey,
  isInstallationKey,
  parseInstallationKey,
} from '@/core/device/InstallationKey';

export type HostAuthorityPurpose =
  | 'cleanup'
  | 'diagnostics'
  | 'open'
  | 'recover'
  | 'retire'
  | 'start';

export interface HostInstallationBindingServiceOptions {
  readonly bindEligibleLegacyRecovery: (
    projectId: CollabProjectId,
    installationKey: InstallationKey,
  ) => Promise<void>;
  readonly installationKey: InstallationKey;
  readonly prepareLegacyRuntime: (projectId: CollabProjectId) => Promise<void>;
  readonly projects: CollabLocalProjectRepository;
}

function bindingError(
  reason: string,
  code: 'authorization-denied' | 'durable-progress-recovery-required' = 'authorization-denied',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'durable-progress-recovery-required'
      ? ['resume', 'open-diagnostics']
      : ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class HostInstallationBindingService {
  private readonly installationKey: InstallationKey;
  private readonly operationQueue = new SerialTaskQueue();

  constructor(private readonly options: HostInstallationBindingServiceOptions) {
    this.installationKey = parseInstallationKey(options.installationKey);
  }

  inspect(projectId: CollabProjectId): Promise<CollabAuthorityInstallationStatus> {
    return this.options.projects.inspectAuthorityInstallation(projectId);
  }

  isRecoveryOwner(recordOwnerInstallationKey: unknown): boolean {
    return isInstallationKey(recordOwnerInstallationKey)
      && recordOwnerInstallationKey === this.installationKey;
  }

  async assertOwned(
    projectId: CollabProjectId,
    purpose: HostAuthorityPurpose,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    const capability = await this.assertOwnedAfterLegacyRecoveryBinding(projectId, purpose);
    await this.options.bindEligibleLegacyRecovery(projectId, this.installationKey);
    return capability;
  }

  async assertOwnedAfterLegacyRecoveryBinding(
    projectId: CollabProjectId,
    _purpose: HostAuthorityPurpose,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    const status = await this.inspect(projectId);
    if (status !== 'hosted-here') {
      throw bindingError(status === 'hosted-elsewhere'
        ? 'host-installation-owner-mismatch'
        : 'host-installation-not-owned');
    }
    return this.options.projects.assertOwnedAuthorityDirectory(projectId);
  }

  async createOwned(
    projectId: CollabProjectId,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    const status = await this.inspect(projectId);
    if (status === 'hosted-here') {
      return this.options.projects.assertOwnedAuthorityDirectory(projectId);
    }
    if (status !== 'absent') {
      throw bindingError(status === 'hosted-elsewhere'
        ? 'host-installation-owner-mismatch'
        : 'host-installation-legacy-claim-required');
    }
    return this.options.projects.createOwnedAuthorityDirectory(projectId);
  }

  async removeOwned(projectId: CollabProjectId): Promise<boolean> {
    const status = await this.inspect(projectId);
    if (status === 'absent') return false;
    if (status !== 'hosted-here') {
      throw bindingError(status === 'hosted-elsewhere'
        ? 'host-installation-owner-mismatch'
        : 'host-installation-not-owned');
    }
    const capability = await this.options.projects.assertOwnedAuthorityDirectory(projectId);
    return this.options.projects.removeOwnedAuthorityDirectory(capability);
  }

  claimLegacy(
    projectId: CollabProjectId,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    return this.operationQueue.run(async () => {
      const status = await this.inspect(projectId);
      if (status === 'hosted-here') {
        const capability = await this.options.projects.assertOwnedAuthorityDirectory(projectId);
        await this.options.bindEligibleLegacyRecovery(projectId, this.installationKey);
        return capability;
      }
      if (status !== 'legacy-unbound') {
        throw bindingError(status === 'hosted-elsewhere'
          ? 'host-installation-owner-mismatch'
          : 'host-installation-legacy-claim-unavailable');
      }
      await this.options.prepareLegacyRuntime(projectId);
      const preparedStatus = await this.inspect(projectId);
      if (preparedStatus === 'hosted-here') {
        const capability = await this.options.projects.assertOwnedAuthorityDirectory(projectId);
        await this.options.bindEligibleLegacyRecovery(projectId, this.installationKey);
        return capability;
      }
      if (preparedStatus !== 'legacy-unbound') {
        throw bindingError('host-installation-legacy-claim-changed');
      }
      const capability = await this.options.projects.claimLegacyAuthorityDirectory(projectId);
      await this.options.bindEligibleLegacyRecovery(projectId, this.installationKey);
      return capability;
    });
  }

  async bindTransferTarget(
    projectId: CollabProjectId,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    const status = await this.inspect(projectId);
    if (status === 'hosted-here') {
      return this.options.projects.assertOwnedAuthorityDirectory(projectId);
    }
    if (status !== 'absent') {
      throw bindingError(status === 'hosted-elsewhere'
        ? 'host-installation-owner-mismatch'
        : 'host-installation-target-not-empty');
    }
    return this.options.projects.createOwnedAuthorityDirectory(projectId);
  }

  prepareAuthorityTransferTarget(
    projectId: CollabProjectId,
    recordOwnerInstallationKey: unknown,
  ): Promise<ProvisionalAuthorityDirectoryCapability> {
    this.assertRecoveryOwner(
      recordOwnerInstallationKey,
      projectId,
      'authority-transfer-target',
    );
    return this.options.projects.prepareProvisionalAuthorityDirectory(projectId);
  }

  async activateAuthorityTransferTarget(
    projectId: CollabProjectId,
    recordOwnerInstallationKey: unknown,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    this.assertRecoveryOwner(
      recordOwnerInstallationKey,
      projectId,
      'authority-transfer-target',
    );
    const status = await this.inspect(projectId);
    if (status === 'hosted-here') {
      return this.options.projects.assertOwnedAuthorityDirectory(projectId);
    }
    if (status !== 'absent') {
      throw bindingError(status === 'hosted-elsewhere'
        ? 'host-installation-owner-mismatch'
        : 'host-installation-target-not-empty');
    }
    const provisional = await this.options.projects.recoverProvisionalAuthorityDirectory(projectId);
    if (!provisional) {
      throw bindingError(
        'host-installation-target-provisional-missing',
        'durable-progress-recovery-required',
      );
    }
    return this.options.projects.bindProvisionalAuthorityDirectory(provisional);
  }

  async discardAuthorityTransferTarget(
    projectId: CollabProjectId,
    recordOwnerInstallationKey: unknown,
  ): Promise<void> {
    this.assertRecoveryOwner(
      recordOwnerInstallationKey,
      projectId,
      'authority-transfer-target',
    );
    if (await this.inspect(projectId) !== 'absent') {
      throw bindingError('host-installation-target-not-provisional');
    }
    const provisional = await this.options.projects.prepareProvisionalAuthorityDirectory(projectId);
    await this.options.projects.removeProvisionalAuthorityDirectory(provisional);
  }

  assertOwnedRetirement(
    projectId: CollabProjectId,
    attemptId: string,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    return this.options.projects.assertOwnedAuthorityRetirement(projectId, attemptId);
  }

  assertRecoveryOwner(
    recordOwnerInstallationKey: unknown,
    _projectId: CollabProjectId,
    _recoveryKind: string,
  ): void {
    if (!this.isRecoveryOwner(recordOwnerInstallationKey)) {
      throw bindingError(
        'host-installation-recovery-owner-mismatch',
        'durable-progress-recovery-required',
      );
    }
  }
}
