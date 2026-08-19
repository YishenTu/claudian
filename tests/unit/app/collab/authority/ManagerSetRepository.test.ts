import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { ManagerSetRepository } from '@/app/collab/authority/ManagerSetRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';

const CREATED_AT = '2026-08-17T00:00:00.000Z';

describe('ManagerSetRepository', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let database: SqlJsProjectDatabase;
  const managers = new ManagerSetRepository();

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-manager-set-'));
    const authorityDirectory = path.join(root, 'authority');
    await mkdir(authorityDirectory);
    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    await database.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: CREATED_AT,
        hostCredentialHash: new Uint8Array(32).fill(1),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      connection.run(
        `INSERT INTO members (
          member_id, display_name, personal_ref, role, status, credential_hash,
          join_attempt_id, created_at, activated_at, revoked_at
        ) VALUES (?, ?, ?, 'member', 'active', ?, NULL, ?, ?, NULL)`,
        [
          'member-a',
          'Alice',
          'refs/heads/members/member-a',
          new Uint8Array(32).fill(2),
          CREATED_AT,
          CREATED_AT,
        ],
      );
    });
  });

  afterEach(async () => {
    await database.close();
    await rm(root, { force: true, recursive: true });
  });

  it('promotes and demotes Managers while advancing one generation per set change', async () => {
    await expect(database.read(connection => managers.read(connection))).resolves.toEqual({
      generation: 0,
      managerMemberIds: ['member-host'],
    });

    await database.mutate(connection => managers.promote(connection, {
      expectedGeneration: 0,
      targetMemberId: 'member-a',
    }));
    await expect(database.read(connection => managers.read(connection))).resolves.toEqual({
      generation: 1,
      managerMemberIds: ['member-a', 'member-host'],
    });

    await database.mutate(connection => managers.demote(connection, {
      expectedGeneration: 1,
      targetMemberId: 'member-host',
    }));
    await expect(database.read(connection => managers.read(connection))).resolves.toEqual({
      generation: 2,
      managerMemberIds: ['member-a'],
    });
  });

  it('requires an active Manager actor and rejects stale generation writes', async () => {
    await expect(database.read(connection => managers.requireActiveManager(
      connection,
      'member-a',
    ))).rejects.toMatchObject({ code: 'authorization-denied' });

    await expect(database.mutate(connection => managers.promote(connection, {
      expectedGeneration: 1,
      targetMemberId: 'member-a',
    }))).rejects.toMatchObject({ code: 'stale-project-selection' });
  });

  it('never permits the active Manager set to become empty', async () => {
    await expect(database.mutate(connection => managers.demote(connection, {
      expectedGeneration: 0,
      targetMemberId: 'member-host',
    }))).rejects.toMatchObject({ code: 'authorization-denied' });

    await expect(database.read(connection => managers.read(connection))).resolves.toEqual({
      generation: 0,
      managerMemberIds: ['member-host'],
    });
  });

  it('promotes a departure successor with one generation change', async () => {
    await database.mutate(connection => managers.promoteSuccessor(connection, {
      departingManagerMemberId: 'member-host',
      expectedGeneration: 0,
      targetMemberId: 'member-a',
    }));

    await expect(database.read(connection => ({
      managerSet: managers.read(connection),
      roles: connection.all(
        'SELECT member_id, role FROM members ORDER BY member_id',
      ),
    }))).resolves.toEqual({
      managerSet: { generation: 1, managerMemberIds: ['member-a'] },
      roles: [
        { member_id: 'member-a', role: 'manager' },
        { member_id: 'member-host', role: 'member' },
      ],
    });
  });

  it('rolls back a role change when the generation compare-and-swap fails', async () => {
    await expect(database.mutate(connection => {
      connection.run(
        "UPDATE members SET role = 'manager' WHERE member_id = 'member-a'",
      );
      managers.advanceGeneration(connection, 4);
    })).rejects.toMatchObject({ code: 'stale-project-selection' });

    await expect(database.read(connection => ({
      managerSet: managers.read(connection),
      role: connection.get(
        "SELECT role FROM members WHERE member_id = 'member-a'",
      )?.role,
    }))).resolves.toEqual({
      managerSet: { generation: 0, managerMemberIds: ['member-host'] },
      role: 'member',
    });
  });

  it('rejects a mutation whose generation is exactly one behind', async () => {
    await database.mutate(connection => {
      connection.run(
        'UPDATE project SET manager_set_generation = 1 WHERE singleton = 1',
      );
    });

    await expect(database.mutate(connection => managers.promote(connection, {
      expectedGeneration: 0,
      targetMemberId: 'member-a',
    }))).rejects.toMatchObject({ code: 'stale-project-selection' });

    await expect(database.read(connection => ({
      managerSet: managers.read(connection),
      role: connection.get(
        "SELECT role FROM members WHERE member_id = 'member-a'",
      )?.role,
    }))).resolves.toEqual({
      managerSet: { generation: 1, managerMemberIds: ['member-host'] },
      role: 'member',
    });
  });
});
