import type { CollabAuthorityTransferStatus, CollabChangeRequest, CollabComment, CollabCommentPage, CollabGitOid, CollabIsoTimestamp, CollabMemberId, CollabOperationId, CollabProjectId, CollabRelativePath, CollabRequestId, CollabResolvingTicketExpectation, CollabTicketAcceptedRelationPage, CollabTicketComment, CollabTicketCommentPage, CollabTicketDetail, CollabTicketId, CollabTicketPage, CollabTicketStatus, CollabTicketSummary } from '@claudian-collab/protocol';
import type { CollabImportedClaimState, CollabProjectInvitationState, CollabProjectMemberBindingState, CollabRole } from '@claudian-collab/protocol';

import type { CollabError } from '@/core/collab/ClaudianCollabError';

import type { CollabProjectSelectionProjection } from './CollabProjectSelection';
import type {
  CollabManagerResponsibilityOfferSummary,
  CollabManagerResponsibilityPurpose,
  CollabProjectSnapshot,
} from './types';
import type {
  CollabAuthoritySyncState,
  CollabConflictDescriptor,
  CollabGitStatus,
  CollabLocalCleanupChoice,
  CollabLocalProjectSummary,
  CollabOperationPhase,
  CollabOperationProgress,
  CollabPublicationReview,
  CollabPublicationReviewFileRequest,
  CollabRequestReview,
  CollabReviewFileContent,
  CollabReviewFileRequest,
  CollabWorkingTreeReview,
  CollabWorkingTreeReviewFileRequest,
} from './types';

export type CollabStaleKind =
  | 'project-selection'
  | 'main'
  | 'request-head'
  | 'request-metadata'
  | 'ticket'
  | 'authority-sync'
  | 'working-copy'
  | 'operation';

export type CollabResult<T> =
  | { status: 'success'; value: T }
  | {
    status: 'cancelled';
    operationId?: CollabOperationId;
    durableProgress: false;
  }
  | {
    status: 'recovery-required';
    operationId: CollabOperationId;
    durableProgress: true;
    durablePhase: CollabOperationPhase;
    error: CollabError;
  }
  | { status: 'stale'; staleKind: CollabStaleKind; error: CollabError }
  | {
    status: 'conflict';
    conflict: CollabConflictDescriptor;
    error: CollabError;
  }
  | { status: 'failure'; error: CollabError };

export interface CollabOperationOptions {
  signal?: AbortSignal;
}

export type CollabFeatureLifecycle =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'failed';

export interface CollabFeatureState {
  lifecycle: CollabFeatureLifecycle;
  projects: readonly CollabLocalProjectSummary[];
  selectedProjectId: CollabProjectId | null;
  activeOperation?: CollabOperationProgress;
  error?: CollabError;
}

export interface CollabFeatureSubscription {
  dispose(): void;
}

export type CollabFeatureStateListener = (state: CollabFeatureState) => void;

export interface CollabProjectInspection {
  project: CollabLocalProjectSummary;
  gitStatus?: CollabGitStatus;
  coordination?: CollabCoordinationSnapshot;
  conflict?: CollabConflictSession;
  personalChanges?: CollabPersonalChangesInspection;
}

export type CollabPersonalAction =
  | 'none'
  | 'publish'
  | 'review-and-publish'
  | 'resolve-changes'
  | 'retry';

export interface CollabPersonalChangesInspection {
  readonly action: CollabPersonalAction;
  readonly hasContribution: boolean;
  readonly unpublishedReview: CollabWorkingTreeReview;
  readonly updateAvailable: boolean;
  readonly review?: CollabPublicationReview;
  readonly conflictOperationId?: CollabOperationId;
}

export interface CollabCreateProjectRequest {
  authority?: { readonly kind: 'lan' } | { readonly kind: 'cloud'; readonly serverUrl: string };
  name: string;
  memberDisplayName: string;
}

export interface CollabInvitationJoinRequest {
  encodedInvitation: string;
  memberDisplayName: string;
  projectSlug?: string;
}

export type CollabJoinProjectRequest = CollabInvitationJoinRequest | {
  readonly existingCloudProjectId: CollabProjectId;
};

export type CollabReconnectProjectRequest = {
  readonly encodedInvitation: string;
  readonly projectId: CollabProjectId;
} | {
  readonly authority: { readonly kind: 'cloud'; readonly serverUrl: string };
  readonly projectId: CollabProjectId;
};

export interface CollabResumeSetupRequest {
  operationId: CollabOperationId;
}

export interface CollabPendingReconnectView {
  readonly operationId: CollabOperationId;
  readonly projectId: CollabProjectId;
  readonly serverUrl: string;
}

export interface CollabCoordinationSnapshot {
  snapshot: CollabProjectSnapshot;
  source: 'online' | 'cache';
  stale: boolean;
  syncState: CollabAuthoritySyncState;
}

export interface CollabProjectCapabilities {
  readonly authorityKind: 'lan' | 'cloud';
  readonly authorityTransfer: boolean;
  readonly importedMemberClaims: boolean;
  readonly invitations: boolean;
  readonly leave: boolean;
  readonly managerResponsibility: boolean;
  readonly membershipManagement: boolean;
  readonly retirement: boolean;
}

export interface CollabTicketPageProjection {
  page: CollabTicketPage;
  source: 'online' | 'cache';
  stale: boolean;
}

export interface CollabTicketDetailProjection {
  detail: CollabTicketDetail;
  source: 'online' | 'cache';
  stale: boolean;
}

export type CollabPublicationState =
  | 'committed-locally'
  | 'pushed'
  | 'request-synchronized'
  | 'review-required';

export interface CollabPublishOutcome {
  projectId: CollabProjectId;
  localHeadOid: CollabGitOid;
  remoteHeadOid?: CollabGitOid;
  request?: CollabChangeRequest;
  review?: CollabPublicationReview;
  state: CollabPublicationState;
}

export interface CollabPublishRequest {
  projectId: CollabProjectId;
  description: string;
}

export interface CollabConfirmPublishRequest {
  projectId: CollabProjectId;
  operationId: CollabOperationId;
  expectedMainOid: CollabGitOid;
  expectedCandidateOid: CollabGitOid;
  description: string;
}

export type CollabReconciliationState =
  | 'already-current'
  | 'fast-forwarded'
  | 'deferred';

export interface CollabReconciliationOutcome {
  projectId: CollabProjectId;
  state: CollabReconciliationState;
  headOid: CollabGitOid;
}

export interface CollabConflictSession {
  descriptor: CollabConflictDescriptor;
  publicationReview?: CollabPublicationReview;
}

export interface CollabConflictFileRequest {
  operationId: CollabOperationId;
  path: CollabRelativePath;
}

export interface CollabConflictTextVersion {
  path: CollabRelativePath;
  text: string | null;
}

export type CollabConflictTextSegment =
  | {
    kind: 'common';
    text: string;
  }
  | {
    accepted: string;
    base: string;
    id: string;
    kind: 'conflict';
    personal: string;
  };

export interface CollabConflictOpaqueVersion {
  path: CollabRelativePath;
  exists: boolean;
  bytes: number;
}

export type CollabConflictFileContent =
  | {
    kind: 'text';
    path: CollabRelativePath;
    base: CollabConflictTextVersion;
    personal: CollabConflictTextVersion;
    accepted: CollabConflictTextVersion;
    segments: readonly CollabConflictTextSegment[];
  }
  | {
    kind: 'binary' | 'delete-modify' | 'rename-delete';
    path: CollabRelativePath;
    base: CollabConflictOpaqueVersion;
    personal: CollabConflictOpaqueVersion;
    accepted: CollabConflictOpaqueVersion;
  }
  | {
    kind: 'directory-file' | 'portability';
    path: CollabRelativePath;
  };

export interface CollabInvitationView {
  encodedInvitation: string;
  expiresAt: CollabIsoTimestamp;
}

export interface CollabInvitationSummaryView {
  readonly invitationId: string;
  readonly state: CollabProjectInvitationState;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
}

export interface CollabMemberSummaryView {
  readonly memberId: CollabMemberId;
  readonly displayName: string;
  readonly role: CollabRole;
  readonly importedClaim: {
    readonly state: Exclude<CollabImportedClaimState, 'not-applicable'>;
    readonly bindingState: CollabProjectMemberBindingState;
  } | null;
}

export interface CollabManagementOperationView {
  readonly action: 'create-invitation' | 'revoke-invitation' | 'demote-manager' | 'remove-member' | 'create-manager-offer' | 'cancel-manager-offer' | 'promote-manager' | 'reissue-member-claim' | 'revoke-member-claim';
  /** Opaque local result identity; it is never the authority idempotency key. */
  readonly completionId: string;
  readonly invitation: CollabInvitationView | null;
  /** Last instant at which a retained invitation or claim secret may be presented. */
  readonly secretAvailableUntil: CollabIsoTimestamp | null;
  readonly status: 'pending' | 'result-retained';
}

/** LAN revokes its singleton invitation; Cloud requires the selected invitation identity. */
export type CollabRevokeInvitationRequest = CollabProjectId | {
  readonly projectId: CollabProjectId;
  readonly invitationId: string;
};

export interface CollabCompleteManagementOperationRequest {
  readonly projectId: CollabProjectId;
  /** Required for Cloud compare-and-remove; omitted for transient LAN abandonment. */
  readonly completionId?: string;
}

export interface CollabImportedMemberClaimRequest {
  readonly projectId: CollabProjectId;
  readonly memberId: CollabMemberId;
}

export interface CollabHostSession {
  projectId: CollabProjectId;
  status: 'running' | 'stopped';
  endpoint?: string;
}

export interface CollabAddCommentRequest {
  projectId: CollabProjectId;
  requestId: CollabRequestId;
  body: string;
  intentId?: string;
}

export interface CollabListTicketsRequest {
  projectId: CollabProjectId;
  status: CollabTicketStatus;
  cursor?: string;
  limit?: number;
}

export interface CollabCommentPageQuery {
  cursor?: string;
  limit?: number;
}

export interface CollabCreateTicketRequest {
  projectId: CollabProjectId;
  title: string;
  body: string;
  intentId?: string;
}

export interface CollabUpdateTicketContentRequest {
  projectId: CollabProjectId;
  ticketId: CollabTicketId;
  expectedRevision: number;
  title: string;
  body: string;
  intentId?: string;
}

export interface CollabAddTicketCommentRequest {
  projectId: CollabProjectId;
  ticketId: CollabTicketId;
  body: string;
  intentId?: string;
}

export interface CollabChangeTicketStatusRequest {
  projectId: CollabProjectId;
  ticketId: CollabTicketId;
  expectedRevision: number;
  intentId?: string;
}

export interface CollabUpdateRequestMetadataRequest {
  projectId: CollabProjectId;
  requestId: CollabRequestId;
  expectedHeadOid: CollabGitOid;
  expectedRequestRevision: number;
  description: string;
  intentId?: string;
}

export interface CollabAcceptRequest {
  projectId: CollabProjectId;
  requestId: CollabRequestId;
  expectedMainOid: CollabGitOid;
  expectedHeadOid: CollabGitOid;
  expectedRequestRevision: number;
  expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
  intentId?: string;
}

export interface CollabAcceptOutcome {
  request: CollabChangeRequest;
  mainOid: CollabGitOid;
  mergeCommitOid: CollabGitOid;
}

export interface CollabPromoteManagerRequest {
  projectId: CollabProjectId;
  targetMemberId: CollabMemberId;
  managerResponsibilityOfferId: CollabOperationId;
}

export interface CollabDemoteManagerRequest {
  projectId: CollabProjectId;
  targetMemberId: CollabMemberId;
}

export interface CollabLeaveProjectRequest {
  projectId: CollabProjectId;
  cleanupChoice: CollabLocalCleanupChoice;
  managerResponsibilityOfferId?: CollabOperationId;
}

export interface CollabCreateManagerResponsibilityOfferRequest {
  projectId: CollabProjectId;
  purpose: CollabManagerResponsibilityPurpose;
  targetMemberId: CollabMemberId;
}

export interface CollabCancelManagerResponsibilityOfferRequest {
  projectId: CollabProjectId;
  offerId: CollabOperationId;
}

export interface CollabCreateHostTransferRequest {
  projectId: CollabProjectId;
  targetMemberId: CollabMemberId;
}

export interface CollabHostTransferIntentRequest {
  projectId: CollabProjectId;
  transferId: CollabOperationId;
}

export type CollabAcceptHostTransferRequest = CollabHostTransferIntentRequest;
export type CollabDeclineHostTransferRequest = CollabHostTransferIntentRequest;
export type CollabCancelHostTransferRequest = CollabHostTransferIntentRequest;

export interface CollabRetireProjectRequest {
  projectId: CollabProjectId;
}

export interface CollabFinalizeRetiredProjectRequest {
  projectId: CollabProjectId;
  cleanupChoice: CollabLocalCleanupChoice;
}

export interface CollabCloudToLanTargetPreparationDescriptor {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly preparationId: string;
  readonly projectId: CollabProjectId;
  readonly publishedAt: CollabIsoTimestamp;
  readonly schemaVersion: 1;
  readonly selectedTargetMemberId: CollabMemberId;
  readonly sourceAuthorityGeneration: number;
  readonly sourceCloudUrl: string;
  readonly targetUrl: string;
}

export interface CollabCloudToLanTransferHandle {
  readonly operationIntentId: string;
  readonly preparationId: string;
  readonly projectId: CollabProjectId;
  readonly schemaVersion: 1;
  readonly selectedTargetMemberId: CollabMemberId;
  readonly sourceAuthorityGeneration: number;
  readonly sourceCloudUrl: string;
  readonly targetUrl: string;
  readonly transferId: string;
}

export interface CollabCloudToLanTransferView {
  readonly manager: Readonly<{
    readonly descriptor: CollabCloudToLanTargetPreparationDescriptor;
    readonly handle: CollabCloudToLanTransferHandle | null;
    readonly status: CollabAuthorityTransferStatus | null;
  }> | null;
  readonly target: Readonly<{
    readonly canWithdraw: boolean;
    readonly descriptor: CollabCloudToLanTargetPreparationDescriptor | null;
    readonly handle: CollabCloudToLanTransferHandle | null;
    readonly status: CollabAuthorityTransferStatus | null;
  }> | null;
}

export interface CollabPrepareCloudToLanTargetRequest {
  readonly projectId: CollabProjectId;
}

export interface CollabBeginCloudToLanTransferRequest {
  readonly descriptor: CollabCloudToLanTargetPreparationDescriptor;
}

export interface CollabWithdrawCloudToLanTargetRequest {
  readonly preparationId: string;
  readonly projectId: CollabProjectId;
}

export interface CollabLanToCloudTransferRequest {
  readonly projectId: CollabProjectId;
  readonly serverUrl: string;
}

export interface CollabLanToCloudTransferSelectionRequest {
  readonly projectId: CollabProjectId;
  readonly transferId: string;
}

export interface CollabLanToCloudTransferView {
  readonly proposedByMemberId: CollabMemberId;
  readonly serverUrl: string;
  readonly sourceOwned: boolean;
  readonly status: CollabAuthorityTransferStatus | null;
}

export interface CollabRemoveMemberRequest {
  projectId: CollabProjectId;
  memberId: CollabMemberId;
}

export interface CollabFeaturePort {
  initialize(options?: CollabOperationOptions): Promise<CollabResult<CollabFeatureState>>;
  listProjects(options?: CollabOperationOptions): Promise<CollabResult<readonly CollabLocalProjectSummary[]>>;
  readProjectSelection(options?: CollabOperationOptions): Promise<CollabResult<CollabProjectSelectionProjection>>;
  selectProject(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabProjectInspection>>;
  inspectProject(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabProjectInspection>>;
  createProject(request: CollabCreateProjectRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabLocalProjectSummary>>;
  joinProject(request: CollabJoinProjectRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabLocalProjectSummary>>;
  reconnectProject(request: CollabReconnectProjectRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabLocalProjectSummary>>;
  readPendingReconnect(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabPendingReconnectView | null>>;
  resumeReconnect(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabLocalProjectSummary>>;
  resumeSetup(request: CollabResumeSetupRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabLocalProjectSummary>>;
  readSnapshot(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabCoordinationSnapshot>>;
  readProjectCapabilities(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabProjectCapabilities>>;
  readPublishDescription(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<string | null>>;
  publish(request: CollabPublishRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabPublishOutcome>>;
  confirmPublish(request: CollabConfirmPublishRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabPublishOutcome>>;
  prepareWorkingTreeReview(projectId: CollabProjectId, baseOid: CollabGitOid, options?: CollabOperationOptions): Promise<CollabResult<CollabWorkingTreeReview>>;
  readWorkingTreeReviewFile(request: CollabWorkingTreeReviewFileRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabReviewFileContent>>;
  preparePublicationReview(projectId: CollabProjectId, operationId: CollabOperationId, options?: CollabOperationOptions): Promise<CollabResult<CollabPublicationReview>>;
  readPublicationReviewFile(request: CollabPublicationReviewFileRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabReviewFileContent>>;
  readConflict(operationId: CollabOperationId, options?: CollabOperationOptions): Promise<CollabResult<CollabConflictSession>>;
  readConflictFile(request: CollabConflictFileRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabConflictFileContent>>;
  createInvitation(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabInvitationView>>;
  listInvitations(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<readonly CollabInvitationSummaryView[]>>;
  listMembers(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<readonly CollabMemberSummaryView[]>>;
  listManagerResponsibilityOffers(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<readonly CollabManagerResponsibilityOfferSummary[]>>;
  reissueMemberClaim(request: CollabImportedMemberClaimRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabInvitationView>>;
  revokeMemberClaim(request: CollabImportedMemberClaimRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  readManagementOperation(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabManagementOperationView | null>>;
  resumeManagementOperation(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabManagementOperationView>>;
  completeManagementOperation(request: CollabCompleteManagementOperationRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  revokeInvitation(request: CollabRevokeInvitationRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  claimLegacyHostInstallation(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabLocalProjectSummary>>;
  startHost(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabHostSession>>;
  stopHost(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabHostSession>>;
  prepareReview(projectId: CollabProjectId, requestId: CollabRequestId, options?: CollabOperationOptions): Promise<CollabResult<CollabRequestReview>>;
  readReviewFile(request: CollabReviewFileRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabReviewFileContent>>;
  addComment(request: CollabAddCommentRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabComment>>;
  listTickets(request: CollabListTicketsRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabTicketPageProjection>>;
  readTicket(projectId: CollabProjectId, ticketId: CollabTicketId, options?: CollabOperationOptions): Promise<CollabResult<CollabTicketDetailProjection>>;
  createTicket(request: CollabCreateTicketRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabTicketDetail>>;
  updateTicketContent(request: CollabUpdateTicketContentRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabTicketSummary>>;
  addTicketComment(request: CollabAddTicketCommentRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabTicketComment>>;
  closeTicket(request: CollabChangeTicketStatusRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabTicketSummary>>;
  reopenTicket(request: CollabChangeTicketStatusRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabTicketSummary>>;
  updateRequestMetadata(request: CollabUpdateRequestMetadataRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabChangeRequest>>;
  acceptRequest(request: CollabAcceptRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabAcceptOutcome>>;
  removeMember(request: CollabRemoveMemberRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  leaveProject(request: CollabLeaveProjectRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  resumeLeave(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  createManagerResponsibilityOffer(request: CollabCreateManagerResponsibilityOfferRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabManagerResponsibilityOfferSummary>>;
  cancelManagerResponsibilityOffer(request: CollabCancelManagerResponsibilityOfferRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabManagerResponsibilityOfferSummary>>;
  promoteManager(request: CollabPromoteManagerRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  demoteManager(request: CollabDemoteManagerRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  createHostTransfer(request: CollabCreateHostTransferRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  acceptHostTransfer(request: CollabAcceptHostTransferRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  declineHostTransfer(request: CollabDeclineHostTransferRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  cancelHostTransfer(request: CollabCancelHostTransferRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  retireProject(request: CollabRetireProjectRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  finalizeRetiredProject(request: CollabFinalizeRetiredProjectRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  retryProjectCleanup(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  proposeLanToCloudTransfer(request: CollabLanToCloudTransferRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabAuthorityTransferStatus>>;
  readLanToCloudTransfer(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabLanToCloudTransferView | null>>;
  readCloudToLanTransfer(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabCloudToLanTransferView | null>>;
  acceptLanToCloudTransfer(request: CollabLanToCloudTransferSelectionRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabAuthorityTransferStatus>>;
  cancelLanToCloudTransfer(request: CollabLanToCloudTransferSelectionRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabAuthorityTransferStatus>>;
  prepareCloudToLanTarget(request: CollabPrepareCloudToLanTargetRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabCloudToLanTargetPreparationDescriptor>>;
  beginCloudToLanTransfer(request: CollabBeginCloudToLanTransferRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabCloudToLanTransferHandle>>;
  acceptCloudToLanTransfer(handle: CollabCloudToLanTransferHandle, options?: CollabOperationOptions): Promise<CollabResult<CollabAuthorityTransferStatus>>;
  withdrawCloudToLanTarget(request: CollabWithdrawCloudToLanTargetRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  observeCloudToLanTransfer(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabAuthorityTransferStatus>>;
  cancelCloudToLanTransfer(handle: CollabCloudToLanTransferHandle, options?: CollabOperationOptions): Promise<CollabResult<CollabAuthorityTransferStatus>>;
  subscribe(listener: CollabFeatureStateListener): CollabFeatureSubscription;
}

export interface CollabBoundedQueryPort {
  listRequestComments(
    projectId: CollabProjectId,
    requestId: CollabRequestId,
    query?: CollabCommentPageQuery,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabCommentPage>>;
  listTicketAcceptedRelations(
    projectId: CollabProjectId,
    ticketId: CollabTicketId,
    query?: CollabCommentPageQuery,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketAcceptedRelationPage>>;
  listTicketComments(
    projectId: CollabProjectId,
    ticketId: CollabTicketId,
    query?: CollabCommentPageQuery,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketCommentPage>>;
  prepareReview(
    projectId: CollabProjectId,
    requestId: CollabRequestId,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabRequestReview>>;
  readTicket(
    projectId: CollabProjectId,
    ticketId: CollabTicketId,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketDetailProjection>>;
}
