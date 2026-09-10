import { COLLAB_LIMITS } from '@claudian-collab/protocol';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import { applyAuthorityMigrations, assertAuthorityDatabaseIntegrity } from '@/app/collab/authority/AuthoritySchema';
import { assertAuthorityTransactionIntegrity, beginAuthorityTransaction } from '@/app/collab/authority/AuthorityTransactionIntegrity';

const NOW = '2026-08-13T00:00:00.000Z';
const OID = 'a'.repeat(40);

function transact(database: Database, change: () => void): void {
  beginAuthorityTransaction(database);
  try {
    change();
    assertAuthorityTransactionIntegrity(database);
    database.run('COMMIT');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }
}

function offer(database: Database, id: string, source: string, target: string): void {
  database.run(`INSERT INTO manager_responsibility_offers (
    offer_id, purpose, source_manager_member_id, target_member_id, status,
    offered_at, expires_at, updated_at
  ) VALUES (?, 'manager-promotion', ?, ?, 'offered', ?, '2026-08-14T00:00:00.000Z', ?)`, [id, source, target, NOW, NOW]);
}

describe('Authority transaction integrity', () => {
  let SQL: SqlJsStatic;
  let database: Database;
  beforeAll(async () => { SQL = await initSqlJs(); });
  beforeEach(() => {
    database = new SQL.Database();
    applyAuthorityMigrations(database);
    for (const member of ['a', 'b', 'c']) {
      database.run(`INSERT INTO members (member_id, display_name, personal_ref, role, status, credential_hash, created_at, activated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`, [member, member, `refs/heads/members/${member}`, member === 'a' ? 'manager' : 'member', new Uint8Array(32), NOW, NOW]);
    }
    database.run(`INSERT INTO project(singleton, project_id, name, state, host_member_id, manager_set_generation, main_ref, created_at, snapshot_generation)
      VALUES (1, 'project-a', 'Project', 'active', 'a', 0, 'refs/heads/main', ?, 1)`, [NOW]);
    for (const member of ['a', 'b', 'c']) {
      database.run(`INSERT INTO change_requests(request_id, member_id, status, first_base_oid, latest_head_oid, merged_oid, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [`request-${member}`, member, member === 'b' ? 'merged' : 'open', OID, OID, member === 'b' ? OID : null, NOW, NOW]);
    }
    for (const ticket of ['ticket-a', 'ticket-b']) {
      database.run(`INSERT INTO tickets(ticket_id, title, body, status, author_member_id, revision, created_at, updated_at)
        VALUES (?, 'Title', 'Body', 'open', 'a', 1, ?, ?)`, [ticket, NOW, NOW]);
    }
    database.run(`INSERT INTO ticket_comments(comment_id, ticket_id, author_member_id, body, created_at)
      VALUES ('comment-a', 'ticket-a', 'a', 'Body', ?)`, [NOW]);
    database.run(`INSERT INTO ticket_mentions(ticket_id, mentioned_member_id, source_kind, source_id, created_at)
      VALUES ('ticket-a', 'b', 'comment', 'comment-a', ?)`, [NOW]);
    database.run(`INSERT INTO request_ticket_relations(relation_id, request_id, ticket_id, commit_oid, kind, state, created_by_member_id, created_at, updated_at)
      VALUES ('relation-a', 'request-a', 'ticket-a', ?, 'resolves', 'pending', 'a', ?, ?)`, [OID, NOW, NOW]);
    assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true });
  });
  afterEach(() => database.close());

  it.each([
    ['Request closure', "UPDATE change_requests SET status = 'discarded' WHERE request_id = 'request-a'"],
    ['relation reassignment', "UPDATE request_ticket_relations SET request_id = 'request-b' WHERE relation_id = 'relation-a'"],
    ['Member deactivation', `UPDATE members SET status = 'left', revoked_at = '${NOW}' WHERE member_id = 'b'`],
    ['mention reassignment', "UPDATE ticket_mentions SET ticket_id = 'ticket-b' WHERE ticket_id = 'ticket-a'"],
    ['mention source replacement', "UPDATE ticket_mentions SET source_id = 'missing-comment' WHERE ticket_id = 'ticket-a'"],
    ['last Manager removal', "UPDATE members SET role = 'member' WHERE member_id = 'a'"],
  ])('rejects an invalid final state after %s and rolls it back', (_name, sql) => {
    expect(() => transact(database, () => database.run(sql))).toThrow();
    transact(database, () => database.run("UPDATE project SET name = 'Valid next transaction'"));
    expect(assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true })).toBe(1);
  });

  it('accepts Member cleanup and Manager succession with valid final state', () => {
    transact(database, () => {
      database.run(`UPDATE members SET status = 'left', revoked_at = '${NOW}' WHERE member_id = 'b'`);
      database.run("DELETE FROM ticket_mentions WHERE mentioned_member_id = 'b'");
      database.run("UPDATE members SET role = 'member' WHERE member_id = 'a'");
      database.run("UPDATE members SET role = 'manager' WHERE member_id = 'c'");
      database.run("DELETE FROM request_ticket_relations WHERE request_id = 'request-a'");
      database.run("UPDATE change_requests SET status = 'discarded' WHERE request_id = 'request-a'");
    });
    expect(assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true })).toBe(1);
  });

  it('checks a moved comment source even if an admitted legacy image lacks its immutability trigger', () => {
    database.run('DROP TRIGGER ticket_comments_immutable_update');
    expect(() => transact(database, () => database.run("UPDATE ticket_comments SET ticket_id = 'ticket-b' WHERE comment_id = 'comment-a'"))).toThrow();
  });

  it('checks row-local invariants without assuming legacy CHECK constraints', () => {
    database.run('PRAGMA ignore_check_constraints = ON');
    expect(() => transact(database, () => database.run("UPDATE tickets SET revision = -1 WHERE ticket_id = 'ticket-a'"))).toThrow();
    expect(() => transact(database, () => database.run("UPDATE change_requests SET revision = -1 WHERE request_id = 'request-a'"))).toThrow();
    database.run('PRAGMA ignore_check_constraints = OFF');
  });

  it('rejects cross-role Manager offer overlap but accepts a settled replacement', () => {
    transact(database, () => offer(database, 'offer-a', 'a', 'b'));
    expect(() => transact(database, () => offer(database, 'offer-b', 'b', 'c'))).toThrow();
    transact(database, () => {
      database.run("UPDATE manager_responsibility_offers SET status = 'cancelled' WHERE offer_id = 'offer-a'");
      offer(database, 'offer-b', 'b', 'c');
    });
    expect(assertAuthorityDatabaseIntegrity(database, { full: true, requireProject: true })).toBe(1);
  });

  it('checks moved Request comments at capacity while allowing unchanged ownership', () => {
    database.run('BEGIN');
    for (let index = 0; index < COLLAB_LIMITS.maxRequestComments; index++) {
      database.run("INSERT INTO comments VALUES (?, 'request-a', 'a', 'Body', ?)", [`comment-${index}`, NOW]);
    }
    database.run("INSERT INTO comments VALUES ('moving', 'request-c', 'c', 'Body', ?)", [NOW]);
    database.run('COMMIT');
    expect(() => transact(database, () => database.run("UPDATE comments SET request_id = 'request-a' WHERE comment_id = 'moving'"))).toThrow();
    transact(database, () => database.run("UPDATE comments SET request_id = request_id WHERE comment_id = 'comment-0'"));
  });

  it('recovers a partially failed tracking installation before admitting another transaction', () => {
    const run = database.run.bind(database);
    let installedTriggers = 0;
    const fault = jest.spyOn(database, 'run').mockImplementation((sql, params) => {
      if (sql.startsWith('CREATE TEMP TRIGGER') && ++installedTriggers === 5) throw new Error('SQLite allocation failed');
      return run(sql, params);
    });
    expect(() => beginAuthorityTransaction(database)).toThrow('SQLite allocation failed');
    fault.mockRestore();
    expect(() => transact(database, () => database.run("UPDATE ticket_mentions SET ticket_id = 'ticket-b' WHERE ticket_id = 'ticket-a'"))).toThrow();
  });

  it('restores deferred foreign keys and affected-record checks after every exported image', () => {
    for (let round = 0; round < 3; round++) {
      database.export();
      expect(() => transact(database, () => database.run("UPDATE tickets SET author_member_id = 'missing' WHERE ticket_id = 'ticket-a'"))).toThrow();
      expect(() => transact(database, () => database.run("UPDATE ticket_mentions SET ticket_id = 'ticket-b' WHERE ticket_id = 'ticket-a'"))).toThrow();
      transact(database, () => database.run("UPDATE project SET name = 'Still writable'"));
    }
  });
});
