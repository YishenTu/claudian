import type { CollabChangeRequest, CollabComment, CollabCommentPage, CollabGitOid, CollabIsoTimestamp, CollabMember, CollabMemberId, CollabOperationId, CollabProjectId, CollabRelativePath, CollabRequestDetail, CollabRequestId, CollabResolvingTicketExpectation, CollabTicketAcceptedRelationPage, CollabTicketComment, CollabTicketCommentPage, CollabTicketDetail, CollabTicketId, CollabTicketPage, CollabTicketStatus, CollabTicketSummary } from '@claudian/collab-protocol';

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
  name: string;
  memberDisplayName: string;
}

export interface CollabJoinProjectRequest {
  encodedInvitation: string;
  memberDisplayName: string;
  projectSlug?: string;
}

export interface CollabReconnectProjectRequest {
  encodedInvitation: string;
  projectId: CollabProjectId;
}

export interface CollabResumeSetupRequest {
  operationId: CollabOperationId;
}

export interface CollabCoordinationSnapshot {
  snapshot: CollabProjectSnapshot;
  source: 'online' | 'cache';
  stale: boolean;
  syncState: CollabAuthoritySyncState;
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
  intentId?: string;
}

export interface CollabDemoteManagerRequest {
  projectId: CollabProjectId;
  targetMemberId: CollabMemberId;
  intentId?: string;
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
  intentId?: string;
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
  managerActorMemberId: CollabMemberId;
  expectedHostMemberId: CollabMemberId;
}

export interface CollabFinalizeRetiredProjectRequest {
  projectId: CollabProjectId;
  cleanupChoice: CollabLocalCleanupChoice;
}

export interface CollabRemoveMemberRequest {
  projectId: CollabProjectId;
  memberId: CollabMemberId;
  intentId?: string;
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
  resumeSetup(request: CollabResumeSetupRequest, options?: CollabOperationOptions): Promise<CollabResult<CollabLocalProjectSummary>>;
  readGitStatus(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabGitStatus>>;
  readSnapshot(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabCoordinationSnapshot>>;
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
  revokeInvitation(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  startHost(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabHostSession>>;
  stopHost(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<CollabHostSession>>;
  readRequest(projectId: CollabProjectId, requestId: CollabRequestId, options?: CollabOperationOptions): Promise<CollabResult<CollabRequestDetail>>;
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
  listMembers(projectId: CollabProjectId, options?: CollabOperationOptions): Promise<CollabResult<readonly CollabMember[]>>;
  removeMember(request: CollabRemoveMemberRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
  leaveProject(request: CollabLeaveProjectRequest, options?: CollabOperationOptions): Promise<CollabResult<void>>;
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
