import type { Database } from 'sql.js';

import { assertAuthorityProjectIntegrity, assertAuthorityRecordIntegrity } from '@/app/collab/authority/authorityIntegrityChecks';

// Capture both sides of ownership changes. Checks run against the final state,
// so cleanup, succession, and settlement can pass through intermediate states.
const TRACKED_KEYS = [
  { table: 'members', keys: [['member', 'member_id']] },
  { table: 'change_requests', keys: [['request', 'request_id']] },
  { table: 'comments', keys: [['request', 'request_id']] },
  { table: 'request_ticket_relations', keys: [['request', 'request_id'], ['ticket', 'ticket_id']] },
  { table: 'tickets', keys: [['ticket', 'ticket_id']] },
  { table: 'ticket_comments', keys: [['ticket', 'ticket_id']] },
  { table: 'ticket_mentions', keys: [['ticket', 'ticket_id']] },
  { table: 'manager_responsibility_offers', keys: [
    ['offer', 'offer_id'], ['participant', 'source_manager_member_id'], ['participant', 'target_member_id'],
  ] },
  { table: 'host_transition_proofs', keys: [['proof', 'transfer_id']] },
] as const;

export function beginAuthorityTransaction(database: Database): void {
  // sql.js export() reopens SQLite: foreign_keys and TEMP objects do not survive.
  // Reestablish connection-local enforcement before admitting the next mutation.
  database.run('PRAGMA foreign_keys = ON');
  if (database.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0] !== 1) {
    throw new Error('Authority transaction foreign keys are unavailable');
  }
  if (!database.exec("SELECT 1 FROM sqlite_temp_master WHERE name = 'authority_changed'").length) {
    database.run('SAVEPOINT authority_tracking');
    try {
      database.run('CREATE TEMP TABLE authority_changed(kind TEXT NOT NULL, id TEXT, PRIMARY KEY(kind, id))');
      for (const entry of TRACKED_KEYS) {
        for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
          const versions = event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
          const inserts = versions.flatMap(version => entry.keys.map(([kind, column]) => (
            `INSERT OR IGNORE INTO authority_changed(kind, id) VALUES ('${kind}', ${version}.${column});`
          ))).join('\n');
          database.run(`CREATE TEMP TRIGGER authority_track_${entry.table}_${event}
            AFTER ${event} ON main.${entry.table} BEGIN ${inserts} END`);
        }
      }
      database.run('RELEASE authority_tracking');
    } catch (error) {
      database.run('ROLLBACK TO authority_tracking');
      database.run('RELEASE authority_tracking');
      throw error;
    }
  }
  database.run('BEGIN IMMEDIATE');
  try {
    database.run('PRAGMA defer_foreign_keys = ON');
    database.run('DELETE FROM temp.authority_changed');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }
}

export function assertAuthorityTransactionIntegrity(database: Database): number {
  // Some legacy primary keys were nullable. Do not lose a changed malformed row
  // through SQL IN/NULL semantics; use the full record audit for that transaction.
  const hasNullKey = database.exec('SELECT 1 FROM temp.authority_changed WHERE id IS NULL LIMIT 1').length > 0;
  assertAuthorityRecordIntegrity(database, !hasNullKey);
  return assertAuthorityProjectIntegrity(database, true);
}
