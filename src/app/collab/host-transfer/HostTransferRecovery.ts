import type { CollabMemberId, CollabOperationId, CollabProjectId } from '@claudian-collab/protocol';

import {
  decodeHostTransferRecoveryRecord,
  type HostTransferRecoveryDirection,
  type HostTransferRecoveryPhase,
  type HostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import type {
  HostTransferActivationCertificate,
} from '@/app/collab/host-transfer/HostTrustTransitionService';
import type { InstallationKey } from '@/core/device/InstallationKey';

export function createIncomingHostTransferIntentRecord(input: {
  readonly createdAt: string;
  readonly ownerInstallationKey: InstallationKey | string;
  readonly projectId: CollabProjectId;
  readonly sourceHostMemberId: CollabMemberId;
  readonly targetHostMemberId: CollabMemberId;
  readonly transferId: CollabOperationId;
}): HostTransferRecoveryRecord {
  return decodeHostTransferRecoveryRecord({
    activationCertificate: null,
    createdAt: input.createdAt,
    direction: 'incoming',
    kind: 'host-transfer-recovery',
    manifestDigest: null,
    ownerInstallationKey: input.ownerInstallationKey,
    phase: 'offered',
    projectId: input.projectId,
    receiverCredential: null,
    receiverCredentialHash: null,
    schemaVersion: 2,
    sourceHostMemberId: input.sourceHostMemberId,
    stagingDirectoryName: null,
    targetCaCertificatePem: null,
    targetCaFingerprint: null,
    targetEndpoint: null,
    targetHostMemberId: input.targetHostMemberId,
    targetTerminalResponseReceived: false,
    transferId: input.transferId,
    updatedAt: input.createdAt,
  });
}

export function createHostTransferRecoveryRecord(input: {
  readonly createdAt: string;
  readonly direction: HostTransferRecoveryDirection;
  readonly ownerInstallationKey: InstallationKey | string;
  readonly projectId: CollabProjectId;
  readonly receiverCredential?: string | null;
  readonly sourceHostMemberId: CollabMemberId;
  readonly stagingDirectoryName?: string | null;
  readonly targetCaCertificatePem?: string | null;
  readonly targetCaFingerprint?: string | null;
  readonly targetEndpoint?: string | null;
  readonly targetHostMemberId: CollabMemberId;
  readonly transferId: CollabOperationId;
}): HostTransferRecoveryRecord {
  return decodeHostTransferRecoveryRecord({
    activationCertificate: null,
    createdAt: input.createdAt,
    direction: input.direction,
    kind: 'host-transfer-recovery',
    manifestDigest: null,
    ownerInstallationKey: input.ownerInstallationKey,
    phase: 'accepted',
    projectId: input.projectId,
    receiverCredential: input.receiverCredential ?? null,
    receiverCredentialHash: null,
    schemaVersion: 2,
    sourceHostMemberId: input.sourceHostMemberId,
    stagingDirectoryName: input.stagingDirectoryName ?? null,
    targetCaCertificatePem: input.targetCaCertificatePem ?? null,
    targetCaFingerprint: input.targetCaFingerprint ?? null,
    targetEndpoint: input.targetEndpoint ?? null,
    targetHostMemberId: input.targetHostMemberId,
    targetTerminalResponseReceived: false,
    transferId: input.transferId,
    updatedAt: input.createdAt,
  });
}

export function advanceHostTransferRecoveryRecord(
  record: HostTransferRecoveryRecord,
  phase: HostTransferRecoveryPhase,
  updatedAt: string,
  options: {
    readonly activationCertificate?: HostTransferActivationCertificate;
    readonly manifestDigest?: string;
    readonly targetTerminalResponseReceived?: boolean;
    readonly terminalCleanupComplete?: boolean;
    readonly terminalReceiptCredentialHash?: string;
  } = {},
): HostTransferRecoveryRecord {
  const targetTerminalResponseReceived = options.targetTerminalResponseReceived === true
    || record.targetTerminalResponseReceived;
  const terminalReceiptCredentialHash = options.terminalReceiptCredentialHash;
  return decodeHostTransferRecoveryRecord({
    ...record,
    activationCertificate: options.activationCertificate === undefined
      ? record.activationCertificate
      : JSON.stringify(options.activationCertificate),
    manifestDigest: options.manifestDigest ?? record.manifestDigest,
    phase,
    receiverCredential: terminalReceiptCredentialHash !== undefined
      ? null
      : record.receiverCredential,
    receiverCredentialHash: terminalReceiptCredentialHash ?? record.receiverCredentialHash,
    stagingDirectoryName: options.terminalCleanupComplete === true
      ? null
      : record.stagingDirectoryName,
    targetTerminalResponseReceived,
    updatedAt,
  });
}

export function parseHostTransferActivationCertificate(
  record: HostTransferRecoveryRecord,
): HostTransferActivationCertificate {
  if (!record.activationCertificate) throw new TypeError('Activation certificate is missing');
  const value = JSON.parse(record.activationCertificate) as HostTransferActivationCertificate;
  if (
    !value
    || value.schemaVersion !== 1
    || value.projectId !== record.projectId
    || value.transferId !== record.transferId
    || value.targetHostMemberId !== record.targetHostMemberId
    || value.manifestDigest !== record.manifestDigest
    || value.targetCaFingerprint !== record.targetCaFingerprint
    || value.signatureAlgorithm !== 'rsa-pss-sha256'
    || typeof value.signature !== 'string'
  ) throw new TypeError('Activation certificate is invalid');
  return value;
}
