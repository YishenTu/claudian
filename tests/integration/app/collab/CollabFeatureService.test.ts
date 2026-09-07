import type * as FileSystem from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  completeCollabFeatureOptions,
  completeCollabPublicationOptions,
} from '@test/helpers/collab/CollabFeatureTestHarness';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CollabPublicationService } from '@/app/collab/publish/CollabPublicationService';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREATED_AT = '2026-09-07T00:00:00.000Z';
const PERSONAL_REF = 'refs/heads/members/member-alice';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}

jest.setTimeout(60_000);

describe('CollabFeatureService selection ordering', () => {
  let vaultRoot: string;
  let foundation: ClaudianCollabService;
  let service: CollabFeatureService;
  let betaRequested: ReturnType<typeof deferred>;
  let releaseBeta: ReturnType<typeof deferred>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'collab-project-selection-'));
    foundation = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
    await foundation.local.workspace.ensureWorkspaceContainer();
    const git = await foundation.requireGitFoundation();
    for (const name of ['alpha', 'beta']) {
      const projectId = `project-${name}`;
      const workspacePath = `workspace/${name}`;
      const repositoryPath = path.join(vaultRoot, workspacePath);
      const serverUrl = `https://${name}.example.test`;
      const gitRemoteUrl = `${serverUrl}/v6/projects/${projectId}/repository.git`;
      await mkdir(repositoryPath);
      await git.repositories.initializeWorkingRepository(repositoryPath);
      await git.repositories.configureLocalRepository(repositoryPath, {
        memberId: 'member-alice',
        personalRef: PERSONAL_REF,
        projectId,
        userDisplayName: 'Alice',
      });
      const mainOid = await git.repositories.createCommitFromIndex(repositoryPath, {
        expectedRefOid: null,
        message: 'Initial Project',
        parents: [],
        ref: PERSONAL_REF,
      });
      await git.runner.run({ args: ['symbolic-ref', 'HEAD', PERSONAL_REF], cwd: repositoryPath });
      await git.repositories.createRef(repositoryPath, 'refs/remotes/origin/main', mainOid);
      await git.repositories.addRemote(repositoryPath, 'origin', gitRemoteUrl);
      await foundation.local.projects.saveMembership({
        authority: { authorityGeneration: 1, bindingVersion: 6, gitRemoteUrl, kind: 'cloud', serverUrl, wireVersion: 10 },
        createdAt: CREATED_AT,
        lastEventSequence: 0,
        lifecycle: 'active',
        member: { displayName: 'Alice', id: 'member-alice', personalRef: PERSONAL_REF, role: 'manager' },
        project: { id: projectId, name, workspacePath },
        schemaVersion: 3,
        updatedAt: CREATED_AT,
      });
      await foundation.local.projects.upsertProject({
        authorityKind: 'cloud',
        createdAt: CREATED_AT,
        id: projectId,
        lifecycle: 'active',
        name,
        updatedAt: CREATED_AT,
        workspacePath,
      });
      await new CollabPublicationStateStore(foundation.local.projects).save({
        baseMainOid: mainOid,
        operation: null,
        projectId,
        schemaVersion: 1,
        updatedAt: CREATED_AT,
      });
      await new CloudProjectCredentialStore(vaultRoot).getOrCreate(projectId);
    }
    await foundation.local.projects.selectProject('project-alpha');
    betaRequested = deferred();
    releaseBeta = deferred();
    const cloudAuthority = new CloudAuthorityAdapter(vaultRoot, {
      request: async input => {
        if (new URL(input.url).hostname === 'beta.example.test') {
          betaRequested.resolve();
          await releaseBeta.promise;
        }
        throw new CollabError({ code: 'endpoint-unreachable' });
      },
    });
    const publication = new CollabPublicationService(foundation, completeCollabPublicationOptions({
      cloudAuthority,
      vaultRoot,
    }));
    service = new CollabFeatureService(
      foundation,
      new CollabProjectSetupService(foundation, { installationKey: TEST_INSTALLATION_A, vaultRoot }),
      { ...completeCollabFeatureOptions({ vaultRoot }), publication },
    );
    const initialized = await service.initialize();
    if (initialized.status !== 'success') throw new Error('Feature initialization failed');
  });

  afterEach(async () => {
    releaseBeta?.resolve();
    await service?.close();
    await foundation?.close();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('keeps the newer committed selection after an older inspection settles', async () => {
    const older = service.selectProject('project-beta');
    await Promise.race([
      betaRequested.promise,
      older.then(result => {
        throw new Error(`Selection settled before reaching the endpoint: ${result.status}`);
      }),
    ]);
    await expect(service.selectProject('project-alpha')).resolves.toMatchObject({ status: 'success' });
    expect((await foundation.local.projects.loadIndex()).selectedProjectId).toBe('project-alpha');
    expect(service.state.selectedProjectId).toBe('project-alpha');

    releaseBeta.resolve();
    await expect(older).resolves.toMatchObject({ status: 'cancelled' });

    expect((await foundation.local.projects.loadIndex()).selectedProjectId).toBe('project-alpha');
    expect(service.state.selectedProjectId).toBe('project-alpha');
  });

  it.each(['missing', 'cancelled', 'persistence-failed'] as const)(
    'publishes the committed selection when the newer request is %s',
    async failure => {
      const older = service.selectProject('project-beta');
      await betaRequested.promise;
      const filesystem = jest.requireActual<typeof FileSystem>('node:fs/promises');
      const rename = filesystem.rename;
      const indexFile = path.join(vaultRoot, '.claudian/collab/index.json');
      const fault = jest.spyOn(filesystem, 'rename').mockImplementation(async (...args) => {
        if (failure === 'persistence-failed' && args[1] === indexFile) {
          throw Object.assign(new Error('Injected index write failure'), { code: 'EIO' });
        }
        return rename(...args);
      });
      try {
        const controller = new AbortController();
        if (failure === 'cancelled') controller.abort();
        await expect(service.selectProject(
          failure === 'missing' ? 'project-missing' : 'project-alpha',
          { signal: controller.signal },
        )).resolves.toMatchObject({ status: failure === 'cancelled' ? 'cancelled' : 'failure' });
      } finally {
        fault.mockRestore();
      }
      releaseBeta.resolve();
      await expect(older).resolves.toMatchObject({ status: 'success' });
      expect((await foundation.local.projects.loadIndex()).selectedProjectId).toBe('project-beta');
      expect(service.state.selectedProjectId).toBe('project-beta');
    },
  );

  it('does not persist an older selection whose filesystem preflight finishes last', async () => {
    const filesystem = jest.requireActual<typeof FileSystem>('node:fs/promises');
    const lstat = filesystem.lstat;
    const preflightStarted = deferred();
    const continuePreflight = deferred();
    let delayed = false;
    const fault = jest.spyOn(filesystem, 'lstat').mockImplementation(async (...args) => {
      const result = await lstat(...args);
      if (!delayed && args[0] === path.join(vaultRoot, 'workspace/beta/.git')) {
        delayed = true;
        preflightStarted.resolve();
        await continuePreflight.promise;
      }
      return result;
    });
    try {
      const older = service.selectProject('project-beta');
      await preflightStarted.promise;
      await expect(service.selectProject('project-alpha')).resolves.toMatchObject({ status: 'success' });
      continuePreflight.resolve();
      await expect(older).resolves.toMatchObject({ status: 'cancelled' });
      expect((await foundation.local.projects.loadIndex()).selectedProjectId).toBe('project-alpha');
      expect(service.state.selectedProjectId).toBe('project-alpha');
    } finally {
      continuePreflight.resolve();
      fault.mockRestore();
    }
  });
});
