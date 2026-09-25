import { fork } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CREATED_AT, createFeatureFixture, createFixture, git, MEMBER_ID, OPERATION_ID, prepareCrashFixture, PROJECT_ID } from '@test/helpers/collab/CloudProjectEntryFixture';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { testTime } from '@test/helpers/testClock';

import { decodeManagerResponsibilityReceiptRecord } from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';
import { decodeCloudProjectEntryRecord } from '@/app/collab/project/CloudProjectEntryRecord';
import { decodeCloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';

jest.setTimeout(30_000);

describe('CloudProjectEntryCoordinator', () => {
  it.each(['create', 'join', 'existing'] as const)('does not claim durable %s progress when its initial intent write never commits', async entry => {
    const fixture = await createFixture({ join: entry !== 'create', alreadyBound: entry === 'existing' });
    const projects = fixture.foundation.local.projects;
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockRejectedValueOnce(Object.assign(new Error('Injected initial disk failure'), { code: 'ENOSPC' }));
    const start = () => entry === 'create' ? fixture.coordinator.createProject({
      authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
    }) : fixture.coordinator.joinProject({ invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes' });
    try {
      await expect(start()).resolves.toMatchObject({ status: 'failure', error: { code: 'operation-failed', recoveryActions: ['retry', 'open-diagnostics'] } });
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
      expect(fixture.admittedRequests).toEqual([]);
      expect(fixture.joinRequests).toEqual([]);
      cut.mockRestore();
      await expect(start()).resolves.toMatchObject({ status: 'success' });
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
    } finally { cut.mockRestore(); await fixture.close(); }
  });

  it.each(['unreadable', 'different'] as const)('does not claim a known durable intent when the failed initial write leaves %s state', async state => {
    const fixture = await createFixture();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const load = projects.loadProjectDocument.bind(projects);
    let writeFailed = false;
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementationOnce(async (...args) => {
      const value = state === 'different' ? { ...args[2], serverUrl: 'http://127.0.0.1:1/different' } : args[2];
      await save(args[0], args[1], value);
      writeFailed = true;
      throw new Error('Injected post-promotion failure');
    });
    const readCut = jest.spyOn(projects, 'loadProjectDocument').mockImplementation((...args) => {
      if (writeFailed && state === 'unreadable') return Promise.reject(new Error('Injected read failure'));
      return load(...args);
    });
    try {
      await expect(fixture.coordinator.createProject({ authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes' }))
        .resolves.toMatchObject({ status: 'failure', error: { code: 'operation-failed', recoveryActions: ['open-diagnostics'] } });
      cut.mockRestore();
      readCut.mockRestore();
      expect(await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ operationId: OPERATION_ID, phase: 'intent', serverUrl: state === 'different' ? 'http://127.0.0.1:1/different' : fixture.serverUrl });
      expect(fixture.admittedRequests).toEqual([]);
      expect(await projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
    } finally { cut.mockRestore(); readCut.mockRestore(); await fixture.close(); }
  });

  it('does not adopt a markerless current Cloud staging clone even when its Git identity matches', async () => {
    const fixture = await createFixture();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
      await save(...args);
      if (args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'clone-validated') throw new Error('Injected clone checkpoint cut');
    });
    try {
      await expect(fixture.coordinator.createProject({ authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes' }))
        .resolves.toMatchObject({ status: 'recovery-required' });
      cut.mockRestore();
      await fixture.foundation.local.workspace.releaseReservedProjectsFolderChild('Shared/Projects', {
        childName: `.claudian-clone-${PROJECT_ID}`, operationId: OPERATION_ID, projectId: PROJECT_ID, purpose: 'create-clone',
      });
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.loadMembership(PROJECT_ID)).toBeNull();
      expect((await lstat(path.join(fixture.vaultRoot, `Shared/Projects/.claudian-clone-${PROJECT_ID}`))).isDirectory()).toBe(true);
      await expect(lstat(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { cut.mockRestore(); await fixture.close(); }
  });

  it.each(['inspectProject', 'selectProject'] as const)('fences %s until a locally finalized Cloud entry completes recovery', async operation => {
    const fixture = await createFixture();
    fixture.failNextActivation();
    const feature = createFeatureFixture(fixture);
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord))
        .toMatchObject({ phase: 'locally-finalized' });
      const before = [...fixture.transportRequests];
      await expect(feature[operation](PROJECT_ID)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
      expect(fixture.transportRequests).toEqual(before);
      await expect(feature.listProjects()).resolves.toMatchObject({ status: 'success', value: [expect.objectContaining({ id: PROJECT_ID, health: 'needs-attention' })] });
      await expect(feature.listPendingSetupOperationIds()).resolves.toEqual([OPERATION_ID]);
      await expect(feature.resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
      await expect(feature[operation](PROJECT_ID)).resolves.toMatchObject({ status: 'success' });
    } finally { await feature.close(); await fixture.close(); }
  });

  it('preserves existing-identity entry recovery when cancellation follows local placement', async () => {
    const fixture = await createFixture({ join: true, alreadyBound: true });
    const controller = new AbortController();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
      await save(...args);
      if (args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'placed') controller.abort();
    });
    try {
      await expect(fixture.coordinator.joinProject({
        invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes',
      }, { signal: controller.signal })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ operationKind: 'cloud-existing-project', phase: 'placed' });
      cut.mockRestore();
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
      expect(fixture.joinRequests).toEqual([]);
    } finally { cut.mockRestore(); await fixture.close(); }
  });

  it('retains completed local facts when cancellation interrupts ordinary activation', async () => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    const controller = new AbortController();
    fixture.onSnapshot(async projectId => {
      const pending = await fixture.foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCloudProjectEntryRecord);
      if (pending?.phase === 'locally-finalized') controller.abort();
    });
    try {
      await expect(feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      }, { signal: controller.signal })).resolves.toMatchObject({ status: 'recovery-required' });
      const [projectId] = await fixture.foundation.local.projects.listPendingOperationProjectIds();
      expect(await fixture.foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ phase: 'locally-finalized' });
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['create', 'join'].flatMap(entry => ['intent', 'admitted', 'clone-validated', 'rename-before-checkpoint', 'placed', 'locally-finalized'].map(phase => ({ entry, phase }))))(
    'recovers $entry after actual process death at the durable $phase boundary', async ({ entry, phase }) => {
      const fixture = await createFixture({ join: entry === 'join' });
      const bundle = await prepareCrashFixture();
      const child = fork(bundle, [], {
        env: { ...process.env, NODE_PATH: path.resolve('node_modules') }, execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const durable = new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => reject(new Error(`Fixture exited before the durable cut: ${String(child.stderr?.read() ?? '').slice(0, 500)}`)));
          child.once('message', message => {
            if ((message as { type?: string; phase?: string }).type !== 'durable-cut'
              || (message as { phase?: string }).phase !== phase) reject(new Error('Unexpected crash fixture outcome'));
            else resolve();
          });
        });
        child.send({ phase, installationKey: TEST_INSTALLATION_A, operationId: OPERATION_ID, projectId: PROJECT_ID, serverUrl: fixture.serverUrl, vaultRoot: fixture.vaultRoot,
          ...(entry === 'join' ? { encodedInvitation: fixture.encodedInvitation } : {}),
        });
        await durable;
        expect(child.kill('SIGKILL')).toBe(true);
        await exited;
        expect(child.signalCode).toBe('SIGKILL');
        expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ phase: phase === 'rename-before-checkpoint' ? 'clone-validated' : phase });
        await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
        expect(entry === 'join' ? fixture.joinRequests : fixture.admittedRequests).toHaveLength(1);
        expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        await fixture.close();
      }
    },
  );

  it('does not resume entry past a competing durable lifecycle owner', async () => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    try {
      fixture.loseNextReply();
      const created = await feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      if (created.status !== 'recovery-required') throw created;
      const projects = fixture.foundation.local.projects;
      const [projectId] = await projects.listPendingOperationProjectIds();
      await projects.saveLifecycleProjectDocument(projectId, 'manager-responsibility-receipt', {
        schemaVersion: 2, kind: 'manager-responsibility-receipt', projectId, offerId: 'offer-conflicting',
        sourceManagerMemberId: 'member-other', targetMemberId: MEMBER_ID, purpose: 'manager-leave',
        status: 'acknowledged', offeredAt: CREATED_AT, expiresAt: testTime({ days: 5, minutes: 10 }),
        acknowledgedAt: CREATED_AT, updatedAt: CREATED_AT,
      }, decodeManagerResponsibilityReceiptRecord);
      await expect(feature.resumeSetup({ operationId: created.operationId })).resolves.toMatchObject({
        status: 'failure', error: { code: 'durable-progress-recovery-required', safeContext: { reason: 'lifecycle-owner-ambiguous' } },
      });
      expect(fixture.admittedRequests).toHaveLength(1);
      expect(await projects.listPendingOperationProjectIds()).toEqual([projectId]);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['occupied', 'symlink', 'foreign-staging'] as const)('preserves a %s boundary introduced after admission intent', async boundary => {
    const fixture = await createFixture();
    const folder = path.join(fixture.vaultRoot, 'Shared/Projects');
    const outside = path.join(fixture.vaultRoot, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.md'), 'Keep outside work\n');
    fixture.onCreate(async () => {
      if (boundary === 'occupied') {
        await mkdir(path.join(folder, 'cloud-notes'));
        await writeFile(path.join(folder, 'cloud-notes/keep.md'), 'Keep occupied work\n');
      } else if (boundary === 'symlink') {
        await symlink(outside, path.join(folder, 'cloud-notes'), 'junction');
      } else {
        await fixture.foundation.local.workspace.reserveProjectsFolderChild('Shared/Projects', {
          childName: `.claudian-clone-${PROJECT_ID}`, operationId: 'different-operation', projectId: PROJECT_ID, purpose: 'create-clone',
        });
        await mkdir(path.join(folder, `.claudian-clone-${PROJECT_ID}`));
        await writeFile(path.join(folder, `.claudian-clone-${PROJECT_ID}/keep.md`), 'Keep staging work\n');
      }
    });
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toBeNull();
      const protectedPath = boundary === 'foreign-staging' ? `.claudian-clone-${PROJECT_ID}/keep.md` : 'cloud-notes/keep.md';
      expect(await readFile(path.join(folder, protectedPath), 'utf8')).toBe(
        boundary === 'foreign-staging' ? 'Keep staging work\n' : boundary === 'occupied' ? 'Keep occupied work\n' : 'Keep outside work\n',
      );
      expect(await readFile(path.join(outside, 'keep.md'), 'utf8')).toBe('Keep outside work\n');
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
    } finally { await fixture.close(); }
  });

  it.each([
    { schemaVersion: 0 }, { phase: 'unknown' }, { serverUrl: 'http://host.invalid/?secret=not-allowed' },
    { stagingDirectoryName: '../foreign' }, { ownerInstallationKey: TEST_INSTALLATION_A },
  ])('leaves corrupt current-only recovery evidence untouched (%j)', async corruption => {
    const fixture = await createFixture();
    try {
      fixture.loseNextReply();
      await fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      const documentPath = path.join(fixture.vaultRoot, `.claudian/collab/projects/${PROJECT_ID}/pending-operation.json`);
      const original = JSON.parse(await readFile(documentPath, 'utf8'));
      const corrupt = JSON.stringify({ ...original, ...corruption });
      await writeFile(documentPath, corrupt);
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'failure', error: { code: 'durable-progress-recovery-required' } });
      expect(await readFile(documentPath, 'utf8')).toBe(corrupt);
      expect(fixture.admittedRequests).toHaveLength(1);
      expect((await lstat(documentPath)).isFile()).toBe(true);
    } finally { await fixture.close(); }
  });

  it.each(['membership', 'publication-state', 'index'] as const)('does not activate a finalized entry whose %s is no longer complete', async missing => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    const cut = jest.spyOn(projects, 'removeProjectDocument').mockRejectedValueOnce(new Error('Injected pending-removal cut'));
    try {
      const created = await feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      expect(created).toMatchObject({ status: 'recovery-required' });
      if (created.status !== 'recovery-required') throw created;
      cut.mockRestore();
      const [projectId] = await projects.listPendingOperationProjectIds();
      if (missing === 'index') {
        const current = await projects.loadIndex();
        await writeFile(path.join(fixture.vaultRoot, '.claudian/collab/index.json'), JSON.stringify({ ...current, projects: [], selectedProjectId: null }));
      } else {
        await rm(path.join(fixture.vaultRoot, `.claudian/collab/projects/${projectId}/${missing}.json`));
      }
      await expect(feature.resumeSetup({ operationId: created.operationId })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.listPendingOperationProjectIds()).toEqual([projectId]);
    } finally { cut.mockRestore(); await feature.close(); await fixture.close(); }
  });

  it('rejects a foreign local Project identity after a rename-before-checkpoint interruption', async () => {
    const fixture = await createFixture();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
      await save(...args);
      if ((args[2] as { phase?: string }).phase === 'clone-validated') throw new Error('Injected clone checkpoint interruption');
    });
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required' });
      cut.mockRestore();
      const folder = path.join(fixture.vaultRoot, 'Shared/Projects');
      const destination = path.join(folder, 'cloud-notes');
      await rename(path.join(folder, `.claudian-clone-${PROJECT_ID}`), destination);
      await git(destination, ['config', '--local', 'claudian.projectId', 'project-foreign']);
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(await git(destination, ['config', '--local', '--get', 'claudian.projectId'])).toBe('project-foreign');
      expect(await projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
    } finally { cut.mockRestore(); await fixture.close(); }
  });

  it('keeps ordinary feature admission closed while local finalization is incomplete', async () => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    const save = fixture.foundation.local.projects.saveMembership.bind(fixture.foundation.local.projects);
    const cut = jest.spyOn(fixture.foundation.local.projects, 'saveMembership').mockImplementationOnce(async membership => {
      await save(membership);
      throw new Error('Injected finalization interruption');
    });
    try {
      const created = await feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      expect(created).toMatchObject({ status: 'recovery-required' });
      if (created.status !== 'recovery-required') throw created;
      const [projectId] = await fixture.foundation.local.projects.listPendingOperationProjectIds();
      expect(await feature.listPendingSetupOperationIds()).toEqual([created.operationId]);
      await expect(feature.readSnapshot(projectId)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
      await expect(feature.resumeSetup({ operationId: created.operationId })).resolves.toMatchObject({ status: 'success' });
      await expect(feature.readSnapshot(projectId)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.failures).toEqual([]);
    } finally {
      cut.mockRestore();
      await feature.close();
      await fixture.close();
    }
  });

  it.each(['create', 'join'].flatMap(entry => ['intent', 'admitted', 'clone-validated', 'placed', 'locally-finalized', 'membership', 'publication', 'index'].map(cut => ({ entry, cut }))))(
    'resumes the same $entry after a durable $cut write without resetting publication progress', async ({ entry, cut }) => {
      const fixture = await createFixture({ join: entry === 'join' });
      const projects = fixture.foundation.local.projects;
      let interrupted = false;
      const interrupt = (point: string) => {
        if (!interrupted && point === cut) { interrupted = true; throw new Error('Injected durable cut'); }
      };
      const saveDocument = projects.saveProjectDocument.bind(projects);
      const saveMembership = projects.saveMembership.bind(projects);
      const upsert = projects.upsertProject.bind(projects);
      const spies = [
        jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
          await saveDocument(...args);
          interrupt(args[1] === 'publication-state' ? 'publication' : (args[2] as { phase?: string }).phase ?? 'other');
        }),
        jest.spyOn(projects, 'saveMembership').mockImplementation(async membership => { await saveMembership(membership); interrupt('membership'); }),
        jest.spyOn(projects, 'upsertProject').mockImplementation(async project => { await upsert(project); interrupt('index'); }),
      ];
      try {
        await expect(entry === 'join' ? fixture.coordinator.joinProject({
          invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob',
        }) : fixture.coordinator.createProject({
          authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
        })).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
        expect(interrupted).toBe(true);
        const pending = await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord);
        expect(pending?.operationId).toBe(OPERATION_ID);
        spies.forEach(spy => spy.mockRestore());
        const publication = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
        if (publication) {
          await projects.saveProjectDocument(PROJECT_ID, 'publication-state', {
            ...publication, updatedAt: testTime({ days: 5, hours: 1 }),
          });
          await writeFile(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes/local.md'), 'Preserved after partial finalization\n');
        }
        const before = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
        const resumed = await fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID });
        if (resumed.status !== 'success') throw resumed;
        expect(entry === 'join' ? fixture.joinRequests : fixture.admittedRequests).toHaveLength(1);
        expect(await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(before ?? {
          baseMainOid: fixture.mainOid, operation: null, projectId: PROJECT_ID, schemaVersion: 1, updatedAt: CREATED_AT,
        });
        const localContent = await readFile(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes/local.md'), 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        expect(localContent).toBe(before ? 'Preserved after partial finalization\n' : null);
        expect(await projects.listPendingOperationProjectIds()).toEqual([]);
        expect(fixture.failures).toEqual([]);
      } finally {
        spies.forEach(spy => spy.mockRestore());
        await fixture.close();
      }
    },
  );

  it('preserves a surviving working tree and publication operation when activation must be retried', async () => {
    const fixture = await createFixture();
    try {
      fixture.failNextActivation();
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required' });
      const workingCopy = path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes');
      await writeFile(path.join(workingCopy, 'local.md'), 'Unsaved local work\n');
      const publication = {
        baseMainOid: fixture.mainOid,
        operation: { contributionHeadOid: fixture.mainOid, createdAt: CREATED_AT, operationId: 'publish-existing', phase: 'captured', updatedAt: CREATED_AT, candidateOid: null, currentMainOid: null },
        projectId: PROJECT_ID, schemaVersion: 1, updatedAt: CREATED_AT,
      };
      await fixture.foundation.local.projects.saveProjectDocument(PROJECT_ID, 'publication-state', publication);
      const resumed = await fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID });
      expect(resumed).toMatchObject({ status: 'success' });
      expect(await readFile(path.join(workingCopy, 'local.md'), 'utf8')).toBe('Unsaved local work\n');
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(publication);
    } finally { await fixture.close(); }
  });
});
