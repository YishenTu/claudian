import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CollabCheckpointArtifactFact,
  CollabCheckpointGitRef,
  CollabCheckpointObjectFormat,
  CollabProjectCheckpointManifest,
} from '@claudian-collab/protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { AuthorityTransferAdmissionSettlement } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferAdmissionSettlement';
import { AuthorityTransferCheckpointGit } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointGit';
import { createAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { AuthorityTransferCheckpointRepository } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointRepository';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';

const CREATED_AT = '2026-08-26T00:00:00.000Z';
const MAIN_OID = 'a'.repeat(40);
const MEMBER_OID = 'b'.repeat(40);

describe('AuthorityTransferCheckpoint', () => {
  let SQL: SqlJsStatic;
  let root: string;
  let source: SqlJsProjectDatabase;
  let target: SqlJsProjectDatabase;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-authority-transfer-checkpoint-'));
    source = await createDatabase(path.join(root, 'source-authority'));
    target = await createDatabase(path.join(root, 'target-authority'));
    await source.mutate(connection => {
      new ProjectAuthorityRepository().initialize(connection, {
        createdAt: CREATED_AT,
        hostCredentialHash: new Uint8Array(32).fill(7),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      connection.run(`
        INSERT INTO members (
          member_id, display_name, personal_ref, role, status, credential_hash,
          join_attempt_id, created_at, activated_at, revoked_at
        ) VALUES (
          'member-a', 'Alice', 'refs/heads/members/member-a', 'member',
          'active', ?, NULL, ?, ?, NULL
        )
      `, [new Uint8Array(32).fill(8), CREATED_AT, CREATED_AT]);
      connection.run(`
        INSERT INTO change_requests (
          request_id, member_id, status, first_base_oid, latest_head_oid,
          merged_oid, created_at, updated_at, description, revision
        ) VALUES (
          'request-one', 'member-a', 'open', ?, ?, NULL, ?, ?, 'Review', 2
        )
      `, [MAIN_OID, MEMBER_OID, CREATED_AT, CREATED_AT]);
      connection.run(`
        INSERT INTO comments (
          comment_id, request_id, author_member_id, body, created_at
        ) VALUES ('request-comment-one', 'request-one', 'member-host', 'Looks good', ?)
      `, [CREATED_AT]);
      connection.run(`
        INSERT INTO tickets (
          ticket_number, ticket_id, title, body, status, author_member_id,
          revision, comment_count, created_at, updated_at
        ) VALUES (
          1, 'ticket-one', 'Portable', 'Keep this record', 'open',
          'member-a', 3, 1, ?, ?
        )
      `, [CREATED_AT, CREATED_AT]);
      connection.run(`
        INSERT INTO ticket_comments (
          comment_id, ticket_id, author_member_id, body, created_at
        ) VALUES ('ticket-comment-one', 'ticket-one', 'member-host', 'Tracked', ?)
      `, [CREATED_AT]);
      connection.run(`
        INSERT INTO request_ticket_relations (
          relation_id, request_id, ticket_id, commit_oid, kind, state,
          created_by_member_id, created_at, updated_at, accepted_at,
          accepted_merge_oid
        ) VALUES (
          'relation-one', 'request-one', 'ticket-one', ?, 'references',
          'pending', 'member-a', ?, ?, NULL, NULL
        )
      `, [MEMBER_OID, CREATED_AT, CREATED_AT]);
      connection.run(`
        INSERT INTO ticket_mentions (
          ticket_id, mentioned_member_id, source_kind, source_id, created_at
        ) VALUES ('ticket-one', 'member-host', 'description', 'ticket-one', ?)
      `, [CREATED_AT]);
    });
  });

  afterEach(async () => {
    await Promise.all([source.close(), target.close()]);
    await rm(root, { force: true, recursive: true });
  });

  it('exports deterministic portable records and imports one inert target authority', async () => {
    const repository = new AuthorityTransferCheckpointRepository();
    const first = await source.read(connection => repository.exportCoordination(connection, {
      expectedMainOid: MAIN_OID,
    }));
    const second = await source.read(connection => repository.exportCoordination(connection, {
      expectedMainOid: MAIN_OID,
    }));

    expect(second).toBe(first);
    expect(first.split('\n').slice(0, 3).map(line => JSON.parse(line))).toEqual([
      {
        kind: 'project',
        recordId: 'project-alpha',
        revision: 2,
        value: {
          activatedAt: CREATED_AT,
          authorityGeneration: 1,
          createdAt: CREATED_AT,
          expectedMainOid: MAIN_OID,
          managerSetGeneration: 0,
          name: 'Alpha',
          projectId: 'project-alpha',
        },
      },
      expect.objectContaining({
        kind: 'member',
        recordId: 'member-a',
        value: expect.objectContaining({
          memberId: 'member-a',
          status: 'active',
        }),
      }),
      expect.objectContaining({
        kind: 'member',
        recordId: 'member-host',
        value: expect.objectContaining({
          memberId: 'member-host',
          role: 'manager',
        }),
      }),
    ]);
    expect(first).toContain('"kind":"ticket-mention"');
    expect(first).not.toContain('credential');
    expect(first).not.toContain(Buffer.alloc(32, 7).toString('hex'));
    expect(first).not.toContain('invitation');

    const manifest = checkpointManifest(first);
    const targetCredentialHash = new Uint8Array(32).fill(9);
    await expect(target.mutate(connection => repository.importCoordination(connection, {
      coordinationNdjson: first,
      manifest: checkpointManifest(first, 'f'.repeat(64)),
      targetHostCredentialHash: targetCredentialHash,
      targetHostMemberId: 'member-a',
    }))).rejects.toMatchObject({
      safeContext: { reason: 'checkpoint-coordination-artifact-mismatch' },
    });
    await target.mutate(connection => repository.importCoordination(connection, {
      coordinationNdjson: first,
      manifest,
      targetHostCredentialHash: targetCredentialHash,
      targetHostMemberId: 'member-a',
    }));

    expect(await target.read(connection => connection.get(`
      SELECT p.project_id, p.state, p.host_member_id, m.authority_generation
      FROM project p CROSS JOIN authority_metadata m
      WHERE p.singleton = 1 AND m.singleton = 1
    `))).toEqual({
      authority_generation: 2,
      host_member_id: 'member-a',
      project_id: 'project-alpha',
      state: 'disabled',
    });
    expect(await target.read(connection => connection.all(`
      SELECT member_id, access_state, credential_hash
      FROM members ORDER BY member_id
    `))).toEqual([
      {
        access_state: 'bound',
        credential_hash: targetCredentialHash,
        member_id: 'member-a',
      },
      {
        access_state: 'unbound',
        credential_hash: null,
        member_id: 'member-host',
      },
    ]);
    expect(await target.read(connection => connection.get(`
      SELECT
        (SELECT COUNT(*) FROM change_requests) AS requests,
        (SELECT COUNT(*) FROM comments) AS request_comments,
        (SELECT COUNT(*) FROM tickets) AS tickets,
        (SELECT COUNT(*) FROM ticket_comments) AS ticket_comments,
        (SELECT COUNT(*) FROM request_ticket_relations) AS relations,
        (SELECT COUNT(*) FROM ticket_mentions) AS mentions
    `))).toEqual({
      mentions: 1,
      relations: 1,
      request_comments: 1,
      requests: 1,
      ticket_comments: 1,
      tickets: 1,
    });
  });

  it('refuses capture while invitation or pending Join admission is live', async () => {
    await source.mutate(connection => {
      connection.run(`
        INSERT INTO invitations (
          invitation_id, token_hash, expires_at, revoked_at,
          created_by_member_id, created_at
        ) VALUES ('invite-one', ?, ?, NULL, 'member-host', ?)
      `, [new Uint8Array(32).fill(4), '2026-08-27T00:00:00.000Z', CREATED_AT]);
    });

    await expect(source.read(connection => (
      new AuthorityTransferCheckpointRepository().exportCoordination(connection, {
        expectedMainOid: MAIN_OID,
      })
    ))).rejects.toMatchObject({
      safeContext: { reason: 'checkpoint-admission-unsettled' },
    });
  });

  it('creates, verifies, and imports a bundle containing only exact portable refs', async () => {
    const repositoryPath = path.join(root, 'repository');
    const targetPath = path.join(root, 'target.git');
    const bundlePath = path.join(root, 'repository.bundle');
    await mkdir(repositoryPath);
    await writeFile(path.join(root, 'empty-gitconfig'), '');
    const runner = new GitCommandRunner({
      emptyConfigPath: path.join(root, 'empty-gitconfig'),
      executablePath: 'git',
    });
    await git(runner, repositoryPath, ['init', '--initial-branch=main']);
    await writeFile(path.join(repositoryPath, 'note.md'), 'portable\n');
    await git(runner, repositoryPath, ['add', 'note.md']);
    await git(runner, repositoryPath, ['commit', '-m', 'portable'], true);
    const oid = (await git(runner, repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await git(runner, repositoryPath, ['update-ref', 'refs/heads/members/member-a', oid]);
    await git(runner, repositoryPath, ['update-ref', 'refs/claudian/private/secret', oid]);
    const refs = [
      { name: 'refs/heads/main', oid },
      { name: 'refs/heads/members/member-a', oid },
    ] as const;
    const checkpointGit = new AuthorityTransferCheckpointGit(runner);

    const identity = await checkpointGit.createBundle({
      bundlePath,
      refs,
      repositoryPath,
    });
    await expect(checkpointGit.verifyBundle({
      bundlePath,
      refs,
      repositoryPath,
    })).resolves.toEqual(identity);
    await checkpointGit.importIntoEmptyBareRepository({
      bundlePath,
      manifest: repositoryManifest(identity, refs),
      targetRepositoryPath: targetPath,
    });

    const list = await git(runner, targetPath, ['for-each-ref', '--format=%(refname) %(objectname)']);
    expect(list.trim().split('\n')).toEqual([
      `refs/heads/main ${oid}`,
      `refs/heads/members/member-a ${oid}`,
    ]);
    await expect(git(runner, targetPath, ['symbolic-ref', 'HEAD']))
      .resolves.toBe('refs/heads/main\n');
    await expect(git(runner, targetPath, ['rev-parse', '--show-object-format']))
      .resolves.toBe('sha1\n');
    expect((await readFile(bundlePath)).byteLength).toBe(identity.byteCount);
    await expect(checkpointGit.verifyBundle({
      bundlePath,
      refs: [{ ...refs[0], oid: 'f'.repeat(40) }, refs[1]],
      repositoryPath,
    })).rejects.toMatchObject({ code: 'authority-integrity-error' });
  });

  it('rejects a manifest-authenticated bundle that advertises an extra private ref', async () => {
    const repositoryPath = path.join(root, 'private-object-repository');
    const targetPath = path.join(root, 'private-object-target.git');
    const bundlePath = path.join(root, 'private-object.bundle');
    await mkdir(repositoryPath);
    await writeFile(path.join(root, 'private-object-gitconfig'), '');
    const runner = new GitCommandRunner({
      emptyConfigPath: path.join(root, 'private-object-gitconfig'),
      executablePath: 'git',
    });
    await git(runner, repositoryPath, ['init', '--initial-branch=main']);
    await writeFile(path.join(repositoryPath, 'public.md'), 'public\n');
    await git(runner, repositoryPath, ['add', 'public.md']);
    await git(runner, repositoryPath, ['commit', '-m', 'public'], true);
    const mainOid = (await git(runner, repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await git(runner, repositoryPath, ['checkout', '--orphan', 'private']);
    await git(runner, repositoryPath, ['rm', '-rf', '.']);
    await writeFile(path.join(repositoryPath, 'private.md'), 'must not transfer\n');
    await git(runner, repositoryPath, ['add', 'private.md']);
    await git(runner, repositoryPath, ['commit', '-m', 'private'], true);
    const privateOid = (await git(runner, repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await git(runner, repositoryPath, [
      'update-ref', 'refs/claudian/private/secret', privateOid,
    ]);
    await git(runner, repositoryPath, ['update-ref', 'refs/heads/main', mainOid]);
    await git(runner, repositoryPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(runner, repositoryPath, ['branch', '-D', 'private']);
    await git(runner, repositoryPath, [
      'bundle', 'create', bundlePath, 'refs/heads/main', 'refs/claudian/private/secret',
    ]);
    const bytes = await readFile(bundlePath);
    const artifact = {
      byteCount: bytes.byteLength,
      name: 'repository.bundle',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    } as const;
    const refs = [{ name: 'refs/heads/main', oid: mainOid }] as const;

    await expect(new AuthorityTransferCheckpointGit(runner)
      .importIntoEmptyBareRepository({
        bundlePath,
        manifest: repositoryManifest(artifact, refs),
        targetRepositoryPath: targetPath,
      })).rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const headerEnd = bytes.indexOf(Buffer.from('\n\n'));
    expect(headerEnd).toBeGreaterThan(0);
    const concealedHeader = bytes.subarray(0, headerEnd).toString('utf8')
      .split('\n')
      .filter(line => !line.endsWith(' refs/claudian/private/secret'))
      .join('\n');
    const concealed = Buffer.concat([
      Buffer.from(`${concealedHeader}\n\n`, 'utf8'),
      bytes.subarray(headerEnd + 2),
    ]);
    await writeFile(bundlePath, concealed);
    const concealedArtifact = {
      byteCount: concealed.byteLength,
      name: 'repository.bundle',
      sha256: createHash('sha256').update(concealed).digest('hex'),
    } as const;
    const concealedTargetPath = path.join(root, 'concealed-object-target.git');

    await expect(new AuthorityTransferCheckpointGit(runner)
      .importIntoEmptyBareRepository({
        bundlePath,
        manifest: repositoryManifest(concealedArtifact, refs),
        targetRepositoryPath: concealedTargetPath,
      })).rejects.toMatchObject({ code: 'authority-integrity-error' });
    await expect(lstat(concealedTargetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('imports a SHA-256 bundle into a canonical SHA-256 bare repository', async () => {
    const repositoryPath = path.join(root, 'sha256-repository');
    const targetPath = path.join(root, 'sha256-target.git');
    const bundlePath = path.join(root, 'sha256.bundle');
    await mkdir(repositoryPath);
    await writeFile(path.join(root, 'sha256-gitconfig'), '');
    const runner = new GitCommandRunner({
      emptyConfigPath: path.join(root, 'sha256-gitconfig'),
      executablePath: 'git',
    });
    await git(runner, repositoryPath, [
      'init', '--object-format=sha256', '--initial-branch=main',
    ]);
    await writeFile(path.join(repositoryPath, 'note.md'), 'sha256\n');
    await git(runner, repositoryPath, ['add', 'note.md']);
    await git(runner, repositoryPath, ['commit', '-m', 'sha256'], true);
    const oid = (await git(runner, repositoryPath, ['rev-parse', 'HEAD'])).trim();
    const refs = [{ name: 'refs/heads/main', oid }] as const;
    const checkpointGit = new AuthorityTransferCheckpointGit(runner);
    const artifact = await checkpointGit.createBundle({ bundlePath, refs, repositoryPath });

    await checkpointGit.importIntoEmptyBareRepository({
      bundlePath,
      manifest: repositoryManifest(artifact, refs, 'sha256'),
      targetRepositoryPath: targetPath,
    });

    await expect(git(runner, targetPath, ['rev-parse', '--show-object-format']))
      .resolves.toBe('sha256\n');
    await expect(git(runner, targetPath, ['symbolic-ref', 'HEAD']))
      .resolves.toBe('refs/heads/main\n');
  });

  it('removes an import repository when initialization fails after creating it', async () => {
    const targetPath = path.join(root, 'failed-target.git');
    await writeFile(path.join(root, 'failed-import-gitconfig'), '');
    const runner = new GitCommandRunner({
      emptyConfigPath: path.join(root, 'failed-import-gitconfig'),
      executablePath: 'git',
    });
    const failingRunner: Pick<GitCommandRunner, 'run'> = {
      run: async (request) => {
        const result = await runner.run(request);
        if (request.args[0] === 'init') throw new Error('injected-init-failure');
        return result;
      },
    };
    const checkpointGit = new AuthorityTransferCheckpointGit(failingRunner);
    const bundlePath = path.join(root, 'unused.bundle');
    await writeFile(bundlePath, 'x');
    const artifact = {
      byteCount: 1,
      name: 'repository.bundle',
      sha256: createHash('sha256').update('x').digest('hex'),
    } as const;
    const refs = [{ name: 'refs/heads/main', oid: MAIN_OID }] as const;

    await expect(checkpointGit.importIntoEmptyBareRepository({
      bundlePath,
      manifest: repositoryManifest(artifact, refs),
      targetRepositoryPath: targetPath,
    })).rejects.toThrow('injected-init-failure');

    await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revokes invitation admission and deletes only canonical pending refs', async () => {
    const repositoryPath = path.join(root, 'settlement-repository');
    await mkdir(repositoryPath);
    await writeFile(path.join(root, 'settlement-gitconfig'), '');
    const runner = new GitCommandRunner({
      emptyConfigPath: path.join(root, 'settlement-gitconfig'),
      executablePath: 'git',
    });
    await git(runner, repositoryPath, ['init', '--initial-branch=main']);
    await writeFile(path.join(repositoryPath, 'note.md'), 'main\n');
    await git(runner, repositoryPath, ['add', 'note.md']);
    await git(runner, repositoryPath, ['commit', '-m', 'main'], true);
    const mainOid = (await git(runner, repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await git(runner, repositoryPath, [
      'update-ref', 'refs/heads/members/member-pending-safe', mainOid,
    ]);
    await writeFile(path.join(repositoryPath, 'note.md'), 'diverged\n');
    await git(runner, repositoryPath, ['commit', '-am', 'diverged'], true);
    const divergentOid = (await git(runner, repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await git(runner, repositoryPath, ['update-ref', 'refs/heads/main', mainOid]);
    await git(runner, repositoryPath, [
      'update-ref', 'refs/heads/members/member-pending-diverged', divergentOid,
    ]);
    await source.mutate(connection => {
      connection.run(`
        INSERT INTO invitations (
          invitation_id, token_hash, expires_at, revoked_at,
          created_by_member_id, created_at
        ) VALUES ('invite-settlement', ?, '2026-08-27T00:00:00.000Z', NULL,
          'member-host', ?)
      `, [new Uint8Array(32).fill(4), CREATED_AT]);
      for (const memberId of ['member-pending-safe', 'member-pending-diverged']) {
        connection.run(`
          INSERT INTO members (
            member_id, display_name, personal_ref, role, status, credential_hash,
            join_attempt_id, created_at, activated_at, revoked_at
          ) VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?, NULL, NULL)
        `, [
          memberId,
          memberId,
          `refs/heads/members/${memberId}`,
          new Uint8Array(32).fill(5),
          `join-${memberId}`,
          CREATED_AT,
        ]);
      }
    });
    const settlement = new AuthorityTransferAdmissionSettlement({
      database: source,
      runner,
    });

    await expect(settlement.settle({
      repositoryPath,
      settledAt: CREATED_AT,
    })).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-pending-ref-diverged' },
    });
    expect(await source.read(connection => connection.get(`
      SELECT
        (SELECT COUNT(*) FROM members WHERE status = 'pending') AS pending,
        (SELECT COUNT(*) FROM invitations WHERE revoked_at IS NULL) AS live
    `))).toEqual({ live: 1, pending: 2 });

    await git(runner, repositoryPath, [
      'update-ref', 'refs/heads/members/member-pending-diverged', mainOid, divergentOid,
    ]);
    await settlement.settle({ repositoryPath, settledAt: CREATED_AT });

    expect(await source.read(connection => connection.get(`
      SELECT
        (SELECT COUNT(*) FROM members WHERE status = 'pending') AS pending,
        (SELECT COUNT(*) FROM invitations WHERE revoked_at IS NULL) AS live,
        (SELECT COUNT(*) FROM invitations WHERE revoked_at = ?) AS revoked
    `, [CREATED_AT]))).toEqual({ live: 0, pending: 0, revoked: 1 });
    expect((await git(runner, repositoryPath, [
      'for-each-ref', '--format=%(refname)', 'refs/heads/members/member-pending-',
    ])).trim()).toBe('');
  });

  async function createDatabase(directory: string): Promise<SqlJsProjectDatabase> {
    await mkdir(directory);
    const database = new SqlJsProjectDatabase(directory, { loadSqlJs: async () => SQL });
    await database.open();
    return database;
  }
});

function checkpointManifest(
  coordination: string,
  coordinationSha256 = createHash('sha256').update(coordination).digest('hex'),
): CollabProjectCheckpointManifest {
  return createAuthorityTransferCheckpointManifest({
    artifacts: [
      {
        byteCount: Buffer.byteLength(coordination),
        name: 'coordination.ndjson',
        sha256: coordinationSha256,
      },
      { byteCount: 1, name: 'repository.bundle', sha256: 'c'.repeat(64) },
    ],
    createdAt: CREATED_AT,
    expectedMainOid: MAIN_OID,
    gitObjectFormat: 'sha1',
    operationId: 'transfer-one',
    projectId: 'project-alpha',
    refs: [
      { name: 'refs/heads/main', oid: MAIN_OID },
      { name: 'refs/heads/members/member-a', oid: MEMBER_OID },
      { name: 'refs/heads/members/member-host', oid: MEMBER_OID },
    ],
    sourceAuthority: { generation: 1, kind: 'cloud' },
    targetAuthority: { generation: 2, kind: 'lan' },
  });
}

function repositoryManifest(
  repositoryArtifact: CollabCheckpointArtifactFact,
  refs: readonly CollabCheckpointGitRef[],
  gitObjectFormat: CollabCheckpointObjectFormat = 'sha1',
): CollabProjectCheckpointManifest {
  return createAuthorityTransferCheckpointManifest({
    artifacts: [
      { byteCount: 1, name: 'coordination.ndjson', sha256: 'a'.repeat(64) },
      repositoryArtifact,
    ],
    createdAt: CREATED_AT,
    expectedMainOid: refs[0]!.oid,
    gitObjectFormat,
    operationId: 'transfer-git',
    projectId: 'project-alpha',
    refs,
    sourceAuthority: { generation: 1, kind: 'lan' },
    targetAuthority: { generation: 2, kind: 'cloud' },
  });
}

async function git(
  runner: GitCommandRunner,
  cwd: string,
  args: readonly string[],
  identity = false,
): Promise<string> {
  const result = await runner.run({
    args,
    cwd,
    ...(identity ? { identity: { email: 'test@example.com', name: 'Test' } } : {}),
    maxStdoutBytes: 1024 * 1024,
    suppressHooks: true,
  });
  return result.stdout.toString('utf8');
}
