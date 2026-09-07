import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import {
  ClaudianCollabService,
  type CollabAuthorityFoundation,
} from '@/app/collab';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import {
  decodeCollabProjectSetupRecord,
} from '@/app/collab/project/CollabProjectSetupRecord';
import {
  type CollabProjectFoundationPort,
  CollabProjectSetupService,
} from '@/app/collab/project/CollabProjectSetupService';

const CREATED_AT = '2026-08-08T00:00:00.000Z';
const PROJECT_ID = 'project-alpha';
const MEMBER_ID = 'member-host';
const OPERATION_ID = 'create-project-alpha';
const MEMBER_CREDENTIAL = 'A'.repeat(43);

jest.setTimeout(30_000);

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'source@example.invalid',
      GIT_AUTHOR_NAME: 'Source Author',
      GIT_COMMITTER_EMAIL: 'source@example.invalid',
      GIT_COMMITTER_NAME: 'Source Author',
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function setupOptions(
  vaultRoot: string,
  getProjectsFolder: () => string = () => 'workspace',
) {
  return {
    createCredential: () => MEMBER_CREDENTIAL,
    createId: (kind: 'member' | 'operation' | 'project') => {
      if (kind === 'member') return MEMBER_ID;
      if (kind === 'operation') return OPERATION_ID;
      return PROJECT_ID;
    },
    getProjectsFolder,
    installationKey: TEST_INSTALLATION_A,
    now: () => new Date(CREATED_AT),
    vaultRoot,
  };
}

describe('CollabProjectSetupService', () => {
  let SQL: SqlJsStatic;
  let vaultRoot: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-project-setup-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  function createFoundation(getProjectsFolder?: () => string): ClaudianCollabService {
    return new ClaudianCollabService({
      createAuthorityDatabase: authorityDirectory => (
        new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL })
      ),
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      ...(getProjectsFolder ? { getProjectsFolder } : {}),
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
  }

  it('creates an empty Project in the captured Projects folder', async () => {
    git(vaultRoot, ['init', '--quiet', '--initial-branch=main']);
    const projectsFolder = 'Shared/Collab Projects';
    const foundation = createFoundation(() => projectsFolder);
    const service = new CollabProjectSetupService(
      foundation,
      setupOptions(vaultRoot, () => projectsFolder),
    );

    const result = await service.createProject({
      memberDisplayName: 'Alice',
      name: 'Alpha Notes',
    });

    expect(result).toEqual({
      status: 'success',
      value: {
        authorityKind: 'lan',
        connectionStatus: 'host-stopped',
        health: 'healthy',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'stopped',
        id: PROJECT_ID,
        name: 'Alpha Notes',
        role: 'manager',
        workspacePath: 'Shared/Collab Projects/alpha-notes',
      },
    });

    const workingCopy = path.join(vaultRoot, 'Shared', 'Collab Projects', 'alpha-notes');
    const bareRepository = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      'repository.git',
    );
    expect(git(workingCopy, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(workingCopy, ['ls-tree', '--name-only', 'HEAD'])).toBe('');
    const mainOid = git(bareRepository, ['rev-parse', 'refs/heads/main']);
    expect(git(bareRepository, ['rev-parse', `refs/heads/members/${MEMBER_ID}`]))
      .toBe(mainOid);
    expect(git(workingCopy, ['rev-parse', 'HEAD'])).toBe(mainOid);
    const origin = spawnSync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd: workingCopy, encoding: 'utf8' },
    );
    expect(origin.status).toBe(1);
    expect(origin.stdout).toBe('');
    expect(git(vaultRoot, [
      'check-ignore',
      'Shared/Collab Projects/alpha-notes/.git/config',
    ])).toBe('Shared/Collab Projects/alpha-notes/.git/config');

    const directPublisher = path.join(vaultRoot, 'direct-publisher');
    git(vaultRoot, [
      'clone',
      '--quiet',
      '--branch',
      `members/${MEMBER_ID}`,
      bareRepository,
      directPublisher,
    ]);
    await writeFile(path.join(directPublisher, 'blocked.md'), 'must not arrive\n');
    git(directPublisher, ['add', 'blocked.md']);
    git(directPublisher, ['commit', '--quiet', '-m', 'test: blocked receive']);
    const blockedPush = spawnSync(
      'git',
      ['push', 'origin', `HEAD:refs/heads/members/${MEMBER_ID}`],
      { cwd: directPublisher, encoding: 'utf8' },
    );
    expect(blockedPush.status).not.toBe(0);
    expect(blockedPush.stderr).toContain('Claudian Collab hosting is not active.');

    await expect(foundation.local.projects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      hostOwnership: { autoStart: true, ownsAuthority: true },
      member: { credential: MEMBER_CREDENTIAL, id: MEMBER_ID, role: 'manager' },
      project: { workspacePath: 'Shared/Collab Projects/alpha-notes' },
    });
    await expect(foundation.local.projects.loadIndex()).resolves.toMatchObject({
      projects: [expect.objectContaining({
        id: PROJECT_ID,
        workspacePath: 'Shared/Collab Projects/alpha-notes',
      })],
      selectedProjectId: PROJECT_ID,
    });
    const authority = await foundation.openAuthority(PROJECT_ID);
    await expect(authority.database.read(connection => ({
      managers: connection.all(`
        SELECT member_id FROM members
        WHERE role = 'manager' AND status = 'active'
        ORDER BY member_id
      `).map(row => row.member_id),
      project: authority.projects.get(connection),
    }))).resolves.toMatchObject({
      managers: [MEMBER_ID],
      project: {
        hostMemberId: MEMBER_ID,
        managerSetGeneration: 0,
        projectId: PROJECT_ID,
      },
    });
    expect((await readdir(path.join(vaultRoot, 'Shared', 'Collab Projects'))).sort())
      .toEqual([
        '.claudian-collab-root.json',
        '.gitignore',
        'alpha-notes',
      ]);
    expect(JSON.parse(await readFile(
      path.join(vaultRoot, 'Shared', 'Collab Projects', '.claudian-collab-root.json'),
      'utf8',
    ))).toEqual({ owner: 'claudian-collab-projects', schemaVersion: 1 });
    await foundation.close();
  });

  it('cancels between staging and the authority commit without committing or orphaning state', async () => {
    git(vaultRoot, ['init', '--quiet', '--initial-branch=main']);
    const foundation = createFoundation();
    const controller = new AbortController();
    const port: CollabProjectFoundationPort = {
      local: foundation.local,
      createAuthority: projectId => port.openAuthority(projectId),
      discardProvisionalAuthority: projectId => (
        foundation.discardProvisionalAuthority(projectId)
      ),
      inspectAuthority: projectId => foundation.inspectAuthority(projectId),
      openAuthority: async projectId => {
        controller.abort();
        return foundation.createAuthority(projectId);
      },
      requireGitFoundation: () => foundation.requireGitFoundation(),
    };
    const service = new CollabProjectSetupService(port, setupOptions(vaultRoot));

    await expect(service.createProject({
      memberDisplayName: 'Alice',
      name: 'Cancelled Mid Commit',
    }, { signal: controller.signal })).resolves.toEqual({
      durableProgress: false,
      operationId: OPERATION_ID,
      status: 'cancelled',
    });

    await expect(foundation.local.projects.loadIndex()).resolves.toMatchObject({
      projects: [],
    });
    await expect(foundation.local.projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      decodeCollabProjectSetupRecord,
    )).resolves.toBeNull();
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.join(vaultRoot, 'workspace'))).resolves.toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/^\.claudian-(?:clone|seed)-/u),
      ]),
    );
    expect((foundation as unknown as {
      authorityFoundations: Map<string, unknown>;
    }).authorityFoundations.size).toBe(0);
    await foundation.close();
  });

  it('preserves discoverable setup state when provisional authority cleanup fails', async () => {
    git(vaultRoot, ['init', '--quiet', '--initial-branch=main']);
    const foundation = createFoundation();
    const controller = new AbortController();
    const port: CollabProjectFoundationPort = {
      local: foundation.local,
      createAuthority: projectId => port.openAuthority(projectId),
      discardProvisionalAuthority: async () => {
        throw new Error('injected provisional authority cleanup failure');
      },
      inspectAuthority: projectId => foundation.inspectAuthority(projectId),
      openAuthority: async projectId => {
        controller.abort();
        return foundation.createAuthority(projectId);
      },
      requireGitFoundation: () => foundation.requireGitFoundation(),
    };
    const service = new CollabProjectSetupService(port, setupOptions(vaultRoot));

    await expect(service.createProject({
      memberDisplayName: 'Alice',
      name: 'Cleanup Failure',
    }, { signal: controller.signal })).resolves.toMatchObject({
      error: expect.objectContaining({
        safeContext: expect.objectContaining({ reason: 'project-setup-cleanup-failed' }),
      }),
      status: 'failure',
    });
    await expect(foundation.local.projects.loadIndex()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: PROJECT_ID })],
    });
    await expect(foundation.local.projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      decodeCollabProjectSetupRecord,
    )).resolves.toMatchObject({ operationId: OPERATION_ID });
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
    ))).resolves.toBeDefined();
    await expect(stat(path.join(
      vaultRoot,
      'workspace',
      `.claudian-seed-${PROJECT_ID}`,
    ))).resolves.toBeDefined();

    await expect(service.resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({
      status: 'success',
      value: { id: PROJECT_ID },
    });
    await expect(stat(path.join(vaultRoot, 'workspace', 'cleanup-failure')))
      .resolves.toBeDefined();
    await foundation.close();
  });

  it('cancels before any Projects-folder or durable setup state is written', async () => {
    const foundation = createFoundation();
    const service = new CollabProjectSetupService(foundation, setupOptions(vaultRoot));
    const controller = new AbortController();
    controller.abort();

    await expect(service.createProject({
      memberDisplayName: 'Alice',
      name: 'Cancelled',
    }, { signal: controller.signal })).resolves.toEqual({
      durableProgress: false,
      status: 'cancelled',
    });
    await expect(foundation.local.projects.loadIndex()).resolves.toMatchObject({
      projects: [],
      selectedProjectId: null,
    });
    await expect(stat(path.join(vaultRoot, 'workspace'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await foundation.close();
  });

  it('resumes committed setup in its captured folder after the live setting changes', async () => {
    let projectsFolder = 'Shared/First Projects';
    const controller = new AbortController();
    const firstFoundation = createFoundation(() => projectsFolder);
    let wrappedAuthority: CollabAuthorityFoundation | null = null;
    const abortingPort: CollabProjectFoundationPort = {
      local: firstFoundation.local,
      createAuthority: projectId => abortingPort.openAuthority(projectId),
      discardProvisionalAuthority: projectId => (
        firstFoundation.discardProvisionalAuthority(projectId)
      ),
      inspectAuthority: projectId => firstFoundation.inspectAuthority(projectId),
      openAuthority: async projectId => {
        const authority = await firstFoundation.createAuthority(projectId);
        if (wrappedAuthority) return wrappedAuthority;
        wrappedAuthority = {
          ...authority,
          database: Object.assign(Object.create(Object.getPrototypeOf(authority.database)), {
            mutate: async <T>(
              mutation: Parameters<typeof authority.database.mutate<T>>[0],
            ) => {
              const result = await authority.database.mutate(mutation);
              controller.abort();
              return result;
            },
            read: authority.database.read.bind(authority.database),
          }),
        };
        return wrappedAuthority;
      },
      requireGitFoundation: () => firstFoundation.requireGitFoundation(),
    };
    const interrupted = new CollabProjectSetupService(
      abortingPort,
      setupOptions(vaultRoot, () => projectsFolder),
    );

    await expect(interrupted.createProject({
      memberDisplayName: 'Alice',
      name: 'Alpha',
    }, { signal: controller.signal })).resolves.toMatchObject({
      durablePhase: 'committed',
      durableProgress: true,
      operationId: OPERATION_ID,
      status: 'recovery-required',
    });
    await firstFoundation.close();

    projectsFolder = 'Shared/Second Projects';
    const reopenedFoundation = createFoundation(() => projectsFolder);
    const resumed = new CollabProjectSetupService(
      reopenedFoundation,
      setupOptions(vaultRoot, () => projectsFolder),
    );
    await expect(resumed.resumeSetup({ operationId: OPERATION_ID })).resolves.toEqual({
      status: 'success',
      value: expect.objectContaining({
        id: PROJECT_ID,
        workspacePath: 'Shared/First Projects/alpha',
      }),
    });
    await expect(stat(path.join(vaultRoot, 'Shared', 'First Projects', 'alpha')))
      .resolves.toBeDefined();
    await expect(stat(path.join(vaultRoot, 'Shared', 'Second Projects')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await reopenedFoundation.close();
  });

  it('refuses ownerless version-1 clone recovery without rewriting durable state', async () => {
    const foundation = createFoundation();
    const service = new CollabProjectSetupService(foundation, setupOptions(vaultRoot));
    await expect(service.createProject({
      memberDisplayName: 'Alice',
      name: 'Legacy recovery',
    })).resolves.toMatchObject({ status: 'success' });

    const finalPath = path.join(vaultRoot, 'workspace', 'legacy-recovery');
    const legacyClonePath = path.join(
      vaultRoot,
      'workspace',
      `.claudian-clone-${PROJECT_ID}`,
    );
    const initialCommitOid = git(finalPath, ['rev-parse', 'HEAD']);
    await rename(finalPath, legacyClonePath);
    await writeFile(finalPath, 'temporary collision\n');
    await foundation.local.projects.saveProjectDocument(
      PROJECT_ID,
      'pending-operation',
      {
        cloneDirectoryName: `.claudian-clone-${PROJECT_ID}`,
        createdAt: CREATED_AT,
        initialCommitOid,
        memberCredential: MEMBER_CREDENTIAL,
        memberDisplayName: 'Alice',
        memberId: MEMBER_ID,
        name: 'Legacy recovery',
        operationId: OPERATION_ID,
        phase: 'committed',
        projectId: PROJECT_ID,
        schemaVersion: 1,
        seedDirectoryName: `.claudian-seed-${PROJECT_ID}`,
        slug: 'legacy-recovery',
        sourcePaths: [],
        updatedAt: CREATED_AT,
      },
    );

    await expect(service.resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({
      error: expect.objectContaining({
        code: 'durable-progress-recovery-required',
        safeContext: expect.objectContaining({
          reason: 'host-installation-recovery-owner-mismatch',
        }),
      }),
      status: 'failure',
    });
    await expect(foundation.local.projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      value => value as {
        legacySetupRecord?: true;
        projectId: string;
        schemaVersion: number;
      },
    )).resolves.toMatchObject({ schemaVersion: 1 });
    await expect(stat(finalPath)).resolves.toBeDefined();
    await expect(stat(legacyClonePath)).resolves.toBeDefined();
    await foundation.close();
  });

  it('fails a legacy planned import closed without touching source content', async () => {
    const foundation = createFoundation();
    await mkdir(path.join(vaultRoot, 'notes'));
    await writeFile(path.join(vaultRoot, 'notes', 'brief.md'), 'keep me\n');
    await foundation.local.workspace.claimProjectsFolder('workspace');
    await mkdir(path.join(vaultRoot, 'workspace', `.claudian-seed-${PROJECT_ID}`));
    const legacyRecord = {
      cloneDirectoryName: `.claudian-clone-${PROJECT_ID}`,
      createdAt: CREATED_AT,
      initialCommitOid: null,
      memberCredential: MEMBER_CREDENTIAL,
      memberDisplayName: 'Alice',
      memberId: MEMBER_ID,
      name: 'Legacy import',
      operationId: OPERATION_ID,
      phase: 'planned',
      projectId: PROJECT_ID,
      schemaVersion: 1,
      seedDirectoryName: `.claudian-seed-${PROJECT_ID}`,
      slug: 'legacy-import',
      sourcePaths: ['notes/brief.md'],
      updatedAt: CREATED_AT,
    } as const;
    await foundation.local.projects.upsertProject({
      authorityKind: 'lan',
      createdAt: CREATED_AT,
      id: PROJECT_ID,
      name: 'Legacy import',
      updatedAt: CREATED_AT,
      workspacePath: 'workspace/legacy-import',
    });
    await foundation.local.projects.saveProjectDocument(
      PROJECT_ID,
      'pending-operation',
      legacyRecord,
    );
    const service = new CollabProjectSetupService(foundation, setupOptions(vaultRoot));

    await expect(service.resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({
      error: expect.objectContaining({
        code: 'durable-progress-recovery-required',
        safeContext: expect.objectContaining({
          reason: 'host-installation-recovery-owner-mismatch',
        }),
      }),
      status: 'failure',
    });
    await expect(readFile(path.join(vaultRoot, 'notes', 'brief.md'), 'utf8'))
      .resolves.toBe('keep me\n');
    await expect(stat(path.join(vaultRoot, 'workspace', `.claudian-seed-${PROJECT_ID}`)))
      .resolves.toBeDefined();
    await expect(foundation.local.projects.loadIndex()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: PROJECT_ID })],
    });
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await foundation.close();
  });

  it('resumes a staged record with an already-aborted signal without committing', async () => {
    const foundation = createFoundation();
    await foundation.local.projects.upsertProject({
      authorityKind: 'lan',
      createdAt: CREATED_AT,
      id: PROJECT_ID,
      name: 'Staged',
      updatedAt: CREATED_AT,
      workspacePath: 'workspace/staged',
    });
    await foundation.local.projects.saveProjectDocument(PROJECT_ID, 'pending-operation', {
      cloneDirectoryName: `.claudian-clone-${PROJECT_ID}`,
      createdAt: CREATED_AT,
      initialCommitOid: '1'.repeat(40),
      memberCredential: MEMBER_CREDENTIAL,
      memberDisplayName: 'Alice',
      memberId: MEMBER_ID,
      name: 'Staged',
      operationId: OPERATION_ID,
      phase: 'staged',
      projectId: PROJECT_ID,
      projectsFolder: 'workspace',
      schemaVersion: 2,
      seedDirectoryName: `.claudian-seed-${PROJECT_ID}`,
      slug: 'staged',
      updatedAt: CREATED_AT,
    });
    const service = new CollabProjectSetupService(foundation, setupOptions(vaultRoot));
    const controller = new AbortController();
    controller.abort();

    await expect(service.resumeSetup(
      { operationId: OPERATION_ID },
      { signal: controller.signal },
    )).resolves.toEqual({
      durableProgress: false,
      status: 'cancelled',
    });
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(foundation.local.projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      decodeCollabProjectSetupRecord,
    )).resolves.toMatchObject({ operationId: OPERATION_ID });
    await foundation.close();
  });

  it('keeps recovery-required semantics when cancellation lands after the authority commit', async () => {
    git(vaultRoot, ['init', '--quiet', '--initial-branch=main']);
    const foundation = createFoundation();
    const controller = new AbortController();
    const port: CollabProjectFoundationPort = {
      local: foundation.local,
      createAuthority: projectId => port.openAuthority(projectId),
      discardProvisionalAuthority: projectId => (
        foundation.discardProvisionalAuthority(projectId)
      ),
      inspectAuthority: projectId => foundation.inspectAuthority(projectId),
      openAuthority: async projectId => {
        const authority = await foundation.createAuthority(projectId);
        return {
          ...authority,
          database: {
            mutate: mutation => {
              controller.abort();
              return authority.database.mutate(mutation);
            },
            read: reader => authority.database.read(reader),
          },
        };
      },
      requireGitFoundation: () => foundation.requireGitFoundation(),
    };
    const service = new CollabProjectSetupService(port, setupOptions(vaultRoot));

    await expect(service.createProject({
      memberDisplayName: 'Alice',
      name: 'Committed Then Cancelled',
    }, { signal: controller.signal })).resolves.toMatchObject({
      durablePhase: 'committed',
      durableProgress: true,
      status: 'recovery-required',
    });
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
    ))).resolves.toBeDefined();
    await expect(foundation.local.projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      decodeCollabProjectSetupRecord,
    )).resolves.toMatchObject({ operationId: OPERATION_ID });
    await foundation.close();
  });

  it('leaves no authority, index, or staging orphans after a pre-commit staging failure', async () => {
    git(vaultRoot, ['init', '--quiet', '--initial-branch=main']);
    const foundation = createFoundation();
    const port: CollabProjectFoundationPort = {
      local: foundation.local,
      createAuthority: projectId => port.openAuthority(projectId),
      discardProvisionalAuthority: projectId => (
        foundation.discardProvisionalAuthority(projectId)
      ),
      inspectAuthority: projectId => foundation.inspectAuthority(projectId),
      openAuthority: projectId => foundation.openAuthority(projectId),
      requireGitFoundation: () => Promise.reject(
        new Error('injected staging Git failure'),
      ),
    };
    const service = new CollabProjectSetupService(port, setupOptions(vaultRoot));

    await expect(service.createProject({
      memberDisplayName: 'Alice',
      name: 'Staging Failure',
    })).resolves.toMatchObject({ status: 'failure' });

    await expect(foundation.local.projects.loadIndex()).resolves.toMatchObject({
      projects: [],
    });
    await expect(foundation.local.projects.loadProjectDocument(
      PROJECT_ID,
      'pending-operation',
      decodeCollabProjectSetupRecord,
    )).resolves.toBeNull();
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.join(vaultRoot, 'workspace'))).resolves.toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/^\.claudian-(?:clone|seed)-/u),
      ]),
    );
    expect((foundation as unknown as {
      authorityFoundations: Map<string, unknown>;
    }).authorityFoundations.size).toBe(0);
    await foundation.close();
  });

  it('never cleans generated-looking children from an unowned captured root', async () => {
    const projectsFolder = 'Unowned Projects';
    const seedPath = path.join(vaultRoot, projectsFolder, `.claudian-seed-${PROJECT_ID}`);
    await mkdir(seedPath, { recursive: true });
    await writeFile(path.join(seedPath, 'keep.md'), 'user content\n');
    const foundation = createFoundation();
    const record = {
      cloneDirectoryName: `.claudian-clone-${PROJECT_ID}`,
      createdAt: CREATED_AT,
      initialCommitOid: null,
      memberCredential: MEMBER_CREDENTIAL,
      memberDisplayName: 'Alice',
      memberId: MEMBER_ID,
      name: 'Unsafe cleanup probe',
      operationId: OPERATION_ID,
      phase: 'planned',
      projectId: PROJECT_ID,
      projectsFolder,
      schemaVersion: 2,
      seedDirectoryName: `.claudian-seed-${PROJECT_ID}`,
      slug: 'unsafe-cleanup-probe',
      updatedAt: CREATED_AT,
    } as const;
    await foundation.local.projects.upsertProject({
      authorityKind: 'lan',
      createdAt: CREATED_AT,
      id: PROJECT_ID,
      name: record.name,
      updatedAt: CREATED_AT,
      workspacePath: `${projectsFolder}/${record.slug}`,
    });
    await foundation.local.projects.saveProjectDocument(
      PROJECT_ID,
      'pending-operation',
      record,
    );
    const service = new CollabProjectSetupService(foundation, setupOptions(vaultRoot));

    await expect(service.resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({
      error: expect.objectContaining({
        code: 'durable-progress-recovery-required',
        safeContext: expect.objectContaining({
          reason: 'host-installation-recovery-owner-mismatch',
        }),
      }),
      status: 'failure',
    });
    await expect(readFile(path.join(seedPath, 'keep.md'), 'utf8'))
      .resolves.toBe('user content\n');
    await foundation.close();
  });
});
