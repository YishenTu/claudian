import { type CollabChangedFile, type CollabChangeRequest, type CollabComment, type CollabMember, type CollabRequestTicketRelation, type CollabResolvingTicketExpectation, type CollabTicketAcceptedRelation, type CollabTicketComment, type CollabTicketDetail, type CollabTicketSummary } from '@claudian/collab-protocol';

import { type CollabBoundedQueryPort, type CollabConflictEntry, type CollabConflictFileContent, type CollabConflictOpaqueVersion, type CollabFeaturePort, type CollabLocalProjectSummary, type CollabProjectInspection, type CollabPublicationReview, type CollabPublishOutcome, type CollabResult, type CollabReviewFileContent } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRuntimeChangedFile,
  type AgentRuntimeChangeRequest,
  type AgentRuntimeChangesPublishResult,
  type AgentRuntimeComment,
  type AgentRuntimeConflictEntry,
  type AgentRuntimeConflictFileContent,
  type AgentRuntimeConflictGetResult,
  type AgentRuntimeConflictLocation,
  type AgentRuntimeConflictOpaqueVersion,
  type AgentRuntimeMember,
  type AgentRuntimeOperationAccess,
  type AgentRuntimeOperationDescriptor,
  type AgentRuntimeOperationSummary,
  type AgentRuntimeParameterDescriptor,
  type AgentRuntimeProjectDetail,
  type AgentRuntimeProjectSummary,
  type AgentRuntimePublicationReview,
  type AgentRuntimeReviewFileContent,
  type AgentRuntimeRpcEnvelope,
  type AgentRuntimeRpcError,
  type AgentRuntimeRpcErrorResponse,
  type AgentRuntimeRpcResponse,
  type AgentRuntimeRpcResult,
  type AgentRuntimeSyncState,
  type AgentRuntimeTicketAcceptedRelation,
  type AgentRuntimeTicketComment,
  type AgentRuntimeTicketCreateResult,
  type AgentRuntimeTicketRelation,
  type AgentRuntimeTicketSummary,
  type AgentRuntimeValueSchema,
  isPlainRecord,
} from './AgentRuntimeRpc';

export type CollabAgentPort = Pick<
  CollabFeaturePort,
  | 'addComment'
  | 'addTicketComment'
  | 'acceptRequest'
  | 'closeTicket'
  | 'confirmPublish'
  | 'createTicket'
  | 'listProjects'
  | 'readProjectSelection'
  | 'inspectProject'
  | 'readSnapshot'
  | 'readReviewFile'
  | 'readWorkingTreeReviewFile'
  | 'readConflict'
  | 'readConflictFile'
  | 'listTickets'
  | 'publish'
  | 'reopenTicket'
  | 'updateTicketContent'
> & { readonly boundedQueries: CollabAgentQueryPort };

export type CollabAgentQueryPort = CollabBoundedQueryPort;

export type ResolveCollabAgentPort = () => Promise<CollabAgentPort | null>;

export interface AgentRuntimePreparedInvocation {
  readonly access: AgentRuntimeOperationAccess;
  readonly id: string;
  execute(signal: AbortSignal): Promise<AgentRuntimeRpcResponse>;
}

export type AgentRuntimeMethodPrepareResult =
  | { readonly status: 'method-not-found' }
  | { readonly status: 'invalid-params' }
  | {
    readonly status: 'success';
    readonly invocation: AgentRuntimePreparedInvocation;
  };

interface AgentRuntimeMethodContext {
  readonly intentId: string;
  readonly resolveCollab: ResolveCollabAgentPort;
}

type AgentRuntimeMethodOutcome =
  | { readonly status: 'success'; readonly result: AgentRuntimeRpcResult }
  | { readonly status: 'error'; readonly error: AgentRuntimeRpcError };

interface AgentRuntimeMethodDefinition {
  readonly access?: AgentRuntimeOperationAccess;
  readonly description: string;
  readonly parameters: readonly AgentRuntimeParameterDescriptor[];
  readonly resultDescription: string;
  execute(
    params: Readonly<Record<string, unknown>>,
    context: AgentRuntimeMethodContext,
    signal: AbortSignal,
  ): Promise<AgentRuntimeMethodOutcome>;
  readonly validate?: (params: Readonly<Record<string, unknown>>) => boolean;
}

const CONTROL_FREE_PATTERN = '^[^\\u0000-\\u001F\\u007F]+$';

const OPAQUE_ID = Object.freeze({
  maxLength: 256,
  minLength: 1,
  pattern: CONTROL_FREE_PATTERN,
  type: 'string' as const,
});

const RELATIVE_PATH = Object.freeze({
  maxLength: 4096,
  minLength: 1,
  pattern: CONTROL_FREE_PATTERN,
  type: 'string' as const,
});

const SHARED_PAGE_CURSOR = Object.freeze({
  maxLength: CLAUDIAN_COLLAB_LIMITS.maxPageCursorUtf16,
  minLength: 1,
  pattern: CONTROL_FREE_PATTERN,
  type: 'string' as const,
});

const NONBLANK_PATTERN = '[^\\s]';

const REQUEST_REVISION = Object.freeze({
  minimum: 0,
  type: 'integer' as const,
});

const TICKET_REVISION = Object.freeze({
  minimum: 1,
  type: 'integer' as const,
});

const TICKET_TITLE = Object.freeze({
  maxLength: CLAUDIAN_COLLAB_LIMITS.maxTicketTitleUtf16,
  minLength: 1,
  pattern: NONBLANK_PATTERN,
  type: 'string' as const,
});

const TICKET_BODY = Object.freeze({
  maxBytes: CLAUDIAN_COLLAB_LIMITS.maxTicketBodyBytes,
  minBytes: 1,
  pattern: NONBLANK_PATTERN,
  type: 'string' as const,
});

const REQUEST_COMMENT_BODY = Object.freeze({
  maxBytes: CLAUDIAN_COLLAB_LIMITS.maxCommentBytes,
  minBytes: 1,
  pattern: NONBLANK_PATTERN,
  type: 'string' as const,
});

const TICKET_COMMENT_BODY = Object.freeze({
  maxBytes: CLAUDIAN_COLLAB_LIMITS.maxTicketCommentBytes,
  minBytes: 1,
  pattern: NONBLANK_PATTERN,
  type: 'string' as const,
});

const PUBLISH_DESCRIPTION = Object.freeze({
  maxBytes: CLAUDIAN_COLLAB_LIMITS.maxRequestDescriptionBytes,
  minBytes: 1,
  pattern: NONBLANK_PATTERN,
  type: 'string' as const,
});

const OID = Object.freeze({
  pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$',
  type: 'string' as const,
});

const OPERATION_NAME = Object.freeze({
  maxLength: 128,
  minLength: 1,
  pattern: '^[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+$',
  type: 'string' as const,
});

const param = (
  name: string,
  description: string,
  required: boolean,
  schema: AgentRuntimeValueSchema,
): AgentRuntimeParameterDescriptor => Object.freeze({
  description,
  name,
  required,
  schema,
});

const projectIdParam = () => param(
  'projectId',
  'Exact Project ID returned by collab.projects.list.',
  true,
  OPAQUE_ID,
);
const requestIdParam = () => param(
  'requestId',
  'Exact Request ID returned by a trusted Runtime result.',
  true,
  OPAQUE_ID,
);
const ticketIdParam = () => param(
  'ticketId',
  'Exact Ticket ID returned by collab.tickets.list.',
  true,
  OPAQUE_ID,
);
const pathParam = () => param(
  'path',
  'Exact changed-file path returned by the owning manifest.',
  true,
  RELATIVE_PATH,
);

const sharedPageParams = (
  owner: AgentRuntimeParameterDescriptor,
  noun: string,
  defaultLimit: number,
  maximum: number,
): readonly AgentRuntimeParameterDescriptor[] => Object.freeze([
  projectIdParam(),
  owner,
  param('cursor', `Opaque cursor returned by a previous ${noun} page.`, false, SHARED_PAGE_CURSOR),
  param('limit', `Maximum ${noun} entries to return.`, false, {
    default: defaultLimit,
    maximum,
    minimum: 1,
    type: 'integer',
  }),
]);

const requestRevisionParam = (name = 'expectedRequestRevision') => param(
  name,
  'Exact non-negative revision returned by the owning Runtime read.',
  true,
  REQUEST_REVISION,
);

const ticketRevisionParam = (name = 'expectedRevision') => param(
  name,
  'Exact positive Ticket revision returned by the owning Runtime read.',
  true,
  TICKET_REVISION,
);

const resolvingTicketsParam = () => param(
  'expectedResolvingTickets',
  'Exact resolving Ticket IDs and revisions returned by the Request detail.',
  true,
  Object.freeze({
    items: Object.freeze({
      additionalProperties: false as const,
      properties: Object.freeze([
        ticketIdParam(),
        ticketRevisionParam('revision'),
      ]),
      type: 'object' as const,
    }),
    maxItems: CLAUDIAN_COLLAB_LIMITS.maxRequestTicketRelations,
    minItems: 0,
    type: 'array' as const,
    uniqueBy: 'ticketId',
  }),
);

const EMPTY_PARAMS: readonly AgentRuntimeParameterDescriptor[] = Object.freeze([]);

const METHOD_DEFINITIONS = {
  'runtime.health.check': {
    description: 'Check whether this Vault Agent Runtime is reachable.',
    parameters: EMPTY_PARAMS,
    resultDescription: 'A fixed healthy response.',
    execute: async () => success({
      ok: true,
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
    }),
  },
  'runtime.operations.list': {
    description: 'List lightweight Agent Runtime operation summaries.',
    parameters: EMPTY_PARAMS,
    resultDescription: 'Runtime identity, access mode, and operation summaries.',
    execute: async () => listRuntimeOperations(),
  },
  'runtime.operations.get': {
    description: 'Get the exact contract for one Agent Runtime operation.',
    parameters: Object.freeze([
      param('name', 'Exact operation name returned by runtime.operations.list.', true, OPERATION_NAME),
    ]),
    resultDescription: 'One exact operation descriptor.',
    execute: async params => getRuntimeOperation(stringParam(params, 'name')),
  },
  'collab.projects.list': {
    description: 'List lightweight Collab Project summaries in this Vault.',
    parameters: EMPTY_PARAMS,
    resultDescription: 'Project IDs, names, roles, health, connection state, and selected Project ID.',
    execute: async (_params, context, signal) => withCollab(
      context,
      signal,
      async collab => {
        const projectsResult = await collab.listProjects(operationOptions(signal));
        if (projectsResult.status !== 'success') {
          return mapCollabResult(projectsResult, () => ({
            projects: [],
            selectedProjectId: null,
          }));
        }
        const projects = projectsResult.value;
        return mapCollabResult(
          await collab.readProjectSelection(operationOptions(signal)),
          selection => ({
            projects: projects.map(toProjectSummary),
            selectedProjectId: projects.some(project => project.id === selection.selectedProjectId)
              ? selection.selectedProjectId
              : null,
          }),
        );
      },
    ),
  },
  'collab.projects.get': {
    description: 'Read one Collab Project detail and coordination summary.',
    parameters: Object.freeze([projectIdParam()]),
    resultDescription: 'Project detail, active Members, main identity, sync, and counts.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.inspectProject(stringParam(params, 'projectId'), operationOptions(signal)),
        inspection => ({ project: toProjectDetail(inspection) }),
      ),
    ),
  },
  'collab.tickets.list': {
    description: 'List one page of open or closed Tickets.',
    parameters: Object.freeze([
      projectIdParam(),
      param('status', 'Ticket status filter.', true, {
        enum: Object.freeze(['open', 'closed']),
        type: 'string',
      }),
      param(
        'cursor',
        'Opaque cursor returned by a previous Ticket page.',
        false,
        SHARED_PAGE_CURSOR,
      ),
      param('limit', 'Maximum Tickets to return.', false, {
        default: CLAUDIAN_COLLAB_LIMITS.defaultTicketPageSize,
        maximum: CLAUDIAN_COLLAB_LIMITS.maxTicketPageSize,
        minimum: 1,
        type: 'integer',
      }),
    ]),
    resultDescription: 'A bounded Ticket summary page with source and staleness.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.listTickets({
          projectId: stringParam(params, 'projectId'),
          status: stringParam(params, 'status') as 'open' | 'closed',
          ...(params.cursor === undefined ? {} : { cursor: stringParam(params, 'cursor') }),
          ...(params.limit === undefined ? {} : { limit: numberParam(params, 'limit') }),
        }, operationOptions(signal)),
        projection => ({
          projectId: stringParam(params, 'projectId'),
          source: projection.source,
          stale: projection.stale,
          status: stringParam(params, 'status') as 'open' | 'closed',
          tickets: projection.page.tickets.map(toTicketSummary),
          ...(projection.page.nextCursor === undefined
            ? {}
            : { nextCursor: projection.page.nextCursor }),
        }),
      ),
    ),
  },
  'collab.tickets.get': {
    description: 'Read one Ticket body and first bounded activity pages.',
    parameters: Object.freeze([projectIdParam(), ticketIdParam()]),
    resultDescription: 'Ticket detail with bounded comments, relations, and continuation cursors.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.boundedQueries.readTicket(
          stringParam(params, 'projectId'),
          stringParam(params, 'ticketId'),
          operationOptions(signal),
        ),
        projection => ({
          acceptedRelations: projection.detail.acceptedRelations.acceptedRelations
            .map(toTicketAcceptedRelation),
          body: projection.detail.body,
          comments: projection.detail.comments.comments.map(toTicketComment),
          ...(projection.detail.comments.nextCursor === undefined
            ? {}
            : { nextCommentCursor: projection.detail.comments.nextCursor }),
          ...(projection.detail.acceptedRelations.nextCursor === undefined
            ? {}
            : {
              nextAcceptedRelationCursor: projection.detail.acceptedRelations.nextCursor,
            }),
          projectId: stringParam(params, 'projectId'),
          source: projection.source,
          stale: projection.stale,
          ticket: toTicketSummary(projection.detail.ticket),
        }),
      ),
    ),
  },
  'collab.tickets.comments.list': {
    description: 'List one bounded page of immutable Ticket comments.',
    parameters: sharedPageParams(
      ticketIdParam(),
      'Ticket comment',
      CLAUDIAN_COLLAB_LIMITS.defaultCommentPageSize,
      CLAUDIAN_COLLAB_LIMITS.maxCommentPageSize,
    ),
    resultDescription: 'Ticket comments and an optional continuation cursor.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.boundedQueries.listTicketComments(
          stringParam(params, 'projectId'),
          stringParam(params, 'ticketId'),
          {
            ...(params.cursor === undefined ? {} : { cursor: stringParam(params, 'cursor') }),
            ...(params.limit === undefined ? {} : { limit: numberParam(params, 'limit') }),
          },
          operationOptions(signal),
        ),
        page => ({
          comments: page.comments.map(toTicketComment),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          projectId: stringParam(params, 'projectId'),
          ticketId: stringParam(params, 'ticketId'),
        }),
      ),
    ),
  },
  'collab.tickets.relations.list': {
    description: 'List one bounded page of accepted Request relations for a Ticket.',
    parameters: sharedPageParams(
      ticketIdParam(),
      'accepted relation',
      CLAUDIAN_COLLAB_LIMITS.maxRelationsPerPage,
      CLAUDIAN_COLLAB_LIMITS.maxRelationsPerPage,
    ),
    resultDescription: 'Accepted relations and an optional continuation cursor.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.boundedQueries.listTicketAcceptedRelations(
          stringParam(params, 'projectId'),
          stringParam(params, 'ticketId'),
          {
            ...(params.cursor === undefined ? {} : { cursor: stringParam(params, 'cursor') }),
            ...(params.limit === undefined ? {} : { limit: numberParam(params, 'limit') }),
          },
          operationOptions(signal),
        ),
        page => ({
          acceptedRelations: page.acceptedRelations.map(toTicketAcceptedRelation),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          projectId: stringParam(params, 'projectId'),
          ticketId: stringParam(params, 'ticketId'),
        }),
      ),
    ),
  },
  'collab.requests.list': {
    description: 'List open change Requests and active Members for one Project.',
    parameters: Object.freeze([projectIdParam()]),
    resultDescription: 'Open Requests, active Members, source, staleness, and sync state.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.readSnapshot(stringParam(params, 'projectId'), operationOptions(signal)),
        coordination => ({
          members: coordination.snapshot.members
            .filter(member => member.status === 'active')
            .map(toActiveMember),
          projectId: stringParam(params, 'projectId'),
          requests: coordination.snapshot.openRequests.map(toChangeRequest),
          scope: 'open',
          source: coordination.source,
          stale: coordination.stale,
          sync: toSyncState(coordination.syncState),
        }),
      ),
    ),
  },
  'collab.requests.get': {
    description: 'Read one change Request with a bounded comment page and changed-file manifest.',
    parameters: Object.freeze([projectIdParam(), requestIdParam()]),
    resultDescription: 'Exact Request metadata, bounded comments, continuation cursor, and effective review comparison.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.boundedQueries.prepareReview(
          stringParam(params, 'projectId'),
          stringParam(params, 'requestId'),
          operationOptions(signal),
        ),
        review => ({
          changedFiles: review.files.map(toChangedFile),
          comments: review.detail.comments.comments.map(toComment),
          ...(review.detail.comments.nextCursor === undefined
            ? {}
            : { nextCommentCursor: review.detail.comments.nextCursor }),
          comparisonBaseOid: review.comparisonBaseOid,
          comparisonKind: review.comparisonKind,
          comparisonTargetOid: review.comparisonTargetOid,
          currentMainOid: review.detail.currentMainOid,
          projectId: stringParam(params, 'projectId'),
          request: toChangeRequest(review.detail.request),
          reviewedHeadOid: review.detail.reviewedHeadOid,
          reviewCondition: review.detail.reviewCondition,
        }),
      ),
    ),
  },
  'collab.requests.comments.list': {
    description: 'List one bounded page of immutable Request comments.',
    parameters: sharedPageParams(
      requestIdParam(),
      'Request comment',
      CLAUDIAN_COLLAB_LIMITS.defaultCommentPageSize,
      CLAUDIAN_COLLAB_LIMITS.maxCommentPageSize,
    ),
    resultDescription: 'Request comments and an optional continuation cursor.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.boundedQueries.listRequestComments(
          stringParam(params, 'projectId'),
          stringParam(params, 'requestId'),
          {
            ...(params.cursor === undefined ? {} : { cursor: stringParam(params, 'cursor') }),
            ...(params.limit === undefined ? {} : { limit: numberParam(params, 'limit') }),
          },
          operationOptions(signal),
        ),
        page => ({
          comments: page.comments.map(toComment),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          projectId: stringParam(params, 'projectId'),
          requestId: stringParam(params, 'requestId'),
        }),
      ),
    ),
  },
  'collab.requests.file.get': {
    description: 'Read one file from an exact re-prepared change Request review.',
    parameters: Object.freeze([projectIdParam(), requestIdParam(), pathParam()]),
    resultDescription: 'Request comparison identity and text or opaque file metadata.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      collab => readRequestFile(collab, params, signal),
    ),
  },
  'collab.changes.mine': {
    description: 'Read the current Member personal unpublished-change manifest.',
    parameters: Object.freeze([projectIdParam()]),
    resultDescription: 'Personal Git summary, unpublished review, and owned publication state.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.inspectProject(stringParam(params, 'projectId'), operationOptions(signal)),
        inspection => toPersonalChangesResult(stringParam(params, 'projectId'), inspection),
      ),
    ),
  },
  'collab.changes.file.get': {
    description: 'Read one file from the current Member unpublished working-tree review.',
    parameters: Object.freeze([projectIdParam(), pathParam()]),
    resultDescription: 'Working-tree comparison identity and text or opaque file metadata.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      collab => readPersonalChangeFile(collab, params, signal),
    ),
  },
  'collab.conflicts.get': {
    description: 'Read the current Member single durable conflict from My changes or an existing Request.',
    parameters: Object.freeze([projectIdParam()]),
    resultDescription: 'Conflict location and immutable file manifest; resolution happens by editing Project files and publishing again.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.inspectProject(stringParam(params, 'projectId'), operationOptions(signal)),
        inspection => toConflictGetResult(stringParam(params, 'projectId'), inspection),
      ),
    ),
  },
  'collab.conflicts.file.get': {
    description: 'Read one file from the current Member durable conflict operation.',
    parameters: Object.freeze([projectIdParam(), pathParam()]),
    resultDescription: 'Immutable base, personal, and accepted versions or opaque metadata for comparison only.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      collab => readConflictFile(collab, params, signal),
    ),
  },
  'collab.tickets.create': {
    access: 'write',
    description: 'Create a Ticket in one Collab Project.',
    parameters: Object.freeze([
      projectIdParam(),
      param('title', 'Nonblank Ticket title.', true, TICKET_TITLE),
      param('body', 'Nonblank Ticket Markdown body.', true, TICKET_BODY),
    ]),
    resultDescription: 'The newly created public Ticket detail.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.createTicket({
          body: stringParam(params, 'body'),
          intentId: context.intentId,
          projectId: stringParam(params, 'projectId'),
          title: stringParam(params, 'title'),
        }, operationOptions(signal)),
        detail => toTicketCreateResult(stringParam(params, 'projectId'), detail),
      ),
    ),
  },
  'collab.tickets.update': {
    access: 'write',
    description: 'Update one Ticket title and Markdown body.',
    parameters: Object.freeze([
      projectIdParam(),
      ticketIdParam(),
      ticketRevisionParam(),
      param('title', 'Nonblank Ticket title.', true, TICKET_TITLE),
      param('body', 'Nonblank Ticket Markdown body.', true, TICKET_BODY),
    ]),
    resultDescription: 'The updated public Ticket summary.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.updateTicketContent({
          body: stringParam(params, 'body'),
          expectedRevision: numberParam(params, 'expectedRevision'),
          intentId: context.intentId,
          projectId: stringParam(params, 'projectId'),
          ticketId: stringParam(params, 'ticketId'),
          title: stringParam(params, 'title'),
        }, operationOptions(signal)),
        ticket => ({ projectId: stringParam(params, 'projectId'), ticket: toTicketSummary(ticket) }),
      ),
    ),
  },
  'collab.tickets.comments.create': {
    access: 'write',
    description: 'Add an immutable comment to one Ticket.',
    parameters: Object.freeze([
      projectIdParam(),
      ticketIdParam(),
      param('body', 'Nonblank Ticket comment Markdown.', true, TICKET_COMMENT_BODY),
    ]),
    resultDescription: 'The newly created public Ticket comment.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.addTicketComment({
          body: stringParam(params, 'body'),
          intentId: context.intentId,
          projectId: stringParam(params, 'projectId'),
          ticketId: stringParam(params, 'ticketId'),
        }, operationOptions(signal)),
        comment => ({
          comment: toTicketComment(comment),
          projectId: stringParam(params, 'projectId'),
        }),
      ),
    ),
  },
  'collab.tickets.close': ticketStatusDefinition('close'),
  'collab.tickets.reopen': ticketStatusDefinition('reopen'),
  'collab.changes.publish': {
    access: 'write',
    description: 'Publish all current Member unpublished changes, including a local-file resolution of an active conflict.',
    parameters: Object.freeze([
      projectIdParam(),
      param('description', 'Nonblank change Request Markdown description.', true, PUBLISH_DESCRIPTION),
    ]),
    resultDescription: 'The final observed publication state after at most one exact confirmation, reusing an existing Request when present.',
    execute: (params, context, signal) => withCollab(
      context,
      signal,
      collab => publishChanges(collab, params, signal),
    ),
  },
  'collab.requests.comments.create': {
    access: 'write',
    description: 'Add an immutable comment to an open change Request.',
    parameters: Object.freeze([
      projectIdParam(),
      requestIdParam(),
      param('body', 'Nonblank Request comment Markdown.', true, REQUEST_COMMENT_BODY),
    ]),
    resultDescription: 'The newly created public Request comment.',
    execute: (params, context, signal) => withCollab(
      context,
      signal,
      collab => createRequestComment(collab, params, context.intentId, signal),
    ),
  },
  'collab.requests.accept': {
    access: 'write',
    description: 'Accept one exact open change Request as the current Manager.',
    parameters: Object.freeze([
      projectIdParam(),
      requestIdParam(),
      param('expectedMainOid', 'Exact reviewed main OID.', true, OID),
      param('expectedHeadOid', 'Exact reviewed Request head OID.', true, OID),
      requestRevisionParam(),
      resolvingTicketsParam(),
    ]),
    resultDescription: 'The merged public Request and resulting main identities.',
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => mapCollabResult(
        await collab.acceptRequest({
          expectedHeadOid: stringParam(params, 'expectedHeadOid'),
          expectedMainOid: stringParam(params, 'expectedMainOid'),
          expectedRequestRevision: numberParam(params, 'expectedRequestRevision'),
          expectedResolvingTickets: resolvingTicketsParamValue(params),
          intentId: context.intentId,
          projectId: stringParam(params, 'projectId'),
          requestId: stringParam(params, 'requestId'),
        }, operationOptions(signal)),
        outcome => ({
          mainOid: outcome.mainOid,
          mergeCommitOid: outcome.mergeCommitOid,
          projectId: stringParam(params, 'projectId'),
          request: toChangeRequest(outcome.request),
        }),
      ),
    ),
  },
} as const satisfies Readonly<Record<string, AgentRuntimeMethodDefinition>>;

export type AgentRuntimeRpcMethod = Extract<keyof typeof METHOD_DEFINITIONS, string>;

export const AGENT_RUNTIME_OPERATION_NAMES: readonly AgentRuntimeRpcMethod[] = Object.freeze(
  Object.keys(METHOD_DEFINITIONS) as AgentRuntimeRpcMethod[],
);

export const AGENT_RUNTIME_OPERATION_DESCRIPTORS: readonly AgentRuntimeOperationDescriptor[] =
  Object.freeze(AGENT_RUNTIME_OPERATION_NAMES.map(name => {
    const definition: AgentRuntimeMethodDefinition = METHOD_DEFINITIONS[name];
    return Object.freeze({
      access: definition.access ?? 'read',
      description: definition.description,
      name,
      parameters: definition.parameters,
      resultDescription: definition.resultDescription,
    });
  }));

export const AGENT_RUNTIME_OPERATION_SUMMARIES: readonly AgentRuntimeOperationSummary[] =
  Object.freeze(AGENT_RUNTIME_OPERATION_DESCRIPTORS.map(operation => Object.freeze({
    access: operation.access,
    description: operation.description,
    name: operation.name,
  })));

export class AgentRuntimeMethodRegistry {
  constructor(private readonly resolveCollab: ResolveCollabAgentPort) {}

  prepare(envelope: AgentRuntimeRpcEnvelope): AgentRuntimeMethodPrepareResult {
    if (!isAgentRuntimeRpcMethod(envelope.method)) return { status: 'method-not-found' };
    const definition: AgentRuntimeMethodDefinition = METHOD_DEFINITIONS[envelope.method];
    const params = decodeParams(envelope.params, definition.parameters);
    if (!params || definition.validate?.(params) === false) {
      return { status: 'invalid-params' };
    }

    return {
      invocation: {
        access: definition.access ?? 'read',
        execute: signal => this.execute(
          envelope.id,
          definition,
          params,
          signal,
        ),
        id: envelope.id,
      },
      status: 'success',
    };
  }

  private async execute(
    id: string,
    definition: AgentRuntimeMethodDefinition,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AgentRuntimeRpcResponse> {
    if (signal.aborted) return errorResponse(id, cancelledError());
    try {
      const outcome = await definition.execute(
        params,
        {
          intentId: intentIdFromRpcId(id),
          resolveCollab: this.resolveCollab,
        },
        signal,
      );
      if (signal.aborted) return errorResponse(id, cancelledError());
      return outcome.status === 'success'
        ? { id, result: outcome.result }
        : errorResponse(id, outcome.error);
    } catch {
      return errorResponse(
        id,
        signal.aborted
          ? cancelledError()
          : { code: 'internal_error', message: 'Internal Agent Runtime error.' },
      );
    }
  }
}

function ticketStatusDefinition(
  action: 'close' | 'reopen',
): AgentRuntimeMethodDefinition {
  return {
    access: 'write',
    description: `${action === 'close' ? 'Close' : 'Reopen'} one Ticket.`,
    parameters: Object.freeze([
      projectIdParam(),
      ticketIdParam(),
      ticketRevisionParam(),
    ]),
    resultDescription: `The ${action === 'close' ? 'closed' : 'reopened'} public Ticket summary.`,
    execute: async (params, context, signal) => withCollab(
      context,
      signal,
      async collab => {
        const request = {
          expectedRevision: numberParam(params, 'expectedRevision'),
          intentId: context.intentId,
          projectId: stringParam(params, 'projectId'),
          ticketId: stringParam(params, 'ticketId'),
        };
        const result = action === 'close'
          ? await collab.closeTicket(request, operationOptions(signal))
          : await collab.reopenTicket(request, operationOptions(signal));
        return mapCollabResult(result, ticket => ({
          projectId: stringParam(params, 'projectId'),
          ticket: toTicketSummary(ticket),
        }));
      },
    ),
  };
}

function listRuntimeOperations(): AgentRuntimeMethodOutcome {
  return success({
    access: 'read-write',
    name: 'claudian-agent-runtime',
    operations: AGENT_RUNTIME_OPERATION_SUMMARIES,
    protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  });
}

function getRuntimeOperation(name: string): AgentRuntimeMethodOutcome {
  const operation = AGENT_RUNTIME_OPERATION_DESCRIPTORS.find(candidate => candidate.name === name);
  return operation
    ? success({ operation, protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION })
    : error({
      code: 'operation_not_found',
      data: { name },
      message: 'Unknown Agent Runtime operation.',
    });
}

async function withCollab(
  context: AgentRuntimeMethodContext,
  signal: AbortSignal,
  operation: (collab: CollabAgentPort) => Promise<AgentRuntimeMethodOutcome>,
): Promise<AgentRuntimeMethodOutcome> {
  if (signal.aborted) return error(cancelledError());
  let collab: CollabAgentPort | null;
  try {
    collab = await context.resolveCollab();
  } catch {
    return error(serviceUnavailableError());
  }
  if (signal.aborted) return error(cancelledError());
  if (!collab) return error(serviceUnavailableError());
  return operation(collab);
}

async function readRequestFile(
  collab: CollabAgentPort,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<AgentRuntimeMethodOutcome> {
  const projectId = stringParam(params, 'projectId');
  const requestId = stringParam(params, 'requestId');
  const path = stringParam(params, 'path');
  const prepared = await collab.boundedQueries.prepareReview(
    projectId,
    requestId,
    operationOptions(signal),
  );
  if (prepared.status !== 'success') return mapCollabFailure(prepared);
  const file = prepared.value.files.find(entry => entry.path === path);
  if (!file) return invalidPath(projectId, path);
  const content = await collab.readReviewFile({
    comparisonBaseOid: prepared.value.comparisonBaseOid,
    comparisonTargetOid: prepared.value.comparisonTargetOid,
    file,
    projectId,
    requestId,
  }, operationOptions(signal));
  return mapCollabResult(content, value => ({
    comparisonBaseOid: prepared.value.comparisonBaseOid,
    comparisonKind: prepared.value.comparisonKind,
    comparisonTargetOid: prepared.value.comparisonTargetOid,
    content: toReviewFileContent(value),
    projectId,
    requestId,
  }));
}

async function readPersonalChangeFile(
  collab: CollabAgentPort,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<AgentRuntimeMethodOutcome> {
  const projectId = stringParam(params, 'projectId');
  const path = stringParam(params, 'path');
  const inspected = await collab.inspectProject(projectId, operationOptions(signal));
  if (inspected.status !== 'success') return mapCollabFailure(inspected);
  const review = inspected.value.personalChanges?.unpublishedReview;
  const file = review?.files.find(entry => entry.path === path);
  if (!review || !file) return invalidPath(projectId, path);
  const content = await collab.readWorkingTreeReviewFile({
    baseOid: review.baseOid,
    file,
    headOid: review.headOid,
    projectId,
    snapshotId: review.snapshotId,
  }, operationOptions(signal));
  return mapCollabResult(content, value => ({
    baseOid: review.baseOid,
    content: toReviewFileContent(value),
    headOid: review.headOid,
    projectId,
  }));
}

async function readConflictFile(
  collab: CollabAgentPort,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<AgentRuntimeMethodOutcome> {
  const projectId = stringParam(params, 'projectId');
  const path = stringParam(params, 'path');
  const inspected = await collab.inspectProject(projectId, operationOptions(signal));
  if (inspected.status !== 'success') return mapCollabFailure(inspected);
  const operationId = inspected.value.conflict?.descriptor.operationId;
  if (!operationId) return invalidPath(projectId, path);
  const current = await collab.readConflict(operationId, operationOptions(signal));
  if (current.status !== 'success') return mapCollabFailure(current);
  if (
    current.value.descriptor.projectId !== projectId
    || !current.value.descriptor.conflicts.some(entry => entry.path === path)
  ) {
    return invalidPath(projectId, path);
  }
  const content = await collab.readConflictFile({ operationId, path }, operationOptions(signal));
  const ownership = conflictOwnership(inspected.value);
  return mapCollabResult(content, value => ({
    content: toConflictFileContent(value),
    location: ownership.location,
    operationId,
    projectId,
    ...(ownership.requestId === undefined ? {} : { requestId: ownership.requestId }),
  }));
}

async function createRequestComment(
  collab: CollabAgentPort,
  params: Readonly<Record<string, unknown>>,
  intentId: string,
  signal: AbortSignal,
): Promise<AgentRuntimeMethodOutcome> {
  const projectId = stringParam(params, 'projectId');
  const requestId = stringParam(params, 'requestId');
  return mapCollabResult(await collab.addComment({
    body: stringParam(params, 'body'),
    intentId,
    projectId,
    requestId,
  }, operationOptions(signal)), comment => ({
    comment: toComment(comment),
    projectId,
  }));
}

async function publishChanges(
  collab: CollabAgentPort,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<AgentRuntimeMethodOutcome> {
  const projectId = stringParam(params, 'projectId');
  const description = stringParam(params, 'description');
  const published = await collab.publish({ description, projectId }, operationOptions(signal));
  if (published.status !== 'success') return mapCollabFailure(published);
  let outcome = published.value;
  if (outcome.state === 'review-required' && outcome.review?.canConfirm) {
    const confirmed = await collab.confirmPublish({
      description,
      expectedCandidateOid: outcome.review.candidateOid,
      expectedMainOid: outcome.review.currentMainOid,
      operationId: outcome.review.operationId,
      projectId,
    }, operationOptions(signal));
    if (confirmed.status !== 'success') return mapCollabFailure(confirmed);
    outcome = confirmed.value;
  }
  return success(toPublishResult(outcome));
}

function toProjectSummary(project: CollabLocalProjectSummary): AgentRuntimeProjectSummary {
  return {
    ...(project.cleanupStatus === undefined ? {} : { cleanupStatus: project.cleanupStatus }),
    connectionStatus: project.connectionStatus,
    health: project.health,
    id: project.id,
    ...(project.lifecycle === undefined ? {} : { lifecycle: project.lifecycle }),
    name: project.name,
    ...(project.retiredAt === undefined ? {} : { retiredAt: project.retiredAt }),
    ...(project.role === undefined ? {} : { role: project.role }),
  };
}

function toProjectDetail(inspection: CollabProjectInspection): AgentRuntimeProjectDetail {
  const coordination = inspection.coordination;
  const currentMember = coordination?.snapshot.currentMember;
  if (currentMember && currentMember.status !== 'active') {
    throw new Error('Collab coordination exposed a non-active current Member.');
  }
  const members = coordination?.snapshot.members
    .filter(member => member.status === 'active')
    .map(toActiveMember) ?? [];
  const managerMemberIds = members
    .filter(member => member.role === 'manager')
    .map(member => member.id);
  return {
    ...toProjectSummary(inspection.project),
    authorityKind: inspection.project.authorityKind,
    coordination: !coordination || !currentMember
      ? null
      : {
        createdAt: coordination.snapshot.project.createdAt,
        currentMember: toActiveMember(currentMember),
        hostMemberId: coordination.snapshot.project.hostMemberId,
        mainOid: coordination.snapshot.project.mainOid,
        managerCount: managerMemberIds.length,
        managerMemberIds,
        members,
        openRequestCount: coordination.snapshot.openRequests.length,
        openTicketCount: coordination.snapshot.openTicketCount,
        source: coordination.source,
        stale: coordination.stale,
        sync: toSyncState(coordination.syncState),
      },
    hostStatus: inspection.project.hostStatus,
    workspacePath: inspection.project.workspacePath,
  };
}

function toPersonalChangesResult(
  projectId: string,
  inspection: CollabProjectInspection,
): AgentRuntimeRpcResult {
  const personal = inspection.personalChanges;
  const ownership = conflictOwnership(inspection);
  const requestOwnsState = ownership.location === 'request'
    && (inspection.conflict !== undefined || personal?.review !== undefined);
  return {
    changes: personal
      ? {
        action: requestOwnsState ? 'none' : personal.action,
        hasContribution: personal.hasContribution,
        updateAvailable: personal.updateAvailable,
        ...(!requestOwnsState && personal.conflictOperationId !== undefined
          ? { conflictOperationId: personal.conflictOperationId }
          : {}),
        unpublishedReview: {
          baseOid: personal.unpublishedReview.baseOid,
          files: personal.unpublishedReview.files.map(toChangedFile),
          headOid: personal.unpublishedReview.headOid,
        },
        ...(!requestOwnsState && personal.review
          ? {
            preparedPublication: {
              baseMainOid: personal.review.baseMainOid,
              canConfirm: personal.review.canConfirm,
              candidateOid: personal.review.candidateOid,
              comparisonBaseOid: personal.review.comparisonBaseOid,
              comparisonTargetOid: personal.review.comparisonTargetOid,
              contributionHeadOid: personal.review.contributionHeadOid,
              currentMainOid: personal.review.currentMainOid,
              files: personal.review.files.map(toChangedFile),
              operationId: personal.review.operationId,
            },
          }
          : {}),
      }
      : null,
    gitStatus: inspection.gitStatus
      ? {
        acceptedMainOid: inspection.gitStatus.acceptedMainOid,
        aheadBy: inspection.gitStatus.aheadBy,
        behindBy: inspection.gitStatus.behindBy,
        changedFiles: inspection.gitStatus.changedFiles.map(toChangedFile),
        headOid: inspection.gitStatus.headOid,
        includesAcceptedMain: inspection.gitStatus.includesAcceptedMain,
        personalRemoteOid: inspection.gitStatus.personalRemoteOid,
        workingTreeClean: inspection.gitStatus.workingTreeClean,
      }
      : null,
    projectId,
  };
}

function toConflictGetResult(
  projectId: string,
  inspection: CollabProjectInspection,
): AgentRuntimeConflictGetResult {
  if (!inspection.conflict) return { conflict: null, projectId };
  const ownership = conflictOwnership(inspection);
  return {
    conflict: {
      conflicts: inspection.conflict.descriptor.conflicts.map(toConflictEntry),
      location: ownership.location,
      mergeBaseOid: inspection.conflict.descriptor.mergeBaseOid,
      operationId: inspection.conflict.descriptor.operationId,
      ...(ownership.requestId === undefined ? {} : { requestId: ownership.requestId }),
      startingMainOid: inspection.conflict.descriptor.startingMainOid,
      startingPersonalOid: inspection.conflict.descriptor.startingPersonalOid,
    },
    projectId,
  };
}

function conflictOwnership(inspection: CollabProjectInspection): {
  readonly location: AgentRuntimeConflictLocation;
  readonly requestId?: string;
} {
  const snapshot = inspection.coordination?.snapshot;
  const ownRequest = snapshot?.openRequests.find(
    request => request.memberId === snapshot.currentMember.id,
  );
  return ownRequest
    ? { location: 'request', requestId: ownRequest.id }
    : { location: 'my-changes' };
}

function toActiveMember(member: CollabMember): AgentRuntimeMember {
  return {
    displayName: member.displayName,
    id: member.id,
    role: member.role,
    status: 'active',
  };
}

function toSyncState(state: {
  readonly status: AgentRuntimeSyncState['status'];
  readonly generation: number;
  readonly eventSequence: number;
}): AgentRuntimeSyncState {
  return {
    eventSequence: state.eventSequence,
    generation: state.generation,
    status: state.status,
  };
}

function toChangedFile(file: CollabChangedFile): AgentRuntimeChangedFile {
  return {
    binary: file.binary,
    kind: file.kind,
    largeForReview: file.largeForReview,
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    ...(file.oldBytes === undefined ? {} : { oldBytes: file.oldBytes }),
    ...(file.newBytes === undefined ? {} : { newBytes: file.newBytes }),
    ...(file.additions === undefined ? {} : { additions: file.additions }),
    ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
  };
}

function toChangeRequest(request: CollabChangeRequest): AgentRuntimeChangeRequest {
  return {
    commentCount: request.commentCount,
    createdAt: request.createdAt,
    description: request.description,
    firstBaseOid: request.firstBaseOid,
    id: request.id,
    latestHeadOid: request.latestHeadOid,
    memberId: request.memberId,
    ...(request.mergedOid === undefined ? {} : { mergedOid: request.mergedOid }),
    revision: request.revision,
    status: request.status,
    ticketRelations: request.ticketRelations.map(toTicketRelation),
    updatedAt: request.updatedAt,
  };
}

function toTicketRelation(relation: CollabRequestTicketRelation): AgentRuntimeTicketRelation {
  return {
    commitOid: relation.commitOid,
    id: relation.id,
    kind: relation.kind,
    state: relation.state,
    ticketId: relation.ticketId,
    ticketNumber: relation.ticketNumber,
    ticketRevision: relation.ticketRevision,
    ticketTitle: relation.ticketTitle,
  };
}

function toComment(comment: CollabComment): AgentRuntimeComment {
  return {
    authorMemberId: comment.authorMemberId,
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
    requestId: comment.requestId,
  };
}

function toTicketSummary(ticket: CollabTicketSummary): AgentRuntimeTicketSummary {
  return {
    authorMemberId: ticket.authorMemberId,
    ...(ticket.closedAt === undefined ? {} : { closedAt: ticket.closedAt }),
    ...(ticket.closedByMemberId === undefined
      ? {}
      : { closedByMemberId: ticket.closedByMemberId }),
    commentCount: ticket.commentCount,
    createdAt: ticket.createdAt,
    id: ticket.id,
    number: ticket.number,
    revision: ticket.revision,
    status: ticket.status,
    title: ticket.title,
    updatedAt: ticket.updatedAt,
  };
}

function toTicketComment(comment: CollabTicketComment): AgentRuntimeTicketComment {
  return {
    authorMemberId: comment.authorMemberId,
    body: comment.body,
    createdAt: comment.createdAt,
    id: comment.id,
    ticketId: comment.ticketId,
  };
}

function toTicketAcceptedRelation(
  relation: CollabTicketAcceptedRelation,
): AgentRuntimeTicketAcceptedRelation {
  return {
    acceptedAt: relation.acceptedAt,
    acceptedMergeOid: relation.acceptedMergeOid,
    commitOid: relation.commitOid,
    id: relation.id,
    kind: relation.kind,
    requestId: relation.requestId,
  };
}

function toTicketCreateResult(
  projectId: string,
  detail: CollabTicketDetail,
): AgentRuntimeTicketCreateResult {
  return {
    acceptedRelations: detail.acceptedRelations.acceptedRelations.map(toTicketAcceptedRelation),
    body: detail.body,
    comments: detail.comments.comments.map(toTicketComment),
    projectId,
    ticket: toTicketSummary(detail.ticket),
  };
}

function toPublicationReview(review: CollabPublicationReview): AgentRuntimePublicationReview {
  return {
    baseMainOid: review.baseMainOid,
    canConfirm: review.canConfirm,
    candidateOid: review.candidateOid,
    comparisonBaseOid: review.comparisonBaseOid,
    comparisonTargetOid: review.comparisonTargetOid,
    contributionHeadOid: review.contributionHeadOid,
    currentMainOid: review.currentMainOid,
    files: review.files.map(toChangedFile),
    operationId: review.operationId,
  };
}

function toPublishResult(outcome: CollabPublishOutcome): AgentRuntimeChangesPublishResult {
  return {
    localHeadOid: outcome.localHeadOid,
    projectId: outcome.projectId,
    ...(outcome.remoteHeadOid === undefined ? {} : { remoteHeadOid: outcome.remoteHeadOid }),
    ...(outcome.request === undefined ? {} : { request: toChangeRequest(outcome.request) }),
    ...(outcome.review === undefined ? {} : { review: toPublicationReview(outcome.review) }),
    state: outcome.state,
  };
}

function toConflictEntry(entry: CollabConflictEntry): AgentRuntimeConflictEntry {
  return {
    kind: entry.kind,
    path: entry.path,
    ...(entry.personalPath === undefined ? {} : { personalPath: entry.personalPath }),
    ...(entry.acceptedPath === undefined ? {} : { acceptedPath: entry.acceptedPath }),
  };
}

function toReviewFileContent(content: CollabReviewFileContent): AgentRuntimeReviewFileContent {
  switch (content.kind) {
    case 'text':
      return {
        file: toChangedFile(content.file),
        kind: 'text',
        newText: content.newText,
        oldText: content.oldText,
      };
    case 'large-text':
      return { file: toChangedFile(content.file), kind: 'large-text' };
    case 'binary':
      return { file: toChangedFile(content.file), kind: 'binary' };
  }
}

function toConflictFileContent(
  content: CollabConflictFileContent,
): AgentRuntimeConflictFileContent {
  switch (content.kind) {
    case 'text':
      return {
        accepted: { path: content.accepted.path, text: content.accepted.text },
        base: { path: content.base.path, text: content.base.text },
        kind: 'text',
        path: content.path,
        personal: { path: content.personal.path, text: content.personal.text },
        segments: content.segments.map(segment => segment.kind === 'common'
          ? { kind: 'common', text: segment.text }
          : {
            accepted: segment.accepted,
            base: segment.base,
            id: segment.id,
            kind: 'conflict',
            personal: segment.personal,
          }),
      };
    case 'binary':
    case 'delete-modify':
    case 'rename-delete':
      return {
        accepted: toConflictOpaqueVersion(content.accepted),
        base: toConflictOpaqueVersion(content.base),
        kind: content.kind,
        path: content.path,
        personal: toConflictOpaqueVersion(content.personal),
      };
    case 'directory-file':
    case 'portability':
      return { kind: content.kind, path: content.path };
  }
}

function toConflictOpaqueVersion(
  version: CollabConflictOpaqueVersion,
): AgentRuntimeConflictOpaqueVersion {
  return {
    bytes: version.bytes,
    exists: version.exists,
    path: version.path,
  };
}

function mapCollabResult<T>(
  result: CollabResult<T>,
  mapper: (value: T) => AgentRuntimeRpcResult,
): AgentRuntimeMethodOutcome {
  if (result.status !== 'success') return mapCollabFailure(result);
  return success(mapper(result.value));
}

function mapCollabFailure(
  result: Exclude<CollabResult<unknown>, { readonly status: 'success' }>,
): AgentRuntimeMethodOutcome {
  if (result.status === 'cancelled') return error(cancelledError());
  const recoveryIdentity = result.status === 'stale'
    ? { staleKind: result.staleKind }
    : result.status === 'conflict'
      ? {
        conflictOperationId: result.conflict.operationId,
        projectId: result.conflict.projectId,
      }
      : result.status === 'recovery-required'
        ? {
          durablePhase: result.durablePhase,
          durableProgress: result.durableProgress,
          operationId: result.operationId,
        }
        : {};
  return error({
    code: result.error.code,
    data: {
      group: result.error.group,
      recoveryActions: result.error.recoveryActions,
      ...recoveryIdentity,
      safeContext: result.error.safeContext,
      status: result.status,
    },
    message: result.error.message,
  });
}

function invalidPath(projectId: string, path: string): AgentRuntimeMethodOutcome {
  const collabError = new CollabError({
    code: 'path-invalid',
    safeContext: { path, projectId },
  });
  return error({
    code: collabError.code,
    data: {
      group: collabError.group,
      recoveryActions: collabError.recoveryActions,
      safeContext: collabError.safeContext,
      status: 'failure',
    },
    message: collabError.message,
  });
}

function success(result: AgentRuntimeRpcResult): AgentRuntimeMethodOutcome {
  return { result, status: 'success' };
}

function error(value: AgentRuntimeRpcError): AgentRuntimeMethodOutcome {
  return { error: value, status: 'error' };
}

function cancelledError(): AgentRuntimeRpcError {
  return {
    code: 'cancelled',
    data: { status: 'cancelled' },
    message: 'collab.error.cancelled',
  };
}

function serviceUnavailableError(): AgentRuntimeRpcError {
  return {
    code: 'service_unavailable',
    message: 'Collab service is unavailable.',
  };
}

function errorResponse(id: string, value: AgentRuntimeRpcError): AgentRuntimeRpcErrorResponse {
  return { error: value, id };
}

function decodeParams(
  params: Readonly<Record<string, unknown>>,
  descriptors: readonly AgentRuntimeParameterDescriptor[],
): Readonly<Record<string, unknown>> | null {
  if (!isPlainRecord(params)) return null;
  const allowed = new Set(descriptors.map(descriptor => descriptor.name));
  const keys = Object.keys(params);
  if (keys.some(key => !allowed.has(key))) return null;
  const decoded: Record<string, unknown> = {};
  for (const descriptor of descriptors) {
    if (!Object.prototype.hasOwnProperty.call(params, descriptor.name)) {
      if (descriptor.required) return null;
      continue;
    }
    const value = params[descriptor.name];
    if (!matchesDescriptor(value, descriptor)) return null;
    decoded[descriptor.name] = value;
  }
  return decoded;
}

function matchesDescriptor(
  value: unknown,
  descriptor: AgentRuntimeParameterDescriptor,
): boolean {
  return matchesSchema(value, descriptor.schema);
}

function matchesSchema(value: unknown, schema: AgentRuntimeValueSchema): boolean {
  if (schema.type === 'integer') {
    return typeof value === 'number'
      && Number.isSafeInteger(value)
      && (schema.minimum === undefined || value >= schema.minimum)
      && (schema.maximum === undefined || value <= schema.maximum);
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    const bytes = new TextEncoder().encode(value).byteLength;
    return (schema.minLength === undefined || value.length >= schema.minLength)
      && (schema.maxLength === undefined || value.length <= schema.maxLength)
      && (schema.minBytes === undefined || bytes >= schema.minBytes)
      && (schema.maxBytes === undefined || bytes <= schema.maxBytes)
      && (schema.enum === undefined || schema.enum.includes(value))
      && (schema.pattern === undefined || new RegExp(schema.pattern, 'u').test(value));
  }
  if (schema.type === 'object') {
    return isPlainRecord(value) && decodeParams(value, schema.properties) !== null;
  }
  if (!Array.isArray(value)) return false;
  if (schema.minItems !== undefined && value.length < schema.minItems) return false;
  if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
  if (!value.every(item => matchesSchema(item, schema.items))) return false;
  if (schema.uniqueBy === undefined) return true;
  const keys = value.map(item => isPlainRecord(item) ? item[schema.uniqueBy!] : undefined);
  return keys.every(key => typeof key === 'string') && new Set(keys).size === keys.length;
}

function isAgentRuntimeRpcMethod(method: string): method is AgentRuntimeRpcMethod {
  return Object.prototype.hasOwnProperty.call(METHOD_DEFINITIONS, method);
}

function operationOptions(signal: AbortSignal): { readonly signal: AbortSignal } {
  return { signal };
}

function stringParam(params: Readonly<Record<string, unknown>>, name: string): string {
  return params[name] as string;
}

function numberParam(params: Readonly<Record<string, unknown>>, name: string): number {
  return params[name] as number;
}

function resolvingTicketsParamValue(
  params: Readonly<Record<string, unknown>>,
): readonly CollabResolvingTicketExpectation[] {
  return params.expectedResolvingTickets as readonly CollabResolvingTicketExpectation[];
}

function intentIdFromRpcId(id: string): string {
  return `r${Buffer.from(id, 'ascii').toString('base64url')}`;
}
