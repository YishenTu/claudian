import { createHash } from 'node:crypto';

import {
  COLLAB_MAIN_REF,
  type CollabCheckpointPortableRecord,
  type CollabMemberId,
  type CollabProjectCheckpointManifest,
  decodeCollabProjectCheckpointCoordinationNdjson,
  encodeCollabProjectCheckpointCoordinationNdjson,
  validateCollabProjectCheckpointConsistency,
} from '@claudian-collab/protocol';

import { AuthorityMetadataRepository } from '@/app/collab/authority/AuthorityMetadataRepository';
import type {
  AuthorityDatabaseConnection,
  AuthoritySqlRow,
  AuthoritySqlValue,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { verifyAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface ExportAuthorityTransferCoordinationInput {
  readonly expectedMainOid: string;
}

export interface ImportAuthorityTransferCoordinationInput {
  readonly coordinationNdjson: string;
  readonly manifest: CollabProjectCheckpointManifest;
  readonly targetHostCredentialHash: Uint8Array;
  readonly targetHostMemberId: CollabMemberId;
}

function checkpointError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function runCheckpointSql(
  connection: AuthorityDatabaseConnection,
  sql: string,
  params: Parameters<AuthorityDatabaseConnection['run']>[1],
  reason: string,
): number {
  try {
    return connection.run(sql, params);
  } catch {
    throw checkpointError(reason);
  }
}

function text(row: AuthoritySqlRow, field: string, nullable = false): string | null {
  const value = row[field];
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw checkpointError('checkpoint-row-invalid');
  return value;
}

function integer(row: AuthoritySqlRow, field: string, minimum = 0): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw checkpointError('checkpoint-row-invalid');
  }
  return value;
}

function status(value: AuthoritySqlValue): 'active' | 'left' | 'revoked' {
  if (value !== 'active' && value !== 'left' && value !== 'revoked') {
    throw checkpointError('checkpoint-member-status-invalid');
  }
  return value;
}

function role(value: AuthoritySqlValue): 'manager' | 'member' {
  if (value !== 'manager' && value !== 'member') {
    throw checkpointError('checkpoint-member-role-invalid');
  }
  return value;
}

function sorted(rows: readonly AuthoritySqlRow[], field: string): readonly AuthoritySqlRow[] {
  return [...rows].sort((left, right) => (
    String(left[field]).localeCompare(String(right[field]), 'en-US')
  ));
}

function mentionRecordId(row: AuthoritySqlRow): string {
  const identity = [
    text(row, 'ticket_id'),
    text(row, 'source_kind'),
    text(row, 'source_id'),
    text(row, 'mentioned_member_id'),
  ].join('\u0000');
  return `ticket-mention-${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

function assertCaptureReady(connection: AuthorityDatabaseConnection): void {
  const blocked = connection.get(`
    SELECT
      (SELECT COUNT(*) FROM members WHERE status = 'pending') AS pending_members,
      (SELECT COUNT(*) FROM invitations WHERE revoked_at IS NULL) AS live_invitations,
      (SELECT COUNT(*) FROM accept_operations WHERE state != 'completed') AS pending_accepts,
      (SELECT COUNT(*) FROM manager_responsibility_offers
        WHERE status IN ('offered', 'acknowledged')) AS pending_manager_offers,
      (SELECT COUNT(*) FROM host_transfer_operations
        WHERE phase IN (
          'offered', 'accepted', 'quiescing', 'staged',
          'authority-relinquished', 'target-active'
        )) AS pending_host_transfers,
      (SELECT COUNT(*) FROM project_terminal_transitions
        WHERE phase = 'quiescing') AS pending_terminal_transitions
  `);
  if (!blocked) throw checkpointError('checkpoint-readiness-invalid');
  if (Object.values(blocked).some(value => value !== 0)) {
    throw checkpointError('checkpoint-admission-unsettled');
  }
}

function portableRecords(
  connection: AuthorityDatabaseConnection,
  input: ExportAuthorityTransferCoordinationInput,
): readonly CollabCheckpointPortableRecord[] {
  assertCaptureReady(connection);
  const project = connection.get(`
    SELECT
      project_id, name, manager_set_generation, created_at, snapshot_generation
    FROM project
    WHERE singleton = 1 AND state = 'active'
  `);
  if (!project) throw checkpointError('checkpoint-project-not-active');
  const projectId = text(project, 'project_id')!;
  const authorityGeneration = new AuthorityMetadataRepository().getGeneration(connection);
  const records: unknown[] = [{
    kind: 'project',
    recordId: projectId,
    revision: integer(project, 'snapshot_generation') + 1,
    value: {
      activatedAt: text(project, 'created_at'),
      authorityGeneration,
      createdAt: text(project, 'created_at'),
      expectedMainOid: input.expectedMainOid,
      managerSetGeneration: integer(project, 'manager_set_generation'),
      name: text(project, 'name'),
      projectId,
    },
  }];

  for (const row of sorted(connection.all(`
    SELECT
      member_id, display_name, personal_ref, role, status,
      created_at, activated_at, revoked_at
    FROM members
    WHERE status IN ('active', 'left', 'revoked')
  `), 'member_id')) {
    const memberStatus = status(row.status);
    const createdAt = text(row, 'created_at')!;
    const activatedAt = text(row, 'activated_at', true);
    const revokedAt = text(row, 'revoked_at', true);
    records.push({
      kind: 'member',
      recordId: text(row, 'member_id'),
      revision: 1,
      value: {
        activatedAt,
        createdAt,
        displayName: text(row, 'display_name'),
        memberId: text(row, 'member_id'),
        personalRef: text(row, 'personal_ref'),
        projectId,
        role: role(row.role),
        status: memberStatus,
        revokedAt,
        updatedAt: revokedAt ?? activatedAt ?? createdAt,
      },
    });
  }

  for (const row of sorted(connection.all(`
    SELECT
      request_id, member_id, status, first_base_oid, latest_head_oid,
      merged_oid, description, revision, created_at, updated_at
    FROM change_requests
  `), 'request_id')) {
    records.push({
      kind: 'request',
      recordId: text(row, 'request_id'),
      revision: integer(row, 'revision') + 1,
      value: {
        createdAt: text(row, 'created_at'),
        description: text(row, 'description'),
        firstBaseOid: text(row, 'first_base_oid'),
        latestHeadOid: text(row, 'latest_head_oid'),
        memberId: text(row, 'member_id'),
        mergedOid: text(row, 'merged_oid', true),
        projectId,
        requestId: text(row, 'request_id'),
        status: text(row, 'status'),
        updatedAt: text(row, 'updated_at'),
      },
    });
  }

  for (const row of sorted(connection.all(`
    SELECT comment_id, request_id, author_member_id, body, created_at
    FROM comments
  `), 'comment_id')) {
    records.push({
      kind: 'request-comment',
      recordId: text(row, 'comment_id'),
      revision: 1,
      value: {
        authorMemberId: text(row, 'author_member_id'),
        body: text(row, 'body'),
        commentId: text(row, 'comment_id'),
        createdAt: text(row, 'created_at'),
        projectId,
        requestId: text(row, 'request_id'),
      },
    });
  }

  for (const row of sorted(connection.all(`
    SELECT
      ticket_number, ticket_id, title, body, status, author_member_id,
      revision, created_at, updated_at, closed_at, closed_by_member_id
    FROM tickets
  `), 'ticket_id')) {
    records.push({
      kind: 'ticket',
      recordId: text(row, 'ticket_id'),
      revision: integer(row, 'revision', 1),
      value: {
        authorMemberId: text(row, 'author_member_id'),
        body: text(row, 'body'),
        closedAt: text(row, 'closed_at', true),
        closedByMemberId: text(row, 'closed_by_member_id', true),
        createdAt: text(row, 'created_at'),
        number: integer(row, 'ticket_number', 1),
        projectId,
        status: text(row, 'status'),
        ticketId: text(row, 'ticket_id'),
        title: text(row, 'title'),
        updatedAt: text(row, 'updated_at'),
      },
    });
  }

  for (const row of sorted(connection.all(`
    SELECT comment_id, ticket_id, author_member_id, body, created_at
    FROM ticket_comments
  `), 'comment_id')) {
    records.push({
      kind: 'ticket-comment',
      recordId: text(row, 'comment_id'),
      revision: 1,
      value: {
        authorMemberId: text(row, 'author_member_id'),
        body: text(row, 'body'),
        commentId: text(row, 'comment_id'),
        createdAt: text(row, 'created_at'),
        projectId,
        ticketId: text(row, 'ticket_id'),
      },
    });
  }

  for (const row of sorted(connection.all(`
    SELECT
      relation_id, request_id, ticket_id, commit_oid, kind, state,
      created_by_member_id, created_at, updated_at, accepted_at,
      accepted_merge_oid
    FROM request_ticket_relations
  `), 'relation_id')) {
    records.push({
      kind: 'ticket-relation',
      recordId: text(row, 'relation_id'),
      revision: 1,
      value: {
        acceptedAt: text(row, 'accepted_at', true),
        acceptedMergeOid: text(row, 'accepted_merge_oid', true),
        commitOid: text(row, 'commit_oid'),
        createdAt: text(row, 'created_at'),
        createdByMemberId: text(row, 'created_by_member_id'),
        kind: text(row, 'kind'),
        projectId,
        relationId: text(row, 'relation_id'),
        requestId: text(row, 'request_id'),
        state: text(row, 'state'),
        ticketId: text(row, 'ticket_id'),
        updatedAt: text(row, 'updated_at'),
      },
    });
  }

  const mentions = connection.all(`
    SELECT ticket_id, mentioned_member_id, source_kind, source_id, created_at
    FROM ticket_mentions
  `).map(row => ({ row, recordId: mentionRecordId(row) }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId, 'en-US'));
  for (const { recordId, row } of mentions) {
    records.push({
      kind: 'ticket-mention',
      recordId,
      revision: 1,
      value: {
        createdAt: text(row, 'created_at'),
        mentionedMemberId: text(row, 'mentioned_member_id'),
        projectId,
        sourceId: text(row, 'source_id'),
        sourceKind: text(row, 'source_kind'),
        ticketId: text(row, 'ticket_id'),
      },
    });
  }

  const candidate = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  return decodeCollabProjectCheckpointCoordinationNdjson(
    candidate,
    'authority-transfer',
  ) as readonly CollabCheckpointPortableRecord[];
}

function requireEmptyAuthority(connection: AuthorityDatabaseConnection): void {
  const row = connection.get(`
    SELECT
      (SELECT COUNT(*) FROM project) AS projects,
      (SELECT COUNT(*) FROM members) AS members,
      (SELECT COUNT(*) FROM invitations) AS invitations,
      (SELECT COUNT(*) FROM change_requests) AS requests,
      (SELECT COUNT(*) FROM tickets) AS tickets
  `);
  if (!row || Object.values(row).some(value => value !== 0)) {
    throw checkpointError('checkpoint-import-target-not-empty');
  }
}

export class AuthorityTransferCheckpointRepository {
  activateImportedAuthority(
    connection: AuthorityDatabaseConnection,
    input: Readonly<{
      projectId: string;
      targetAuthorityGeneration: number;
    }>,
  ): void {
    const project = connection.get(`
      SELECT project_id, state
      FROM project
      WHERE singleton = 1
    `);
    const generation = connection.get(`
      SELECT authority_generation
      FROM authority_metadata
      WHERE singleton = 1
    `);
    if (
      !project
      || text(project, 'project_id') !== input.projectId
      || (text(project, 'state') !== 'disabled' && text(project, 'state') !== 'active')
      || !generation
      || generation.authority_generation !== input.targetAuthorityGeneration
    ) throw checkpointError('checkpoint-target-authority-identity-invalid');
    if (text(project, 'state') === 'active') return;
    const changes = connection.run(`
      UPDATE project
      SET state = 'active'
      WHERE singleton = 1 AND project_id = ? AND state = 'disabled'
    `, [input.projectId]);
    if (changes !== 1) throw checkpointError('checkpoint-target-activation-stale');
  }

  exportCoordination(
    connection: AuthorityDatabaseConnection,
    input: ExportAuthorityTransferCoordinationInput,
  ): string {
    return encodeCollabProjectCheckpointCoordinationNdjson(
      portableRecords(connection, input),
      'authority-transfer',
    );
  }

  importCoordination(
    connection: AuthorityDatabaseConnection,
    input: ImportAuthorityTransferCoordinationInput,
  ): void {
    if (input.targetHostCredentialHash.byteLength !== 32) {
      throw checkpointError('checkpoint-target-credential-invalid');
    }
    const manifest = verifyAuthorityTransferCheckpointManifest(input.manifest);
    const coordinationArtifact = manifest.artifacts.find(
      artifact => artifact.name === 'coordination.ndjson',
    );
    if (
      coordinationArtifact === undefined
      || coordinationArtifact.byteCount !== Buffer.byteLength(input.coordinationNdjson, 'utf8')
      || coordinationArtifact.sha256 !== createHash('sha256')
        .update(input.coordinationNdjson, 'utf8')
        .digest('hex')
    ) throw checkpointError('checkpoint-coordination-artifact-mismatch');
    const records = decodeCollabProjectCheckpointCoordinationNdjson(
      input.coordinationNdjson,
      'authority-transfer',
    );
    validateCollabProjectCheckpointConsistency(manifest, records);
    const target = manifest.targetAuthority;
    if (target?.kind !== 'lan') throw checkpointError('checkpoint-target-authority-invalid');
    const portable = records as readonly CollabCheckpointPortableRecord[];
    const project = portable[0];
    if (project?.kind !== 'project') throw checkpointError('checkpoint-project-missing');
    const members = portable.filter(record => record.kind === 'member');
    const targetHost = members.find(record => record.value.memberId === input.targetHostMemberId);
    if (targetHost?.kind !== 'member' || targetHost.value.status !== 'active') {
      throw checkpointError('checkpoint-target-host-invalid');
    }
    requireEmptyAuthority(connection);

    for (const record of members) {
      if (record.kind !== 'member') continue;
      const bound = record.value.memberId === input.targetHostMemberId;
      runCheckpointSql(connection, `
        INSERT INTO members (
          member_id, display_name, personal_ref, role, status, access_state,
          credential_hash, join_attempt_id, created_at, activated_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `, [
        record.value.memberId,
        record.value.displayName,
        record.value.personalRef,
        record.value.role,
        record.value.status,
        bound ? 'bound' : 'unbound',
        bound ? input.targetHostCredentialHash : null,
        record.value.createdAt,
        record.value.activatedAt,
        record.value.revokedAt,
      ], 'checkpoint-import-member-failed');
    }

    new AuthorityMetadataRepository().installGeneration(connection, target.generation);
    runCheckpointSql(connection, `
      INSERT INTO project (
        singleton, project_id, name, state, host_member_id,
        manager_set_generation, main_ref, created_at, snapshot_generation
      ) VALUES (1, ?, ?, 'disabled', ?, ?, ?, ?, ?)
    `, [
      project.value.projectId,
      project.value.name,
      input.targetHostMemberId,
      project.value.managerSetGeneration,
      COLLAB_MAIN_REF,
      project.value.createdAt,
      project.revision - 1,
    ], 'checkpoint-import-project-failed');

    for (const record of portable) {
      switch (record.kind) {
        case 'project':
        case 'member':
          break;
        case 'request':
          runCheckpointSql(connection, `
            INSERT INTO change_requests (
              request_id, member_id, status, first_base_oid, latest_head_oid,
              merged_oid, created_at, updated_at, description, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            record.value.requestId,
            record.value.memberId,
            record.value.status,
            record.value.firstBaseOid,
            record.value.latestHeadOid,
            record.value.mergedOid,
            record.value.createdAt,
            record.value.updatedAt,
            record.value.description,
            record.revision - 1,
          ], 'checkpoint-import-request-failed');
          break;
        case 'request-comment':
          runCheckpointSql(connection, `
            INSERT INTO comments (
              comment_id, request_id, author_member_id, body, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `, [
            record.value.commentId,
            record.value.requestId,
            record.value.authorMemberId,
            record.value.body,
            record.value.createdAt,
          ], 'checkpoint-import-request-comment-failed');
          break;
        case 'ticket': {
          const commentCount = portable.filter(candidate => (
            candidate.kind === 'ticket-comment'
            && candidate.value.ticketId === record.value.ticketId
          )).length;
          runCheckpointSql(connection, `
            INSERT INTO tickets (
              ticket_number, ticket_id, title, body, status, author_member_id,
              revision, comment_count, created_at, updated_at, closed_at,
              closed_by_member_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            record.value.number,
            record.value.ticketId,
            record.value.title,
            record.value.body,
            record.value.status,
            record.value.authorMemberId,
            record.revision,
            commentCount,
            record.value.createdAt,
            record.value.updatedAt,
            record.value.closedAt,
            record.value.closedByMemberId,
          ], 'checkpoint-import-ticket-failed');
          break;
        }
        case 'ticket-comment':
          runCheckpointSql(connection, `
            INSERT INTO ticket_comments (
              comment_id, ticket_id, author_member_id, body, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `, [
            record.value.commentId,
            record.value.ticketId,
            record.value.authorMemberId,
            record.value.body,
            record.value.createdAt,
          ], 'checkpoint-import-ticket-comment-failed');
          break;
        case 'ticket-relation':
          runCheckpointSql(connection, `
            INSERT INTO request_ticket_relations (
              relation_id, request_id, ticket_id, commit_oid, kind, state,
              created_by_member_id, created_at, updated_at, accepted_at,
              accepted_merge_oid
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            record.value.relationId,
            record.value.requestId,
            record.value.ticketId,
            record.value.commitOid,
            record.value.kind,
            record.value.state,
            record.value.createdByMemberId,
            record.value.createdAt,
            record.value.updatedAt,
            record.value.acceptedAt,
            record.value.acceptedMergeOid,
          ], 'checkpoint-import-ticket-relation-failed');
          break;
        case 'ticket-mention':
          runCheckpointSql(connection, `
            INSERT INTO ticket_mentions (
              ticket_id, mentioned_member_id, source_kind, source_id, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `, [
            record.value.ticketId,
            record.value.mentionedMemberId,
            record.value.sourceKind,
            record.value.sourceId,
            record.value.createdAt,
          ], 'checkpoint-import-ticket-mention-failed');
          break;
      }
    }
  }
}
