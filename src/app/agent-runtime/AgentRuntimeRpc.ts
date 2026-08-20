import type { CollabFileChangeKind, CollabReviewCondition, CollabRole, CollabTicketCommitRelationKind } from '@claudian/collab-protocol';

import type { CollabAuthorityKind, CollabAuthoritySyncStatus, CollabConflictKind, CollabConnectionStatus, CollabHostStatus, CollabLocalCleanupStatus, CollabPersonalAction, CollabProjectHealth, CollabProjectLifecycle, CollabReviewComparisonKind } from '@/core/collab';
import type { CollabErrorCode } from '@/core/collab/ClaudianCollabError';

export const AGENT_RUNTIME_PROTOCOL_VERSION = 5 as const;

export type AgentRuntimeRpcOwnedErrorCode =
  | 'invalid_request'
  | 'method_not_found'
  | 'operation_not_found'
  | 'invalid_params'
  | 'service_unavailable'
  | 'request_timeout'
  | 'response_too_large'
  | 'cancelled'
  | 'internal_error';

export type AgentRuntimeRpcErrorCode =
  | AgentRuntimeRpcOwnedErrorCode
  | CollabErrorCode;

export interface AgentRuntimeRpcEnvelope {
  readonly id: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AgentRuntimeStringSchema {
  readonly type: 'string';
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minBytes?: number;
  readonly maxBytes?: number;
  readonly pattern?: string;
}

export interface AgentRuntimeIntegerSchema {
  readonly type: 'integer';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}

export interface AgentRuntimeObjectSchema {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly properties: readonly AgentRuntimeParameterDescriptor[];
}

export interface AgentRuntimeArraySchema {
  readonly type: 'array';
  readonly items: AgentRuntimeValueSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueBy?: string;
}

export type AgentRuntimeValueSchema =
  | AgentRuntimeStringSchema
  | AgentRuntimeIntegerSchema
  | AgentRuntimeObjectSchema
  | AgentRuntimeArraySchema;

export interface AgentRuntimeParameterDescriptor {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  readonly schema: AgentRuntimeValueSchema;
}

export type AgentRuntimeOperationAccess = 'read' | 'write';

export interface AgentRuntimeOperationSummary {
  readonly name: string;
  readonly access: AgentRuntimeOperationAccess;
  readonly description: string;
}

export interface AgentRuntimeOperationDescriptor extends AgentRuntimeOperationSummary {
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly AgentRuntimeParameterDescriptor[];
  readonly resultDescription: string;
}

export interface AgentRuntimeProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly health: CollabProjectHealth;
  readonly connectionStatus: CollabConnectionStatus;
  readonly lifecycle?: CollabProjectLifecycle;
  readonly cleanupStatus?: CollabLocalCleanupStatus;
  readonly retiredAt?: string;
  readonly role?: CollabRole;
}

export interface AgentRuntimeMember {
  readonly id: string;
  readonly displayName: string;
  readonly role: CollabRole;
  readonly status: 'active';
}

export interface AgentRuntimeSyncState {
  readonly status: CollabAuthoritySyncStatus;
  readonly generation: number;
  readonly eventSequence: number;
}

export interface AgentRuntimeProjectDetail extends AgentRuntimeProjectSummary {
  readonly workspacePath: string;
  readonly authorityKind: CollabAuthorityKind;
  readonly hostStatus: CollabHostStatus;
  readonly coordination: null | {
    readonly source: 'online' | 'cache';
    readonly stale: boolean;
    readonly sync: AgentRuntimeSyncState;
    readonly mainOid: string;
    readonly hostMemberId: string;
    readonly managerCount: number;
    readonly managerMemberIds: readonly string[];
    readonly createdAt: string;
    readonly currentMember: AgentRuntimeMember;
    readonly members: readonly AgentRuntimeMember[];
    readonly openRequestCount: number;
    readonly openTicketCount: number;
  };
}

export interface AgentRuntimeChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly kind: CollabFileChangeKind;
  readonly binary: boolean;
  readonly oldBytes?: number;
  readonly newBytes?: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly largeForReview: boolean;
}

export interface AgentRuntimeGitStatus {
  readonly headOid: string | null;
  readonly personalRemoteOid: string | null;
  readonly acceptedMainOid: string | null;
  readonly includesAcceptedMain: boolean | null;
  readonly changedFiles: readonly AgentRuntimeChangedFile[];
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly workingTreeClean: boolean;
}

export interface AgentRuntimeTicketRelation {
  readonly id: string;
  readonly ticketId: string;
  readonly ticketNumber: number;
  readonly ticketTitle: string;
  readonly ticketRevision: number;
  readonly commitOid: string;
  readonly kind: CollabTicketCommitRelationKind;
  readonly state: 'pending' | 'accepted';
}

export interface AgentRuntimeChangeRequest {
  readonly id: string;
  readonly memberId: string;
  readonly status: 'open' | 'merged' | 'discarded';
  readonly firstBaseOid: string;
  readonly latestHeadOid: string;
  readonly mergedOid?: string;
  readonly description: string;
  readonly revision: number;
  readonly ticketRelations: readonly AgentRuntimeTicketRelation[];
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentRuntimeComment {
  readonly id: string;
  readonly requestId: string;
  readonly authorMemberId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface AgentRuntimeTicketSummary {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly status: 'open' | 'closed';
  readonly authorMemberId: string;
  readonly revision: number;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
  readonly closedByMemberId?: string;
}

export interface AgentRuntimeTicketComment {
  readonly id: string;
  readonly ticketId: string;
  readonly authorMemberId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface AgentRuntimeTicketAcceptedRelation {
  readonly id: string;
  readonly requestId: string;
  readonly kind: CollabTicketCommitRelationKind;
  readonly commitOid: string;
  readonly acceptedMergeOid: string;
  readonly acceptedAt: string;
}

export interface AgentRuntimeConflictEntry {
  readonly path: string;
  readonly kind: CollabConflictKind;
  readonly personalPath?: string;
  readonly acceptedPath?: string;
}

export type AgentRuntimeReviewFileContent =
  | {
    readonly kind: 'text';
    readonly file: AgentRuntimeChangedFile;
    readonly oldText: string | null;
    readonly newText: string | null;
  }
  | {
    readonly kind: 'large-text';
    readonly file: AgentRuntimeChangedFile;
  }
  | {
    readonly kind: 'binary';
    readonly file: AgentRuntimeChangedFile;
  };

export interface AgentRuntimeConflictTextVersion {
  readonly path: string;
  readonly text: string | null;
}

export type AgentRuntimeConflictTextSegment =
  | { readonly kind: 'common'; readonly text: string }
  | {
    readonly kind: 'conflict';
    readonly id: string;
    readonly base: string;
    readonly personal: string;
    readonly accepted: string;
  };

export interface AgentRuntimeConflictOpaqueVersion {
  readonly path: string;
  readonly exists: boolean;
  readonly bytes: number;
}

export type AgentRuntimeConflictFileContent =
  | {
    readonly kind: 'text';
    readonly path: string;
    readonly base: AgentRuntimeConflictTextVersion;
    readonly personal: AgentRuntimeConflictTextVersion;
    readonly accepted: AgentRuntimeConflictTextVersion;
    readonly segments: readonly AgentRuntimeConflictTextSegment[];
  }
  | {
    readonly kind: 'binary' | 'delete-modify' | 'rename-delete';
    readonly path: string;
    readonly base: AgentRuntimeConflictOpaqueVersion;
    readonly personal: AgentRuntimeConflictOpaqueVersion;
    readonly accepted: AgentRuntimeConflictOpaqueVersion;
  }
  | {
    readonly kind: 'directory-file' | 'portability';
    readonly path: string;
  };

export interface AgentRuntimeOperationsListResult {
  readonly access: 'read-write';
  readonly operations: readonly AgentRuntimeOperationSummary[];
  readonly name: 'claudian-agent-runtime';
  readonly protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
}

export interface AgentRuntimeOperationGetResult {
  readonly operation: AgentRuntimeOperationDescriptor;
  readonly protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
}

export interface AgentRuntimeHealthCheckResult {
  readonly ok: true;
  readonly protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
}

export interface AgentRuntimeProjectsListResult {
  readonly projects: readonly AgentRuntimeProjectSummary[];
  readonly selectedProjectId: string | null;
}

export interface AgentRuntimeProjectGetResult {
  readonly project: AgentRuntimeProjectDetail;
}

export interface AgentRuntimePersonalChangesResult {
  readonly projectId: string;
  readonly gitStatus: AgentRuntimeGitStatus | null;
  readonly changes: null | {
    readonly action: CollabPersonalAction;
    readonly hasContribution: boolean;
    readonly updateAvailable: boolean;
    readonly conflictOperationId?: string;
    readonly unpublishedReview: {
      readonly baseOid: string;
      readonly headOid: string;
      readonly files: readonly AgentRuntimeChangedFile[];
    };
    readonly preparedPublication?: {
      readonly operationId: string;
      readonly baseMainOid: string;
      readonly currentMainOid: string;
      readonly contributionHeadOid: string;
      readonly candidateOid: string;
      readonly comparisonBaseOid: string;
      readonly comparisonTargetOid: string;
      readonly canConfirm: boolean;
      readonly files: readonly AgentRuntimeChangedFile[];
    };
  };
}

export interface AgentRuntimePersonalChangeFileResult {
  readonly projectId: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly content: AgentRuntimeReviewFileContent;
}

export interface AgentRuntimeRequestsListResult {
  readonly projectId: string;
  readonly scope: 'open';
  readonly source: 'online' | 'cache';
  readonly stale: boolean;
  readonly sync: AgentRuntimeSyncState;
  readonly requests: readonly AgentRuntimeChangeRequest[];
  readonly members: readonly AgentRuntimeMember[];
}

export interface AgentRuntimeRequestGetResult {
  readonly projectId: string;
  readonly request: AgentRuntimeChangeRequest;
  readonly currentMainOid: string;
  readonly reviewedHeadOid: string;
  readonly reviewCondition: CollabReviewCondition;
  readonly comparisonKind: CollabReviewComparisonKind;
  readonly comparisonBaseOid: string;
  readonly comparisonTargetOid: string;
  readonly changedFiles: readonly AgentRuntimeChangedFile[];
  readonly comments: readonly AgentRuntimeComment[];
  readonly nextCommentCursor?: string;
}

export interface AgentRuntimeRequestCommentsListResult {
  readonly projectId: string;
  readonly requestId: string;
  readonly comments: readonly AgentRuntimeComment[];
  readonly nextCursor?: string;
}

export interface AgentRuntimeRequestFileResult {
  readonly projectId: string;
  readonly requestId: string;
  readonly comparisonKind: CollabReviewComparisonKind;
  readonly comparisonBaseOid: string;
  readonly comparisonTargetOid: string;
  readonly content: AgentRuntimeReviewFileContent;
}

export interface AgentRuntimeTicketsListResult {
  readonly projectId: string;
  readonly status: 'open' | 'closed';
  readonly source: 'online' | 'cache';
  readonly stale: boolean;
  readonly tickets: readonly AgentRuntimeTicketSummary[];
  readonly nextCursor?: string;
}

export interface AgentRuntimeTicketGetResult {
  readonly projectId: string;
  readonly source: 'online' | 'cache';
  readonly stale: boolean;
  readonly ticket: AgentRuntimeTicketSummary;
  readonly body: string;
  readonly comments: readonly AgentRuntimeTicketComment[];
  readonly acceptedRelations: readonly AgentRuntimeTicketAcceptedRelation[];
  readonly nextCommentCursor?: string;
  readonly nextAcceptedRelationCursor?: string;
}

export interface AgentRuntimeTicketCommentsListResult {
  readonly projectId: string;
  readonly ticketId: string;
  readonly comments: readonly AgentRuntimeTicketComment[];
  readonly nextCursor?: string;
}

export interface AgentRuntimeTicketRelationsListResult {
  readonly projectId: string;
  readonly ticketId: string;
  readonly acceptedRelations: readonly AgentRuntimeTicketAcceptedRelation[];
  readonly nextCursor?: string;
}

export interface AgentRuntimeTicketCreateResult {
  readonly projectId: string;
  readonly ticket: AgentRuntimeTicketSummary;
  readonly body: string;
  readonly comments: readonly AgentRuntimeTicketComment[];
  readonly acceptedRelations: readonly AgentRuntimeTicketAcceptedRelation[];
}

export interface AgentRuntimeTicketSummaryMutationResult {
  readonly projectId: string;
  readonly ticket: AgentRuntimeTicketSummary;
}

export interface AgentRuntimeTicketCommentCreateResult {
  readonly projectId: string;
  readonly comment: AgentRuntimeTicketComment;
}

export interface AgentRuntimeRequestCommentCreateResult {
  readonly projectId: string;
  readonly comment: AgentRuntimeComment;
}

export interface AgentRuntimeRequestAcceptResult {
  readonly projectId: string;
  readonly request: AgentRuntimeChangeRequest;
  readonly mainOid: string;
  readonly mergeCommitOid: string;
}

export interface AgentRuntimePublicationReview {
  readonly operationId: string;
  readonly baseMainOid: string;
  readonly currentMainOid: string;
  readonly contributionHeadOid: string;
  readonly candidateOid: string;
  readonly comparisonBaseOid: string;
  readonly comparisonTargetOid: string;
  readonly canConfirm: boolean;
  readonly files: readonly AgentRuntimeChangedFile[];
}

export interface AgentRuntimeChangesPublishResult {
  readonly projectId: string;
  readonly state:
    | 'committed-locally'
    | 'pushed'
    | 'request-synchronized'
    | 'review-required';
  readonly localHeadOid: string;
  readonly remoteHeadOid?: string;
  readonly request?: AgentRuntimeChangeRequest;
  readonly review?: AgentRuntimePublicationReview;
}

export type AgentRuntimeConflictLocation = 'my-changes' | 'request';

export interface AgentRuntimeConflictGetResult {
  readonly projectId: string;
  readonly conflict: null | {
    readonly operationId: string;
    readonly location: AgentRuntimeConflictLocation;
    readonly requestId?: string;
    readonly startingPersonalOid: string;
    readonly startingMainOid: string;
    readonly mergeBaseOid: string;
    readonly conflicts: readonly AgentRuntimeConflictEntry[];
  };
}

export interface AgentRuntimeConflictFileResult {
  readonly projectId: string;
  readonly operationId: string;
  readonly location: AgentRuntimeConflictLocation;
  readonly requestId?: string;
  readonly content: AgentRuntimeConflictFileContent;
}

export type AgentRuntimeRpcResult =
  | AgentRuntimeOperationsListResult
  | AgentRuntimeOperationGetResult
  | AgentRuntimeHealthCheckResult
  | AgentRuntimeProjectsListResult
  | AgentRuntimeProjectGetResult
  | AgentRuntimePersonalChangesResult
  | AgentRuntimePersonalChangeFileResult
  | AgentRuntimeRequestsListResult
  | AgentRuntimeRequestGetResult
  | AgentRuntimeRequestCommentsListResult
  | AgentRuntimeRequestFileResult
  | AgentRuntimeTicketsListResult
  | AgentRuntimeTicketGetResult
  | AgentRuntimeTicketCommentsListResult
  | AgentRuntimeTicketRelationsListResult
  | AgentRuntimeTicketCreateResult
  | AgentRuntimeTicketSummaryMutationResult
  | AgentRuntimeTicketCommentCreateResult
  | AgentRuntimeRequestCommentCreateResult
  | AgentRuntimeRequestAcceptResult
  | AgentRuntimeChangesPublishResult
  | AgentRuntimeConflictGetResult
  | AgentRuntimeConflictFileResult;

export interface AgentRuntimeRpcError {
  readonly code: AgentRuntimeRpcErrorCode;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface AgentRuntimeRpcSuccessResponse {
  readonly id: string;
  readonly result: AgentRuntimeRpcResult;
}

export interface AgentRuntimeRpcErrorResponse {
  readonly id: string | null;
  readonly error: AgentRuntimeRpcError;
}

export type AgentRuntimeRpcResponse =
  | AgentRuntimeRpcSuccessResponse
  | AgentRuntimeRpcErrorResponse;

export type AgentRuntimeRpcEnvelopeDecodeResult =
  | { readonly status: 'success'; readonly envelope: AgentRuntimeRpcEnvelope }
  | { readonly status: 'invalid-request' };

const RPC_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const REQUEST_KEYS = new Set(['id', 'method', 'params']);

export function decodeAgentRuntimeRpcEnvelope(
  input: unknown,
): AgentRuntimeRpcEnvelopeDecodeResult {
  if (!isPlainRecord(input)) return { status: 'invalid-request' };
  const keys = Object.keys(input);
  if (keys.length !== REQUEST_KEYS.size || keys.some(key => !REQUEST_KEYS.has(key))) {
    return { status: 'invalid-request' };
  }
  if (typeof input.id !== 'string' || !RPC_ID_PATTERN.test(input.id)) {
    return { status: 'invalid-request' };
  }
  if (typeof input.method !== 'string' || !isPlainRecord(input.params)) {
    return { status: 'invalid-request' };
  }
  return {
    envelope: {
      id: input.id,
      method: input.method,
      params: input.params,
    },
    status: 'success',
  };
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
