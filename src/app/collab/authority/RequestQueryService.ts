import { type CollabMemberId, type CollabProjectId, type CollabRequestDetail } from '@claudian/collab-protocol';

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
  'changedFiles' | 'currentMainOid' | 'reviewCondition' | 'reviewedHeadOid'
>;

export interface RequestQueryGitPort {
  inspect(input: RequestQueryGitInput): Promise<RequestQueryGitResult>;
}

function queryError(
  code: 'request-not-open' | 'stale-request-head',
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
      return {
        comments: this.requests.listComments(connection, requestId),
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
      comments: initial.comments,
      request: initial.request,
    };
  }
}
