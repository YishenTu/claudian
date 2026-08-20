import {
  COLLAB_MEMBER_REF_PREFIX,
} from './CollabConstants';
import { isCollabMemberId } from './CollabValidation';

export type CollabProjectId = string;
export type CollabMemberId = string;
export type CollabRequestId = string;
export type CollabCommentId = string;
export type CollabTicketId = string;
export type CollabTicketCommentId = string;
export type CollabTicketRelationId = string;
export type CollabOperationId = string;
export type CollabIdempotencyKey = string;
export type CollabGitOid = string;
export type CollabIsoTimestamp = string;
export type CollabRelativePath = string;

export type CollabRole = 'manager' | 'member';
export type CollabMemberStatus = 'pending' | 'active' | 'revoked' | 'left';
export type CollabRequestStatus = 'open' | 'merged' | 'discarded';
export type CollabTicketStatus = 'open' | 'closed';
export type CollabTicketCommitRelationKind = 'references' | 'resolves';

export function collabMemberRef(memberId: CollabMemberId): string {
  if (!isCollabMemberId(memberId)) {
    throw new RangeError('Invalid Collab member ID');
  }
  return `${COLLAB_MEMBER_REF_PREFIX}${memberId}`;
}

export interface CollabMember {
  id: CollabMemberId;
  displayName: string;
  personalRef: string;
  role: CollabRole;
  status: CollabMemberStatus;
  createdAt: CollabIsoTimestamp;
  activatedAt?: CollabIsoTimestamp;
  revokedAt?: CollabIsoTimestamp;
}

export interface CollabTicketSummary {
  id: CollabTicketId;
  number: number;
  title: string;
  status: CollabTicketStatus;
  authorMemberId: CollabMemberId;
  revision: number;
  acceptedRelationCount: number;
  commentCount: number;
  createdAt: CollabIsoTimestamp;
  updatedAt: CollabIsoTimestamp;
  closedAt?: CollabIsoTimestamp;
  closedByMemberId?: CollabMemberId;
}

export interface CollabTicketComment {
  id: CollabTicketCommentId;
  ticketId: CollabTicketId;
  authorMemberId: CollabMemberId;
  body: string;
  createdAt: CollabIsoTimestamp;
}

export interface CollabTicketAcceptedRelation {
  id: CollabTicketRelationId;
  requestId: CollabRequestId;
  kind: CollabTicketCommitRelationKind;
  commitOid: CollabGitOid;
  acceptedMergeOid: CollabGitOid;
  acceptedAt: CollabIsoTimestamp;
}

export interface CollabTicketDetail {
  ticket: CollabTicketSummary;
  body: string;
  comments: CollabTicketCommentPage;
  acceptedRelations: CollabTicketAcceptedRelationPage;
}

export interface CollabTicketCommentPage {
  comments: readonly CollabTicketComment[];
  nextCursor?: string;
}

export interface CollabTicketAcceptedRelationPage {
  acceptedRelations: readonly CollabTicketAcceptedRelation[];
  nextCursor?: string;
}

export interface CollabTicketPage {
  tickets: readonly CollabTicketSummary[];
  nextCursor?: string;
}

export interface CollabRequestTicketRelation {
  id: CollabTicketRelationId;
  ticketId: CollabTicketId;
  ticketNumber: number;
  ticketTitle: string;
  ticketRevision: number;
  commitOid: CollabGitOid;
  kind: CollabTicketCommitRelationKind;
  state: 'pending' | 'accepted';
}

export interface CollabParsedTicketReference {
  ticketNumber: number;
  kind: CollabTicketCommitRelationKind;
}

export interface CollabChangeRequest {
  id: CollabRequestId;
  memberId: CollabMemberId;
  status: CollabRequestStatus;
  firstBaseOid: CollabGitOid;
  latestHeadOid: CollabGitOid;
  mergedOid?: CollabGitOid;
  description: string;
  revision: number;
  ticketRelations: readonly CollabRequestTicketRelation[];
  commentCount: number;
  createdAt: CollabIsoTimestamp;
  updatedAt: CollabIsoTimestamp;
}

export interface CollabComment {
  id: CollabCommentId;
  requestId: CollabRequestId;
  authorMemberId: CollabMemberId;
  body: string;
  createdAt: CollabIsoTimestamp;
}

export interface CollabCommentPage {
  comments: readonly CollabComment[];
  nextCursor?: string;
}

export type CollabFileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed';

export interface CollabChangedFile {
  path: CollabRelativePath;
  previousPath?: CollabRelativePath;
  kind: CollabFileChangeKind;
  binary: boolean;
  oldBytes?: number;
  newBytes?: number;
  additions?: number;
  deletions?: number;
  largeForReview: boolean;
}

export type CollabReviewCondition = 'clean' | 'conflicting' | 'stale';

export interface CollabRequestDetail {
  request: CollabChangeRequest;
  currentMainOid: CollabGitOid;
  reviewedHeadOid: CollabGitOid;
  reviewCondition: CollabReviewCondition;
  comments: CollabCommentPage;
}

export interface CollabResolvingTicketExpectation {
  ticketId: CollabTicketId;
  revision: number;
}
