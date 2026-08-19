import { createHash, randomUUID } from 'node:crypto';

import { type CollabMemberId, type CreateCommentRequest, type CreateCommentResponse } from '@claudian/collab-protocol';

import { AcceptOperationRepository } from '@/app/collab/authority/AcceptOperationRepository';
import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { RequestCommentRepository } from '@/app/collab/authority/RequestCommentRepository';
import {
  decodeAuthorityChangeRequest,
  RequestEnsureRepository,
} from '@/app/collab/authority/RequestEnsureRepository';
import type { RequestEnsureDatabasePort } from '@/app/collab/authority/RequestEnsureService';
import {
  decodeAuthorityComment,
} from '@/app/collab/authority/RequestQueryRepository';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RequestCommentServiceOptions {
  readonly createCommentId?: () => string;
  readonly now?: () => Date;
}

function commentError(reason: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { reason },
  });
}

function acceptanceRecoveryError(): CollabError {
  return new CollabError({
    code: 'acceptance-recovery-required',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason: 'request-comment-accept-in-progress' },
  });
}

function normalizeBody(body: string): string {
  const normalized = body.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const containsForbiddenControl = [...normalized].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127;
  });
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, 'utf8') > CLAUDIAN_COLLAB_LIMITS.maxCommentBytes
    || containsForbiddenControl
  ) {
    throw commentError('request-comment-body-invalid');
  }
  return normalized;
}

function fingerprint(
  request: CreateCommentRequest,
  body: string,
): string {
  return createHash('sha256').update(JSON.stringify({
    body,
    projectId: request.projectId,
    requestId: request.requestId,
  })).digest('hex');
}

function decodeReplay(value: unknown): CreateCommentResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CollabError({
      code: 'authority-integrity-error',
      safeContext: { reason: 'comment-idempotency-response-invalid' },
    });
  }
  const response = value as Readonly<Record<string, unknown>>;
  if (
    !response.comment
    || typeof response.comment !== 'object'
    || Array.isArray(response.comment)
    || !response.request
    || typeof response.request !== 'object'
    || Array.isArray(response.request)
  ) {
    throw new CollabError({
      code: 'authority-integrity-error',
      safeContext: { reason: 'comment-idempotency-response-invalid' },
    });
  }
  const comment = response.comment as Readonly<Record<string, unknown>>;
  const request = response.request as Readonly<Record<string, unknown>>;
  return {
    comment: decodeAuthorityComment({
      author_member_id: comment.authorMemberId,
      body: comment.body,
      comment_id: comment.id,
      created_at: comment.createdAt,
      request_id: comment.requestId,
    }),
    request: decodeAuthorityChangeRequest({
      ...request,
      comment_count: request.commentCount,
      created_at: request.createdAt,
      first_base_oid: request.firstBaseOid,
      latest_head_oid: request.latestHeadOid,
      member_id: request.memberId,
      merged_oid: request.mergedOid ?? null,
      request_id: request.id,
      updated_at: request.updatedAt,
    }),
  };
}

export class RequestCommentService {
  private readonly acceptOperations = new AcceptOperationRepository();
  private readonly comments = new RequestCommentRepository();
  private readonly createCommentId: () => string;
  private readonly events = new AuthorityEventRepository();
  private readonly idempotency = new AuthorityIdempotencyRepository();
  private readonly members = new RequestEnsureRepository();
  private readonly now: () => Date;
  constructor(
    private readonly database: RequestEnsureDatabasePort,
    options: RequestCommentServiceOptions = {},
  ) {
    this.createCommentId = options.createCommentId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async create(
    actorMemberId: CollabMemberId,
    request: CreateCommentRequest,
  ): Promise<CreateCommentResponse> {
    const body = normalizeBody(request.body);
    const idempotencyInput = {
      actorMemberId,
      key: request.idempotencyKey,
      operationKind: 'comment' as const,
      requestFingerprint: fingerprint(request, body),
    };
    const replay = await this.database.read(connection => {
      this.members.requireActiveMember(connection, request.projectId, actorMemberId);
      return this.idempotency.find<unknown>(connection, idempotencyInput);
    });
    if (replay) return decodeReplay(replay.response);
    const createdAt = this.now().toISOString();
    const commentId = this.createCommentId();
    return (await this.database.mutate(connection => {
      this.members.requireActiveMember(connection, request.projectId, actorMemberId);
      const concurrent = this.idempotency.find<unknown>(connection, idempotencyInput);
      if (concurrent) return decodeReplay(concurrent.response);
      const incomplete = this.acceptOperations.findIncomplete(connection);
      if (incomplete?.requestId === request.requestId) {
        throw acceptanceRecoveryError();
      }
      const response = this.comments.create(connection, {
        authorMemberId: actorMemberId,
        body,
        commentId,
        createdAt,
        requestId: request.requestId,
      });
      this.events.append(connection, {
        actorMemberId,
        createdAt,
        kind: 'comment.created',
        payload: {
          commentId: response.comment.id,
          requestId: request.requestId,
        },
      });
      return this.idempotency.store(connection, {
        ...idempotencyInput,
        createdAt,
        response,
      }).response;
    })).value;
  }
}
