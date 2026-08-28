import { type CollabOperationId, type CollabProjectId } from '@claudian-collab/protocol';

import type { HostTransferAuthorityRecord } from '@/app/collab/authority/HostTransferRepository';
import type {
  HostTransferAdmissionPort,
  HostTransferAuthorityPort,
  HostTransferPackagePreparationPort,
  HostTransferProjectionPort,
  HostTransferRecoveryStorePort,
  HostTransferSourceIdentityPort,
  HostTransferTargetTransportPort,
  PreparedHostTransferPackage,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import {
  advanceHostTransferRecoveryRecord,
  createHostTransferRecoveryRecord,
  parseHostTransferActivationCertificate,
} from '@/app/collab/host-transfer/HostTransferRecovery';
import type { HostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface OutgoingHostTransferCoordinatorOptions {
  readonly installationKey: InstallationKey | string;
  readonly now?: () => Date;
  readonly syncProjection?: (projectId: CollabProjectId) => void;
  readonly trust?: HostTrustTransitionService;
}

function outgoingError(
  reason: string,
  code: 'cancelled' | 'durable-progress-recovery-required' | 'operation-failed'
    = 'durable-progress-recovery-required',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'cancelled' ? ['retry'] : ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw outgoingError('host-transfer-outgoing-cancelled', 'cancelled');
}

function isBeforeRelinquishment(phase: HostTransferRecoveryRecord['phase']): boolean {
  return phase === 'accepted' || phase === 'quiescing' || phase === 'staged';
}

function isAfterRelinquishment(phase: HostTransferRecoveryRecord['phase']): boolean {
  return phase === 'authority-relinquished'
    || phase === 'target-active'
    || phase === 'completed';
}

const PHASE_ORDER: Readonly<Record<HostTransferRecoveryRecord['phase'], number>> = {
  offered: 0,
  accepted: 1,
  quiescing: 2,
  staged: 3,
  'authority-relinquished': 4,
  'target-active': 5,
  completed: 6,
  cancelled: 7,
  declined: 7,
  expired: 7,
};

export class OutgoingHostTransferCoordinator {
  private readonly now: () => Date;
  private readonly operationQueue = new SerialTaskQueue();
  private readonly trust: HostTrustTransitionService;

  constructor(
    private readonly authority: HostTransferAuthorityPort,
    private readonly admission: HostTransferAdmissionPort,
    private readonly packages: HostTransferPackagePreparationPort,
    private readonly target: HostTransferTargetTransportPort,
    private readonly identity: HostTransferSourceIdentityPort,
    private readonly projections: HostTransferProjectionPort,
    private readonly recovery: HostTransferRecoveryStorePort,
    private readonly options: OutgoingHostTransferCoordinatorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.trust = options.trust ?? new HostTrustTransitionService();
  }

  run(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.operationQueue.run(() => this.runUnlocked(projectId, transferId, signal));
  }

  prepareAccepted(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      await this.loadOrCreateRecord(projectId, transferId);
    });
  }

  prepareCancellation(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      const authority = await this.authority.getTransfer(transferId);
      if (!authority || authority.transferId !== transferId) {
        throw outgoingError('host-transfer-authority-record-missing');
      }
      if (authority.phase === 'offered' || authority.phase === 'cancelled') return;
      if (
        authority.phase !== 'accepted'
        && authority.phase !== 'quiescing'
        && authority.phase !== 'staged'
      ) throw outgoingError('host-transfer-cancellation-unavailable');
      await this.loadOrCreateRecord(projectId, transferId);
    });
  }

  inspectStartupRecovery(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<
    'post-relinquishment' | 'pre-relinquishment' | 'pre-relinquishment-cleanup'
  > {
    return this.operationQueue.run(async () => {
      const [local, authority] = await Promise.all([
        this.recovery.load(projectId, 'outgoing'),
        this.authority.getTransfer(transferId),
      ]);
      if (
        !local
        || local.projectId !== projectId
        || local.transferId !== transferId
        || !authority
        || authority.transferId !== transferId
      ) throw outgoingError('host-transfer-startup-recovery-missing');
      if (
        local.sourceHostMemberId !== authority.sourceHostMemberId
        || local.targetHostMemberId !== authority.targetHostMemberId
        || local.targetEndpoint !== authority.targetEndpoint
        || local.targetCaFingerprint !== authority.targetCaFingerprint
      ) throw outgoingError('host-transfer-recovery-authority-mismatch');
      const authorityAfterRelinquishment = authority.phase === 'authority-relinquished'
        || authority.phase === 'target-active'
        || authority.phase === 'completed';
      const localAfterRelinquishment = local.phase === 'authority-relinquished'
        || local.phase === 'target-active'
        || local.phase === 'completed';
      const authorityTerminal = authority.phase === 'cancelled'
        || authority.phase === 'declined'
        || authority.phase === 'expired';
      const localTerminal = local.phase === 'cancelled'
        || local.phase === 'declined'
        || local.phase === 'expired';
      if (authorityTerminal || localTerminal) {
        if (
          !authorityTerminal
          || (localTerminal && local.phase !== authority.phase)
          || localAfterRelinquishment
        ) throw outgoingError('host-transfer-terminal-recovery-mismatch');
        return 'pre-relinquishment-cleanup';
      }
      return authorityAfterRelinquishment || localAfterRelinquishment
        ? 'post-relinquishment'
        : 'pre-relinquishment';
    });
  }

  prepareTerminalRecoveryBeforeStartup(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      const record = await this.recovery.load(projectId, 'outgoing');
      const authorityRecord = await this.authority.getTransfer(transferId);
      if (
        !record
        || record.transferId !== transferId
        || !authorityRecord
        || authorityRecord.transferId !== transferId
      ) throw outgoingError('host-transfer-startup-recovery-missing');
      const reconciled = await this.reconcileRecovery(record, authorityRecord);
      if (
        reconciled.phase !== 'cancelled'
        && reconciled.phase !== 'declined'
        && reconciled.phase !== 'expired'
      ) throw outgoingError('host-transfer-startup-terminal-recovery-missing');
      await this.checkpointTargetCancellation(reconciled);
    });
  }

  cancelBeforeRelinquishment(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      const record = await this.recovery.load(projectId, 'outgoing');
      const authorityRecord = await this.authority.getTransfer(transferId);
      if (!record && authorityRecord?.phase === 'cancelled') {
        return;
      }
      if (!record || record.transferId !== transferId) {
        throw outgoingError('host-transfer-cancellation-recovery-missing');
      }
      if (!authorityRecord || authorityRecord.phase !== 'cancelled') {
        throw outgoingError('host-transfer-cancellation-not-durable');
      }
      const reconciled = await this.reconcileRecovery(record, authorityRecord);
      if (reconciled.phase !== 'cancelled') {
        throw outgoingError('host-transfer-cancellation-phase-mismatch');
      }
      await this.finishTerminalRecovery(reconciled);
    });
  }

  private async runUnlocked(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<void> {
    let record = await this.loadOrCreateRecord(projectId, transferId);
    try {
      while (record.phase !== 'completed') {
        throwIfCancelled(signal);
        if (record.phase === 'accepted') {
          await this.target.probe({
            endpoint: record.targetEndpoint!,
            receiverCredential: record.receiverCredential!,
            targetCaCertificatePem: record.targetCaCertificatePem!,
            targetCaFingerprint: record.targetCaFingerprint!,
            transferId,
            ...(signal ? { signal } : {}),
          });
          await this.authority.advance({
            expectedPhase: 'accepted',
            nextPhase: 'quiescing',
            transferId,
          });
          await this.admission.quiesceAndDrain(projectId, transferId, signal);
          record = advanceHostTransferRecoveryRecord(
            record,
            'quiescing',
            this.now().toISOString(),
          );
          await this.recovery.save(record);
          continue;
        }
        if (record.phase === 'quiescing') {
          await this.admission.quiesceAndDrain(projectId, transferId, signal);
          await this.admission.assertAcceptanceSettled(projectId);
          const signer = await this.identity.hostCaSigner();
          const proof = await this.trust.signTransition(signer, {
            issuedAt: this.now().toISOString(),
            nextCaCertificatePem: record.targetCaCertificatePem!,
            projectId,
            transferId,
          });
          const prepared = await this.packages.prepare({
            projectId,
            proof,
            targetCaFingerprint: record.targetCaFingerprint!,
            targetHostMemberId: record.targetHostMemberId,
            transferId,
            ...(signal ? { signal } : {}),
          });
          this.assertPreparedPackage(record, prepared);
          const acknowledgement = await this.target.stage({
            authoritySnapshot: prepared.authoritySnapshot,
            endpoint: record.targetEndpoint!,
            gitBundle: prepared.gitBundle,
            manifest: prepared.manifest,
            receiverCredential: record.receiverCredential!,
            targetCaCertificatePem: record.targetCaCertificatePem!,
            targetCaFingerprint: record.targetCaFingerprint!,
            transferId,
            ...(signal ? { signal } : {}),
          });
          if (acknowledgement.manifestDigest !== prepared.manifestDigest) {
            throw outgoingError('host-transfer-package-acknowledgement-mismatch');
          }
          await this.authority.advance({
            expectedPhase: 'quiescing',
            manifestDigest: prepared.manifestDigest,
            nextPhase: 'staged',
            transferId,
          });
          record = advanceHostTransferRecoveryRecord(
            record,
            'staged',
            this.now().toISOString(),
            { manifestDigest: prepared.manifestDigest },
          );
          await this.recovery.save(record);
          continue;
        }
        if (record.phase === 'staged') {
          const prepared = await this.packages.restore({
            manifestDigest: record.manifestDigest!,
            projectId,
            transferId,
            ...(signal ? { signal } : {}),
          });
          this.assertPreparedPackage(record, prepared);
          const signer = await this.identity.hostCaSigner();
          const activationCertificate = await this.trust.signActivation(signer, {
            cutoverAt: this.now().toISOString(),
            manifestDigest: record.manifestDigest!,
            projectId,
            targetCaFingerprint: record.targetCaFingerprint!,
            targetHostMemberId: record.targetHostMemberId,
            transferId,
          });
          const relinquished = await this.authority.relinquish({
            activationCertificate,
            previousCaCertificatePem: signer.caCertificatePem,
            projectId,
            proof: prepared.proof,
            transferId,
          });
          if (relinquished.phase !== 'authority-relinquished') {
            throw outgoingError('host-transfer-relinquishment-not-durable');
          }
          await this.admission.closeActiveAuthority(projectId, transferId);
          record = advanceHostTransferRecoveryRecord(
            record,
            'authority-relinquished',
            this.now().toISOString(),
            { activationCertificate },
          );
          await this.recovery.save(record);
          continue;
        }
        if (record.phase === 'authority-relinquished') {
          await this.admission.closeActiveAuthority(projectId, transferId);
          const activationCertificate = parseHostTransferActivationCertificate(record);
          await this.target.activate({
            activationCertificate,
            endpoint: record.targetEndpoint!,
            receiverCredential: record.receiverCredential!,
            targetCaCertificatePem: record.targetCaCertificatePem!,
            targetCaFingerprint: record.targetCaFingerprint!,
            transferId,
            ...(signal ? { signal } : {}),
          });
          await this.authority.advance({
            expectedPhase: 'authority-relinquished',
            nextPhase: 'target-active',
            transferId,
          });
          record = advanceHostTransferRecoveryRecord(
            record,
            'target-active',
            this.now().toISOString(),
          );
          await this.recovery.save(record);
          continue;
        }
        if (record.phase === 'target-active') {
          await this.admission.closeActiveAuthority(projectId, transferId);
          const memberCredential = await this.identity.memberCredential(projectId);
          await this.target.verifyActive({
            endpoint: record.targetEndpoint!,
            memberCredential,
            projectId,
            targetCaCertificatePem: record.targetCaCertificatePem!,
            targetCaFingerprint: record.targetCaFingerprint!,
            targetHostMemberId: record.targetHostMemberId,
            ...(signal ? { signal } : {}),
          });
          const prepared = await this.packages.restore({
            manifestDigest: record.manifestDigest!,
            projectId,
            transferId,
            ...(signal ? { signal } : {}),
          });
          await this.projections.demoteSourceHost({
            autoStart: false,
            endpoint: record.targetEndpoint!,
            ownsAuthority: false,
            projectId,
            proof: prepared.proof,
            targetCaCertificatePem: record.targetCaCertificatePem!,
            targetCaFingerprint: record.targetCaFingerprint!,
            targetHostMemberId: record.targetHostMemberId,
            transferId,
          });
          this.options.syncProjection?.(projectId);
          await this.authority.advance({
            expectedPhase: 'target-active',
            nextPhase: 'completed',
            transferId,
          });
          record = advanceHostTransferRecoveryRecord(
            record,
            'completed',
            this.now().toISOString(),
          );
          await this.recovery.save(record);
          continue;
        }
        if (
          record.phase === 'cancelled'
          || record.phase === 'declined'
          || record.phase === 'expired'
        ) {
          await this.finishTerminalRecovery(record);
          return;
        }
        throw outgoingError('host-transfer-outgoing-phase-invalid');
      }
      await this.admission.closeActiveAuthority(projectId, transferId);
      await this.target.markCompleted({
        endpoint: record.targetEndpoint!,
        receiverCredential: record.receiverCredential!,
        targetCaCertificatePem: record.targetCaCertificatePem!,
        targetCaFingerprint: record.targetCaFingerprint!,
        transferId,
        ...(signal ? { signal } : {}),
      });
      record = advanceHostTransferRecoveryRecord(
        record,
        'completed',
        this.now().toISOString(),
        { targetTerminalResponseReceived: true },
      );
      await this.recovery.save(record);
      await this.admission.finalizeOldAuthority(projectId, transferId);
      await this.confirmTargetTerminalReceipt(record, signal).catch(() => undefined);
      await this.recovery.remove(projectId, 'outgoing');
    } catch (error) {
      if (isAfterRelinquishment(record.phase)) {
        await this.admission.closeActiveAuthority(projectId, transferId).catch(() => undefined);
      }
      throw error;
    }
  }

  private async loadOrCreateRecord(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<HostTransferRecoveryRecord> {
    const existing = await this.recovery.load(projectId, 'outgoing');
    const authorityRecord = await this.authority.getTransfer(transferId);
    if (!authorityRecord || authorityRecord.transferId !== transferId) {
      throw outgoingError('host-transfer-authority-record-missing');
    }
    if (existing) {
      if (existing.transferId !== transferId) {
        throw outgoingError('host-transfer-outgoing-operation-mismatch');
      }
      return this.reconcileRecovery(existing, authorityRecord);
    }
    if (
      (authorityRecord.phase !== 'accepted'
        && authorityRecord.phase !== 'quiescing'
        && authorityRecord.phase !== 'staged')
      || !authorityRecord.targetEndpoint
      || !authorityRecord.targetCaCertificatePem
      || !authorityRecord.targetCaFingerprint
      || !authorityRecord.receiverCredential
    ) throw outgoingError('host-transfer-authority-not-accepted');
    const record = createHostTransferRecoveryRecord({
      createdAt: authorityRecord.updatedAt,
      direction: 'outgoing',
      ownerInstallationKey: this.options.installationKey,
      projectId,
      receiverCredential: authorityRecord.receiverCredential,
      sourceHostMemberId: authorityRecord.sourceHostMemberId,
      targetCaCertificatePem: authorityRecord.targetCaCertificatePem,
      targetCaFingerprint: authorityRecord.targetCaFingerprint,
      targetEndpoint: authorityRecord.targetEndpoint,
      targetHostMemberId: authorityRecord.targetHostMemberId,
      transferId,
    });
    await this.recovery.save(record);
    return this.reconcileRecovery(record, authorityRecord);
  }

  private async reconcileRecovery(
    local: HostTransferRecoveryRecord,
    authority: HostTransferAuthorityRecord,
  ): Promise<HostTransferRecoveryRecord> {
    if (
      local.sourceHostMemberId !== authority.sourceHostMemberId
      || local.targetHostMemberId !== authority.targetHostMemberId
      || local.targetEndpoint !== authority.targetEndpoint
      || local.targetCaFingerprint !== authority.targetCaFingerprint
    ) throw outgoingError('host-transfer-recovery-authority-mismatch');
    if (authority.phase === 'cancelled' || authority.phase === 'declined' || authority.phase === 'expired') {
      const terminalPhase = authority.phase === 'cancelled'
        ? 'cancelled' as const
        : authority.phase === 'declined'
          ? 'declined' as const
          : 'expired' as const;
      if (
        local.phase === 'cancelled'
        || local.phase === 'declined'
        || local.phase === 'expired'
      ) {
        if (local.phase !== terminalPhase) {
          throw outgoingError('host-transfer-terminal-phase-mismatch');
        }
        return local;
      }
      if (!isBeforeRelinquishment(local.phase)) {
        throw outgoingError('host-transfer-terminal-after-relinquishment');
      }
      const terminal = advanceHostTransferRecoveryRecord(
        local,
        terminalPhase,
        this.now().toISOString(),
      );
      await this.recovery.save(terminal);
      return terminal;
    }
    if (PHASE_ORDER[local.phase] > PHASE_ORDER[authority.phase]) {
      throw outgoingError('host-transfer-local-phase-ahead');
    }
    let reconciled = local;
    if (PHASE_ORDER[authority.phase] >= PHASE_ORDER.quiescing && reconciled.phase === 'accepted') {
      reconciled = advanceHostTransferRecoveryRecord(
        reconciled,
        'quiescing',
        this.now().toISOString(),
      );
    }
    if (PHASE_ORDER[authority.phase] >= PHASE_ORDER.staged && reconciled.phase === 'quiescing') {
      if (!authority.manifestDigest) throw outgoingError('host-transfer-authority-manifest-missing');
      const manifestDigest: string = authority.manifestDigest;
      reconciled = advanceHostTransferRecoveryRecord(
        reconciled,
        'staged',
        this.now().toISOString(),
        { manifestDigest },
      );
    }
    if (
      PHASE_ORDER[authority.phase] >= PHASE_ORDER['authority-relinquished']
      && reconciled.phase === 'staged'
    ) {
      if (!authority.activationCertificate) {
        throw outgoingError('host-transfer-authority-activation-missing');
      }
      const activationCertificate = authority.activationCertificate;
      reconciled = advanceHostTransferRecoveryRecord(
        reconciled,
        'authority-relinquished',
        this.now().toISOString(),
        { activationCertificate },
      );
    }
    if (PHASE_ORDER[authority.phase] >= PHASE_ORDER['target-active']
      && reconciled.phase === 'authority-relinquished') {
      reconciled = advanceHostTransferRecoveryRecord(
        reconciled,
        'target-active',
        this.now().toISOString(),
      );
    }
    if (authority.phase === 'completed' && reconciled.phase === 'target-active') {
      reconciled = advanceHostTransferRecoveryRecord(
        reconciled,
        'completed',
        this.now().toISOString(),
      );
    }
    if (reconciled !== local) await this.recovery.save(reconciled);
    return reconciled;
  }

  private async finishTerminalRecovery(
    record: HostTransferRecoveryRecord,
  ): Promise<void> {
    const checkpoint = await this.checkpointTargetCancellation(record);
    await this.admission.reopenBeforeRelinquishment(
      checkpoint.projectId,
      checkpoint.transferId,
    );
    await this.confirmTargetTerminalReceipt(checkpoint).catch(() => undefined);
    await this.recovery.remove(checkpoint.projectId, 'outgoing');
  }

  private async checkpointTargetCancellation(
    record: HostTransferRecoveryRecord,
  ): Promise<HostTransferRecoveryRecord> {
    if (record.targetTerminalResponseReceived) return record;
    await this.target.cancel({
      endpoint: record.targetEndpoint!,
      receiverCredential: record.receiverCredential!,
      targetCaCertificatePem: record.targetCaCertificatePem!,
      targetCaFingerprint: record.targetCaFingerprint!,
      transferId: record.transferId,
    });
    const checkpoint = advanceHostTransferRecoveryRecord(
      record,
      record.phase,
      this.now().toISOString(),
      { targetTerminalResponseReceived: true },
    );
    await this.recovery.save(checkpoint);
    return checkpoint;
  }

  private async confirmTargetTerminalReceipt(
    record: HostTransferRecoveryRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!record.targetTerminalResponseReceived) return;
    await this.target.confirmTerminal({
      endpoint: record.targetEndpoint!,
      receiverCredential: record.receiverCredential!,
      targetCaCertificatePem: record.targetCaCertificatePem!,
      targetCaFingerprint: record.targetCaFingerprint!,
      transferId: record.transferId,
      ...(signal ? { signal } : {}),
    });
  }

  private assertPreparedPackage(
    record: HostTransferRecoveryRecord,
    prepared: PreparedHostTransferPackage,
  ): void {
    if (
      prepared.manifest.projectId !== record.projectId
      || prepared.manifest.transferId !== record.transferId
      || prepared.manifest.targetHostMemberId !== record.targetHostMemberId
      || prepared.manifest.targetCaFingerprint !== record.targetCaFingerprint
      || (record.manifestDigest !== null && prepared.manifestDigest !== record.manifestDigest)
      || prepared.proof.projectId !== record.projectId
      || prepared.proof.transferId !== record.transferId
      || prepared.proof.nextCaFingerprint !== record.targetCaFingerprint
    ) throw outgoingError('host-transfer-prepared-package-binding-invalid');
  }
}
