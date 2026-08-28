import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DevelopmentBootstrapAttemptStatus } from '@claudian-collab/protocol';
import {
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
} from '@test/helpers/installations';

import {
  CloudBootstrapCoordinator,
  type CloudBootstrapCoordinatorOptions,
} from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import {
  CloudBootstrapReadinessCollector,
  type CloudBootstrapReadinessObservation,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import { CloudBootstrapService } from '@/app/collab/bootstrap/CloudBootstrapService';
import {
  createCloudBootstrapTransitionRecord,
  decodeCloudBootstrapTransitionRecord,
  developmentBootstrapManifestSha256,
  markCloudBootstrapTerminalCleanupCompleted,
  observeCloudBootstrapAttemptStatus,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CloudBootstrapTransitionStore } from '@/app/collab/bootstrap/CloudBootstrapTransitionStore';
import { CollabProjectLifecycleSubsystem } from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';

import {
  ATTEMPT_ID,
  bootstrapManifest,
  finalizeActivatedBindingForTest,
  HOST_MEMBER_ID,
  HOST_OID,
  HOST_REF,
  MAIN_OID,
  MANIFEST_SHA256,
  OTHER_MEMBER_ID,
  PROJECT_ID,
} from '../../../../unit/app/collab/bootstrap/fixtures';

const ACTIVATION_RESULT = {
  activatedAt: '2026-08-21T00:00:04.000Z',
  activationOperationId: 'activation-one',
  placementGeneration: 1,
  projectId: PROJECT_ID,
} as const;

function activatedStatus(): DevelopmentBootstrapAttemptStatus {
  return {
    activationPhase: 'completed',
    activationResult: ACTIVATION_RESULT,
    attemptId: ATTEMPT_ID,
    bundleState: 'validated',
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
    manifestSha256: MANIFEST_SHA256,
    projectId: PROJECT_ID,
    reporterMemberIds: [HOST_MEMBER_ID, OTHER_MEMBER_ID],
    state: 'activated',
  };
}

function status(
  state: DevelopmentBootstrapAttemptStatus['state'],
  bundleState: DevelopmentBootstrapAttemptStatus['bundleState'],
): DevelopmentBootstrapAttemptStatus {
  return {
    attemptId: ATTEMPT_ID,
    bundleState,
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
    manifestSha256: MANIFEST_SHA256,
    projectId: PROJECT_ID,
    reporterMemberIds: bundleState === 'missing'
      ? []
      : [HOST_MEMBER_ID, OTHER_MEMBER_ID],
    state,
  };
}

function readyObservation(): CloudBootstrapReadinessObservation {
  return {
    collabGitChildCount: 0,
    operations: {
      cleanup: 'settled',
      conflictRecovery: 'settled',
      hostTransfer: 'settled',
      join: 'settled',
      leave: 'settled',
      managerResponsibility: 'settled',
      projectSetup: 'settled',
      publish: 'settled',
      reconciliation: 'settled',
      reconnect: 'settled',
      retirement: 'settled',
    },
    preservedWork: {
      hasLocalOnlyCommits: true,
      hasPrivateDraft: true,
      hasUnpublishedFiles: true,
    },
    projectOperationQueue: { activeCount: 0, queuedCount: 0 },
    projectWorkSession: 'closed',
    repository: {
      mainOid: MAIN_OID,
      memberId: HOST_MEMBER_ID,
      objectFormat: 'sha1',
      personalRef: HOST_REF,
      personalRefOid: HOST_OID,
      projectId: PROJECT_ID,
    },
  };
}

describe('Former Host Cloud bootstrap fence', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-bootstrap-'));
    await mkdir(path.join(vaultRoot, 'workspace', PROJECT_ID), { recursive: true });
    await writeFile(
      path.join(vaultRoot, 'workspace', PROJECT_ID, 'unpublished.md'),
      'preserve me\n',
    );
    await mkdir(path.join(vaultRoot, '.claudian', 'collab', 'projects', PROJECT_ID), {
      recursive: true,
    });
    await writeFile(
      path.join(vaultRoot, '.claudian', 'collab', 'projects', PROJECT_ID, 'membership.json'),
      JSON.stringify({ authority: 'lan', origin: 'https://192.168.1.20:54545' }),
    );
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('keeps LAN stopped while completing local binding after a lost activation response', async () => {
    const transitionStore = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
    const hostStatePath = path.join(vaultRoot, '.claudian', 'collab', 'host-state.json');
    await writeFile(hostStatePath, JSON.stringify({
      activeChildren: 1,
      autoStart: true,
      resources: 2,
      routeRegistered: true,
      running: true,
    }));
    let cloudStatus: DevelopmentBootstrapAttemptStatus | null = null;
    const stopAndDrain = jest.fn(async () => {
      await writeFile(hostStatePath, JSON.stringify({
        activeChildren: 0,
        autoStart: false,
        resources: 0,
        routeRegistered: false,
        running: false,
      }));
      return {
        autoStartDisabled: true as const,
        resourcesDrained: true as const,
        routeUnregistered: true as const,
        stoppedAt: '2026-08-21T00:00:02.000Z',
      };
    });
    const common: Omit<CloudBootstrapCoordinatorOptions, 'cloud'> = {
      binding: { finalize: async record => finalizeActivatedBindingForTest(record) },
      createFenceId: () => 'bootstrap-fence-one',
      formerHost: { stopAndDrain },
      localIdentity: {
        load: async () => ({
          authorityKind: 'lan',
          caFingerprint: 'b'.repeat(64),
          endpoint: 'https://192.168.1.20:54545',
          gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
          memberId: HOST_MEMBER_ID,
          ownsAuthority: true,
          projectId: PROJECT_ID,
        }),
      },
      installationKey: TEST_INSTALLATION_A,
      now: () => new Date('2026-08-21T00:00:03.000Z'),
      readiness: new CloudBootstrapReadinessCollector({
        inspect: async () => readyObservation(),
      }),
      source: {
        assertManifestCurrent: async () => undefined,
        captureManifest: async () => bootstrapManifest(),
        discardBundle: async () => undefined,
        openBundle: async function* () { yield new Uint8Array([1, 2, 3]); },
      },
      transitions: transitionStore,
      workSessions: {
        closeAndDrain: async () => undefined,
        completeAfterActivation: async () => undefined,
        resumeAfterCancellation: async () => undefined,
      },
    };
    const first = new CloudBootstrapCoordinator({
      ...common,
      cloud: {
        activate: async () => {
          cloudStatus = activatedStatus();
          throw new Error('simulated lost activation response');
        },
        begin: async () => status('collecting', 'missing'),
        cancel: async () => { throw new Error('unused'); },
        get: async () => cloudStatus,
        report: async () => status('validating', 'missing'),
        upload: async (_request, body) => {
          for await (const chunk of body(new AbortController().signal)) {
            if (chunk.byteLength === 0) throw new Error('Empty bundle chunk');
          }
          return status('ready', 'validated');
        },
      },
    });

    await expect(first.startFormerHost({
      developmentActorId: HOST_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    })).rejects.toThrow('simulated lost activation response');
    expect(await transitionStore.load(PROJECT_ID)).toMatchObject({
      attemptState: 'pending',
      fence: { state: 'host-stopped' },
      phase: 'intent',
    });

    const restartStop = jest.fn(async () => { throw new Error('Host stop replayed'); });
    const restarted = new CloudBootstrapCoordinator({
      ...common,
      cloud: {
        activate: async () => activatedStatus(),
        begin: async () => { throw new Error('begin replayed'); },
        cancel: async () => { throw new Error('unused'); },
        get: async () => cloudStatus,
        report: async () => { throw new Error('report replayed'); },
        upload: async () => { throw new Error('upload replayed'); },
      },
      formerHost: { stopAndDrain: restartStop },
    });

    await expect(restarted.recoverProject(PROJECT_ID)).resolves.toMatchObject({
      activationResult: ACTIVATION_RESULT,
      attemptState: 'activated',
      fence: { state: 'terminal' },
      phase: 'fence-terminal',
    });
    expect(restartStop).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(hostStatePath, 'utf8'))).toEqual({
      activeChildren: 0,
      autoStart: false,
      resources: 0,
      routeRegistered: false,
      running: false,
    });
    expect(await readFile(
      path.join(vaultRoot, 'workspace', PROJECT_ID, 'unpublished.md'),
      'utf8',
    )).toBe('preserve me\n');
    expect(JSON.parse(await readFile(
      path.join(vaultRoot, '.claudian', 'collab', 'projects', PROJECT_ID, 'membership.json'),
      'utf8',
    ))).toEqual({ authority: 'lan', origin: 'https://192.168.1.20:54545' });
    await expect(transitionStore.list()).resolves.toMatchObject({
      blockedProjectIds: [],
      records: [expect.objectContaining({ projectId: PROJECT_ID })],
      retryRequired: false,
    });
  });

  it('isolates a corrupt Project transition while preserving other recovery candidates', async () => {
    const transitionStore = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
    const valid = createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:00.000Z',
    });
    await transitionStore.create(valid);
    const transitionDirectory = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'cloud-bootstrap-transitions',
    );
    await writeFile(
      path.join(transitionDirectory, 'project-corrupt.json'),
      '{not-json',
      { mode: 0o600 },
    );
    await mkdir(path.join(transitionDirectory, 'project-directory.json'));

    await expect(transitionStore.list()).resolves.toEqual({
      blockedProjectIds: ['project-corrupt', 'project-directory'],
      records: [valid],
      retryRequired: false,
    });
    const inspectLifecycleOwner = (projectId: string) => (
      transitionStore as unknown as {
        inspectLifecycleOwner(candidateProjectId: string): Promise<
          'absent' | 'nonterminal' | 'terminal'
        >;
      }
    ).inspectLifecycleOwner(projectId);
    await expect(inspectLifecycleOwner('project-corrupt')).resolves.toBe('nonterminal');
    await expect(inspectLifecycleOwner('project-directory')).resolves.toBe('nonterminal');
    const lifecycle = new CollabProjectLifecycleSubsystem({
      closeRecovery: async () => undefined,
      durableOwners: [{
        inspect: inspectLifecycleOwner,
        name: 'cloud-bootstrap',
      }],
      hostTransfer: {} as never,
      localExit: {} as never,
      recoveryStages: [],
      retirement: {} as never,
    });
    const fenceUncertainProject = jest.fn(async (_projectId: string) => undefined);
    const bootstrap = new CloudBootstrapService({
      assertHostInstallationOwned: async () => undefined,
      assertRecoveryOwner: () => undefined,
      createCoordinator: () => ({}) as never,
      fenceUncertainProject,
      projectRecoveryAdmission: (projectId, operation) => lifecycle.runExclusive(
        projectId,
        'cloud-bootstrap',
        'recovery',
        operation,
      ),
      recoverLocalArtifacts: async () => undefined,
      transitions: transitionStore,
    });
    await expect(bootstrap.prepareLocalRecovery()).resolves.toBeUndefined();
    expect(fenceUncertainProject.mock.calls.map(([projectId]) => projectId).sort()).toEqual([
      PROJECT_ID,
      'project-corrupt',
      'project-directory',
    ]);
    await bootstrap.close();
    await lifecycle.lifecycleRecovery.close();
    await expect(transitionStore.load('project-corrupt')).rejects.toMatchObject({
      safeContext: {
        projectId: 'project-corrupt',
        reason: 'cloud-bootstrap-transition-corrupt',
      },
    });

    const validPath = path.join(transitionDirectory, `${PROJECT_ID}.json`);
    await chmod(validPath, 0o000);
    await expect(transitionStore.list()).resolves.toEqual({
      blockedProjectIds: [PROJECT_ID, 'project-corrupt', 'project-directory'],
      records: [],
      retryRequired: true,
    });
    await expect(inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await chmod(validPath, 0o600);
  });

  it('serializes a LAN Host start against durable fence creation', async () => {
    const transitionStore = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
    let releaseStart: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const start = transitionStore.runWithLanHostStartGuard(PROJECT_ID, async () => {
      markStarted?.();
      await new Promise<void>(resolve => { releaseStart = resolve; });
      return 'running';
    });
    await started;
    let fenceCreated = false;
    const create = transitionStore.create(createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:00.000Z',
    })).then(record => {
      fenceCreated = true;
      return record;
    });
    await Promise.resolve();
    expect(fenceCreated).toBe(false);

    releaseStart?.();
    await expect(start).resolves.toBe('running');
    await create;
    await expect(transitionStore.runWithLanHostStartGuard(
      PROJECT_ID,
      async () => 'unexpected',
    )).rejects.toMatchObject({
      safeContext: { reason: 'cloud-bootstrap-host-fence-active' },
    });
  });

  it('keeps a foreign synchronized bootstrap record inert for lifecycle and Host start', async () => {
    const writer = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
    await writer.create(createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:00.000Z',
    }));
    const foreign = new CloudBootstrapTransitionStore(vaultRoot, {
      isRecoveryOwner: ownerInstallationKey => ownerInstallationKey === TEST_INSTALLATION_B,
    });

    await expect(foreign.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('absent');
    await expect(foreign.runWithLanHostStartGuard(
      PROJECT_ID,
      async () => 'running',
    )).resolves.toBe('running');
  });

  it('keeps an ownerless legacy bootstrap fence visible and blocks Host restart', async () => {
    const current = createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:00.000Z',
    });
    const { ownerInstallationKey: _ownerInstallationKey, ...withoutOwner } = current;
    const writer = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
    await writer.create(decodeCloudBootstrapTransitionRecord({
      ...withoutOwner,
      schemaVersion: 1,
    }));
    const ownerAware = new CloudBootstrapTransitionStore(vaultRoot, {
      isRecoveryOwner: ownerInstallationKey => ownerInstallationKey === TEST_INSTALLATION_A,
    });

    await expect(ownerAware.inspectLifecycleOwner(PROJECT_ID)).resolves.toBe('nonterminal');
    await expect(ownerAware.runWithLanHostStartGuard(
      PROJECT_ID,
      async () => 'unexpected',
    )).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'cloud-bootstrap-legacy-owner-missing' },
    });
  });

  it('fails transition creation and update closed when directory sync is unavailable', async () => {
    const transitionDirectory = path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'cloud-bootstrap-transitions',
    );
    await mkdir(transitionDirectory, { mode: 0o300 });
    const transitionStore = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
    const record = createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:00.000Z',
    });
    try {
      await expect(transitionStore.create(record)).rejects.toMatchObject({
        safeContext: { reason: 'directory-sync-required' },
      });
      await chmod(transitionDirectory, 0o700);
      await expect(transitionStore.load(PROJECT_ID)).resolves.toEqual(record);
      await chmod(transitionDirectory, 0o300);
      await expect(transitionStore.save(record)).rejects.toMatchObject({
        safeContext: { reason: 'directory-sync-required' },
      });
    } finally {
      await chmod(transitionDirectory, 0o700);
    }
  });

  it('archives a durable cancellation before admitting a new bootstrap attempt', async () => {
    const transitionStore = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
    const first = createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:00.000Z',
    });
    await transitionStore.create(first);
    const cleanupPending = observeCloudBootstrapAttemptStatus(first, {
      attemptId: ATTEMPT_ID,
      bundleState: 'missing',
      cancellationPhase: 'cancelled',
      createdAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-22T00:00:00.000Z',
      manifestSha256: MANIFEST_SHA256,
      projectId: PROJECT_ID,
      reporterMemberIds: [],
      state: 'cancelled',
    }, '2026-08-21T00:00:01.000Z');
    await transitionStore.save(cleanupPending);
    const nextManifest = { ...bootstrapManifest(), attemptId: 'bootstrap-attempt-two' };
    const next = createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-two',
      manifest: nextManifest,
      manifestSha256: developmentBootstrapManifestSha256(nextManifest),
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:03.000Z',
    });

    await expect(transitionStore.create(next)).rejects.toMatchObject({
      safeContext: { reason: 'cloud-bootstrap-transition-conflict' },
    });
    const cancelled = markCloudBootstrapTerminalCleanupCompleted(
      cleanupPending,
      '2026-08-21T00:00:02.000Z',
    );
    await transitionStore.save(cancelled);
    await expect(transitionStore.create(next)).resolves.toEqual(next);
    await expect(transitionStore.load(PROJECT_ID)).resolves.toEqual(next);
    await expect(readFile(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'cloud-bootstrap-transition-history',
      PROJECT_ID,
      `${ATTEMPT_ID}.json`,
    ), 'utf8')).resolves.toBe(`${JSON.stringify(cancelled, null, 2)}\n`);
  });
});
