import { type CollabChangeRequest, type CollabMember, type CollabMemberId, collabMemberRef, type CollabMemberStatus, isCollabMemberId, isCollabOpaqueId } from '@claudian/collab-protocol';

import { RequestTicketRelationRepository } from '@/app/collab/authority/RequestTicketRelationRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityInvitationRecord {
  readonly createdAt: string;
  readonly createdByMemberId: CollabMemberId;
  readonly expiresAt: string;
  readonly id: string;
  readonly revokedAt: string | null;
  readonly tokenHash: Uint8Array;
}

export interface AuthorityMemberCredentialRecord {
  readonly credentialHash: Uint8Array;
  readonly joinAttemptId: string | null;
  readonly member: CollabMember;
}

export interface CreateAuthorityInvitationInput {
  readonly createdAt: string;
  readonly createdByMemberId: CollabMemberId;
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly tokenHash: Uint8Array;
}

export interface CreatePendingMembershipInput {
  readonly createdAt: string;
  readonly credentialHash: Uint8Array;
  readonly displayName: string;
  readonly joinAttemptId: string;
  readonly memberId: CollabMemberId;
}

function membershipError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
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
  if (typeof value !== 'string') throw membershipError('authority-row-invalid');
  return value;
}

function bytes(row: Readonly<Record<string, unknown>>, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw membershipError('authority-credential-hash-invalid');
  }
  return Uint8Array.from(value);
}

function assertTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw membershipError(`${field}-invalid`);
  }
}

function assertMemberId(value: string, field: string): void {
  if (!isCollabMemberId(value)) {
    throw membershipError(`${field}-invalid`);
  }
}

function assertOpaqueId(value: string, field: string): void {
  if (!isCollabOpaqueId(value)) {
    throw membershipError(`${field}-invalid`);
  }
}

function decodeMember(row: Readonly<Record<string, unknown>>): AuthorityMemberCredentialRecord {
  const id = text(row, 'member_id')!;
  const displayName = text(row, 'display_name')!;
  const personalRef = text(row, 'personal_ref')!;
  const role = text(row, 'role');
  const status = text(row, 'status');
  const createdAt = text(row, 'created_at')!;
  const activatedAt = text(row, 'activated_at', true);
  const revokedAt = text(row, 'revoked_at', true);
  const joinAttemptId = text(row, 'join_attempt_id', true);
  if (
    (role !== 'manager' && role !== 'member')
    || !isMemberStatus(status)
    || !isCollabMemberId(id)
    || (joinAttemptId !== null && !isCollabOpaqueId(joinAttemptId))
    || personalRef !== collabMemberRef(id)
  ) {
    throw membershipError('authority-member-row-invalid');
  }
  assertTimestamp(createdAt, 'member-created-at');
  if (activatedAt !== null) assertTimestamp(activatedAt, 'member-activated-at');
  if (revokedAt !== null) assertTimestamp(revokedAt, 'member-revoked-at');
  return {
    credentialHash: bytes(row, 'credential_hash'),
    joinAttemptId,
    member: {
      ...(activatedAt === null ? {} : { activatedAt }),
      createdAt,
      displayName,
      id,
      personalRef,
      ...(revokedAt === null ? {} : { revokedAt }),
      role,
      status,
    },
  };
}

function isMemberStatus(value: unknown): value is CollabMemberStatus {
  return value === 'pending'
    || value === 'active'
    || value === 'revoked'
    || value === 'left';
}

function decodeInvitation(
  row: Readonly<Record<string, unknown>>,
): AuthorityInvitationRecord {
  const createdAt = text(row, 'created_at')!;
  const expiresAt = text(row, 'expires_at')!;
  const revokedAt = text(row, 'revoked_at', true);
  const createdByMemberId = text(row, 'created_by_member_id')!;
  const invitationId = text(row, 'invitation_id')!;
  assertMemberId(createdByMemberId, 'invitation-creator-id');
  assertOpaqueId(invitationId, 'invitation-id');
  assertTimestamp(createdAt, 'invitation-created-at');
  assertTimestamp(expiresAt, 'invitation-expires-at');
  if (revokedAt !== null) assertTimestamp(revokedAt, 'invitation-revoked-at');
  return {
    createdAt,
    createdByMemberId,
    expiresAt,
    id: invitationId,
    revokedAt,
    tokenHash: bytes(row, 'token_hash'),
  };
}

function decodeChangeRequest(
  row: Readonly<Record<string, unknown>>,
  ticketRelations: CollabChangeRequest['ticketRelations'],
): CollabChangeRequest {
  const status = text(row, 'status');
  const commentCount = row.comment_count;
  const revision = row.revision;
  if (
    (status !== 'open' && status !== 'merged' && status !== 'discarded')
    || typeof commentCount !== 'number'
    || !Number.isSafeInteger(commentCount)
    || commentCount < 0
    || typeof revision !== 'number'
    || !Number.isSafeInteger(revision)
    || revision < 0
  ) {
    throw membershipError('authority-request-row-invalid');
  }
  const mergedOid = text(row, 'merged_oid', true);
  return {
    commentCount,
    createdAt: text(row, 'created_at')!,
    description: text(row, 'description')!,
    firstBaseOid: text(row, 'first_base_oid')!,
    id: text(row, 'request_id')!,
    latestHeadOid: text(row, 'latest_head_oid')!,
    memberId: text(row, 'member_id')!,
    ...(mergedOid === null ? {} : { mergedOid }),
    revision,
    status,
    ticketRelations,
    updatedAt: text(row, 'updated_at')!,
  };
}

const MEMBER_COLUMNS = `
  member_id, display_name, personal_ref, role, status, credential_hash,
  join_attempt_id, created_at, activated_at, revoked_at
`;

export class PendingMembershipRepository {
  private readonly requestTicketRelations = new RequestTicketRelationRepository();

  listInvitations(connection: AuthorityDatabaseConnection): readonly AuthorityInvitationRecord[] {
    return connection.all(`
      SELECT invitation_id, token_hash, expires_at, revoked_at,
             created_by_member_id, created_at
      FROM invitations
      ORDER BY created_at DESC, invitation_id DESC
    `).map(decodeInvitation);
  }

  rotateInvitation(
    connection: AuthorityDatabaseConnection,
    input: CreateAuthorityInvitationInput,
  ): AuthorityInvitationRecord {
    assertOpaqueId(input.invitationId, 'invitation-id');
    assertMemberId(input.createdByMemberId, 'invitation-creator-id');
    assertTimestamp(input.createdAt, 'invitation-created-at');
    assertTimestamp(input.expiresAt, 'invitation-expires-at');
    if (input.tokenHash.byteLength !== 32) {
      throw membershipError('invitation-token-hash-invalid');
    }
    connection.run(
      'UPDATE invitations SET revoked_at = ? WHERE revoked_at IS NULL',
      [input.createdAt],
    );
    connection.run(
      `INSERT INTO invitations (
        invitation_id, token_hash, expires_at, revoked_at,
        created_by_member_id, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?)`,
      [
        input.invitationId,
        input.tokenHash,
        input.expiresAt,
        input.createdByMemberId,
        input.createdAt,
      ],
    );
    const created = this.listInvitations(connection).find(
      invitation => invitation.id === input.invitationId,
    );
    if (!created) throw membershipError('invitation-create-failed');
    return created;
  }

  revokeCurrentInvitation(
    connection: AuthorityDatabaseConnection,
    revokedAt: string,
  ): number {
    assertTimestamp(revokedAt, 'invitation-revoked-at');
    const active = connection.all(
      'SELECT invitation_id FROM invitations WHERE revoked_at IS NULL',
    );
    connection.run(
      'UPDATE invitations SET revoked_at = ? WHERE revoked_at IS NULL',
      [revokedAt],
    );
    return active.length;
  }

  listCredentialRecords(
    connection: AuthorityDatabaseConnection,
    statuses: readonly CollabMemberStatus[],
  ): readonly AuthorityMemberCredentialRecord[] {
    if (statuses.length === 0 || statuses.some(status => !isMemberStatus(status))) {
      throw membershipError('member-status-filter-invalid');
    }
    const placeholders = statuses.map(() => '?').join(', ');
    return connection.all(`
      SELECT ${MEMBER_COLUMNS}
      FROM members
      WHERE status IN (${placeholders})
      ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, created_at, member_id
    `, [...statuses]).map(decodeMember);
  }

  findByJoinAttempt(
    connection: AuthorityDatabaseConnection,
    joinAttemptId: string,
  ): AuthorityMemberCredentialRecord | null {
    assertOpaqueId(joinAttemptId, 'join-attempt-id');
    const row = connection.get(`
      SELECT ${MEMBER_COLUMNS}
      FROM members
      WHERE join_attempt_id = ?
    `, [joinAttemptId]);
    return row ? decodeMember(row) : null;
  }

  createPending(
    connection: AuthorityDatabaseConnection,
    input: CreatePendingMembershipInput,
  ): AuthorityMemberCredentialRecord {
    assertMemberId(input.memberId, 'member-id');
    assertOpaqueId(input.joinAttemptId, 'join-attempt-id');
    assertTimestamp(input.createdAt, 'member-created-at');
    if (
      input.displayName.trim().length === 0
      || input.displayName.length > 200
      || input.displayName.includes('\u0000')
      || input.displayName.includes('\r')
      || input.displayName.includes('\n')
      || input.credentialHash.byteLength !== 32
    ) {
      throw membershipError('pending-member-input-invalid');
    }
    connection.run(
      `INSERT INTO members (
        member_id, display_name, personal_ref, role, status, credential_hash,
        join_attempt_id, created_at, activated_at, revoked_at
      ) VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?, NULL, NULL)`,
      [
        input.memberId,
        input.displayName,
        collabMemberRef(input.memberId),
        input.credentialHash,
        input.joinAttemptId,
        input.createdAt,
      ],
    );
    const created = this.findByJoinAttempt(connection, input.joinAttemptId);
    if (!created) throw membershipError('pending-member-create-failed');
    return created;
  }

  rotatePendingCredential(
    connection: AuthorityDatabaseConnection,
    memberId: CollabMemberId,
    credentialHash: Uint8Array,
  ): AuthorityMemberCredentialRecord {
    assertMemberId(memberId, 'member-id');
    if (credentialHash.byteLength !== 32) {
      throw membershipError('member-credential-hash-invalid');
    }
    connection.run(
      "UPDATE members SET credential_hash = ? WHERE member_id = ? AND status = 'pending'",
      [credentialHash, memberId],
    );
    const row = connection.get(`
      SELECT ${MEMBER_COLUMNS}
      FROM members
      WHERE member_id = ?
    `, [memberId]);
    if (!row) throw membershipError('pending-member-missing');
    return decodeMember(row);
  }

  activate(
    connection: AuthorityDatabaseConnection,
    memberId: CollabMemberId,
    activatedAt: string,
  ): AuthorityMemberCredentialRecord {
    assertMemberId(memberId, 'member-id');
    assertTimestamp(activatedAt, 'member-activated-at');
    connection.run(
      `UPDATE members
       SET status = 'active', activated_at = ?
       WHERE member_id = ? AND status = 'pending'`,
      [activatedAt, memberId],
    );
    const row = connection.get(`
      SELECT ${MEMBER_COLUMNS}
      FROM members
      WHERE member_id = ?
    `, [memberId]);
    if (!row) throw membershipError('member-missing');
    return decodeMember(row);
  }

  removePendingCreatedBefore(
    connection: AuthorityDatabaseConnection,
    cutoff: string,
  ): readonly CollabMember[] {
    const expired = this.listPendingCreatedBefore(connection, cutoff);
    this.removePending(connection, expired.map(member => member.id));
    return expired;
  }

  listPendingCreatedBefore(
    connection: AuthorityDatabaseConnection,
    cutoff: string,
  ): readonly CollabMember[] {
    assertTimestamp(cutoff, 'pending-cutoff');
    return connection.all(`
      SELECT ${MEMBER_COLUMNS}
      FROM members
      WHERE status = 'pending' AND created_at <= ?
      ORDER BY created_at, member_id
    `, [cutoff]).map(row => decodeMember(row).member);
  }

  removePending(
    connection: AuthorityDatabaseConnection,
    memberIds: readonly CollabMemberId[],
  ): void {
    for (const memberId of memberIds) {
      assertMemberId(memberId, 'member-id');
      connection.run(
        "DELETE FROM members WHERE member_id = ? AND status = 'pending'",
        [memberId],
      );
    }
  }

  listMembers(connection: AuthorityDatabaseConnection): readonly CollabMember[] {
    return connection.all(`
      SELECT ${MEMBER_COLUMNS}
      FROM members
      ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, created_at, member_id
    `).map(row => decodeMember(row).member);
  }

  listOpenRequests(connection: AuthorityDatabaseConnection): readonly CollabChangeRequest[] {
    return connection.all(`
      SELECT
        r.request_id, r.member_id, r.status, r.first_base_oid,
        r.latest_head_oid, r.merged_oid, r.description, r.revision,
        r.created_at, r.updated_at,
        COUNT(c.comment_id) AS comment_count
      FROM change_requests r
      LEFT JOIN comments c ON c.request_id = r.request_id
      WHERE r.status = 'open'
      GROUP BY r.request_id
      ORDER BY r.created_at, r.request_id
    `).map(row => decodeChangeRequest(
      row,
      this.requestTicketRelations.listForRequest(connection, text(row, 'request_id')!),
    ));
  }

  latestEventSequence(connection: AuthorityDatabaseConnection): number {
    const sequence = connection.get(
      'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events',
    )?.sequence;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
      throw membershipError('event-sequence-invalid');
    }
    return sequence;
  }
}
