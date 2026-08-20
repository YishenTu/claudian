import { COLLAB_LIMITS } from '@claudian/collab-protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

/**
 * Stable opaque pagination for authority reads. Cursors are keysets over the
 * producer's `(createdAt, id)` ordering, encoded as base64url JSON; clients
 * never parse them. Pages are bounded by both a count cap and a final UTF-8
 * serialization byte budget so every transport can carry a valid page.
 */
export interface AuthorityKeysetCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface AuthorityKeysetPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface AuthorityDetailPageBudgets {
  readonly commentsMaxUtf8Bytes: number;
  readonly relationsMaxUtf8Bytes: number;
}

export type AuthorityKeysetPageItemField =
  | 'acceptedRelations'
  | 'comments'
  | 'items'
  | 'tickets';

// Envelope keys, requestId/protocolVersion, page object keys, and cursor
// strings ride alongside the measured detail content.
const DETAIL_ENVELOPE_RESERVE_BYTES = 1_024;
// Floors keep at least one maximal item per embedded page so traversal never
// stalls behind an unsplittable first item.
const JSON_STRING_WORST_CASE_EXPANSION = 6;
const COMMENT_PAGE_FLOOR_BYTES = (
  COLLAB_LIMITS.maxTicketCommentBytes * JSON_STRING_WORST_CASE_EXPANSION
) + 4_096;
const RELATION_PAGE_FLOOR_BYTES = 4_096;

function cursorError(reason: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

export function encodeAuthorityKeysetCursor(cursor: AuthorityKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeAuthorityKeysetCursor(
  value: string | undefined,
  reason: string,
): AuthorityKeysetCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > COLLAB_LIMITS.maxPageCursorUtf16) {
    throw cursorError(reason);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw cursorError(reason);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cursorError(reason);
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  if (
    typeof record.createdAt !== 'string'
    || Number.isNaN(Date.parse(record.createdAt))
    || new Date(record.createdAt).toISOString() !== record.createdAt
    || typeof record.id !== 'string'
    || record.id.length === 0
    || record.id.length > 128
  ) {
    throw cursorError(reason);
  }
  return { createdAt: record.createdAt, id: record.id };
}

/**
 * Byte budgets for the comment and relation pages embedded in a detail
 * response. The fixed part (summary, body/description, scalars) is measured
 * after JSON serialization and the pages share what remains of the shared
 * detail bound, so a valid detail fits every conforming transport envelope
 * whenever its fixed part alone does.
 */
export function authorityDetailPageBudgets(
  fixedUtf8Bytes: number,
  includeRelations: boolean,
): AuthorityDetailPageBudgets {
  const clamp = (value: number, floor: number, ceiling: number): number => (
    Math.min(ceiling, Math.max(floor, value))
  );
  const available = Math.max(
    0,
    COLLAB_LIMITS.detailMaxUtf8Bytes - fixedUtf8Bytes - DETAIL_ENVELOPE_RESERVE_BYTES,
  );
  if (!includeRelations) {
    return {
      commentsMaxUtf8Bytes: clamp(
        available,
        COMMENT_PAGE_FLOOR_BYTES,
        COLLAB_LIMITS.commentPageMaxUtf8Bytes,
      ),
      relationsMaxUtf8Bytes: 0,
    };
  }
  const relationsMaxUtf8Bytes = clamp(
    Math.ceil(available / 4),
    RELATION_PAGE_FLOOR_BYTES,
    COLLAB_LIMITS.relationPageMaxUtf8Bytes,
  );
  return {
    commentsMaxUtf8Bytes: clamp(
      available - relationsMaxUtf8Bytes,
      COMMENT_PAGE_FLOOR_BYTES,
      COLLAB_LIMITS.commentPageMaxUtf8Bytes,
    ),
    relationsMaxUtf8Bytes,
  };
}

/**
 * Trim rows fetched in key order (limit + 1 entries) to one bounded page.
 * One maximum-size item fits the byte budget by contract, so a page is never
 * empty while rows remain. A producer that violates that contract fails
 * closed instead of emitting an oversized page. Cursor
 * encoding defaults to the shared keyset codec; callers with their own wire
 * cursor (e.g. Ticket list pages) supply `encodeKey`.
 */
export function trimAuthorityKeysetPage<T>(
  rows: readonly T[],
  limit: number,
  maxUtf8Bytes: number,
  key: (row: T) => AuthorityKeysetCursor,
  encodeKey: (cursor: AuthorityKeysetCursor) => string = encodeAuthorityKeysetCursor,
  itemField: AuthorityKeysetPageItemField = 'items',
): AuthorityKeysetPage<T> {
  const candidates = rows.slice(0, limit);
  const items: T[] = [];
  let nextCursor: string | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const candidateItems = [...items, candidate];
    const hasMore = index + 1 < candidates.length || rows.length > limit;
    const candidateCursor = hasMore ? encodeKey(key(candidate)) : undefined;
    const serializedPage = {
      [itemField]: candidateItems,
      ...(candidateCursor ? { nextCursor: candidateCursor } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(serializedPage), 'utf8') > maxUtf8Bytes) {
      if (items.length === 0) {
        throw new CollabError({
          code: 'authority-integrity-error',
          recoveryActions: ['open-diagnostics'],
          safeContext: { reason: 'authority-page-item-exceeds-byte-budget' },
        });
      }
      break;
    }
    items.push(candidate);
    nextCursor = candidateCursor;
  }
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
