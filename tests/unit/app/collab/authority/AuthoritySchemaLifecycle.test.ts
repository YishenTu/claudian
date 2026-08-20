import { COLLAB_LIMITS } from '@claudian/collab-protocol';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import {
  applyAuthorityMigrations,
  assertAuthorityDatabaseIntegrity,
  migrateLegacyAuthorityDatabaseToCurrent,
} from '@/app/collab/authority/AuthoritySchema';
import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';

const CREATED_AT = '2026-08-13T00:00:00.000Z';
const LATER = '2026-08-13T00:10:00.000Z';

function columns(database: Database, table: string): string[] {
  return database.exec(`PRAGMA table_info(${table})`)[0]?.values
    .map(row => String(row[1])) ?? [];
}

function addMemberTableUniqueConstraint(database: Database): void {
  const schema = database.exec(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'members'
  `)[0]?.values[0]?.[0];
  if (typeof schema !== 'string') throw new Error('Members schema missing');
  const shadowSchema = schema.replace(/\)\s*$/, ', UNIQUE(role, status))');
  database.run('ALTER TABLE members RENAME TO members_without_shadow_constraint');
  database.run(shadowSchema);
  database.run('INSERT INTO members SELECT * FROM members_without_shadow_constraint');
}

function downgradeEmptyCurrentSchemaToV8(database: Database): void {
  database.run(`
    DROP TRIGGER comments_request_capacity_insert;
    DROP TRIGGER request_ticket_relations_accepted_capacity_insert;
    DROP TRIGGER request_ticket_relations_accepted_capacity_update;

    ALTER TABLE project RENAME TO project_v9_fixture;
    CREATE TABLE project (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      project_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active', 'disabled')),
      host_member_id TEXT NOT NULL REFERENCES members(member_id),
      manager_member_id TEXT NOT NULL REFERENCES members(member_id),
      manager_generation INTEGER NOT NULL DEFAULT 0,
      main_ref TEXT NOT NULL CHECK(main_ref = 'refs/heads/main'),
      created_at TEXT NOT NULL,
      snapshot_generation INTEGER NOT NULL DEFAULT 0
    );
    DROP TABLE project_v9_fixture;

    ALTER TABLE accept_operations RENAME TO accept_operations_v9_fixture;
    CREATE TABLE accept_operations (
      operation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES change_requests(request_id),
      expected_main_oid TEXT NOT NULL,
      expected_head_oid TEXT NOT NULL,
      result_commit_oid TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared', 'ref_updated', 'completed')),
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expected_request_revision INTEGER NOT NULL DEFAULT 0,
      expected_resolving_tickets_json TEXT NOT NULL DEFAULT '[]'
        CHECK(json_valid(expected_resolving_tickets_json))
    );
    DROP TABLE accept_operations_v9_fixture;

    DROP INDEX manager_responsibility_one_nonterminal_source;
    DROP INDEX manager_responsibility_one_nonterminal_target;
    ALTER TABLE manager_responsibility_offers
      RENAME TO manager_responsibility_offers_v9_fixture;
    CREATE TABLE manager_responsibility_offers (
      offer_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK(purpose IN ('manager-transfer', 'manager-leave')),
      source_manager_member_id TEXT NOT NULL REFERENCES members(member_id),
      source_manager_generation INTEGER NOT NULL,
      target_member_id TEXT NOT NULL REFERENCES members(member_id),
      status TEXT NOT NULL CHECK(status IN (
        'offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired'
      )),
      offered_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      acknowledged_at TEXT,
      consumed_at TEXT,
      updated_at TEXT NOT NULL
    );
    DROP TABLE manager_responsibility_offers_v9_fixture;
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
      ON manager_responsibility_offers((1))
      WHERE status IN ('offered', 'acknowledged');
    CREATE UNIQUE INDEX members_one_active_manager
      ON members(role)
      WHERE role = 'manager' AND status = 'active';
    PRAGMA user_version = 8;
  `);
}

function createV8Database(SQL: SqlJsStatic): Database {
  const database = new SQL.Database();
  applyAuthorityMigrations(database);
  downgradeEmptyCurrentSchemaToV8(database);
  return database;
}

function createHybridV8Database(SQL: SqlJsStatic): Database {
  const database = new SQL.Database();
  applyAuthorityMigrations(database);
  insertMembers(database);
  database.run(`
    INSERT INTO project (
      singleton, project_id, name, state, host_member_id,
      manager_set_generation, main_ref, created_at, snapshot_generation
    ) VALUES (
      1, 'project-alpha', 'Alpha', 'active', 'member-host', 7,
      'refs/heads/main', '${CREATED_AT}', 3
    );

    DROP INDEX manager_responsibility_one_nonterminal_source;
    DROP INDEX manager_responsibility_one_nonterminal_target;
    ALTER TABLE manager_responsibility_offers
      RENAME TO manager_responsibility_offers_v9_fixture;
    CREATE TABLE manager_responsibility_offers (
      offer_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK(purpose IN ('manager-transfer', 'manager-leave')),
      source_manager_member_id TEXT NOT NULL REFERENCES members(member_id),
      source_manager_generation INTEGER NOT NULL,
      target_member_id TEXT NOT NULL REFERENCES members(member_id),
      status TEXT NOT NULL CHECK(status IN (
        'offered', 'acknowledged', 'consumed', 'declined', 'cancelled', 'expired'
      )),
      offered_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      acknowledged_at TEXT,
      consumed_at TEXT,
      updated_at TEXT NOT NULL
    );
    DROP TABLE manager_responsibility_offers_v9_fixture;
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
      ON manager_responsibility_offers((1))
      WHERE status IN ('offered', 'acknowledged');
    CREATE UNIQUE INDEX members_one_active_manager
      ON members(role)
      WHERE role = 'manager' AND status = 'active';
    PRAGMA user_version = 8;
  `);
  return database;
}

function insertMembers(database: Database): void {
  database.run(`
    INSERT INTO members (
      member_id, display_name, personal_ref, role, status,
      credential_hash, created_at, activated_at
    ) VALUES
      ('member-host', 'Host', 'refs/heads/members/member-host', 'manager', 'active', ?, '${CREATED_AT}', '${CREATED_AT}'),
      ('member-a', 'Alice', 'refs/heads/members/member-a', 'member', 'active', ?, '${CREATED_AT}', '${CREATED_AT}')
  `, [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)]);
}

function insertProject(database: Database, managerMemberId = 'member-host'): void {
  database.run(`
    INSERT INTO project (
      singleton, project_id, name, state, host_member_id, manager_member_id,
      manager_generation, main_ref, created_at, snapshot_generation
    ) VALUES (
      1, 'project-alpha', 'Alpha', 'active', 'member-host', ?, 7,
      'refs/heads/main', '${CREATED_AT}', 3
    )
  `, [managerMemberId]);
}

describe('AuthoritySchema lifecycle migration', () => {
  let SQL: SqlJsStatic;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  it('atomically migrates a populated v8 authority to the finite multi-Manager v11 schema', () => {
    const database = createV8Database(SQL);
    insertMembers(database);
    insertProject(database);
    database.run(`
      INSERT INTO change_requests (
        request_id, member_id, status, first_base_oid, latest_head_oid,
        merged_oid, created_at, updated_at, description, revision
      ) VALUES (
        'request-one', 'member-a', 'open', '${'a'.repeat(40)}', '${'b'.repeat(40)}',
        NULL, '${CREATED_AT}', '${CREATED_AT}', 'Review', 2
      );
      INSERT INTO accept_operations (
        operation_id, request_id, expected_main_oid, expected_head_oid,
        result_commit_oid, state, idempotency_key, created_at, updated_at,
        expected_request_revision, expected_resolving_tickets_json
      ) VALUES
        ('accept-pending', 'request-one', '${'a'.repeat(40)}', '${'b'.repeat(40)}',
          NULL, 'prepared', 'accept-pending-key', '${CREATED_AT}', '${CREATED_AT}', 2, '[]'),
        ('accept-complete', 'request-one', '${'a'.repeat(40)}', '${'b'.repeat(40)}',
          '${'c'.repeat(40)}', 'completed', 'accept-complete-key', '${CREATED_AT}', '${CREATED_AT}', 2, '[]');
      INSERT INTO tickets (
        ticket_id, title, body, status, author_member_id, revision,
        comment_count, created_at, updated_at
      ) VALUES (
        'ticket-one', 'Ticket', 'Body', 'open', 'member-a', 1, 0,
        '${CREATED_AT}', '${CREATED_AT}'
      );
      INSERT INTO manager_responsibility_offers (
        offer_id, purpose, source_manager_member_id, source_manager_generation,
        target_member_id, status, offered_at, expires_at, acknowledged_at,
        consumed_at, updated_at
      ) VALUES
        ('offer-pending', 'manager-transfer', 'member-host', 7, 'member-a',
          'acknowledged', '${CREATED_AT}', '${LATER}', '${CREATED_AT}', NULL, '${CREATED_AT}'),
        ('offer-complete', 'manager-transfer', 'member-host', 7, 'member-a',
          'consumed', '${CREATED_AT}', '${LATER}', '${CREATED_AT}', '${CREATED_AT}', '${CREATED_AT}');
      INSERT INTO host_transfer_operations (
        transfer_id, source_host_member_id, target_host_member_id, phase,
        offered_at, expires_at, updated_at
      ) VALUES (
        'transfer-one', 'member-host', 'member-a', 'completed',
        '${CREATED_AT}', '${LATER}', '${CREATED_AT}'
      );
      INSERT INTO project_terminal_transitions (
        singleton, operation_id, kind, actor_member_id, idempotency_key,
        request_fingerprint, phase, retired_at, updated_at
      ) VALUES (
        1, 'retire-one', 'retire', 'member-host', 'retire-key',
        '${'d'.repeat(64)}', 'tombstone-committed', '${CREATED_AT}', '${CREATED_AT}'
      );
    `);

    expect(migrateLegacyAuthorityDatabaseToCurrent(database)).toBe(3);
    expect(applyAuthorityMigrations(database)).toBe(false);
    expect(database.exec('PRAGMA user_version')[0]?.values[0]?.[0])
      .toBe(COLLAB_AUTHORITY_SCHEMA_VERSION);
    expect(columns(database, 'project')).toContain('manager_set_generation');
    expect(columns(database, 'project')).not.toContain('manager_member_id');
    expect(columns(database, 'accept_operations')).toContain('completion_actor_member_id');
    expect(columns(database, 'manager_responsibility_offers'))
      .not.toContain('source_manager_generation');
    expect(database.exec(`
      SELECT project_id, host_member_id, manager_set_generation,
             main_ref, snapshot_generation
      FROM project
    `)[0]?.values[0]).toEqual([
      'project-alpha', 'member-host', 7, 'refs/heads/main', 3,
    ]);
    expect(database.exec(`
      SELECT operation_id, completion_actor_member_id
      FROM accept_operations ORDER BY operation_id
    `)[0]?.values).toEqual([
      ['accept-complete', null],
      ['accept-pending', 'member-host'],
    ]);
    expect(database.exec(`
      SELECT offer_id, purpose, status
      FROM manager_responsibility_offers ORDER BY offer_id
    `)[0]?.values).toEqual([
      ['offer-complete', 'manager-promotion', 'consumed'],
      ['offer-pending', 'manager-promotion', 'cancelled'],
    ]);
    expect(database.exec('SELECT COUNT(*) FROM tickets')[0]?.values[0]?.[0]).toBe(1);
    expect(database.exec('SELECT COUNT(*) FROM host_transfer_operations')[0]?.values[0]?.[0])
      .toBe(1);
    expect(database.exec('SELECT COUNT(*) FROM project_terminal_transitions')[0]?.values[0]?.[0])
      .toBe(1);
    expect(database.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'members_one_active_manager'
    `)).toEqual([]);
    expect(assertAuthorityDatabaseIntegrity(database, {
      full: true,
      requireProject: true,
    })).toBe(3);
  });

  it('rejects a mismatched v8 Manager pointer and rolls the migration back', () => {
    const database = createV8Database(SQL);
    insertMembers(database);
    insertProject(database, 'member-a');

    expect(() => applyAuthorityMigrations(database)).toThrow(
      'Authority V8 Manager pointer invariant failed',
    );
    expect(database.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
    expect(columns(database, 'project')).toContain('manager_member_id');
    expect(columns(database, 'project')).not.toContain('manager_set_generation');
    expect(columns(database, 'accept_operations')).not.toContain(
      'completion_actor_member_id',
    );
  });

  it('rejects a hybrid v8 image instead of blessing partial v9 sentinels', () => {
    const source = createHybridV8Database(SQL);
    const bytes = Uint8Array.from(source.export());
    source.close();
    const ordinary = new SQL.Database(bytes);
    const hostTransfer = new SQL.Database(bytes);

    expect(() => applyAuthorityMigrations(ordinary)).toThrow(
      'Authority V9 Manager schema is incomplete',
    );
    expect(ordinary.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
    expect(() => migrateLegacyAuthorityDatabaseToCurrent(hostTransfer)).toThrow(
      'Authority V9 Manager schema is incomplete',
    );
    expect(hostTransfer.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
  });

  it('repairs the obsolete singular-Manager index on a current v11 database', () => {
    const database = new SQL.Database();
    applyAuthorityMigrations(database);
    database.run(`
      CREATE UNIQUE INDEX members_one_active_manager
      ON members(role)
      WHERE role = 'manager' AND status = 'active'
    `);

    expect(applyAuthorityMigrations(database)).toBe(true);
    expect(database.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'members_one_active_manager'
    `)).toEqual([]);
  });

  it('installs exact finite-collection triggers in the v11 authority schema', () => {
    const database = new SQL.Database();
    applyAuthorityMigrations(database);

    expect(database.exec(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'comments_request_capacity_insert',
        'request_ticket_relations_accepted_capacity_insert',
        'request_ticket_relations_accepted_capacity_update'
      )
      ORDER BY name
    `)[0]?.values).toEqual([
      ['comments_request_capacity_insert'],
      ['request_ticket_relations_accepted_capacity_insert'],
      ['request_ticket_relations_accepted_capacity_update'],
    ]);
  });

  it('rejects legacy authority data that exceeds the shared Request comment limit', () => {
    const database = new SQL.Database();
    applyAuthorityMigrations(database);
    database.run(`
      DROP TRIGGER comments_request_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_update;
      PRAGMA user_version = 10;
    `);
    insertMembers(database);
    database.run(`
      INSERT INTO project (
        singleton, project_id, name, state, host_member_id,
        manager_set_generation, main_ref, created_at, snapshot_generation
      ) VALUES (
        1, 'project-alpha', 'Alpha', 'active', 'member-host', 0,
        'refs/heads/main', '${CREATED_AT}', 0
      );
      INSERT INTO change_requests (
        request_id, member_id, status, first_base_oid, latest_head_oid,
        merged_oid, created_at, updated_at, description, revision
      ) VALUES (
        'request-one', 'member-a', 'open', '${'a'.repeat(40)}', '${'b'.repeat(40)}',
        NULL, '${CREATED_AT}', '${CREATED_AT}', 'Review', 1
      );
    `);
    for (let index = 0; index <= COLLAB_LIMITS.maxRequestComments; index += 1) {
      database.run(
        `INSERT INTO comments (
          comment_id, request_id, author_member_id, body, created_at
        ) VALUES (?, 'request-one', 'member-host', 'Comment', ?)`,
        [`comment-${index}`, CREATED_AT],
      );
    }

    expect(() => applyAuthorityMigrations(database)).toThrow(
      'Authority V11 finite collection invariant failed',
    );
    expect(database.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(10);
  });

  it.each([
    {
      corrupt: (database: Database) => {
        database.run('DROP INDEX manager_responsibility_one_nonterminal_source');
      },
      name: 'missing responsibility index',
    },
    {
      corrupt: (database: Database) => {
        database.run(`
          DROP INDEX manager_responsibility_one_nonterminal_source;
          CREATE INDEX manager_responsibility_one_nonterminal_source
          ON manager_responsibility_offers(status)
        `);
      },
      name: 'malformed responsibility index',
    },
  ])('rejects a current v11 database with a $name', ({ corrupt }) => {
    const database = new SQL.Database();
    applyAuthorityMigrations(database);
    corrupt(database);

    expect(() => applyAuthorityMigrations(database)).toThrow(
      'Authority V10 Manager schema is incomplete',
    );
    expect(database.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(11);
  });

  it('rejects a renamed unique index that still enforces one active Manager', () => {
    const database = new SQL.Database();
    applyAuthorityMigrations(database);
    database.run(`
      CREATE UNIQUE INDEX members_single_manager_shadow
      ON members(role)
      WHERE role = 'manager' AND status = 'active'
    `);

    expect(() => applyAuthorityMigrations(database)).toThrow(
      'Authority V10 Manager schema is incomplete',
    );
  });

  it('rejects an unexpected multi-column unique Member index', () => {
    const database = new SQL.Database();
    applyAuthorityMigrations(database);
    database.run(`
      CREATE UNIQUE INDEX members_single_manager_shadow
      ON members(status, role)
      WHERE role = 'manager' AND status = 'active'
    `);

    expect(() => applyAuthorityMigrations(database)).toThrow(
      'Authority V10 Manager schema is incomplete',
    );
  });

  it('rejects an unexpected table-level unique Member constraint', () => {
    const database = new SQL.Database();
    applyAuthorityMigrations(database);
    addMemberTableUniqueConstraint(database);

    expect(() => applyAuthorityMigrations(database)).toThrow(
      'Authority V10 Manager schema is incomplete',
    );
  });

  it('rolls back v8 migration when a renamed singular-Manager index survives', () => {
    const source = createV8Database(SQL);
    source.run(`
      DROP INDEX members_one_active_manager;
      CREATE UNIQUE INDEX members_single_manager_shadow
      ON members(status, role)
      WHERE role = 'manager' AND status = 'active'
    `);
    const bytes = Uint8Array.from(source.export());
    source.close();
    const ordinary = new SQL.Database(bytes);
    const hostTransfer = new SQL.Database(bytes);

    expect(() => applyAuthorityMigrations(ordinary)).toThrow(
      'Authority V9 Manager schema is incomplete',
    );
    expect(ordinary.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
    expect(() => migrateLegacyAuthorityDatabaseToCurrent(hostTransfer)).toThrow(
      'Authority V9 Manager schema is incomplete',
    );
    expect(hostTransfer.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
  });

  it('rolls back v8 migration when a table-level unique Member constraint survives', () => {
    const source = createV8Database(SQL);
    source.run('DROP INDEX members_one_active_manager');
    addMemberTableUniqueConstraint(source);
    const bytes = Uint8Array.from(source.export());
    source.close();
    const ordinary = new SQL.Database(bytes);
    const hostTransfer = new SQL.Database(bytes);

    expect(() => applyAuthorityMigrations(ordinary)).toThrow(
      'Authority V9 Manager schema is incomplete',
    );
    expect(ordinary.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
    expect(() => migrateLegacyAuthorityDatabaseToCurrent(hostTransfer)).toThrow(
      'Authority V9 Manager schema is incomplete',
    );
    expect(hostTransfer.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(8);
  });
});
