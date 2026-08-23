import type { CollabMemberId, CollabOperationId, CollabProjectId } from '@claudian-collab/protocol';

import type {
  HostTransferAuthorityRecord,
} from '@/app/collab/authority/HostTransferRepository';
import type {
  HostTransferPackageManifest,
} from '@/app/collab/host-transfer/HostTransferPackage';
import type {
  HostTransferRecoveryDirection,
  HostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import type {
  HostTransferActivationCertificate,
} from '@/app/collab/host-transfer/HostTrustTransitionService';
import type { AcceptHostTransferRequest } from '@/app/collab/lan/LanCollabControlOperations';
import type { LanTlsHostCaSigner } from '@/app/collab/lan/LanTlsIdentity';
import type { CollabHostTransferSummary, CollabHostTrustTransitionProof } from '@/core/collab';

export interface HostTransferRecoveryStorePort {
  load(
    projectId: CollabProjectId,
    direction: HostTransferRecoveryDirection,
  ): Promise<HostTransferRecoveryRecord | null>;
  save(record: HostTransferRecoveryRecord): Promise<void>;
  remove(
    projectId: CollabProjectId,
    direction: HostTransferRecoveryDirection,
  ): Promise<void>;
}

export interface HostTransferAuthorityPort {
  getTransfer(transferId: CollabOperationId): Promise<HostTransferAuthorityRecord | null>;
  advance(input: {
    readonly expectedPhase: HostTransferAuthorityRecord['phase'];
    readonly manifestDigest?: string;
    readonly nextPhase: HostTransferAuthorityRecord['phase'];
    readonly transferId: CollabOperationId;
  }): Promise<HostTransferAuthorityRecord>;
  relinquish(input: {
    readonly activationCertificate: HostTransferActivationCertificate;
    readonly previousCaCertificatePem: string;
    readonly projectId: CollabProjectId;
    readonly proof: CollabHostTrustTransitionProof;
    readonly transferId: CollabOperationId;
  }): Promise<HostTransferAuthorityRecord>;
}

export interface IncomingHostTransferAuthorityClientPort {
  accept(request: AcceptHostTransferRequest): Promise<CollabHostTransferSummary>;
}

export interface HostTransferAdmissionPort {
  quiesceAndDrain(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<void>;
  assertAcceptanceSettled(projectId: CollabProjectId): Promise<void>;
  closeActiveAuthority(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void>;
  reopenBeforeRelinquishment(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void>;
  finalizeOldAuthority(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void>;
}

export interface PreparedHostTransferPackage {
  readonly manifest: HostTransferPackageManifest;
  readonly manifestDigest: string;
  readonly proof: CollabHostTrustTransitionProof;
  readonly gitBundle: AsyncIterable<Uint8Array>;
  readonly authoritySnapshot: AsyncIterable<Uint8Array>;
}

export interface HostTransferPackagePreparationPort {
  prepare(input: {
    readonly projectId: CollabProjectId;
    readonly proof: CollabHostTrustTransitionProof;
    readonly targetCaFingerprint: string;
    readonly targetHostMemberId: CollabMemberId;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<PreparedHostTransferPackage>;
  restore(input: {
    readonly manifestDigest: string;
    readonly projectId: CollabProjectId;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<PreparedHostTransferPackage>;
}

export interface HostTransferSourceIdentityPort {
  hostCaSigner(): Promise<LanTlsHostCaSigner>;
  memberCredential(projectId: CollabProjectId): Promise<string>;
}

export interface HostTransferTargetTransportPort {
  probe(input: {
    readonly endpoint: string;
    readonly receiverCredential: string;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  stage(input: {
    readonly authoritySnapshot: AsyncIterable<Uint8Array>;
    readonly endpoint: string;
    readonly gitBundle: AsyncIterable<Uint8Array>;
    readonly manifest: HostTransferPackageManifest;
    readonly receiverCredential: string;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly manifestDigest: string }>;
  activate(input: {
    readonly activationCertificate: HostTransferActivationCertificate;
    readonly endpoint: string;
    readonly receiverCredential: string;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  cancel(input: {
    readonly endpoint: string;
    readonly receiverCredential: string;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  verifyActive(input: {
    readonly endpoint: string;
    readonly memberCredential: string;
    readonly projectId: CollabProjectId;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly targetHostMemberId: CollabMemberId;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  markCompleted(input: {
    readonly endpoint: string;
    readonly receiverCredential: string;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  confirmTerminal(input: {
    readonly endpoint: string;
    readonly receiverCredential: string;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export interface IncomingHostTransferPreparationPort {
  assertEligible(input: {
    readonly projectId: CollabProjectId;
    readonly targetMemberId: CollabMemberId;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  startProvisional(input: {
    readonly projectId: CollabProjectId;
    readonly transferId: CollabOperationId;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly endpoint: string;
    readonly receiverCredential: string;
    readonly stagingDirectoryName: string;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
  }>;
  restoreProvisional(record: HostTransferRecoveryRecord): Promise<void>;
  cancelProvisional(record: HostTransferRecoveryRecord): Promise<void>;
  completeProvisional(record: HostTransferRecoveryRecord): Promise<void>;
  confirmTerminalReceipt(record: HostTransferRecoveryRecord): Promise<void>;
  restoreTerminalReceipt(record: HostTransferRecoveryRecord): Promise<void>;
}

export interface IncomingHostTransferPackagePort {
  stageAndValidate(input: {
    readonly authoritySnapshot: AsyncIterable<Uint8Array>;
    readonly gitBundle: AsyncIterable<Uint8Array>;
    readonly manifest: HostTransferPackageManifest;
    readonly record: HostTransferRecoveryRecord;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly manifestDigest: string }>;
  installAndActivate(input: {
    readonly activationCertificate: HostTransferActivationCertificate;
    readonly manifestDigest: string;
    readonly record: HostTransferRecoveryRecord;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly eventSequence: number;
  }>;
}

export interface IncomingHostTransferActivationPort {
  activate(input: {
    readonly projectId: CollabProjectId;
    readonly targetHostMemberId: CollabMemberId;
    readonly transferId: CollabOperationId;
  }): Promise<{ readonly endpoint: string }>;
}

export interface HostTransferProjectionPort {
  readPinnedSourceCa(projectId: CollabProjectId): Promise<string>;
  promoteTargetHost(input: {
    readonly autoStart: true;
    readonly endpoint: string;
    readonly eventSequence: number;
    readonly ownsAuthority: true;
    readonly projectId: CollabProjectId;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly targetHostMemberId: CollabMemberId;
    readonly transferId: CollabOperationId;
  }): Promise<void>;
  demoteSourceHost(input: {
    readonly autoStart: false;
    readonly endpoint: string;
    readonly ownsAuthority: false;
    readonly projectId: CollabProjectId;
    readonly proof: CollabHostTrustTransitionProof;
    readonly targetCaCertificatePem: string;
    readonly targetCaFingerprint: string;
    readonly targetHostMemberId: CollabMemberId;
    readonly transferId: CollabOperationId;
  }): Promise<void>;
}
