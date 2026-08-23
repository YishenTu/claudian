import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_MAIN_REF, collabMemberRef } from '@claudian-collab/protocol';
import {
  writeGitFixtureBlob,
  writeGitFixtureTree,
} from '@test/helpers/collabGitObjects';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import {
  AcceptCoordinator,
  type AcceptCoordinatorFailurePoint,
} from '@/app/collab/accept/AcceptCoordinator';
import { AcceptGitRepository } from '@/app/collab/accept/AcceptGitRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  type AuthorityDatabaseConnection,
  SqlJsProjectDatabase,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const ACCEPTED_AT = '2026-08-08T00:01:00.000Z';
const IDENTITY = Object.freeze({ email: 'fixture@claudian.local', name: 'Fixture' });
const MEMBER_ID = 'member-a';
const MEMBER_REF = collabMemberRef(MEMBER_ID);

jest.setTimeout(30_000);

describe('AcceptCoordinator Native Git integration', () => {
  let SQL: SqlJsStatic;
  let authorityDirectory: string;
  let database: SqlJsProjectDatabase;
  let git: GitRepositoryService;
  let repository: AcceptGitRepository;
  let repositoryPath: string;
  let root: string;
  let runner: GitCommandRunner;
  let headOid: string;
  let mainOid: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-accept-integration-'));
    authorityDirectory = path.join(root, 'authority');
    repositoryPath = path.join(authorityDirectory, 'repository.git');
    await mkdir(authorityDirectory);
    await mkdir(repositoryPath);
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') {
      throw new Error('Native Git is required for integration tests');
    }
    runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    });
    git = new GitRepositoryService(runner);
    await git.initializeBareRepository(repositoryPath);
    const baseBlob = await writeGitFixtureBlob(runner, repositoryPath, Buffer.from('base\n'));
    const baseTree = await writeGitFixtureTree(runner, repositoryPath, [
      { mode: '100644', oid: baseBlob, path: 'note.md', type: 'blob' },
    ]);
    mainOid = await git.commitTree(repositoryPath, {
      identity: IDENTITY,
      message: 'Base',
      parents: [],
      treeOid: baseTree,
    });
    const memberBlob = await writeGitFixtureBlob(runner, repositoryPath, Buffer.from('member\n'));
    const memberTree = await writeGitFixtureTree(runner, repositoryPath, [
      { mode: '100644', oid: memberBlob, path: 'member.md', type: 'blob' },
      { mode: '100644', oid: baseBlob, path: 'note.md', type: 'blob' },
    ]);
    headOid = await git.commitTree(repositoryPath, {
      identity: IDENTITY,
      message: 'Member change',
      parents: [mainOid],
      treeOid: memberTree,
    });
    await git.createRef(repositoryPath, COLLAB_MAIN_REF, mainOid);
    await git.createRef(repositoryPath, MEMBER_REF, headOid);
    repository = new AcceptGitRepository(repositoryPath, git);
    database = await openDatabase();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: CREATED_AT,
        hostCredentialHash: new Uint8Array(32).fill(9),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      insertActiveMember(connection);
      insertOpenRequest(connection);
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('creates the exact merge commit and leaves the Member ref untouched', async () => {
    const response = await coordinator().accept('member-host', input());

    expect(await git.resolveRef(repositoryPath, COLLAB_MAIN_REF)).toBe(response.mainOid);
    expect(await git.resolveRef(repositoryPath, MEMBER_REF)).toBe(headOid);
    expect(await show(response.mainOid, '%P')).toBe(`${mainOid} ${headOid}`);
    expect(await show(response.mainOid, '%an%x00%ae%x00%cn%x00%ce')).toBe(
      'Claudian Collab\0collab@claudian.local\0Claudian Collab\0collab@claudian.local',
    );
    await expect(git.assertHealthy(repositoryPath)).resolves.toBeUndefined();
  });

  it('rejects a clean merge whose combined tree is not cross-platform portable', async () => {
    const baseEntries = await git.listTreeRecursive(repositoryPath, mainOid);
    const note = baseEntries.find(entry => entry.path === 'note.md');
    if (!note) throw new Error('Base note missing');
    const managerBlob = await writeGitFixtureBlob(
      runner,
      repositoryPath,
      Buffer.from('manager\n'),
    );
    const advancedTree = await writeGitFixtureTree(runner, repositoryPath, [
      { mode: '100644', oid: managerBlob, path: 'Member.md', type: 'blob' },
      { mode: '100644', oid: note.oid, path: 'note.md', type: 'blob' },
    ]);
    const advancedMain = await git.commitTree(repositoryPath, {
      identity: IDENTITY,
      message: 'Manager change',
      parents: [mainOid],
      treeOid: advancedTree,
    });
    await expect(git.compareAndSwapRef(
      repositoryPath,
      COLLAB_MAIN_REF,
      advancedMain,
      mainOid,
    )).resolves.toMatchObject({ updated: true });
    mainOid = advancedMain;

    await expect(coordinator().accept('member-host', input())).rejects.toMatchObject({
      code: 'path-not-portable',
    });
    expect(await git.resolveRef(repositoryPath, COLLAB_MAIN_REF)).toBe(advancedMain);
    expect(await database.read(connection => connection.get(
      'SELECT COUNT(*) AS count FROM accept_operations',
    )?.count)).toBe(0);
  });

  it.each([
    'after-prepared',
    'after-result-persisted',
    'after-ref-updated',
    'after-completed',
  ] as const)('recovers %s after a database and coordinator restart', async failurePoint => {
    await expect(coordinator(failurePoint).accept('member-host', input()))
      .rejects.toThrow(`Injected ${failurePoint}`);
    await database.close();
    database = await openDatabase();

    const restarted = coordinator();
    await restarted.recover();
    const response = await restarted.accept('member-host', input());

    expect(await git.resolveRef(repositoryPath, COLLAB_MAIN_REF)).toBe(response.mainOid);
    expect(await git.resolveRef(repositoryPath, MEMBER_REF)).toBe(headOid);
    expect(await show(response.mainOid, '%P')).toBe(`${mainOid} ${headOid}`);
    expect(await database.read(connection => connection.get(
      'SELECT state FROM accept_operations WHERE operation_id = ?',
      ['accept-one'],
    )?.state)).toBe('completed');
    await expect(git.assertHealthy(repositoryPath)).resolves.toBeUndefined();
  });

  it.each([
    ['prepared', false],
    ['ref_updated', true],
  ] as const)(
    'migrates and recovers a v8 %s Accept with the then-current singular Manager',
    async (operationState, refAlreadyUpdated) => {
      let legacyResultOid: string | null = null;
      if (refAlreadyUpdated) {
        const merge = await repository.mergeTree(mainOid, headOid);
        if (merge.kind !== 'clean') throw new Error('Expected clean fixture merge');
        legacyResultOid = await repository.commitTree({
          identity: { email: 'collab@claudian.local', name: 'Claudian Collab' },
          message: 'Accept request request-one',
          parents: [mainOid, headOid],
          treeOid: merge.treeOid,
        });
        const updated = await repository.compareAndSwapRef(
          COLLAB_MAIN_REF,
          legacyResultOid,
          mainOid,
        );
        if (!updated.updated) throw new Error('Failed to install v8 accepted main');
      }

      const openResult = await installLegacyV8Accept(operationState, legacyResultOid);
      expect(openResult).toMatchObject({ migrated: true, source: 'primary' });
      await expect(database.read(connection => connection.get(
        `SELECT completion_actor_member_id, state
         FROM accept_operations WHERE operation_id = 'accept-one'`,
      ))).resolves.toEqual({
        completion_actor_member_id: 'member-manager',
        state: operationState,
      });

      const restarted = coordinator();
      await restarted.recover();
      await restarted.recover();
      await expect(restarted.accept('member-manager', input())).resolves.toMatchObject({
        request: { status: 'merged' },
      });

      const finalMainOid = await git.resolveRef(repositoryPath, COLLAB_MAIN_REF);
      expect(operationState === 'ref_updated'
        ? finalMainOid === legacyResultOid
        : finalMainOid !== mainOid).toBe(true);
      await expect(database.read(connection => ({
        events: connection.all(
          "SELECT actor_member_id FROM events WHERE event_kind = 'request.accepted'",
        ),
        idempotency: connection.all(
          "SELECT actor_member_id FROM idempotency_results WHERE operation_kind = 'accept'",
        ),
        operation: connection.get(
          "SELECT completion_actor_member_id, state FROM accept_operations WHERE operation_id = 'accept-one'",
        ),
      }))).resolves.toEqual({
        events: [{ actor_member_id: 'member-manager' }],
        idempotency: [{ actor_member_id: 'member-manager' }],
        operation: {
          completion_actor_member_id: 'member-manager',
          state: 'completed',
        },
      });
    },
  );

  function coordinator(failurePoint?: AcceptCoordinatorFailurePoint): AcceptCoordinator {
    return new AcceptCoordinator(database, repository, {
      createOperationId: () => 'accept-one',
      failAfter: failurePoint
        ? point => {
          if (point === failurePoint) throw new Error(`Injected ${point}`);
        }
        : undefined,
      now: () => new Date(ACCEPTED_AT),
    });
  }

  function input() {
    return {
      expectedHeadOid: headOid,
      expectedMainOid: mainOid,
      expectedRequestRevision: 1,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-key',
      projectId: 'project-alpha',
      requestId: 'request-one',
    };
  }

  async function openDatabase(): Promise<SqlJsProjectDatabase> {
    const opened = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await opened.open();
    return opened;
  }

  async function installLegacyV8Accept(
    state: 'prepared' | 'ref_updated',
    resultCommitOid: string | null,
  ) {
    const bytes = await database.exportSnapshot();
    await database.close();
    const legacy = new SQL.Database(bytes);
    try {
      downgradeToV8(legacy);
      legacy.run(
        `INSERT INTO accept_operations (
          operation_id, request_id, expected_main_oid, expected_head_oid,
          result_commit_oid, state, idempotency_key, created_at, updated_at,
          expected_request_revision, expected_resolving_tickets_json
        ) VALUES (?, 'request-one', ?, ?, ?, ?, 'accept-key', ?, ?, 1, '[]')`,
        ['accept-one', mainOid, headOid, resultCommitOid, state, CREATED_AT, ACCEPTED_AT],
      );
      await writeFile(path.join(authorityDirectory, 'collab.db'), legacy.export());
      await rm(path.join(authorityDirectory, 'collab.db.bak'), { force: true });
      await rm(path.join(authorityDirectory, 'collab.db.tmp'), { force: true });
    } finally {
      legacy.close();
    }
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    return database.open();
  }

  async function show(oid: string, format: string): Promise<string> {
    const result = await runner.run({
      args: ['show', '-s', `--format=${format}`, oid],
      cwd: repositoryPath,
    });
    return result.stdout.toString('utf8').trim();
  }

  function insertActiveMember(connection: AuthorityDatabaseConnection): void {
    connection.run(
      `INSERT INTO members (
        member_id, display_name, personal_ref, role, status, credential_hash,
        join_attempt_id, created_at, activated_at, revoked_at
      ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)`,
      [
        MEMBER_ID,
        'Member A',
        MEMBER_REF,
        new Uint8Array(32).fill(4),
        CREATED_AT,
        CREATED_AT,
      ],
    );
  }

  function insertOpenRequest(connection: AuthorityDatabaseConnection): void {
    connection.run(
      `INSERT INTO change_requests (
        request_id, member_id, status, first_base_oid, latest_head_oid,
        merged_oid, description, revision, created_at, updated_at
      ) VALUES (?, ?, 'open', ?, ?, NULL, ?, 1, ?, ?)`,
      ['request-one', MEMBER_ID, mainOid, headOid, 'Member change', CREATED_AT, CREATED_AT],
    );
  }
});

function downgradeToV8(database: Database): void {
  database.run(`
    PRAGMA foreign_keys = OFF;

    UPDATE members SET role = 'member' WHERE member_id = 'member-host';
    INSERT INTO members (
      member_id, display_name, personal_ref, role, status, credential_hash,
      join_attempt_id, created_at, activated_at, revoked_at
    ) VALUES (
      'member-manager', 'Legacy Manager',
      'refs/heads/members/member-manager', 'manager', 'active',
      X'0505050505050505050505050505050505050505050505050505050505050505',
      NULL, '${CREATED_AT}', '${CREATED_AT}', NULL
    );

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
    INSERT INTO project (
      singleton, project_id, name, state, host_member_id, manager_member_id,
      manager_generation, main_ref, created_at, snapshot_generation
    )
    SELECT
      singleton, project_id, name, state, host_member_id, 'member-manager',
      manager_set_generation + 1, main_ref, created_at, snapshot_generation
    FROM project_v9_fixture;
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
      RENAME TO manager_responsibility_offers_v10_fixture;
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
    INSERT INTO manager_responsibility_offers SELECT
      offer_id,
      CASE purpose WHEN 'manager-promotion' THEN 'manager-transfer' ELSE purpose END,
      source_manager_member_id,
      (SELECT manager_generation FROM project WHERE singleton = 1),
      target_member_id,
      status,
      offered_at,
      expires_at,
      acknowledged_at,
      consumed_at,
      updated_at
    FROM manager_responsibility_offers_v10_fixture;
    DROP TABLE manager_responsibility_offers_v10_fixture;
    CREATE UNIQUE INDEX manager_responsibility_one_nonterminal
      ON manager_responsibility_offers((1))
      WHERE status IN ('offered', 'acknowledged');

    CREATE UNIQUE INDEX members_one_active_manager
      ON members(role) WHERE role = 'manager' AND status = 'active';
    PRAGMA user_version = 8;
  `);
}
