import type {
  COLLAB_MAIN_REF,
  CollabChangedFile as SharedCollabChangedFile,
  CollabChangeRequest,
  CollabGitOid,
  CollabIsoTimestamp,
  CollabMember,
  CollabMemberId,
  CollabOperationId,
  CollabProjectId,
  CollabRelativePath,
  CollabRequestDetail,
  CollabRequestId,
  CollabRole,
  CollabTicketSummary,
} from '@claudian-collab/protocol';

/** Claudian's local authority selection. This is not a shared wire contract. */
export type CollabAuthorityKind = 'lan' | 'cloud';

export interface CollabProjectBase {
  id: CollabProjectId;
  name: string;
  authorityKind: CollabAuthorityKind;
  mainRef: typeof COLLAB_MAIN_REF;
  mainOid: CollabGitOid;
  createdAt: CollabIsoTimestamp;
}

export interface CollabLanProject extends CollabProjectBase {
  authorityKind: 'lan';
  hostMemberId: CollabMemberId;
  managerSetGeneration: number;
}

export interface CollabCloudProject extends CollabProjectBase {
  authorityKind: 'cloud';
}

export type CollabProject = CollabLanProject | CollabCloudProject;

export type CollabManagerResponsibilityPurpose =
  | 'manager-promotion'
  | 'manager-leave';

export type CollabManagerResponsibilityOfferStatus =
  | 'offered'
  | 'acknowledged'
  | 'consumed'
  | 'declined'
  | 'cancelled'
  | 'expired';

export interface CollabManagerResponsibilityOfferSummary {
  offerId: CollabOperationId;
  purpose: CollabManagerResponsibilityPurpose;
  sourceManagerMemberId: CollabMemberId;
  targetMemberId: CollabMemberId;
  status: CollabManagerResponsibilityOfferStatus;
  offeredAt: CollabIsoTimestamp;
  expiresAt: CollabIsoTimestamp;
  acknowledgedAt?: CollabIsoTimestamp;
}

export type CollabHostTransferPhase =
  | 'offered'
  | 'accepted'
  | 'transferring'
  | 'recovery-required'
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'expired';

export interface CollabHostTransferSummary {
  transferId: CollabOperationId;
  targetMemberId: CollabMemberId;
  phase: CollabHostTransferPhase;
  offeredAt: CollabIsoTimestamp;
  expiresAt: CollabIsoTimestamp;
  canAccept: boolean;
  canDecline: boolean;
  canCancel: boolean;
}

export interface CollabHostTrustTransitionProof {
  schemaVersion: 1;
  projectId: CollabProjectId;
  transferId: CollabOperationId;
  previousCaFingerprint: string;
  nextCaCertificatePem: string;
  nextCaFingerprint: string;
  issuedAt: CollabIsoTimestamp;
  signatureAlgorithm: 'rsa-pss-sha256';
  signature: string;
}

export interface CollabRetirementResult {
  projectId: CollabProjectId;
  retiredAt: CollabIsoTimestamp;
  retirementId?: CollabOperationId;
}

export interface CollabProjectSnapshotBase {
  project: CollabProject;
  currentMember: CollabMember;
  members: readonly CollabMember[];
  openRequests: readonly CollabChangeRequest[];
  openTicketCount: number;
  ticketHighlights: readonly CollabTicketSummary[];
  eventSequence: number;
}

/** Client projection for the existing LAN authority. */
export interface CollabLanProjectSnapshot extends CollabProjectSnapshotBase {
  project: CollabLanProject;
  hostTransfer?: CollabHostTransferSummary;
  managerResponsibilityOffer?: CollabManagerResponsibilityOfferSummary;
}

/** Client projection composed from the package Cloud snapshot and local binding. */
export interface CollabCloudProjectSnapshot extends CollabProjectSnapshotBase {
  project: CollabCloudProject;
}

export type CollabProjectSnapshot =
  | CollabLanProjectSnapshot
  | CollabCloudProjectSnapshot;

export function isCollabLanProjectSnapshot(
  snapshot: CollabProjectSnapshot,
): snapshot is CollabLanProjectSnapshot {
  return snapshot.project.authorityKind === 'lan';
}

export function isCollabCloudProjectSnapshot(
  snapshot: CollabProjectSnapshot,
): snapshot is CollabCloudProjectSnapshot {
  return snapshot.project.authorityKind === 'cloud';
}

/** Client-local review metadata captured from the working tree. */
export interface CollabChangedFile extends SharedCollabChangedFile {
  workingTreeContentHash?: string;
}

export type CollabProjectLifecycle = 'active' | 'leaving' | 'retired';
export type CollabLocalCleanupChoice = 'keep-files' | 'delete-files';
export type CollabLocalCleanupStatus = 'pending' | 'running' | 'failed' | 'complete';
export type CollabProjectHealth = 'healthy' | 'missing' | 'needs-attention';
export type CollabConnectionStatus =
  | 'connected'
  | 'offline'
  | 'host-stopped'
  | 'permission-required'
  | 'invitation-expired'
  | 'access-removed'
  | 'needs-attention';
export type CollabHostStatus =
  | 'not-host'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'needs-attention';
export type CollabHostInstallationStatus =
  | 'not-host'
  | 'hosted-here'
  | 'hosted-elsewhere'
  | 'legacy-unbound';

export interface CollabLocalProjectSummary {
  id: CollabProjectId;
  name: string;
  workspacePath: CollabRelativePath;
  authorityKind: CollabAuthorityKind;
  health: CollabProjectHealth;
  connectionStatus: CollabConnectionStatus;
  hostInstallationStatus: CollabHostInstallationStatus;
  hostStatus: CollabHostStatus;
  lifecycle?: CollabProjectLifecycle;
  cleanupStatus?: CollabLocalCleanupStatus;
  retiredAt?: CollabIsoTimestamp;
  role?: CollabRole;
}

export interface CollabGitStatus {
  headOid: CollabGitOid | null;
  personalRemoteOid: CollabGitOid | null;
  acceptedMainOid: CollabGitOid | null;
  includesAcceptedMain: boolean | null;
  changedFiles: readonly CollabChangedFile[];
  aheadBy: number;
  behindBy: number;
  workingTreeClean: boolean;
}

export type CollabConflictKind =
  | 'text'
  | 'binary'
  | 'delete-modify'
  | 'rename-delete'
  | 'directory-file'
  | 'portability';

export interface CollabConflictEntry {
  path: CollabRelativePath;
  kind: CollabConflictKind;
  personalPath?: CollabRelativePath;
  acceptedPath?: CollabRelativePath;
  baseOid?: CollabGitOid;
  personalOid?: CollabGitOid;
  acceptedOid?: CollabGitOid;
}

export interface CollabConflictDescriptor {
  operationId: CollabOperationId;
  projectId: CollabProjectId;
  startingPersonalOid: CollabGitOid;
  startingMainOid: CollabGitOid;
  mergeBaseOid: CollabGitOid;
  conflicts: readonly CollabConflictEntry[];
}

export type CollabReviewComparisonKind = 'candidate' | 'contribution';

export interface CollabRequestReview {
  projectId: CollabProjectId;
  detail: CollabRequestDetail;
  comparisonKind: CollabReviewComparisonKind;
  comparisonBaseOid: CollabGitOid;
  comparisonTargetOid: CollabGitOid;
  files: readonly CollabChangedFile[];
  canAccept: boolean;
}

export interface CollabPublicationReview {
  kind: 'publication';
  projectId: CollabProjectId;
  operationId: CollabOperationId;
  baseMainOid: CollabGitOid;
  currentMainOid: CollabGitOid;
  contributionHeadOid: CollabGitOid;
  candidateOid: CollabGitOid;
  comparisonBaseOid: CollabGitOid;
  comparisonTargetOid: CollabGitOid;
  files: readonly CollabChangedFile[];
  canConfirm: boolean;
}

export interface CollabWorkingTreeReview {
  kind: 'working-tree';
  projectId: CollabProjectId;
  baseOid: CollabGitOid;
  headOid: CollabGitOid;
  snapshotId: string;
  files: readonly CollabChangedFile[];
}

export interface CollabReviewFileRequest {
  projectId: CollabProjectId;
  requestId: CollabRequestId;
  comparisonBaseOid: CollabGitOid;
  comparisonTargetOid: CollabGitOid;
  file: CollabChangedFile;
}

export interface CollabPublicationReviewFileRequest {
  projectId: CollabProjectId;
  operationId: CollabOperationId;
  expectedMainOid: CollabGitOid;
  expectedCandidateOid: CollabGitOid;
  comparisonBaseOid: CollabGitOid;
  comparisonTargetOid: CollabGitOid;
  file: CollabChangedFile;
}

export interface CollabWorkingTreeReviewFileRequest {
  projectId: CollabProjectId;
  baseOid: CollabGitOid;
  headOid: CollabGitOid;
  snapshotId: string;
  file: CollabChangedFile;
}

export type CollabReviewFileContent =
  | {
    kind: 'text';
    file: CollabChangedFile;
    oldText: string | null;
    newText: string | null;
  }
  | {
    kind: 'large-text';
    file: CollabChangedFile;
  }
  | {
    kind: 'binary';
    file: CollabChangedFile;
    preview?: {
      bytes: Uint8Array;
      mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
    };
  };

export type CollabAuthoritySyncStatus =
  | 'offline'
  | 'synchronizing'
  | 'synchronized';

export interface CollabAuthoritySyncState {
  projectId: CollabProjectId;
  status: CollabAuthoritySyncStatus;
  generation: number;
  eventSequence: number;
}

export type CollabOperationKind =
  | 'initialize'
  | 'create-project'
  | 'join-project'
  | 'reconnect-project'
  | 'publish'
  | 'resolve-conflict'
  | 'start-host'
  | 'stop-host'
  | 'create-invitation'
  | 'revoke-invitation'
  | 'comment'
  | 'create-ticket'
  | 'update-ticket'
  | 'comment-ticket'
  | 'change-ticket-status'
  | 'update-request-metadata'
  | 'accept'
  | 'remove-member'
  | 'leave-project'
  | 'promote-manager'
  | 'demote-manager'
  | 'manager-responsibility'
  | 'transfer-host'
  | 'retire-project'
  | 'finalize-retired-project'
  | 'cleanup-project';

export type CollabOperationPhase =
  | 'validating'
  | 'staging'
  | 'committed'
  | 'fetching'
  | 'pushed'
  | 'request-synchronized'
  | 'prepared'
  | 'ref-updated'
  | 'completed';

export interface CollabOperationProgress {
  id: CollabOperationId;
  kind: CollabOperationKind;
  phase: CollabOperationPhase;
  startedAt: CollabIsoTimestamp;
  cancellable: boolean;
}
