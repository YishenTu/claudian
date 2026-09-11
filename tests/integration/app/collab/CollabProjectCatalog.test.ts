import type * as FileSystem from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_CHECKPOINT_ARTIFACT_LIMITS, COLLAB_LIMITS, collabCloudCapabilityDocument, collabCloudSuccessEnvelope } from '@claudian-collab/protocol';
import { completeCollabFeatureOptions, completeCollabPublicationOptions } from '@test/helpers/collab/CollabFeatureTestHarness';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { CollabProjectCatalog } from '@/app/collab/CollabProjectCatalog';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CollabPublicationService } from '@/app/collab/publish/CollabPublicationService';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';
import { CloudAuthorityAdapter, CloudProjectEventClient, type CloudProjectEventSocket } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';
import { CollabError } from '@/core/collab/ClaudianCollabError';
const CREATED_AT = '2026-09-07T00:00:00.000Z';
const PERSONAL_REF = 'refs/heads/members/member-alice';
class Socket implements CloudProjectEventSocket {
  constructor(readonly projectId: string) {}
  listener?: (data: string) => void;
  closed = false;
  close(_code: number, _reason: string): void { this.closed = true; }
  onClose(_listener: (code: number) => void): void {}
  onError(_listener: () => void): void {}
  onOpen(listener: () => void): void { queueMicrotask(listener); }
  onMessage(listener: (data: string) => void): void {
    this.listener = listener;
  }
  snapshotRequired(sequence: number): void {
    this.listener?.(JSON.stringify({ kind: 'snapshot.required', latestSequence: sequence }));
  }
}
const limits = {
  maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
  maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
  maxCheckpointRepositoryBundleBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
  maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
  maxDevelopmentBootstrapGitBundleBytes: 1024, maxDevelopmentBootstrapManifestUtf8Bytes: 1024,
  maxDevelopmentBootstrapReportUtf8Bytes: 1024, maxEventReplay: 100,
  maxGitReceivePackBytes: 1024, maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
  maxRepositoryBytes: 1024,
};
async function bounded<T>(promise: Promise<T>, reason: string): Promise<T> {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(reason)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

interface Fixture {
  readonly service: CollabFeatureService;
  readonly foundation: ClaudianCollabService;
  readonly publication: CollabPublicationService;
  readonly sockets: Socket[];
  networkRequestCount(): number;
  advance(projectId: string, mainOid?: string): void;
  enableNetwork(): void;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>, initialize = true): Promise<void> {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'collab-coordination-refresh-'));
  let foundation!: ClaudianCollabService;
  let service: CollabFeatureService | undefined;
  const mainOids = new Map<string, string>();
  let enabled = false;
  let networkRequests = 0;
  const sequences = new Map<string, number>();
  const sockets: Socket[] = [];
  try {
    foundation = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
    await foundation.local.workspace.ensureWorkspaceContainer();
    const git = await foundation.requireGitFoundation();
    for (const name of ['alpha', 'beta', 'gamma']) {
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
      mainOids.set(projectId, mainOid);
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
    await foundation.local.projects.selectProject('project-beta');

    const cloudAuthority = new CloudAuthorityAdapter(vaultRoot, {
      createEventClient: (input, invalidation) => new CloudProjectEventClient(input, invalidation, { createSocket: () => { const socket = new Socket(input.projectId); sockets.push(socket); return socket; } }),
      request: async input => {
        networkRequests += 1;
        if (!enabled) throw new CollabError({ code: 'endpoint-unreachable' });
        const projectId = input.url.includes('beta.example.test') ? 'project-beta' : 'project-alpha';
        const currentMember = { activatedAt: CREATED_AT, createdAt: CREATED_AT, displayName: 'Alice', id: 'member-alice', personalRef: PERSONAL_REF, role: 'member', status: 'active' };
        return {
          body: input.method === 'GET' ? collabCloudCapabilityDocument(['project-events', 'project-snapshot'], limits) : collabCloudSuccessEnvelope(
            (input.body as { requestId: string }).requestId,
            { currentMember, eventSequence: sequences.get(projectId) ?? 2, members: [currentMember], openRequests: [], openTicketCount: 0,
              project: { authorityGeneration: 1, createdAt: CREATED_AT, expectedMainOid: mainOids.get(projectId), id: projectId, mainRef: 'refs/heads/main', name: 'alpha' }, ticketHighlights: [] },
          ),
          contentType: 'application/json', status: 200,
        };
      },
    });
    const publication = new CollabPublicationService(foundation, completeCollabPublicationOptions({ cloudAuthority, vaultRoot }));
    service = new CollabFeatureService(foundation, new CollabProjectSetupService(foundation, { installationKey: TEST_INSTALLATION_A, vaultRoot }), { ...completeCollabFeatureOptions({ vaultRoot }), publication });
    if (initialize) expect((await service.initialize()).status).toBe('success');
    await new Promise<void>(resolve => setImmediate(resolve));
    await run({ service, foundation, publication, sockets, networkRequestCount: () => networkRequests,
      advance: (projectId, mainOid) => { if (mainOid) mainOids.set(projectId, mainOid); const sequence = (sequences.get(projectId) ?? 2) + 1; sequences.set(projectId, sequence); sockets.find(socket => !socket.closed && socket.projectId === projectId)?.snapshotRequired(sequence); },
      enableNetwork: () => { enabled = true; } });
  } finally {
    await service?.close();
    await foundation?.close();
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

jest.setTimeout(60000);

it('does not publish catalog notifications for unchanged queries', async () => {
  await withFixture(async ({ service }) => {
    const listener = jest.fn();
    const subscription = service.subscribe(listener);
    listener.mockClear();
    await service.listProjects();
    await service.readProjectSelection();
    await service.listProjects();
    expect(listener).not.toHaveBeenCalled();
    subscription.dispose();
  });
});

it('keeps the catalog and inspection coherent with an accepted demotion during selection', async () => {
  await withFixture(async ({ service, foundation, enableNetwork }) => {
    enableNetwork();
    const selected = await service.selectProject('project-alpha');
    expect(selected.status).toBe('success');
    const inspected = await service.inspectProject('project-alpha');
    expect(inspected).toMatchObject({ status: 'success', value: {
      project: { id: 'project-alpha', role: 'member' },
      coordination: { snapshot: { currentMember: { role: 'member' } } },
    } });
    expect((await foundation.local.projects.loadMembership('project-alpha'))?.member.role).toBe('member');
    let accepted!: () => void;
    const published = new Promise<void>(resolve => { accepted = resolve; });
    const subscription = service.subscribe(state => {
      if (state.projects.find(project => project.id === 'project-alpha')?.role === 'member') accepted();
    });
    try { await bounded(published, 'Accepted membership was not published'); }
    finally { subscription.dispose(); }
    expect(service.state.projects.find(project => project.id === 'project-alpha')?.role).toBe('member');
  });
});


it('retains maintenance when refresh adopts a durably selected Project', async () => {
  await withFixture(async ({ service, foundation, sockets, enableNetwork }) => {
    enableNetwork();
    await foundation.local.projects.selectProject('project-alpha');
    await service.refreshLifecycleProjection();
    expect(service.state.selectedProjectId).toBe('project-alpha');
    let ready!: () => void;
    const initial = new Promise<void>(resolve => { ready = resolve; });
    const observation = service.observeProject('project-alpha', snapshot => {
      if (snapshot) ready();
    });
    await bounded(initial, 'Selected Project observation did not start');
    await new Promise<void>(resolve => setImmediate(resolve));
    observation.dispose();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sockets.find(socket => socket.projectId === 'project-alpha')?.closed).toBe(false);
  });
});

it('does not retain event demand after a one-shot coordination read', async () => {
  await withFixture(async ({ publication, sockets, enableNetwork }) => {
    enableNetwork();
    await publication.readCoordinationSnapshot('project-alpha');
    expect(sockets).toHaveLength(0);
  }, false);
});


it('delivers unselected Project changes to its observers and releases only their own demand', async () => {
  await withFixture(async ({ service, publication, sockets, enableNetwork, advance }) => {
    enableNetwork();
    const first: number[] = [];
    const second: number[] = [];
    const beta: number[] = [];
    let ready!: () => void;
    const initial = new Promise<void>(resolve => { ready = resolve; });
    let betaReady!: () => void;
    const betaConnected = new Promise<void>(resolve => { betaReady = resolve; });
    const one = service.observeProject('project-alpha', snapshot => {
      if (snapshot) first.push(snapshot.snapshot.eventSequence);
    });
    const two = service.observeProject('project-alpha', snapshot => {
      if (snapshot) second.push(snapshot.snapshot.eventSequence);
      if (snapshot?.snapshot.eventSequence === 2) ready();
    });
    const other = service.observeProject('project-beta', snapshot => {
      if (snapshot) beta.push(snapshot.snapshot.eventSequence);
      if (snapshot && publication.readConnectionStatus('project-beta') === 'connected') betaReady();
    });
    try {
      await bounded(Promise.all([initial, betaConnected]), 'Project observations did not start');
      await publication.readCoordinationSnapshot('project-beta');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(service.state.selectedProjectId).toBe('project-beta');
      expect(first).toContain(2);
      expect(second).toContain(2);
      const betaBefore = [...beta];
      one.dispose();
      first.length = 0;
      let changed!: () => void;
      const change = new Promise<void>(resolve => { changed = resolve; });
      const completion = service.observeProject('project-alpha', snapshot => {
        if (snapshot?.snapshot.eventSequence === 3) changed();
      });
      advance('project-alpha');
      await bounded(change, 'Unselected Alpha change was not delivered');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(first).toEqual([]);
      expect(second).toContain(3);
      expect(beta).toEqual(betaBefore);
      completion.dispose();
      expect(sockets.filter(socket => socket.projectId === 'project-alpha')).toHaveLength(1);
      expect(sockets.find(socket => socket.projectId === 'project-alpha')?.closed).toBe(false);
      two.dispose();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sockets.find(socket => socket.projectId === 'project-alpha')?.closed).toBe(true);
      expect(sockets.find(socket => socket.projectId === 'project-beta')?.closed).toBe(false);
    } finally { one.dispose(); two.dispose(); other.dispose(); }
  });
});


it('resumes live observation after a Project suspension without reopening its view', async () => {
  await withFixture(async ({ service, publication, sockets, enableNetwork }) => {
    enableNetwork();
    let ready!: () => void;
    let restarted!: () => void;
    const initial = new Promise<void>(resolve => { ready = resolve; });
    const resumed = new Promise<void>(resolve => { restarted = resolve; });
    let suspended = false;
    const observation = service.observeProject('project-alpha', snapshot => {
      if (!snapshot) return;
      if (suspended) restarted();
      else ready();
    });
    try {
      await bounded(initial, 'Initial observation did not start');
      const suspension = await publication.suspendProject('project-alpha');
      suspended = true;
      expect(sockets.find(socket => socket.projectId === 'project-alpha')?.closed).toBe(true);
      await publication.resumeProject(suspension);
      await bounded(resumed, 'Observation did not resume');
      expect(sockets.filter(socket => socket.projectId === 'project-alpha')).toHaveLength(2);
    } finally { observation.dispose(); }
  });
});

it('does not resurrect a removed Project from an older initial full refresh', async () => {
  await withFixture(async ({ foundation }) => {
    let block = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const catalog = new CollabProjectCatalog({
      projects: foundation.local.projects,
      workspace: foundation.local.workspace,
      pendingLeaves: { listProjectIds: async () => ['project-beta'], load: async () => { if (block) { block = false; entered(); await gate; } return null; } },
      cloudRetirementIntents: { listProjectIds: async () => [] },
      hostInstallation: { inspect: async () => 'absent' },
      lanHost: { getProjectState: () => ({ status: 'stopped' }) },
      readConnectionStatus: () => 'offline',
      beforeSelectionPublished: () => undefined,
      onPublish: () => undefined,
    });
    const oldRefresh = catalog.refresh();
    await started;
    await foundation.local.projects.removeProject('project-alpha');
    const latest = await catalog.refresh();
    expect(latest.projects.map(project => project.id)).toEqual(['project-beta', 'project-gamma']);
    release();
    const final = await oldRefresh;
    expect(final.projects.map(project => project.id)).toEqual(['project-beta', 'project-gamma']);
  }, false);
});


it('registers accepted-main synchronization before an observer starts an inspection', async () => {
  await withFixture(async ({ service, publication, enableNetwork, advance }) => {
    enableNetwork();
    let ready!: () => void;
    let inspected!: (registered: boolean) => void;
    const initial = new Promise<void>(resolve => { ready = resolve; });
    const observed = new Promise<boolean>(resolve => { inspected = resolve; });
    const observation = service.observeProject('project-alpha', coordination => {
      if (coordination?.snapshot.eventSequence === 2) ready();
      if (coordination?.snapshot.eventSequence !== 3) return;
      const inspection = publication.beginProjectInspection('project-alpha');
      inspected(inspection.precedingSynchronization !== null);
      inspection.release();
    });
    try {
      await bounded(initial, 'Initial snapshot was not observed');
      advance('project-alpha', 'c'.repeat(40));
      expect(await bounded(observed, 'Changed main was not observed')).toBe(true);
    } finally { observation.dispose(); }
  });
});


it('commits queued A to B to C selections as coherent catalog revisions', async () => {
  await withFixture(async ({ service }) => {
    const filesystem = jest.requireActual<typeof FileSystem>('node:fs/promises');
    const rename = filesystem.rename;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let blocked = false;
    const delayed = jest.spyOn(filesystem, 'rename').mockImplementation(async (...args) => {
      if (!blocked && String(args[1]).endsWith('/index.json')) {
        blocked = true;
        entered();
        await gate;
      }
      return rename(...args);
    });
    const revisions: string[] = [];
    const coherent: boolean[] = [];
    const subscription = service.subscribe(state => {
      if (!state.selectedProjectId) return;
      coherent.push(state.projects.some(project => project.id === state.selectedProjectId));
      revisions.push(state.selectedProjectId);
    });
    try {
      const alpha = service.selectProject('project-alpha');
      await bounded(started, 'Selection persistence did not start');
      const beta = service.selectProject('project-beta');
      const gamma = service.selectProject('project-gamma');
      expect(service.state.selectedProjectId).toBe('project-beta');
      release();
      expect((await Promise.all([alpha, beta, gamma])).map(result => result.status))
        .toEqual(['success', 'success', 'success']);
      expect(service.state.selectedProjectId).toBe('project-gamma');
      expect(revisions.slice(-3)).toEqual(['project-alpha', 'project-beta', 'project-gamma']);
      expect(coherent.every(Boolean)).toBe(true);
    } finally { release(); delayed.mockRestore(); subscription.dispose(); }
  });
});

it('preserves committed selection when its separate Git inspection fails', async () => {
  await withFixture(async ({ service, foundation }) => {
    const selected = await service.selectProject('project-alpha');
    expect(selected).toMatchObject({ status: 'success', value: { project: { id: 'project-alpha' } } });
    const workspace = await foundation.local.workspace.resolveManagedProjectPath('workspace/alpha');
    await writeFile(path.join(workspace, '.git', 'HEAD'), 'invalid-head\n');
    expect((await service.inspectProject('project-alpha')).status).toBe('failure');
    expect(service.state.selectedProjectId).toBe('project-alpha');
  });
});


it('does not restart observation when initial connection fails after its observer closes', async () => {
  await withFixture(async ({ publication, networkRequestCount }) => {
    const observation = publication.observeProject('project-alpha');
    observation.dispose();
    await new Promise(resolve => setTimeout(resolve, 150));
    const settledRequests = networkRequestCount();
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(networkRequestCount()).toBe(settledRequests);
  }, false);
});


it('retains passive observation opened during a temporary Project suspension', async () => {
  await withFixture(async ({ service, publication, networkRequestCount, enableNetwork }) => {
    enableNetwork();
    const suspension = await publication.suspendProject('project-alpha');
    let ready!: () => void;
    const observed = new Promise<void>(resolve => { ready = resolve; });
    const observation = service.observeProject('project-alpha', coordination => {
      if (coordination?.snapshot.eventSequence === 2) ready();
    });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(networkRequestCount()).toBe(0);
      await publication.resumeProject(suspension);
      await bounded(observed, 'New observation did not start after resume');
    } finally { observation.dispose(); }
  }, false);
});


it('keeps a replacement observer live when the previous last observer closes in the same turn', async () => {
  await withFixture(async ({ service, enableNetwork, advance }) => {
    enableNetwork();
    let ready!: () => void;
    const initial = new Promise<void>(resolve => { ready = resolve; });
    const first = service.observeProject('project-alpha', coordination => {
      if (coordination?.snapshot.eventSequence === 2) ready();
    });
    await bounded(initial, 'Initial observer did not connect');
    first.dispose();
    let changed!: () => void;
    const change = new Promise<void>(resolve => { changed = resolve; });
    const replacement = service.observeProject('project-alpha', coordination => {
      if (coordination?.snapshot.eventSequence === 3) changed();
    });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      advance('project-alpha');
      await expect(bounded(change, 'Replacement observer did not receive the event')).resolves.toBeUndefined();
    } finally { first.dispose(); replacement.dispose(); }
  }, false);
});

it('refreshes a one-shot presentation read after unobserved authority changes', async () => {
  await withFixture(async ({ publication, enableNetwork, advance, sockets }) => {
    enableNetwork();
    const initial = await publication.readPresentationSnapshot('project-alpha');
    expect(initial.snapshot.eventSequence).toBe(2);
    expect(sockets).toHaveLength(0);
    advance('project-alpha');
    const next = await publication.readPresentationSnapshot('project-alpha');
    expect(next).toMatchObject({ source: 'online', stale: false, snapshot: { eventSequence: 3 } });
  }, false);
});

it('registers maintenance for main accepted while an observed Project was suspended', async () => {
  await withFixture(async ({ service, publication, enableNetwork, advance }) => {
    enableNetwork();
    let ready!: () => void;
    let resumed!: (registered: boolean) => void;
    const initial = new Promise<void>(resolve => { ready = resolve; });
    const result = new Promise<boolean>(resolve => { resumed = resolve; });
    const observation = service.observeProject('project-alpha', snapshot => {
      if (snapshot?.snapshot.eventSequence === 2) ready();
      if (snapshot?.snapshot.eventSequence !== 3) return;
      const lease = publication.beginProjectInspection('project-alpha');
      resumed(lease.precedingSynchronization !== null);
      lease.release();
    });
    try {
      await bounded(initial, 'Initial observation missing');
      expect((await service.selectProject('project-alpha')).status).toBe('success');
      const suspension = await publication.suspendProject('project-alpha');
      advance('project-alpha', 'c'.repeat(40));
      await publication.resumeProject(suspension);
      expect(await bounded(result, 'Resumed snapshot missing')).toBe(true);
    } finally { observation.dispose(); }
  }, false);
});

