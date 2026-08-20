import { type CollabMemberId, isCollabGitOid, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityEventAppendInput {
  readonly actorMemberId: CollabMemberId | null;
  readonly createdAt: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuthorityEventRecord {
  readonly actorMemberId: CollabMemberId | null;
  readonly createdAt: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence: number;
}

function eventError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

const EVENT_OPAQUE_ID_KEYS = new Set([
  'commentId',
  'discardedRequestId',
  'invitationId',
  'requestId',
  'ticketId',
  'transferId',
]);
const EVENT_MEMBER_ID_KEYS = new Set(['memberId', 'targetMemberId']);
const EVENT_TOKEN_KEYS = new Set(['phase']);
const EVENT_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function sanitizeAuthorityEventPayload(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (EVENT_OPAQUE_ID_KEYS.has(key)) {
      if (value === null && key === 'discardedRequestId') payload[key] = value;
      if (isCollabOpaqueId(value)) payload[key] = value;
      continue;
    }
    if (EVENT_MEMBER_ID_KEYS.has(key)) {
      if (isCollabMemberId(value)) payload[key] = value;
      continue;
    }
    if (key === 'projectId') {
      if (isCollabProjectId(value)) payload[key] = value;
      continue;
    }
    if (key === 'headOid' && isCollabGitOid(value)) {
      payload[key] = value;
      continue;
    }
    if (key === 'expiresAt' && typeof value === 'string') {
      if (!Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value) {
        payload[key] = value;
      }
      continue;
    }
    if (key === 'revoked' && typeof value === 'boolean') {
      payload[key] = value;
      continue;
    }
    if (EVENT_TOKEN_KEYS.has(key) && typeof value === 'string' && EVENT_TOKEN_PATTERN.test(value)) {
      payload[key] = value;
    }
  }
  return payload;
}

export class AuthorityEventRepository {
  append(
    connection: AuthorityDatabaseConnection,
    input: AuthorityEventAppendInput,
  ): AuthorityEventRecord {
    if (input.actorMemberId !== null && !isCollabMemberId(input.actorMemberId)) {
      throw eventError('authority-event-actor-invalid');
    }
    if (!/^[a-z][a-z0-9.-]{0,99}$/.test(input.kind)) {
      throw eventError('authority-event-kind-invalid');
    }
    assertTimestamp(input.createdAt);
    const payload = sanitizeAuthorityEventPayload(input.payload);
    connection.run(
      `INSERT INTO events (event_kind, actor_member_id, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
      [input.kind, input.actorMemberId, JSON.stringify(payload), input.createdAt],
    );
    const sequence = connection.get('SELECT last_insert_rowid() AS sequence')?.sequence;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw eventError('authority-event-sequence-invalid');
    }
    return { ...input, payload, sequence };
  }

  listAfter(
    connection: AuthorityDatabaseConnection,
    sequence: number,
    limit: number,
  ): readonly AuthorityEventRecord[] {
    if (
      !Number.isSafeInteger(sequence)
      || sequence < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 500
    ) {
      throw eventError('authority-event-query-invalid');
    }
    return connection.all(
      `SELECT sequence, event_kind, actor_member_id, payload_json, created_at
       FROM events
       WHERE sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
      [sequence, limit],
    ).map(row => {
      const eventSequence = row.sequence;
      const kind = row.event_kind;
      const actorMemberId = row.actor_member_id;
      const createdAt = row.created_at;
      const payloadJson = row.payload_json;
      if (
        typeof eventSequence !== 'number'
        || !Number.isSafeInteger(eventSequence)
        || eventSequence < 1
        || typeof kind !== 'string'
        || (typeof actorMemberId !== 'string' && actorMemberId !== null)
        || typeof createdAt !== 'string'
        || typeof payloadJson !== 'string'
      ) {
        throw eventError('authority-event-row-invalid');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        throw eventError('authority-event-payload-invalid');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw eventError('authority-event-payload-invalid');
      }
      return {
        actorMemberId,
        createdAt,
        kind,
        payload: payload as Readonly<Record<string, unknown>>,
        sequence: eventSequence,
      };
    });
  }
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw eventError('authority-event-created-at-invalid');
  }
}
