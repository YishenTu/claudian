import { COLLAB_LIMITS } from '@claudian-collab/protocol';
import type { Database, SqlValue } from 'sql.js';

function firstColumn(database: Database, sql: string): readonly SqlValue[] {
  return database.exec(sql)[0]?.values.map(row => row[0]) ?? [];
}

function affected(onlyAffected: boolean, kind: string, column: string): string {
  return onlyAffected
    ? `${column} IN (SELECT id FROM temp.authority_changed WHERE kind = '${kind}')`
    : '1';
}

export function finiteCollectionCapacityIsValid(database: Database, onlyAffected = false): boolean {
  return firstColumn(database, `
    SELECT request_id
    FROM comments
    WHERE ${affected(onlyAffected, 'request', 'request_id')}
    GROUP BY request_id
    HAVING COUNT(*) > ${COLLAB_LIMITS.maxRequestComments}
    LIMIT 1
  `).length === 0
    && firstColumn(database, `
      SELECT ticket_id
      FROM request_ticket_relations
      WHERE state = 'accepted' AND ${affected(onlyAffected, 'ticket', 'ticket_id')}
      GROUP BY ticket_id
      HAVING COUNT(*) > ${COLLAB_LIMITS.maxTicketAcceptedRelations}
      LIMIT 1
    `).length === 0;
}

export function assertAuthorityRecordIntegrity(database: Database, onlyAffected = false): void {
  if (!finiteCollectionCapacityIsValid(database, onlyAffected)) {
    throw new Error('Authority finite collection invariant failed');
  }
  if (firstColumn(database, `
    SELECT request_id FROM change_requests
    WHERE ${affected(onlyAffected, 'request', 'request_id')}
      AND (typeof(revision) != 'integer' OR revision < 0)
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority request revision invariant failed');
  }
  if (firstColumn(database, `
    SELECT offer_id FROM manager_responsibility_offers
    WHERE ${affected(onlyAffected, 'offer', 'offer_id')} AND (
      expires_at <= offered_at
      OR (status = 'offered' AND acknowledged_at IS NOT NULL)
      OR (status = 'acknowledged' AND acknowledged_at IS NULL)
      OR (status = 'consumed' AND (acknowledged_at IS NULL OR consumed_at IS NULL))
    ) LIMIT 1
  `).length > 0) {
    throw new Error('Authority Manager responsibility invariant failed');
  }
  if (firstColumn(database, `
    SELECT participant_id
    FROM (
      SELECT source_manager_member_id AS participant_id
      FROM manager_responsibility_offers
      WHERE status IN ('offered', 'acknowledged')
        AND ${affected(onlyAffected, 'participant', 'source_manager_member_id')}
      UNION ALL
      SELECT target_member_id AS participant_id
      FROM manager_responsibility_offers
      WHERE status IN ('offered', 'acknowledged')
        AND ${affected(onlyAffected, 'participant', 'target_member_id')}
    )
    GROUP BY participant_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Manager responsibility participant invariant failed');
  }
  if (firstColumn(database, `
    SELECT transfer_id FROM host_transition_proofs
    WHERE ${affected(onlyAffected, 'proof', 'transfer_id')}
      AND previous_ca_fingerprint = next_ca_fingerprint
    LIMIT 1
  `).length > 0) {
    throw new Error('Authority Host transition invariant failed');
  }
  if (firstColumn(database, `
    SELECT ticket_id FROM tickets
    WHERE ${affected(onlyAffected, 'ticket', 'ticket_id')} AND (
      typeof(revision) != 'integer'
      OR revision < 1
      OR typeof(comment_count) != 'integer'
      OR comment_count < 0
      OR (status = 'open' AND (closed_at IS NOT NULL OR closed_by_member_id IS NOT NULL))
      OR (status = 'closed' AND (closed_at IS NULL OR closed_by_member_id IS NULL))
    ) LIMIT 1
  `).length > 0) {
    throw new Error('Authority Ticket invariant failed');
  }
  if (firstColumn(database, `
    SELECT relation_id FROM request_ticket_relations r
    JOIN change_requests q ON q.request_id = r.request_id
    WHERE ${affected(onlyAffected, 'request', 'r.request_id')} AND (
      (r.state = 'pending' AND q.status != 'open')
      OR (r.state = 'accepted' AND (
        r.accepted_at IS NULL OR r.accepted_merge_oid IS NULL
      ))
    ) LIMIT 1
  `).length > 0) {
    throw new Error('Authority Ticket relation invariant failed');
  }
  if (firstColumn(database, `
    SELECT m.source_id FROM ticket_mentions m
    JOIN members target ON target.member_id = m.mentioned_member_id
    WHERE (${affected(onlyAffected, 'ticket', 'm.ticket_id')}
      OR ${affected(onlyAffected, 'member', 'm.mentioned_member_id')}) AND (
      target.status != 'active'
      OR (m.source_kind = 'description' AND m.source_id != m.ticket_id)
      OR (m.source_kind = 'comment' AND NOT EXISTS (
        SELECT 1 FROM ticket_comments c
        WHERE c.comment_id = m.source_id AND c.ticket_id = m.ticket_id
      ))
    ) LIMIT 1
  `).length > 0) {
    throw new Error('Authority Ticket mention invariant failed');
  }

}

export function assertAuthorityProjectIntegrity(database: Database, requireProject: boolean): number {
  if (firstColumn(database, `
    SELECT singleton FROM authority_metadata
    WHERE singleton != 1
      OR typeof(authority_generation) != 'integer'
      OR authority_generation < 1
  `).length > 0 || firstColumn(database, `
    SELECT singleton FROM authority_metadata
  `).length !== 1) {
    throw new Error('Authority generation invariant failed');
  }

  const projectRows = database.exec(`
    SELECT
      p.snapshot_generation,
      p.manager_set_generation,
      EXISTS(
        SELECT 1 FROM members WHERE role = 'manager' AND status = 'active'
      ) AS has_active_manager
    FROM project p
    WHERE p.singleton = 1
  `);
  const rows = projectRows[0]?.values ?? [];
  if (rows.length === 0 && !requireProject) return 0;
  if (rows.length !== 1) throw new Error('Authority project row is invalid');
  const [
    generation,
    managerGeneration,
    hasActiveManager,
  ] = rows[0];
  if (
    typeof generation !== 'number'
    || !Number.isSafeInteger(generation)
    || generation < 0
    || typeof managerGeneration !== 'number'
    || !Number.isSafeInteger(managerGeneration)
    || managerGeneration < 0
    || typeof hasActiveManager !== 'number'
    || !Number.isSafeInteger(hasActiveManager)
    || hasActiveManager < 1
  ) {
    throw new Error('Authority manager or generation invariant failed');
  }
  return generation;
}
