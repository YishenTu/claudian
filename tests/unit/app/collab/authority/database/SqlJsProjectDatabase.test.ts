import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { applyAuthorityMigrations } from '@/app/collab/authority/AuthoritySchema';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import {
  NodeSqlJsSnapshotStore,
  type SqlJsSnapshotStore,
} from '@/app/collab/authority/SqlJsSnapshotStore';
import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

describe('SqlJsProjectDatabase', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let authorityDirectory: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-authority-database-'));
    authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('loads SQL lazily, serializes mutations, and restores the durable generation', async () => {
    const loadSqlJs = jest.fn().mockResolvedValue(SQL);
    const database = new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs });
    const projects = new ProjectAuthorityRepository();

    expect(loadSqlJs).not.toHaveBeenCalled();
    await expect(database.open()).resolves.toEqual({
      generation: 0,
      migrated: false,
      source: 'new',
    });
    expect(loadSqlJs).toHaveBeenCalledTimes(1);

    await database.mutate(connection => projects.initialize(connection, projectInput()));
    const mutations = await Promise.all([
      database.mutate(connection => {
        connection.run(
          'UPDATE project SET name = ? WHERE singleton = 1',
          ['First durable name'],
        );
        return 'first';
      }),
      database.mutate(connection => {
        connection.run(
          'UPDATE project SET name = ? WHERE singleton = 1',
          ['Second durable name'],
        );
        return 'second';
      }),
    ]);

    expect(mutations).toEqual([
      { generation: 2, value: 'first' },
      { generation: 3, value: 'second' },
    ]);
    expect(await database.read(connection => projects.get(connection)?.name))
      .toBe('Second durable name');
    await database.close();

    const reopened = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await expect(reopened.open()).resolves.toEqual({
      generation: 3,
      migrated: false,
      source: 'primary',
    });
    expect(await reopened.read(connection => projects.get(connection)?.name))
      .toBe('Second durable name');
    await reopened.close();
  });

  it('exports a cloned snapshot inside the serialized database boundary', async () => {
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    const projects = new ProjectAuthorityRepository();
    await database.open();
    await database.mutate(connection => projects.initialize(connection, projectInput()));

    const first = await database.exportSnapshot();
    const firstCopy = Uint8Array.from(first);
    first.fill(0);
    const second = await database.exportSnapshot();

    expect(second).toEqual(firstCopy);
    expect(second).not.toBe(first);
    const exported = new SQL.Database(second);
    expect(exported.exec('SELECT project_id FROM project')[0]?.values[0]?.[0])
      .toBe('project-alpha');
    exported.close();
    await database.close();
  });

  it('creates assignment-free Ticket storage and general Request comments', async () => {
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();

    await expect(database.read(connection => ({
      mentionTable: connection.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_mentions'",
      )?.name,
      commentColumns: connection.all('PRAGMA table_info(comments)').map(row => row.name),
      ticketColumns: connection.all('PRAGMA table_info(tickets)').map(row => row.name),
    }))).resolves.toEqual(expect.objectContaining({
      commentColumns: [
        'comment_id',
        'request_id',
        'author_member_id',
        'body',
        'created_at',
      ],
      mentionTable: 'ticket_mentions',
      ticketColumns: expect.not.arrayContaining(['assignee_member_id']),
    }));
    await database.close();
  });

  it('migrates a version-three Ticket database that predates durable mentions', async () => {
    const seed = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await seed.open();
    await seed.mutate(connection => (
      new ProjectAuthorityRepository().initialize(connection, projectInput())
    ));
    await seed.close();

    const primaryPath = path.join(authorityDirectory, 'collab.db');
    const versionThree = new SQL.Database(await readFile(primaryPath));
    versionThree.run(`
      DROP TRIGGER comments_request_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_update;
      DROP TABLE ticket_mentions;
      PRAGMA user_version = 3;
    `);
    await writeFile(primaryPath, versionThree.export());
    versionThree.close();

    const migrated = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await expect(migrated.open()).resolves.toMatchObject({
      migrated: true,
      source: 'primary',
    });
    await expect(migrated.read(connection => ({
      commentColumns: connection.all('PRAGMA table_info(comments)').map(row => row.name),
      mentionTable: connection.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket_mentions'",
      )?.name,
      version: connection.get('PRAGMA user_version')?.user_version,
    }))).resolves.toEqual({
      commentColumns: [
        'comment_id',
        'request_id',
        'author_member_id',
        'body',
        'created_at',
      ],
      mentionTable: 'ticket_mentions',
      version: COLLAB_AUTHORITY_SCHEMA_VERSION,
    });
    await migrated.close();
  });

  it('drops legacy inline comments while preserving general comments during migration', async () => {
    const seed = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await seed.open();
    await seed.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, projectInput());
      connection.run(
        `INSERT INTO change_requests (
          request_id, member_id, status, first_base_oid, latest_head_oid,
          merged_oid, created_at, updated_at
        ) VALUES (?, ?, 'open', ?, ?, NULL, ?, ?)`,
        [
          'request-legacy',
          'member-host',
          '1'.repeat(40),
          '2'.repeat(40),
          CREATED_AT,
          CREATED_AT,
        ],
      );
      connection.run(
        `INSERT INTO comments (
          comment_id, request_id, author_member_id, body, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          'comment-general',
          'request-legacy',
          'member-host',
          'General request comment',
          CREATED_AT,
        ],
      );
    });
    await seed.close();

    const primaryPath = path.join(authorityDirectory, 'collab.db');
    const versionSix = new SQL.Database(await readFile(primaryPath));
    versionSix.run(`
      DROP TRIGGER comments_request_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_update;
      ALTER TABLE comments ADD COLUMN anchor_path TEXT;
      INSERT INTO comments (
        comment_id, request_id, author_member_id, body, created_at, anchor_path
      ) VALUES (
        'comment-legacy', 'request-legacy', 'member-host',
        'Legacy inline comment', '${CREATED_AT}', 'notes/legacy.md'
      );
      PRAGMA user_version = 6;
    `);
    await writeFile(primaryPath, versionSix.export());
    versionSix.close();

    const migrated = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await expect(migrated.open()).resolves.toMatchObject({
      migrated: true,
      source: 'primary',
    });
    await expect(migrated.read(connection => ({
      columns: connection.all('PRAGMA table_info(comments)').map(row => row.name),
      comment: connection.get(
        `SELECT comment_id FROM comments WHERE comment_id = 'comment-legacy'`,
      ),
      generalComment: connection.get(
        `SELECT body FROM comments WHERE comment_id = 'comment-general'`,
      ),
      version: connection.get('PRAGMA user_version')?.user_version,
    }))).resolves.toEqual({
      columns: [
        'comment_id',
        'request_id',
        'author_member_id',
        'body',
        'created_at',
      ],
      comment: null,
      generalComment: { body: 'General request comment' },
      version: COLLAB_AUTHORITY_SCHEMA_VERSION,
    });
    await migrated.close();
  });

  it('reports lazy SQL initialization failures without writing authority files', async () => {
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => {
        throw new Error('Injected Wasm initialization failure');
      },
    });

    await expect(database.open()).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'sql-js-initialize-failed' },
    });
    await expect(readFile(path.join(authorityDirectory, 'collab.db')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists snapshots in temp, backup, primary, then directory-sync order', async () => {
    const projects = new ProjectAuthorityRepository();
    const store = new RecordingSnapshotStore(
      new NodeSqlJsSnapshotStore(authorityDirectory),
    );
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
      snapshotStore: store,
    });
    await database.open();
    await database.mutate(connection => projects.initialize(connection, projectInput()));
    store.calls.length = 0;

    await database.mutate(connection => {
      connection.run('UPDATE project SET name = ? WHERE singleton = 1', ['Next name']);
    });

    expect(store.calls).toEqual([
      'writeTemporary',
      'removeBackup',
      'rotatePrimaryToBackup',
      'promoteTemporary',
      'syncDirectory',
    ]);
    await database.close();
  });

  it('notifies subscribers only after a durable mutation and isolates listener failures', async () => {
    const projects = new ProjectAuthorityRepository();
    const store = new RecordingSnapshotStore(
      new NodeSqlJsSnapshotStore(authorityDirectory),
    );
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
      snapshotStore: store,
    });
    await database.open();
    const generations: number[] = [];
    const first = database.subscribe(generation => {
      generations.push(generation);
      expect(store.calls.at(-1)).toBe('syncDirectory');
    });
    database.subscribe(() => {
      throw new Error('Injected subscriber failure');
    });

    await expect(database.mutate(connection => (
      projects.initialize(connection, projectInput())
    ))).resolves.toMatchObject({ generation: 1 });
    expect(generations).toEqual([1]);

    first.dispose();
    await database.mutate(connection => {
      connection.run('UPDATE project SET name = ? WHERE singleton = 1', ['Next name']);
    });
    expect(generations).toEqual([1]);
    await database.close();
  });

  it('does not notify subscribers for rolled-back or non-durable mutations', async () => {
    const projects = new ProjectAuthorityRepository();
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => projects.initialize(connection, projectInput()));
    const listener = jest.fn();
    database.subscribe(listener);

    await expect(database.mutate(() => {
      throw new Error('Injected transaction failure');
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
    expect(listener).not.toHaveBeenCalled();

    await database.close();
    expect(() => database.subscribe(listener)).toThrow(expect.objectContaining({
      code: 'not-initialized',
    }));
  });

  it.each([
    'writeTemporary',
    'rotatePrimaryToBackup',
    'promoteTemporary',
    'syncDirectory',
  ] as const)('blocks after an injected %s failure and recovers the highest valid snapshot', async (
    failedOperation,
  ) => {
    const projects = new ProjectAuthorityRepository();
    const seed = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await seed.open();
    await seed.mutate(connection => projects.initialize(connection, projectInput()));
    await seed.close();

    const store = new FaultingSnapshotStore(
      new NodeSqlJsSnapshotStore(authorityDirectory),
      failedOperation,
    );
    const failing = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
      snapshotStore: store,
    });
    await failing.open();

    await expect(failing.mutate(connection => {
      connection.run('UPDATE project SET name = ? WHERE singleton = 1', ['Recovered name']);
    })).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await expect(failing.read(() => null)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });

    const recovered = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    const openResult = await recovered.open();
    const expectedGeneration = failedOperation === 'writeTemporary' ? 1 : 2;
    expect(openResult.generation).toBe(expectedGeneration);
    expect(await recovered.read(connection => projects.get(connection)?.name)).toBe(
      expectedGeneration === 2 ? 'Recovered name' : 'Alpha',
    );
    await recovered.close();
  });

  it('selects and promotes a valid backup when newer candidates are corrupt', async () => {
    const projects = new ProjectAuthorityRepository();
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => projects.initialize(connection, projectInput()));
    await database.mutate(connection => {
      connection.run('UPDATE project SET name = ? WHERE singleton = 1', ['Generation two']);
    });
    await database.close();
    await writeFile(path.join(authorityDirectory, 'collab.db'), 'corrupt primary');
    await writeFile(path.join(authorityDirectory, 'collab.db.tmp'), 'corrupt temporary');

    const recovered = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await expect(recovered.open()).resolves.toMatchObject({
      generation: 1,
      source: 'backup',
    });
    expect(await recovered.read(connection => projects.get(connection)?.name)).toBe('Alpha');
    await recovered.close();

    expect((await readFile(path.join(authorityDirectory, 'collab.db'))).subarray(0, 16))
      .toEqual(Buffer.from('SQLite format 3\0'));
  });

  it('blocks corrupt authority state instead of creating a blank database beside it', async () => {
    const primaryPath = path.join(authorityDirectory, 'collab.db');
    await writeFile(primaryPath, 'not a sqlite database');
    const original = await readFile(primaryPath);
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });

    await expect(database.open()).rejects.toMatchObject({
      code: 'database-corrupt',
    });
    expect(await readFile(primaryPath)).toEqual(original);
    await expect(readFile(path.join(authorityDirectory, 'collab.db.tmp')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an authority schema newer than this build supports', async () => {
    const projects = new ProjectAuthorityRepository();
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => projects.initialize(connection, projectInput()));
    await database.close();

    const primaryPath = path.join(authorityDirectory, 'collab.db');
    const newer = new SQL.Database(await readFile(primaryPath));
    newer.run(`PRAGMA user_version = ${COLLAB_AUTHORITY_SCHEMA_VERSION + 1}`);
    await writeFile(primaryPath, newer.export());
    newer.close();

    const unsupported = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await expect(unsupported.open()).rejects.toMatchObject({
      code: 'schema-version-unsupported',
    });
  });

  it('never downgrades to an older backup when primary uses a newer schema', async () => {
    const projects = new ProjectAuthorityRepository();
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => projects.initialize(connection, projectInput()));
    await database.mutate(connection => {
      connection.run('UPDATE project SET name = ? WHERE singleton = 1', ['Generation two']);
    });
    await database.close();

    const primaryPath = path.join(authorityDirectory, 'collab.db');
    const newer = new SQL.Database(await readFile(primaryPath));
    newer.run(`PRAGMA user_version = ${COLLAB_AUTHORITY_SCHEMA_VERSION + 1}`);
    const newerBytes = newer.export();
    await writeFile(primaryPath, newerBytes);
    newer.close();

    const unsupported = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await expect(unsupported.open()).rejects.toMatchObject({
      code: 'schema-version-unsupported',
    });
    expect(await readFile(primaryPath)).toEqual(Buffer.from(newerBytes));
  });

  it('migrates schema version zero and durably advances its generation', async () => {
    const projects = new ProjectAuthorityRepository();
    const database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => projects.initialize(connection, projectInput()));
    await database.close();

    const primaryPath = path.join(authorityDirectory, 'collab.db');
    const legacy = new SQL.Database(await readFile(primaryPath));
    legacy.run(`
      DROP TRIGGER comments_request_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_insert;
      DROP TRIGGER request_ticket_relations_accepted_capacity_update;
      PRAGMA user_version = 0;
    `);
    await writeFile(primaryPath, legacy.export());
    legacy.close();

    const migrated = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await expect(migrated.open()).resolves.toEqual({
      generation: 2,
      migrated: true,
      source: 'primary',
    });
    expect(await migrated.read(connection => (
      connection.get('PRAGMA user_version')?.user_version
    ))).toBe(COLLAB_AUTHORITY_SCHEMA_VERSION);
    await migrated.close();
  });

  it('rejects an incomplete legacy schema without leaving a partial migration', () => {
    const legacy = new SQL.Database();
    legacy.run(`
      CREATE TABLE comments (
        comment_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        author_member_id TEXT NOT NULL,
        body TEXT NOT NULL CHECK(length(body) > 0),
        created_at TEXT NOT NULL
      );
      INSERT INTO comments (
        comment_id, request_id, author_member_id, body, created_at
      ) VALUES (
        'comment-old', 'request-one', 'member-host', 'Legacy feedback', '${CREATED_AT}'
      );
      PRAGMA user_version = 1;
    `);

    expect(() => applyAuthorityMigrations(legacy)).toThrow();
    expect(legacy.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(1);
    const columns = legacy.exec('PRAGMA table_info(comments)')[0]?.values
      .map(row => row[1]);
    expect(columns).not.toContain('anchor_path');
    expect(legacy.exec(`
      SELECT body
      FROM comments WHERE comment_id = 'comment-old'
    `)[0]?.values[0]).toEqual(['Legacy feedback']);
    legacy.close();
  });
});

function projectInput() {
  return {
    createdAt: CREATED_AT,
    hostCredentialHash: new Uint8Array(32).fill(7),
    hostDisplayName: 'Host',
    hostMemberId: 'member-host',
    name: 'Alpha',
    projectId: 'project-alpha',
  };
}

class FaultingSnapshotStore implements SqlJsSnapshotStore {
  private failed = false;

  constructor(
    private readonly delegate: SqlJsSnapshotStore,
    private readonly failedOperation:
      | 'promoteTemporary'
      | 'rotatePrimaryToBackup'
      | 'syncDirectory'
      | 'writeTemporary',
  ) {}

  readCandidate = (kind: Parameters<SqlJsSnapshotStore['readCandidate']>[0]) => (
    this.delegate.readCandidate(kind)
  );

  removeBackup = () => this.delegate.removeBackup();

  removePrimary = () => this.delegate.removePrimary();

  async writeTemporary(contents: Uint8Array): Promise<void> {
    await this.failOnce('writeTemporary');
    await this.delegate.writeTemporary(contents);
  }

  async rotatePrimaryToBackup(): Promise<void> {
    await this.failOnce('rotatePrimaryToBackup');
    await this.delegate.rotatePrimaryToBackup();
  }

  async promoteTemporary(): Promise<void> {
    await this.failOnce('promoteTemporary');
    await this.delegate.promoteTemporary();
  }

  async syncDirectory(): Promise<void> {
    await this.failOnce('syncDirectory');
    await this.delegate.syncDirectory();
  }

  private async failOnce(operation: typeof this.failedOperation): Promise<void> {
    if (!this.failed && this.failedOperation === operation) {
      this.failed = true;
      throw new Error(`Injected ${operation} failure`);
    }
  }
}

class RecordingSnapshotStore implements SqlJsSnapshotStore {
  readonly calls: string[] = [];

  constructor(private readonly delegate: SqlJsSnapshotStore) {}

  readCandidate = (kind: Parameters<SqlJsSnapshotStore['readCandidate']>[0]) => (
    this.delegate.readCandidate(kind)
  );

  async writeTemporary(contents: Uint8Array): Promise<void> {
    this.calls.push('writeTemporary');
    await this.delegate.writeTemporary(contents);
  }

  async removeBackup(): Promise<void> {
    this.calls.push('removeBackup');
    await this.delegate.removeBackup();
  }

  async rotatePrimaryToBackup(): Promise<void> {
    this.calls.push('rotatePrimaryToBackup');
    await this.delegate.rotatePrimaryToBackup();
  }

  async removePrimary(): Promise<void> {
    this.calls.push('removePrimary');
    await this.delegate.removePrimary();
  }

  async promoteTemporary(): Promise<void> {
    this.calls.push('promoteTemporary');
    await this.delegate.promoteTemporary();
  }

  async syncDirectory(): Promise<void> {
    this.calls.push('syncDirectory');
    await this.delegate.syncDirectory();
  }
}
