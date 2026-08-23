import { type CollabChangeRequest, type CollabMemberId, type CollabProjectId, type CollabRequestTicketRelation, isCollabGitOid, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import {
  type PendingTicketRelationInput,
  RequestTicketRelationRepository,
} from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface ActiveRequestMember {
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
}

export interface EnsureAuthorityRequestInput {
  readonly createdAt: string;
  readonly firstBaseOid: string;
  readonly headOid: string;
  readonly memberId: CollabMemberId;
  readonly requestId: string;
  readonly description: string;
  readonly relations: readonly PendingTicketRelationInput[];
}

export interface EnsureAuthorityRequestResult {
  readonly change: 'created' | 'unchanged' | 'updated';
  readonly request: CollabChangeRequest;
}

function requestError(
  code:
    | 'authority-integrity-error'
    | 'authorization-denied'
    | 'membership-revoked'
    | 'project-not-found'
    | 'request-not-open'
    | 'stale-request-metadata'
    | 'stale-request-head',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'authority-integrity-error'
      ? ['open-diagnostics']
      : code === 'stale-request-head'
        ? ['retry']
        : [],
    safeContext: { reason },
  });
}

function text(
  row: Readonly<Record<string, unknown>>,
  field: string,
  nullable = false,
): string | null {
  const value = row[field];
  if (nullable && value === null) return null;
  if (typeof value !== 'string') {
    throw requestError('authority-integrity-error', 'request-row-invalid');
  }
  return value;
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw requestError('authority-integrity-error', 'request-timestamp-invalid');
  }
}

export function decodeAuthorityChangeRequest(
  row: Readonly<Record<string, unknown>>,
  ticketRelations: readonly CollabRequestTicketRelation[] = [],
): CollabChangeRequest {
  const status = text(row, 'status');
  const commentCount = row.comment_count;
  const id = text(row, 'request_id')!;
  const memberId = text(row, 'member_id')!;
  const firstBaseOid = text(row, 'first_base_oid')!;
  const latestHeadOid = text(row, 'latest_head_oid')!;
  const mergedOid = text(row, 'merged_oid', true);
  const createdAt = text(row, 'created_at')!;
  const updatedAt = text(row, 'updated_at')!;
  const description = text(row, 'description')!;
  const revision = row.revision;
  if (
    !isCollabOpaqueId(id)
    || !isCollabMemberId(memberId)
    || !isCollabGitOid(firstBaseOid)
    || !isCollabGitOid(latestHeadOid)
    || (mergedOid !== null && !isCollabGitOid(mergedOid))
    || (status !== 'open' && status !== 'merged' && status !== 'discarded')
    || typeof commentCount !== 'number'
    || !Number.isSafeInteger(commentCount)
    || commentCount < 0
    || typeof revision !== 'number'
    || !Number.isSafeInteger(revision)
    || revision < 0
  ) {
    throw requestError('authority-integrity-error', 'request-row-invalid');
  }
  assertTimestamp(createdAt);
  assertTimestamp(updatedAt);
  return {
    commentCount,
    createdAt,
    description,
    firstBaseOid,
    id,
    latestHeadOid,
    memberId,
    ...(mergedOid === null ? {} : { mergedOid }),
    revision,
    status,
    ticketRelations,
    updatedAt,
  };
}

const REQUEST_SELECT = `
  SELECT
    r.request_id, r.member_id, r.status, r.first_base_oid,
    r.latest_head_oid, r.merged_oid, r.description, r.revision,
    r.created_at, r.updated_at,
    COUNT(c.comment_id) AS comment_count
  FROM change_requests r
  LEFT JOIN comments c ON c.request_id = r.request_id
`;

export class RequestEnsureRepository {
  private readonly relations = new RequestTicketRelationRepository();

  requireActiveMember(
    connection: AuthorityDatabaseConnection,
    projectId: CollabProjectId,
    memberId: CollabMemberId,
  ): ActiveRequestMember {
    if (!isCollabProjectId(projectId) || !isCollabMemberId(memberId)) {
      throw requestError('authority-integrity-error', 'request-identity-invalid');
    }
    const row = connection.get(
      `SELECT
        p.project_id, p.state AS project_state,
        m.member_id, m.personal_ref, m.status AS member_status
       FROM project p
       LEFT JOIN members m ON m.member_id = ?
       WHERE p.singleton = 1`,
      [memberId],
    );
    if (!row || row.project_id !== projectId) {
      throw requestError('project-not-found', 'request-project-missing');
    }
    if (row.project_state !== 'active') {
      throw requestError('authorization-denied', 'request-project-disabled');
    }
    if (row.member_id !== memberId || row.member_status !== 'active') {
      throw requestError('membership-revoked', 'request-member-not-active');
    }
    const personalRef = row.personal_ref;
    if (typeof personalRef !== 'string') {
      throw requestError('authority-integrity-error', 'request-personal-ref-invalid');
    }
    return { memberId, personalRef };
  }

  findOpen(
    connection: AuthorityDatabaseConnection,
    memberId: CollabMemberId,
  ): CollabChangeRequest | null {
    const row = connection.get(`${REQUEST_SELECT}
      WHERE r.member_id = ? AND r.status = 'open'
      GROUP BY r.request_id`, [memberId]);
    return row
      ? decodeAuthorityChangeRequest(
        row,
        this.relations.listForRequest(connection, text(row, 'request_id')!),
      )
      : null;
  }

  find(
    connection: AuthorityDatabaseConnection,
    requestId: string,
  ): CollabChangeRequest | null {
    if (!isCollabOpaqueId(requestId)) {
      throw requestError('authority-integrity-error', 'request-identity-invalid');
    }
    const row = connection.get(`${REQUEST_SELECT}
      WHERE r.request_id = ?
      GROUP BY r.request_id`, [requestId]);
    return row
      ? decodeAuthorityChangeRequest(
        row,
        this.relations.listForRequest(connection, requestId),
      )
      : null;
  }

  ensure(
    connection: AuthorityDatabaseConnection,
    input: EnsureAuthorityRequestInput,
  ): EnsureAuthorityRequestResult {
    if (
      !isCollabOpaqueId(input.requestId)
      || !isCollabMemberId(input.memberId)
      || !isCollabGitOid(input.firstBaseOid)
      || !isCollabGitOid(input.headOid)
      || typeof input.description !== 'string'
    ) {
      throw requestError('authority-integrity-error', 'request-input-invalid');
    }
    assertTimestamp(input.createdAt);
    const existing = this.findOpen(connection, input.memberId);
    if (existing && connection.get(
      `SELECT operation_id
       FROM accept_operations
       WHERE request_id = ? AND state != 'completed'
       LIMIT 1`,
      [existing.id],
    )) {
      throw requestError('stale-request-head', 'request-accept-in-progress');
    }
    if (
      existing?.latestHeadOid === input.headOid
      && existing.description === input.description
      && sameRelationSet(existing.ticketRelations, input.relations)
    ) {
      return { change: 'unchanged', request: existing };
    }
    if (existing) {
      this.relations.replacePending(connection, {
        actorMemberId: input.memberId,
        commitOid: input.headOid,
        relations: input.relations,
        requestId: existing.id,
        updatedAt: input.createdAt,
      });
      connection.run(
        `UPDATE change_requests
         SET latest_head_oid = ?, description = ?, revision = revision + 1,
           updated_at = ?
         WHERE request_id = ? AND status = 'open'`,
        [input.headOid, input.description, input.createdAt, existing.id],
      );
      const updated = this.findOpen(connection, input.memberId);
      if (!updated || updated.id !== existing.id || updated.latestHeadOid !== input.headOid) {
        throw requestError('authority-integrity-error', 'request-update-failed');
      }
      return { change: 'updated', request: updated };
    }
    connection.run(
      `INSERT INTO change_requests (
        request_id, member_id, status, first_base_oid, latest_head_oid,
        merged_oid, description, revision, created_at, updated_at
      ) VALUES (?, ?, 'open', ?, ?, NULL, ?, 1, ?, ?)`,
      [
        input.requestId,
        input.memberId,
        input.firstBaseOid,
        input.headOid,
        input.description,
        input.createdAt,
        input.createdAt,
      ],
    );
    this.relations.replacePending(connection, {
      actorMemberId: input.memberId,
      commitOid: input.headOid,
      relations: input.relations,
      requestId: input.requestId,
      updatedAt: input.createdAt,
    });
    const created = this.findOpen(connection, input.memberId);
    if (!created || created.id !== input.requestId) {
      throw requestError('authority-integrity-error', 'request-create-failed');
    }
    return { change: 'created', request: created };
  }

  updateMetadata(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly actorMemberId: CollabMemberId;
      readonly description: string;
      readonly expectedHeadOid: string;
      readonly expectedRequestRevision: number;
      readonly relations: readonly PendingTicketRelationInput[];
      readonly requestId: string;
      readonly updatedAt: string;
    },
  ): EnsureAuthorityRequestResult {
    const existing = this.find(connection, input.requestId);
    if (!existing || existing.status !== 'open') {
      throw requestError('request-not-open', 'request-metadata-request-not-open');
    }
    if (existing.memberId !== input.actorMemberId) {
      throw requestError('authorization-denied', 'request-metadata-owner-required');
    }
    if (existing.latestHeadOid !== input.expectedHeadOid) {
      throw requestError('stale-request-head', 'request-metadata-head-changed');
    }
    if (existing.revision !== input.expectedRequestRevision) {
      throw requestError('stale-request-metadata', 'request-metadata-revision-changed');
    }
    if (connection.get(
      `SELECT operation_id FROM accept_operations
       WHERE request_id = ? AND state != 'completed' LIMIT 1`,
      [existing.id],
    )) {
      throw requestError('stale-request-metadata', 'request-accept-in-progress');
    }
    if (
      existing.description === input.description
      && sameRelationSet(existing.ticketRelations, input.relations)
    ) {
      return { change: 'unchanged', request: existing };
    }
    this.relations.replacePending(connection, {
      actorMemberId: input.actorMemberId,
      commitOid: existing.latestHeadOid,
      relations: input.relations,
      requestId: existing.id,
      updatedAt: input.updatedAt,
    });
    connection.run(
      `UPDATE change_requests
       SET description = ?, revision = revision + 1, updated_at = ?
       WHERE request_id = ? AND status = 'open' AND revision = ?`,
      [
        input.description,
        input.updatedAt,
        existing.id,
        input.expectedRequestRevision,
      ],
    );
    const updated = this.find(connection, existing.id);
    if (!updated || updated.revision !== existing.revision + 1) {
      throw requestError('authority-integrity-error', 'request-metadata-update-failed');
    }
    return { change: 'updated', request: updated };
  }
}

function sameRelationSet(
  existing: readonly CollabRequestTicketRelation[],
  desired: readonly PendingTicketRelationInput[],
): boolean {
  if (existing.length !== desired.length) return false;
  const desiredByTicket = new Map(desired.map(relation => [relation.ticketId, relation.kind]));
  return existing.every(relation => (
    relation.state === 'pending'
    && desiredByTicket.get(relation.ticketId) === relation.kind
  ));
}
