import type { CollabChangeRequest, CollabComment, CollabTicketComment, CollabTicketDetail, CollabTicketSummary } from '@claudian-collab/protocol';

import type { CollabAcceptOutcome, CollabAcceptRequest, CollabAddCommentRequest, CollabAddTicketCommentRequest, CollabChangeTicketStatusRequest, CollabCoordinationSnapshot, CollabCreateTicketRequest, CollabListTicketsRequest, CollabOperationOptions, CollabPublicationReview, CollabPublishOutcome, CollabRequestReview, CollabResult, CollabTicketDetailProjection, CollabTicketPageProjection, CollabUpdateRequestMetadataRequest, CollabUpdateTicketContentRequest, CollabWorkingTreeReview } from '@/core/collab';
import type {
  CollabConflictResolutionPanelOptions,
  CollabConflictResolutionPort,
} from '@/features/collab/detail/conflict/CollabConflictResolutionPanel';
import type { ReviewDiffSessionPort } from '@/features/collab/detail/review/ReviewDiffSession';

export interface CollabRequestDetailViewState {
  readonly comparisonBaseOid: string;
  readonly comparisonTargetOid: string;
  readonly kind: 'request';
  readonly projectId: string;
  readonly requestId: string;
  readonly reviewedHeadOid: string;
  readonly reviewedMainOid: string;
  readonly selectedPath?: string;
}

export interface CollabConflictDetailViewState {
  readonly kind: 'conflict';
  readonly location: 'my-changes' | 'request';
  readonly operationId: string;
  readonly projectId: string;
  readonly requestId?: string;
}

export interface CollabPublicationDetailViewState {
  readonly candidateOid: string;
  readonly comparisonBaseOid: string;
  readonly comparisonTargetOid: string;
  readonly currentMainOid: string;
  readonly kind: 'publication';
  readonly operationId: string;
  readonly projectId: string;
  readonly selectedPath?: string;
}

export interface CollabWorkingTreeDetailViewState {
  readonly baseOid: string;
  readonly headOid: string;
  readonly kind: 'working-tree';
  readonly projectId: string;
  readonly selectedPath?: string;
  readonly snapshotId: string;
}

export interface CollabTicketDetailViewState {
  readonly kind: 'ticket';
  readonly projectId: string;
  readonly ticketId?: string;
}

export type CollabDetailViewState =
  | CollabConflictDetailViewState
  | CollabPublicationDetailViewState
  | CollabRequestDetailViewState
  | CollabTicketDetailViewState
  | CollabWorkingTreeDetailViewState;

export type CollabReviewDetailViewState =
  | CollabPublicationDetailViewState
  | CollabRequestDetailViewState
  | CollabWorkingTreeDetailViewState;

export interface CollabDetailViewPort
  extends CollabConflictResolutionPort, ReviewDiffSessionPort {
  isDetailAdmissionOpen(): boolean;
  listTickets(
    request: CollabListTicketsRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketPageProjection>>;
  prepareReview(
    projectId: string,
    requestId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabRequestReview>>;
  preparePublicationReview(
    projectId: string,
    operationId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabPublicationReview>>;
  prepareWorkingTreeReview(
    projectId: string,
    baseOid: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabWorkingTreeReview>>;
  publish(
    request: { readonly description: string; readonly projectId: string },
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabPublishOutcome>>;
  confirmPublish(
    request: {
      readonly expectedCandidateOid: string;
      readonly expectedMainOid: string;
      readonly operationId: string;
      readonly projectId: string;
      readonly description: string;
    },
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabPublishOutcome>>;
  acceptRequest(
    request: CollabAcceptRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabAcceptOutcome>>;
  addComment(
    request: CollabAddCommentRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabComment>>;
  readSnapshot(
    projectId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabCoordinationSnapshot>>;
  readPublishDescription(
    projectId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<string | null>>;
  addTicketComment(
    request: CollabAddTicketCommentRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketComment>>;
  closeTicket(
    request: CollabChangeTicketStatusRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketSummary>>;
  createTicket(
    request: CollabCreateTicketRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketDetail>>;
  readTicket(
    projectId: string,
    ticketId: string,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketDetailProjection>>;
  reopenTicket(
    request: CollabChangeTicketStatusRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketSummary>>;
  updateRequestMetadata(
    request: CollabUpdateRequestMetadataRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabChangeRequest>>;
  updateTicketContent(
    request: CollabUpdateTicketContentRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabTicketSummary>>;
  subscribe(listener: () => void): { dispose(): void };
}

export interface CollabDetailConflictPanel {
  destroy(): void;
  open(operationId: string): Promise<void>;
}

export type CollabDetailConflictPanelFactory = (
  root: HTMLElement,
  port: CollabConflictResolutionPort,
  options: CollabConflictResolutionPanelOptions,
) => CollabDetailConflictPanel;
