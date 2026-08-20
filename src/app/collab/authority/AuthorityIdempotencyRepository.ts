import { type CollabIdempotencyKey, type CollabMemberId, isCollabMemberId, isCollabOpaqueId } from '@claudian/collab-protocol';

import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SqlJsProjectDatabase';
import { type CollabOperationKind } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const COLLAB_OPERATION_KINDS = new Set<CollabOperationKind>([
  'initialize',
  'create-project',
  'join-project',
  'reconnect-project',
  'publish',
  'resolve-conflict',
  'start-host',
  'stop-host',
  'create-invitation',
  'revoke-invitation',
  'comment',
  'create-ticket',
  'update-ticket',
  'comment-ticket',
  'change-ticket-status',
  'update-request-metadata',
  'accept',
  'remove-member',
  'leave-project',
  'promote-manager',
  'demote-manager',
  'manager-responsibility',
  'transfer-host',
  'retire-project',
  'finalize-retired-project',
  'cleanup-project',
]);

export interface AuthorityIdempotencyStoreInput<T> {
  readonly actorMemberId: CollabMemberId;
  readonly createdAt: string;
  readonly key: CollabIdempotencyKey;
  readonly operationKind: CollabOperationKind;
  readonly requestFingerprint: string;
  readonly response: T;
}

export type AuthorityIdempotencyLookupInput = Omit<
  AuthorityIdempotencyStoreInput<never>,
  'createdAt' | 'response'
>;

export type AuthorityIdempotencyStoreResult<T> =
  | { readonly status: 'stored'; readonly response: T }
  | { readonly status: 'existing'; readonly response: T };

function idempotencyError(
  code: 'authority-integrity-error' | 'idempotency-conflict',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'idempotency-conflict' ? [] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class AuthorityIdempotencyRepository {
  find<T>(
    connection: AuthorityDatabaseConnection,
    input: AuthorityIdempotencyLookupInput,
  ): { readonly response: T; readonly status: 'existing' } | null {
    assertLookupInput(input);
    const existing = connection.get(
      `SELECT request_fingerprint, response_json
       FROM idempotency_results
       WHERE actor_member_id = ? AND operation_kind = ? AND idempotency_key = ?`,
      [input.actorMemberId, input.operationKind, input.key],
    );
    if (!existing) return null;
    if (existing.request_fingerprint !== input.requestFingerprint) {
      throw idempotencyError('idempotency-conflict', 'idempotency-key-reused');
    }
    if (typeof existing.response_json !== 'string') {
      throw idempotencyError('authority-integrity-error', 'idempotency-row-invalid');
    }
    try {
      return { response: JSON.parse(existing.response_json) as T, status: 'existing' };
    } catch {
      throw idempotencyError('authority-integrity-error', 'idempotency-response-invalid');
    }
  }

  store<T>(
    connection: AuthorityDatabaseConnection,
    input: AuthorityIdempotencyStoreInput<T>,
  ): AuthorityIdempotencyStoreResult<T> {
    assertInput(input);
    const existing = this.find<T>(connection, input);
    if (existing) {
      return existing;
    }

    let responseJson: string | undefined;
    try {
      responseJson = JSON.stringify(input.response);
    } catch {
      throw idempotencyError('authority-integrity-error', 'idempotency-response-invalid');
    }
    if (responseJson === undefined) {
      throw idempotencyError('authority-integrity-error', 'idempotency-response-invalid');
    }
    connection.run(
      `INSERT INTO idempotency_results (
        actor_member_id, operation_kind, idempotency_key, request_fingerprint,
        response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.actorMemberId,
        input.operationKind,
        input.key,
        input.requestFingerprint,
        responseJson,
        input.createdAt,
      ],
    );
    return { response: input.response, status: 'stored' };
  }
}

function assertLookupInput(input: AuthorityIdempotencyLookupInput): void {
  if (
    !isCollabMemberId(input.actorMemberId)
    || !isCollabOpaqueId(input.key)
    || !COLLAB_OPERATION_KINDS.has(input.operationKind)
    || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)
  ) {
    throw idempotencyError('authority-integrity-error', 'idempotency-input-invalid');
  }
}

function assertInput<T>(input: AuthorityIdempotencyStoreInput<T>): void {
  assertLookupInput(input);
  if (
    Number.isNaN(Date.parse(input.createdAt))
    || new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
    throw idempotencyError('authority-integrity-error', 'idempotency-input-invalid');
  }
}
