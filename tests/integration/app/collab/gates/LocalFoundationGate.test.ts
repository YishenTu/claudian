import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import initSqlJs, { type SqlJsStatic } from 'sql.js';

import {
  ClaudianCollabService,
  type CollabAuthorityFoundation,
} from '@/app/collab';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import type { GitRuntimeResolution } from '@/app/collab/git/GitRuntimeResolver';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

jest.setTimeout(30_000);

describe('G2 local foundation gate', () => {
  let SQL: SqlJsStatic;
  let vaultRoot: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-local-foundation-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('constructs without scanning Git, touching SQL, or creating Vault state', async () => {
    const resolution: GitRuntimeResolution = { reason: 'not-found', status: 'missing' };
    const gitRuntimeResolver = {
      resolve: jest.fn().mockResolvedValue(resolution),
      rescan: jest.fn().mockResolvedValue(resolution),
    };
    const createAuthorityDatabase = jest.fn();

    const service = new ClaudianCollabService({
      createAuthorityDatabase,
      getConfiguredGitPath: () => '',
      getEnvironment: () => ({ Path: '/custom/native/bin' }),
      gitRuntimeResolver,
      obsidianConfigDirectory: '.obsidian-custom',
      vaultRoot,
    });

    expect(gitRuntimeResolver.resolve).not.toHaveBeenCalled();
    expect(createAuthorityDatabase).not.toHaveBeenCalled();
    expect(service.local.pathPolicy.validateRepositoryPath(
      '.obsidian-custom/settings.json',
    )).toMatchObject({ ok: false });
    await expect(readFile(path.join(vaultRoot, '.claudian', 'collab', '.gitignore')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await expect(service.resolveGitRuntime()).resolves.toEqual(resolution);
    expect(gitRuntimeResolver.resolve).toHaveBeenCalledTimes(1);
    expect(gitRuntimeResolver.resolve).toHaveBeenCalledWith({
      configuredPath: '',
      pathEnvironment: '/custom/native/bin',
    });
    expect(createAuthorityDatabase).not.toHaveBeenCalled();
    await service.close();
  });

  it('composes real local, Git, and recoverable SQL foundations for L4', async () => {
    const createAuthorityDatabase = (authorityDirectory: string) => (
      new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL })
    );
    const service = new ClaudianCollabService({
      createAuthorityDatabase,
      getConfiguredGitPath: () => '',
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });

    await service.local.workspace.ensureWorkspaceContainer();
    const git = await service.requireGitFoundation();
    const repositoryPath = path.join(vaultRoot, 'workspace', 'seed');
    await mkdir(repositoryPath);
    await git.repositories.initializeWorkingRepository(repositoryPath);
    await git.repositories.configureLocalRepository(repositoryPath, {
      memberId: 'member-host',
      personalRef: 'refs/heads/members/member-host',
      projectId: 'project-alpha',
      userDisplayName: 'Host',
    });
    await git.repositories.stageAll(repositoryPath);
    await expect(git.repositories.createCommitFromIndex(repositoryPath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    })).resolves.toMatch(/^[0-9a-f]{40,64}$/);

    const authority: CollabAuthorityFoundation = await service.openAuthority('project-alpha');
    const bareRepositoryPath = path.join(authority.authorityDirectory, 'repository.git');
    await mkdir(bareRepositoryPath);
    await git.repositories.initializeBareRepository(bareRepositoryPath);
    await git.repositories.createRef(
      repositoryPath,
      'refs/heads/members/member-host',
      (await git.repositories.resolveRef(repositoryPath, 'refs/heads/main'))!,
    );
    await git.repositories.addRemote(repositoryPath, 'origin', bareRepositoryPath);
    await git.repositories.push(
      repositoryPath,
      'origin',
      'refs/heads/main:refs/heads/main',
    );
    await git.repositories.push(
      repositoryPath,
      'origin',
      'refs/heads/members/member-host:refs/heads/members/member-host',
    );
    await authority.database.mutate(connection => {
      authority.projects.initialize(connection, {
        createdAt: CREATED_AT,
        hostCredentialHash: new Uint8Array(32).fill(4),
        hostDisplayName: 'Host',
        hostMemberId: 'member-host',
        name: 'Alpha',
        projectId: 'project-alpha',
      });
      authority.events.append(connection, {
        actorMemberId: 'member-host',
        createdAt: CREATED_AT,
        kind: 'project.created',
        payload: { projectId: 'project-alpha' },
      });
    });
    expect(await authority.database.read(connection => (
      authority.projects.get(connection)?.snapshotGeneration
    ))).toBe(1);
    const clonePath = await git.repositories.cloneRepository({
      branch: 'members/member-host',
      directoryName: 'project-alpha',
      parentDirectory: path.join(vaultRoot, 'workspace'),
      remoteUrl: bareRepositoryPath,
    });
    expect(await git.repositories.resolveRef(
      clonePath,
      'refs/heads/members/member-host',
    )).toMatch(/^[0-9a-f]{40,64}$/);
    await service.close();

    const reopenedService = new ClaudianCollabService({
      createAuthorityDatabase,
      getConfiguredGitPath: () => git.runtime.executablePath,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
    const [firstOpen, concurrentOpen] = await Promise.all([
      reopenedService.openAuthority('project-alpha'),
      reopenedService.openAuthority('project-alpha'),
    ]);
    expect(concurrentOpen).toBe(firstOpen);
    expect(await firstOpen.database.read(connection => (
      firstOpen.events.listAfter(connection, 0, 10)
    ))).toEqual([
      expect.objectContaining({ kind: 'project.created', sequence: 1 }),
    ]);
    expect(await readFile(
      path.join(vaultRoot, '.claudian', 'collab', '.gitignore'),
      'utf8',
    )).toContain('/*');
    await reopenedService.close();
  });

  it('maps missing and incompatible Git into stable setup errors', async () => {
    const cases: ReadonlyArray<{
      resolution: GitRuntimeResolution;
      code: string;
    }> = [
      {
        code: 'git-not-found',
        resolution: { reason: 'not-found', status: 'missing' },
      },
      {
        code: 'git-version-unsupported',
        resolution: {
          minimumVersion: '2.38.0',
          missingCapabilities: [],
          source: 'configured',
          status: 'incompatible',
          version: '2.37.0',
        },
      },
      {
        code: 'git-capability-missing',
        resolution: {
          minimumVersion: '2.38.0',
          missingCapabilities: ['http-backend'],
          source: 'path',
          status: 'incompatible',
          version: '2.50.0',
        },
      },
    ];

    for (const testCase of cases) {
      const service = new ClaudianCollabService({
        getConfiguredGitPath: () => '',
        gitRuntimeResolver: {
          resolve: async () => testCase.resolution,
          rescan: async () => testCase.resolution,
        },
        obsidianConfigDirectory: '.obsidian',
        vaultRoot,
      });
      await expect(service.requireGitFoundation()).rejects.toMatchObject({
        code: testCase.code,
      });
      await service.close();
    }
  });
});
