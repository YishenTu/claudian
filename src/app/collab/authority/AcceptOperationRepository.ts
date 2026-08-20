import { type CollabChangeRequest, type CollabMemberId, type CollabProjectId, type CollabResolvingTicketExpectation, isCollabGitOid, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import {
  decodeAuthorityChangeRequest,
} from '@/app/collab/authority/RequestEnsureRepository';
import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketRepository } from '@/app/collab/authority/TicketRepository';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type AcceptOperationState = 'prepared' | 'ref_updated' | 'completed';

export interface AuthorityAcceptOperation {
  readonly completionActorMemberId: CollabMemberId | null;
  readonly createdAt: string;
  readonly expectedHeadOid: string;
  readonly expectedMainOid: string;
  readonly expectedRequestRevision: number;
  readonly expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly resultCommitOid: string | null;
  readonly state: AcceptOperationState;
  readonly updatedAt: string;
}

export interface AuthorityAcceptContext {
  readonly personalRef: string;
  readonly request: CollabChangeRequest;
}

function repositoryError(
  code:
    | 'acceptance-recovery-required'
    | 'authority-integrity-error'
    | 'authorization-denied'
    | 'request-not-open'
    | 'stale-ticket'
    | 'stale-request-metadata'
    | 'stale-request-head',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'acceptance-recovery-required'
      || code === 'authority-integrity-error'
      ? ['open-diagnostics']
      : [],
    safeContext: { reason },
  });
}

function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw repositoryError('authority-integrity-error', 'accept-operation-row-invalid');
  }
}

function decodeOperation(
  row: Readonly<Record<string, unknown>>,
): AuthorityAcceptOperation {
  const operationId = row.operation_id;
  const completionActorMemberId = row.completion_actor_member_id;
  const requestId = row.request_id;
  const expectedMainOid = row.expected_main_oid;
  const expectedHeadOid = row.expected_head_oid;
  const expectedRequestRevision = row.expected_request_revision;
  const expectedResolvingTickets = decodeResolvingTicketExpectations(
    row.expected_resolving_tickets_json,
  );
  const resultCommitOid = row.result_commit_oid;
  const state = row.state;
  const idempotencyKey = row.idempotency_key;
  assertTimestamp(row.created_at);
  assertTimestamp(row.updated_at);
  if (
    typeof operationId !== 'string'
    || !isCollabOpaqueId(operationId)
    || (
      completionActorMemberId !== null
      && (typeof completionActorMemberId !== 'string' || !isCollabMemberId(completionActorMemberId))
    )
    || typeof requestId !== 'string'
    || !isCollabOpaqueId(requestId)
    || typeof expectedMainOid !== 'string'
    || !isCollabGitOid(expectedMainOid)
    || typeof expectedHeadOid !== 'string'
    || !isCollabGitOid(expectedHeadOid)
    || typeof expectedRequestRevision !== 'number'
    || !Number.isSafeInteger(expectedRequestRevision)
    || expectedRequestRevision < 0
    || (typeof resultCommitOid !== 'string' && resultCommitOid !== null)
    || (typeof resultCommitOid === 'string' && !isCollabGitOid(resultCommitOid))
    || (state !== 'prepared' && state !== 'ref_updated' && state !== 'completed')
    || !isCollabOpaqueId(idempotencyKey)
  ) {
    throw repositoryError('authority-integrity-error', 'accept-operation-row-invalid');
  }
  if (
    (state === 'prepared' && resultCommitOid !== null)
    || (state !== 'prepared' && resultCommitOid === null)
    || (state !== 'completed' && completionActorMemberId === null)
  ) {
    throw repositoryError('authority-integrity-error', 'accept-operation-row-invalid');
  }
  return {
    completionActorMemberId,
    createdAt: row.created_at,
    expectedHeadOid,
    expectedMainOid,
    expectedRequestRevision,
    expectedResolvingTickets,
    idempotencyKey,
    operationId,
    requestId,
    resultCommitOid,
    state,
    updatedAt: row.updated_at,
  };
}

function decodeResolvingTicketExpectations(
  value: unknown,
): readonly CollabResolvingTicketExpectation[] {
  if (typeof value !== 'string') {
    throw repositoryError('authority-integrity-error', 'accept-ticket-expectations-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw repositoryError('authority-integrity-error', 'accept-ticket-expectations-invalid');
  }
  if (!Array.isArray(parsed)) {
    throw repositoryError('authority-integrity-error', 'accept-ticket-expectations-invalid');
  }
  const result: CollabResolvingTicketExpectation[] = [];
  let previousTicketId = '';
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw repositoryError('authority-integrity-error', 'accept-ticket-expectations-invalid');
    }
    const record = entry as Readonly<Record<string, unknown>>;
    const ticketId = record.ticketId;
    const revision = record.revision;
    if (
      typeof ticketId !== 'string'
      || !isCollabOpaqueId(ticketId)
      || ticketId <= previousTicketId
      || typeof revision !== 'number'
      || !Number.isSafeInteger(revision)
      || revision < 1
    ) {
      throw repositoryError('authority-integrity-error', 'accept-ticket-expectations-invalid');
    }
    result.push({ ticketId, revision });
    previousTicketId = ticketId;
  }
  return result;
}

function encodeResolvingTicketExpectations(
  expectations: readonly CollabResolvingTicketExpectation[],
): string {
  return JSON.stringify([...expectations].sort((left, right) => (
    left.ticketId.localeCompare(right.ticketId)
  )));
}

export class AcceptOperationRepository {
  private readonly managers = new ManagerSetRepository();
  private readonly relations = new RequestTicketRelationRepository();
  private readonly tickets = new TicketRepository(this.relations);

  requireManager(
    connection: AuthorityDatabaseConnection,
    projectId: CollabProjectId,
    memberId: CollabMemberId,
  ): void {
    this.requireActiveMember(connection, projectId, memberId);
    this.managers.requireActiveManager(connection, memberId);
  }

  requireActiveMember(
    connection: AuthorityDatabaseConnection,
    projectId: CollabProjectId,
    memberId: CollabMemberId,
  ): void {
    const row = connection.get(
      `SELECT
        p.project_id, p.state AS project_state, m.status AS member_status
       FROM project p
       LEFT JOIN members m ON m.member_id = ?
       WHERE p.singleton = 1`,
      [memberId],
    );
    if (!row || row.project_id !== projectId) {
      throw repositoryError('authorization-denied', 'accept-project-mismatch');
    }
    if (
      row.project_state !== 'active'
      || row.member_status !== 'active'
    ) {
      throw repositoryError('authorization-denied', 'accept-active-member-required');
    }
  }

  currentProjectId(connection: AuthorityDatabaseConnection): CollabProjectId {
    const row = connection.get(
      'SELECT project_id FROM project WHERE singleton = 1',
    );
    if (!row || !isCollabProjectId(row.project_id)) {
      throw repositoryError('authority-integrity-error', 'accept-project-invalid');
    }
    return row.project_id;
  }

  findIncomplete(
    connection: AuthorityDatabaseConnection,
  ): AuthorityAcceptOperation | null {
    const rows = connection.all(
      `SELECT
        operation_id, request_id, expected_main_oid, expected_head_oid,
        expected_request_revision, expected_resolving_tickets_json,
        completion_actor_member_id, result_commit_oid, state,
        idempotency_key, created_at, updated_at
       FROM accept_operations
       WHERE state != 'completed'
       ORDER BY created_at, operation_id
       LIMIT 2`,
    );
    if (rows.length > 1) {
      throw repositoryError(
        'acceptance-recovery-required',
        'multiple-incomplete-accept-operations',
      );
    }
    return rows[0] ? decodeOperation(rows[0]) : null;
  }

  find(
    connection: AuthorityDatabaseConnection,
    operationId: string,
  ): AuthorityAcceptOperation | null {
    const row = connection.get(
      `SELECT
        operation_id, request_id, expected_main_oid, expected_head_oid,
        expected_request_revision, expected_resolving_tickets_json,
        completion_actor_member_id, result_commit_oid, state,
        idempotency_key, created_at, updated_at
       FROM accept_operations
       WHERE operation_id = ?`,
      [operationId],
    );
    return row ? decodeOperation(row) : null;
  }

  loadOpenRequest(
    connection: AuthorityDatabaseConnection,
    requestId: string,
  ): AuthorityAcceptContext {
    const row = connection.get(
      `SELECT
        r.request_id, r.member_id, r.status, r.first_base_oid,
        r.latest_head_oid, r.merged_oid, r.description, r.revision,
        r.created_at, r.updated_at,
        m.personal_ref, m.status AS member_status,
        COUNT(c.comment_id) AS comment_count
       FROM change_requests r
       JOIN members m ON m.member_id = r.member_id
       LEFT JOIN comments c ON c.request_id = r.request_id
       WHERE r.request_id = ?
       GROUP BY r.request_id`,
      [requestId],
    );
    if (!row || row.status !== 'open') {
      throw repositoryError('request-not-open', 'accept-request-not-open');
    }
    if (row.member_status !== 'active' || typeof row.personal_ref !== 'string') {
      throw repositoryError('authorization-denied', 'accept-request-member-not-active');
    }
    return {
      personalRef: row.personal_ref,
      request: decodeAuthorityChangeRequest(
        row,
        this.relations.listForRequest(connection, requestId),
      ),
    };
  }

  validateResolvingTickets(
    connection: AuthorityDatabaseConnection,
    request: CollabChangeRequest,
    expected: readonly CollabResolvingTicketExpectation[],
  ): void {
    if (request.revision < 1 || request.description.trim().length === 0) {
      throw repositoryError(
        'stale-request-metadata',
        'accept-request-description-required',
      );
    }
    const actual = request.ticketRelations
      .filter(relation => relation.kind === 'resolves')
      .sort((left, right) => left.ticketId.localeCompare(right.ticketId));
    const sortedExpected = [...expected]
      .sort((left, right) => left.ticketId.localeCompare(right.ticketId));
    if (
      sortedExpected.some((entry, index) => (
        !isCollabOpaqueId(entry.ticketId)
        || !Number.isSafeInteger(entry.revision)
        || entry.revision < 1
        || (index > 0 && sortedExpected[index - 1]?.ticketId === entry.ticketId)
      ))
      || actual.length !== sortedExpected.length
      || actual.some((relation, index) => (
        relation.ticketId !== sortedExpected[index]?.ticketId
      ))
    ) {
      throw repositoryError(
        'stale-request-metadata',
        'accept-resolving-ticket-set-changed',
      );
    }
    for (let index = 0; index < actual.length; index += 1) {
      const relation = actual[index];
      const expectation = sortedExpected[index];
      const ticket = this.tickets.find(connection, relation.ticketId);
      if (
        !ticket
        || ticket.status !== 'open'
        || ticket.revision !== expectation.revision
        || relation.ticketRevision !== expectation.revision
      ) {
        throw repositoryError('stale-ticket', 'accept-resolving-ticket-changed');
      }
    }
  }

  prepare(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly createdAt: string;
      readonly completionActorMemberId: CollabMemberId;
      readonly expectedHeadOid: string;
      readonly expectedMainOid: string;
      readonly expectedRequestRevision: number;
      readonly expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
      readonly idempotencyKey: string;
      readonly operationId: string;
      readonly requestId: string;
    },
  ): AuthorityAcceptOperation {
    if (this.findIncomplete(connection)) {
      throw repositoryError(
        'acceptance-recovery-required',
        'accept-operation-already-incomplete',
      );
    }
    const request = this.loadOpenRequest(connection, input.requestId).request;
    if (request.latestHeadOid !== input.expectedHeadOid) {
      throw repositoryError('stale-request-head', 'accept-request-head-changed');
    }
    if (request.revision !== input.expectedRequestRevision) {
      throw repositoryError('stale-request-metadata', 'accept-request-revision-changed');
    }
    this.validateResolvingTickets(connection, request, input.expectedResolvingTickets);
    this.relations.assertAcceptCapacity(connection, input.requestId);
    connection.run(
      `INSERT INTO accept_operations (
        operation_id, request_id, expected_main_oid, expected_head_oid,
        expected_request_revision, expected_resolving_tickets_json,
        completion_actor_member_id, result_commit_oid, state,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, ?, ?)`,
      [
        input.operationId,
        input.requestId,
        input.expectedMainOid,
        input.expectedHeadOid,
        input.expectedRequestRevision,
        encodeResolvingTicketExpectations(input.expectedResolvingTickets),
        input.completionActorMemberId,
        input.idempotencyKey,
        input.createdAt,
        input.createdAt,
      ],
    );
    const prepared = this.find(connection, input.operationId);
    if (!prepared) {
      throw repositoryError('authority-integrity-error', 'accept-prepare-failed');
    }
    return prepared;
  }

  persistResult(
    connection: AuthorityDatabaseConnection,
    operationId: string,
    resultCommitOid: string,
    updatedAt: string,
  ): AuthorityAcceptOperation {
    connection.run(
      `UPDATE accept_operations
       SET result_commit_oid = ?, state = 'ref_updated', updated_at = ?
       WHERE operation_id = ? AND state = 'prepared'`,
      [resultCommitOid, updatedAt, operationId],
    );
    const operation = this.find(connection, operationId);
    if (
      !operation
      || operation.state !== 'ref_updated'
      || operation.resultCommitOid !== resultCommitOid
    ) {
      throw repositoryError('authority-integrity-error', 'accept-result-persist-failed');
    }
    return operation;
  }

  insertCompleted(
    connection: AuthorityDatabaseConnection,
    input: {
      readonly createdAt: string;
      readonly completionActorMemberId: CollabMemberId;
      readonly expectedHeadOid: string;
      readonly expectedMainOid: string;
      readonly expectedRequestRevision: number;
      readonly expectedResolvingTickets: readonly CollabResolvingTicketExpectation[];
      readonly idempotencyKey: string;
      readonly operationId: string;
      readonly requestId: string;
      readonly resultCommitOid: string;
    },
  ): AuthorityAcceptOperation {
    if (this.findIncomplete(connection)) {
      throw repositoryError(
        'acceptance-recovery-required',
        'accept-operation-already-incomplete',
      );
    }
    this.relations.assertAcceptCapacity(connection, input.requestId);
    connection.run(
      `INSERT INTO accept_operations (
        operation_id, request_id, expected_main_oid, expected_head_oid,
        expected_request_revision, expected_resolving_tickets_json,
        completion_actor_member_id, result_commit_oid, state,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      [
        input.operationId,
        input.requestId,
        input.expectedMainOid,
        input.expectedHeadOid,
        input.expectedRequestRevision,
        encodeResolvingTicketExpectations(input.expectedResolvingTickets),
        input.completionActorMemberId,
        input.resultCommitOid,
        input.idempotencyKey,
        input.createdAt,
        input.createdAt,
      ],
    );
    const operation = this.find(connection, input.operationId);
    if (!operation || operation.state !== 'completed') {
      throw repositoryError('authority-integrity-error', 'accept-completed-insert-failed');
    }
    return operation;
  }

  finalizeRequest(
    connection: AuthorityDatabaseConnection,
    operation: AuthorityAcceptOperation,
    updatedAt: string,
  ): CollabChangeRequest {
    const actorMemberId = operation.completionActorMemberId;
    if (actorMemberId === null) {
      throw repositoryError('authority-integrity-error', 'accept-completion-actor-missing');
    }
    const context = this.loadOpenRequest(connection, operation.requestId);
    if (context.request.latestHeadOid !== operation.expectedHeadOid) {
      throw repositoryError('stale-request-head', 'accept-finalize-head-changed');
    }
    if (context.request.revision !== operation.expectedRequestRevision) {
      throw repositoryError('stale-request-metadata', 'accept-finalize-revision-changed');
    }
    this.validateResolvingTickets(
      connection,
      context.request,
      operation.expectedResolvingTickets,
    );
    if (!operation.resultCommitOid) {
      throw repositoryError('authority-integrity-error', 'accept-result-missing');
    }
    this.relations.assertAcceptCapacity(connection, operation.requestId);
    this.relations.acceptPending(connection, {
      acceptedAt: updatedAt,
      acceptedMergeOid: operation.resultCommitOid,
      requestId: operation.requestId,
    });
    for (const expectation of operation.expectedResolvingTickets) {
      const closed = this.tickets.changeStatus(connection, {
        actorMemberId,
        expectedRevision: expectation.revision,
        status: 'closed',
        ticketId: expectation.ticketId,
        updatedAt,
      });
      if (!closed || closed.status !== 'closed' || closed.revision !== expectation.revision + 1) {
        throw repositoryError('stale-ticket', 'accept-ticket-close-failed');
      }
    }
    connection.run(
      `UPDATE change_requests
       SET status = 'merged', merged_oid = ?, updated_at = ?
       WHERE request_id = ? AND status = 'open' AND latest_head_oid = ?`,
      [
        operation.resultCommitOid,
        updatedAt,
        operation.requestId,
        operation.expectedHeadOid,
      ],
    );
    if (operation.state !== 'completed') {
      connection.run(
        `UPDATE accept_operations
         SET state = 'completed', updated_at = ?
         WHERE operation_id = ? AND state = 'ref_updated'`,
        [updatedAt, operation.operationId],
      );
    }
    const row = connection.get(
      `SELECT
        r.request_id, r.member_id, r.status, r.first_base_oid,
        r.latest_head_oid, r.merged_oid, r.description, r.revision,
        r.created_at, r.updated_at,
        COUNT(c.comment_id) AS comment_count
       FROM change_requests r
       LEFT JOIN comments c ON c.request_id = r.request_id
       WHERE r.request_id = ?
       GROUP BY r.request_id`,
      [operation.requestId],
    );
    const completed = this.find(connection, operation.operationId);
    if (!row || !completed || completed.state !== 'completed') {
      throw repositoryError('authority-integrity-error', 'accept-finalize-failed');
    }
    return decodeAuthorityChangeRequest(
      row,
      this.relations.listForRequest(connection, operation.requestId),
    );
  }
}
