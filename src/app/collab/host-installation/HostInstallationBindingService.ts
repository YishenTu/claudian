import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  AuthorityResourceOperation,
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
    operation: AuthorityResourceOperation | null = null,
    validateLegacy?: (resource: OwnedAuthorityDirectoryCapability) => Promise<void>,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    const status = await this.inspect(projectId);
    if (status === 'hosted-here') {
      const resource = await this.options.projects.assertOwnedAuthorityDirectory(projectId);
      if (operation === null) return resource;
      if (resource.operation === null) {
        if (!validateLegacy) throw bindingError('authority-resource-operation-mismatch', 'durable-progress-recovery-required');
        await validateLegacy(resource);
      }
      return this.options.projects.bindOwnedAuthorityOperation(resource, operation);
    }
    if (status !== 'absent') {
      throw bindingError(status === 'hosted-elsewhere'
        ? 'host-installation-owner-mismatch'
        : 'host-installation-legacy-claim-required');
    }
    return this.options.projects.createOwnedAuthorityDirectory(projectId, operation);
  }

  removeOwned(capability: OwnedAuthorityDirectoryCapability, operation: AuthorityResourceOperation | null = capability.operation): Promise<boolean> {
    return this.options.projects.removeOwnedAuthorityDirectory(capability, operation);
  }

  async captureStoppedAuthority(
    projectId: CollabProjectId,
    expectedGeneration: number,
    facts: {
      readonly isServing: () => boolean;
      readonly readProject: (resource: OwnedAuthorityDirectoryCapability) => Promise<{
        readonly projectId: CollabProjectId;
        readonly authorityGeneration: number;
      } | null>;
    },
  ): Promise<OwnedAuthorityDirectoryCapability | null> {
    const status = await this.inspect(projectId);
    if (status === 'absent') return null;
    const capability = await this.assertOwned(projectId, 'cleanup');
    const project = await facts.readProject(capability);
    if (facts.isServing() || !project || project.projectId !== projectId
      || project.authorityGeneration !== expectedGeneration) {
      throw bindingError('authority-transfer-former-source-not-replaceable', 'durable-progress-recovery-required');
    }
    await this.options.projects.validateOwnedAuthorityDirectory(capability);
    return capability;
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
    operation: AuthorityResourceOperation,
    validateLegacy: (authorityDirectory: string) => Promise<void>,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    const capability = await this.createOwned(projectId);
    if (capability.operation === null) await validateLegacy(capability.authorityDirectory);
    return this.options.projects.bindOwnedAuthorityOperation(capability, operation);
  }

  prepareAuthorityTransferTarget(
    projectId: CollabProjectId,
    recordOwnerInstallationKey: unknown,
    operation: AuthorityResourceOperation,
  ): Promise<ProvisionalAuthorityDirectoryCapability> {
    this.assertRecoveryOwner(recordOwnerInstallationKey, projectId, 'authority-transfer-target');
    return this.options.projects.prepareProvisionalAuthorityDirectory(projectId, operation);
  }

  async recoverAuthorityTransferTarget(
    projectId: CollabProjectId,
    recordOwnerInstallationKey: unknown,
    operation: AuthorityResourceOperation,
    validateLegacy?: (authorityDirectory: string) => Promise<void>,
  ): Promise<ProvisionalAuthorityDirectoryCapability | null> {
    this.assertRecoveryOwner(recordOwnerInstallationKey, projectId, 'authority-transfer-target');
    return validateLegacy
      ? this.options.projects.adoptLegacyProvisionalAuthorityDirectory(projectId, operation, validateLegacy)
      : this.options.projects.recoverProvisionalAuthorityDirectory(projectId, operation);
  }

  async activateAuthorityTransferTarget(
    capability: ProvisionalAuthorityDirectoryCapability,
  ): Promise<OwnedAuthorityDirectoryCapability> {
    this.assertRecoveryOwner(capability.ownerInstallationKey, capability.projectId, 'authority-transfer-target');
    return this.options.projects.bindProvisionalAuthorityDirectory(capability);
  }

  async discardAuthorityTransferTarget(
    projectId: CollabProjectId,
    recordOwnerInstallationKey: unknown,
    operation: AuthorityResourceOperation,
    validateLegacy?: (authorityDirectory: string) => Promise<void>,
  ): Promise<void> {
    this.assertRecoveryOwner(recordOwnerInstallationKey, projectId, 'authority-transfer-target');
    await this.options.projects.resumeAuthorityDirectoryRemovals(projectId, operation);
    const provisional = await this.recoverAuthorityTransferTarget(
      projectId, recordOwnerInstallationKey, operation, validateLegacy,
    );
    if (provisional !== null) await this.options.projects.removeProvisionalAuthorityDirectory(provisional);
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
