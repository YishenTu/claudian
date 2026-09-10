import type * as FileSystem from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_CHECKPOINT_ARTIFACT_LIMITS, COLLAB_LIMITS, collabCloudCapabilityDocument, collabCloudSuccessEnvelope } from '@claudian-collab/protocol';
import { completeCollabFeatureOptions, completeCollabPublicationOptions } from '@test/helpers/collab/CollabFeatureTestHarness';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CollabPublicationService } from '@/app/collab/publish/CollabPublicationService';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';
import { CloudAuthorityAdapter, CloudProjectEventClient, type CloudProjectEventSocket } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { CollabCoordinationSnapshot } from '@/core/collab/CollabFeaturePort';
const CREATED_AT = '2026-09-07T00:00:00.000Z';
const PERSONAL_REF = 'refs/heads/members/member-alice';
class Socket implements CloudProjectEventSocket {
  listener?: (data: string) => void;
  close(_code: number, _reason: string): void {}
  onClose(_listener: (code: number) => void): void {}
  onError(_listener: () => void): void {}
  onOpen(_listener: () => void): void {}
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

jest.setTimeout(60000);
it.each(['unrelated-filesystem-fault', 'overlapping-lifecycle-refresh'])(
  'preserves Project updates during %s', async scenario => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'collab-coordination-refresh-'));
  let foundation!: ClaudianCollabService;
  let service: CollabFeatureService | undefined;
  const mainOids = new Map<string, string>();
  let enabled = false;
  let sequence = 1;
  const socket = new Socket();
  try {
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
    await foundation.local.projects.selectProject('project-alpha');

    let networkRequests = 0;
    const cloudAuthority = new CloudAuthorityAdapter(vaultRoot, {
      createEventClient: (input, invalidation) => new CloudProjectEventClient(input, invalidation, { createSocket: () => socket }),
      request: async input => {
        networkRequests += 1;
        if (!enabled) throw new CollabError({ code: 'endpoint-unreachable' });
        const currentMember = { activatedAt: CREATED_AT, createdAt: CREATED_AT, displayName: 'Alice', id: 'member-alice', personalRef: PERSONAL_REF, role: sequence === 1 ? 'manager' : 'member', status: 'active' };
        return {
          body: input.method === 'GET' ? collabCloudCapabilityDocument(['project-events', 'project-snapshot'], limits) : collabCloudSuccessEnvelope(
            (input.body as { requestId: string }).requestId,
            { currentMember, eventSequence: sequence, members: [currentMember], openRequests: [], openTicketCount: 0,
              project: { authorityGeneration: 1, createdAt: CREATED_AT, expectedMainOid: mainOids.get('project-alpha'), id: 'project-alpha', mainRef: 'refs/heads/main', name: 'alpha' }, ticketHighlights: [] },
          ),
          contentType: 'application/json', status: 200,
        };
      },
    });
    const publication = new CollabPublicationService(foundation, completeCollabPublicationOptions({ cloudAuthority, vaultRoot }));
    service = new CollabFeatureService(foundation, new CollabProjectSetupService(foundation, { installationKey: TEST_INSTALLATION_A, vaultRoot }), { ...completeCollabFeatureOptions({ vaultRoot }), publication });
    expect((await service.initialize()).status).toBe('success');
    await service.inspectProject('project-alpha');
    enabled = true;
    expect((await service.readSnapshot('project-alpha')).status).toBe('success');
    const overlapping = scenario === 'overlapping-lifecycle-refresh';
    let releaseBeta!: () => void;
    let betaRequested!: () => void;
    const betaBlocked = new Promise<void>(resolve => { betaRequested = resolve; });
    const betaReleased = new Promise<void>(resolve => { releaseBeta = resolve; });
    if (overlapping) {
      await foundation.local.projects.upsertProject({
        authorityKind: 'cloud', createdAt: CREATED_AT, id: 'project-beta',
        lifecycle: 'active', name: 'Recovered beta', updatedAt: CREATED_AT,
        workspacePath: 'workspace/beta',
      });
    }
    const filesystem = jest.requireActual<typeof FileSystem>('node:fs/promises');
    const readFile = filesystem.readFile;
    const fault = jest.spyOn(filesystem, 'readFile').mockImplementation(async (...args) => {
      if (!overlapping && String(args[0]).split(path.sep).includes('project-beta')) {
        throw Object.assign(new Error('Unrelated Project unavailable'), { code: 'EIO' });
      }
      return readFile(...args);
    });
    const lstat = filesystem.lstat;
    const delayedStat = jest.spyOn(filesystem, 'lstat').mockImplementation(async (...args) => {
      if (overlapping && String(args[0]) === path.join(vaultRoot, 'workspace', 'beta', '.git')) {
        betaRequested();
        await betaReleased;
      }
      return lstat(...args);
    });
    try {
      let forwardedSnapshot: CollabCoordinationSnapshot | undefined;
      let initial = true;
      let resolveEvent!: () => void;
      const event = new Promise<void>(resolve => { resolveEvent = resolve; });
      const subscription = service.subscribe((_state, coordination) => {
        if (initial) {
          initial = false;
          return;
        }
        if (coordination?.snapshot.eventSequence !== 2) return;
        forwardedSnapshot = coordination;
        resolveEvent();
      });
      let receivedEvent!: () => void;
      const publicationEvent = new Promise<void>(resolve => { receivedEvent = resolve; });
      const publicationSubscription = publication.subscribeCoordination(() => receivedEvent());
      const lifecycleRefresh = overlapping ? service.refreshLifecycleProjection() : null;
      if (overlapping) await bounded(betaBlocked, 'Beta read did not start');
      sequence = 2;
      socket.snapshotRequired(sequence);
      await bounded(publicationEvent, 'Publication event did not arrive');
      if (overlapping) await bounded(event, 'Feature event did not arrive');
      releaseBeta();
      await lifecycleRefresh;
      await bounded(event, 'Feature event did not arrive');
      publicationSubscription.dispose();
      expect(service.state.projects.find(project => project.id === 'project-beta')?.name)
        .toBe(overlapping ? 'Recovered beta' : 'beta');
      subscription.dispose();
      expect(service.state.projects.find(project => project.id === 'project-alpha')?.role)
        .toBe('member');
      expect({ error: service.state.error, coordination: forwardedSnapshot }).toMatchObject({
        error: undefined,
        coordination: {
          snapshot: { eventSequence: 2, project: { id: 'project-alpha' } },
          source: 'online', stale: false,
          syncState: { eventSequence: 2, generation: 0, projectId: 'project-alpha', status: 'synchronized' },
        },
      });
      const requestsBeforeLocalEdits = networkRequests;
      for (const content of ['First local edit\n', 'Other local edit\n']) {
        await writeFile(path.join(vaultRoot, 'workspace', 'alpha', 'note.md'), content);
        await expect(service.inspectProject('project-alpha')).resolves.toMatchObject({
          status: 'success', value: {
            coordination: { source: 'online', stale: false, snapshot: { eventSequence: 2 } },
            gitStatus: { headOid: mainOids.get('project-alpha'), workingTreeClean: false, changedFiles: [expect.objectContaining({ path: 'note.md' })] },
            personalChanges: { unpublishedReview: { headOid: mainOids.get('project-alpha'), files: [expect.objectContaining({ path: 'note.md' })] } },
          },
        });
      }
      expect(networkRequests).toBe(requestsBeforeLocalEdits);
    } finally {
      releaseBeta();
      fault.mockRestore();
      delayedStat.mockRestore();
    }
  } finally {
    await service?.close();
    await foundation?.close();
    await rm(vaultRoot, { recursive: true, force: true });
  }
  },
);
