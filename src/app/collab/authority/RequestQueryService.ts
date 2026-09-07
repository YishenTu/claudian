import {
  COLLAB_LIMITS,
  type CollabCommentPage,
  type CollabMemberId,
  type CollabProjectId,
  type CollabRequestDetail,
} from '@claudian-collab/protocol';

import {
  authorityDetailPageBudgets,
  decodeAuthorityKeysetCursor,
} from '@/app/collab/authority/AuthorityKeysetPage';
import { RequestEnsureRepository } from '@/app/collab/authority/RequestEnsureRepository';
import type {
  RequestEnsureDatabasePort,
} from '@/app/collab/authority/RequestEnsureService';
import {
  RequestQueryRepository,
} from '@/app/collab/authority/RequestQueryRepository';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RequestQueryGitInput {
  readonly firstBaseOid: string;
  readonly latestHeadOid: string;
  readonly personalRef: string;
  readonly projectId: CollabProjectId;
}

export type RequestQueryGitResult = Pick<
  CollabRequestDetail,
  'currentMainOid' | 'reviewCondition' | 'reviewedHeadOid'
>;

export interface RequestQueryGitPort {
  inspect(input: RequestQueryGitInput): Promise<RequestQueryGitResult>;
}

export interface RequestCommentPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

// Reserve for the Git-produced scalars (currentMainOid, reviewedHeadOid,
// reviewCondition) and response keys that join the measured request summary
// in the detail envelope.
const REQUEST_DETAIL_SCALAR_RESERVE_BYTES = 512;

function queryError(
  code: 'protocol-payload-invalid' | 'request-not-open' | 'stale-request-head',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

export class RequestQueryService {
  private readonly members = new RequestEnsureRepository();
  private readonly requests = new RequestQueryRepository();

  constructor(
    private readonly database: RequestEnsureDatabasePort,
    private readonly git: RequestQueryGitPort,
  ) {}

  async read(
    actorMemberId: CollabMemberId,
    projectId: CollabProjectId,
    requestId: string,
  ): Promise<CollabRequestDetail> {
    const initial = await this.database.read(connection => {
      this.members.requireActiveMember(connection, projectId, actorMemberId);
      const request = this.requests.find(connection, requestId);
      if (!request) throw queryError('request-not-open', 'request-detail-missing');
      // The embedded first comment page shares what the measured request
      // summary leaves of the shared detail budget.
      const budgets = authorityDetailPageBudgets(
        Buffer.byteLength(JSON.stringify(request.request), 'utf8')
          + REQUEST_DETAIL_SCALAR_RESERVE_BYTES,
        false,
      );
      return {
        comments: this.requests.listCommentsPage(connection, requestId, {
          limit: COLLAB_LIMITS.defaultCommentPageSize,
          maxUtf8Bytes: budgets.commentsMaxUtf8Bytes,
        }),
        ...request,
      };
    });
    const git = await this.git.inspect({
      firstBaseOid: initial.request.firstBaseOid,
      latestHeadOid: initial.request.latestHeadOid,
      personalRef: initial.personalRef,
      projectId,
    });
    const current = await this.database.read(connection => {
      this.members.requireActiveMember(connection, projectId, actorMemberId);
      return this.requests.find(connection, requestId);
    });
    if (
      !current
      || current.request.latestHeadOid !== initial.request.latestHeadOid
      || current.request.status !== initial.request.status
      || current.request.revision !== initial.request.revision
      || current.request.updatedAt !== initial.request.updatedAt
    ) {
      throw queryError('stale-request-head', 'request-detail-changed-during-read');
    }
    return {
      ...git,
      comments: {
        comments: initial.comments.items,
        ...(initial.comments.nextCursor
          ? { nextCursor: initial.comments.nextCursor }
          : {}),
      },
      request: initial.request,
    };
  }

  async readComments(
    actorMemberId: CollabMemberId,
    projectId: CollabProjectId,
    requestId: string,
    query: RequestCommentPageQuery,
  ): Promise<CollabCommentPage> {
    const limit = query.limit ?? COLLAB_LIMITS.defaultCommentPageSize;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > COLLAB_LIMITS.maxCommentPageSize
    ) {
      throw queryError('protocol-payload-invalid', 'request-comment-page-limit-invalid');
    }
    const cursor = decodeAuthorityKeysetCursor(
      query.cursor,
      'request-comment-cursor-invalid',
    );
    return this.database.read(connection => {
      this.members.requireActiveMember(connection, projectId, actorMemberId);
      if (!this.requests.find(connection, requestId)) {
        throw queryError('request-not-open', 'request-detail-missing');
      }
      const page = this.requests.listCommentsPage(connection, requestId, {
        ...(cursor ? { after: cursor } : {}),
        limit,
      });
      return {
        comments: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
  }
}
