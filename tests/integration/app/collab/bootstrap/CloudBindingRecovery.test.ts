import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabMemberRef,
  type DevelopmentBootstrapManifest,
} from '@claudian/collab-protocol';

import {
  type CloudBootstrapBindingEffects,
  CloudBootstrapBindingFinalizer,
} from '@/app/collab/bootstrap/CloudBootstrapBindingFinalizer';
import {
  CLOUD_BOOTSTRAP_TRANSITION_PHASES,
  type CloudBootstrapTransitionPhase,
  type CloudBootstrapTransitionRecord,
  type CloudBootstrapTransitionStorePort,
  createCloudBootstrapTransitionRecord,
  developmentBootstrapManifestSha256,
  markCloudBootstrapHostStopped,
  observeCloudBootstrapAttemptStatus,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CloudBootstrapTransitionStore } from '@/app/collab/bootstrap/CloudBootstrapTransitionStore';
import {
  LocalCloudBootstrapBindingEffects,
} from '@/app/collab/bootstrap/LocalCloudBootstrapBindingEffects';
import {
  type CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
  isCollabLocalCloudMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import {
  ensureTrustedCollabOrigin,
  rotateCloudBootstrapOrigin,
} from '@/app/collab/git/CollabGitOriginPolicy';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import type { CollabAuthorityAdapter } from '@/app/collab/remote-authority/CollabAuthoritySession';

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const PROJECT_ID = 'project-cloud-recovery';
const MEMBER_ID = 'member-alice';
const OTHER_MEMBER_ID = 'member-bob';
const PERSONAL_REF = collabMemberRef(MEMBER_ID);
const OTHER_PERSONAL_REF = collabMemberRef(OTHER_MEMBER_ID);
const OLD_ENDPOINT = 'https://192.168.1.20:54545/';
const OLD_REMOTE = `${OLD_ENDPOINT}v1/git/${PROJECT_ID}/repository.git`;
const CLOUD_ORIGIN = 'https://cloud.example.test';
const CLOUD_REMOTE = `${CLOUD_ORIGIN}/v1/projects/${PROJECT_ID}/repository.git`;
const CRASH = new Error('simulated process crash');

jest.setTimeout(30_000);

interface RecoveryFixture {
  readonly mainOid: string;
  readonly manifest: DevelopmentBootstrapManifest;
  readonly record: CloudBootstrapTransitionRecord;
  readonly repositoryPath: string;
  readonly vaultRoot: string;
}

type BindingEffectName = keyof CloudBootstrapBindingEffects;

const EFFECT_PHASES = Object.freeze([
  ['intent', 'confirmReadiness'],
  ['readiness-confirmed', 'rotateOrigin'],
  ['origin-rotated', 'verifyCloud'],
  ['cloud-verified', 'replaceMembership'],
  ['membership-replaced', 'repairIndex'],
  ['index-repaired', 'retireLanAuthority'],
] as const satisfies readonly (readonly [CloudBootstrapTransitionPhase, BindingEffectName])[]);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

function manifest(mainOid: string): DevelopmentBootstrapManifest {
  return {
    attemptId: 'bootstrap-cloud-recovery',
    comparison: {
      mainOid,
      mainRef: COLLAB_MAIN_REF,
      managerSetGeneration: 1,
      members: [{
        activatedAt: '2026-08-21T00:00:00.000Z',
        createdAt: '2026-08-20T00:00:00.000Z',
        displayName: 'Alice',
        memberId: MEMBER_ID,
        personalRef: PERSONAL_REF,
        role: 'manager',
        status: 'active',
      }, {
        activatedAt: '2026-08-21T00:00:01.000Z',
        createdAt: '2026-08-20T00:00:01.000Z',
        displayName: 'Bob',
        memberId: OTHER_MEMBER_ID,
        personalRef: OTHER_PERSONAL_REF,
        role: 'member',
        status: 'active',
      }],
      projectCreatedAt: '2026-08-20T00:00:00.000Z',
      projectId: PROJECT_ID,
      projectName: 'Cloud Recovery',
      sourceCaFingerprint: 'b'.repeat(64),
      sourceEventSequence: 12,
      sourceHostMemberId: MEMBER_ID,
    },
    createdAt: '2026-08-22T00:00:00.000Z',
    git: {
      bundle: { byteCount: 128, sha256: 'c'.repeat(64) },
      objectFormat: 'sha1',
      refs: [
        { name: COLLAB_MAIN_REF, oid: mainOid },
        { name: PERSONAL_REF, oid: mainOid },
        { name: OTHER_PERSONAL_REF, oid: mainOid },
      ].sort((left, right) => left.name.localeCompare(right.name, 'en-US')),
    },
    manifestSchemaVersion: 1,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sourceEligibility: {
      liveInvitations: 0,
      nonActiveMemberships: 0,
      nonterminalAcceptOperations: 0,
      nonterminalHostTransfers: 0,
      nonterminalManagerOffers: 0,
      requestComments: 0,
      requests: 0,
      terminalProjectTransitions: 0,
      ticketComments: 0,
      ticketMentions: 0,
      ticketRelations: 0,
      tickets: 0,
    },
  };
}

function lanMembership(): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: OLD_ENDPOINT,
      gitRemoteUrl: OLD_REMOTE,
      hostCaCertificatePem: [
        '-----BEGIN CERTIFICATE-----',
        'RECOVERY',
        '-----END CERTIFICATE-----',
      ].join('\n'),
      hostCaFingerprint: 'b'.repeat(64),
      kind: 'lan',
    },
    createdAt: '2026-08-20T00:00:00.000Z',
    hostOwnership: { autoStart: false, ownsAuthority: true },
    lastEventSequence: 12,
    lifecycle: 'active',
    member: {
      credential: 'A'.repeat(43),
      displayName: 'Alice',
      id: MEMBER_ID,
      personalRef: PERSONAL_REF,
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Recovery',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

async function createFixture(root: string): Promise<RecoveryFixture> {
  const vaultRoot = path.join(root, 'vault');
  await mkdir(vaultRoot);
  const projects = new CollabLocalProjectRepository(vaultRoot);
  const workspace = new CollabWorkspaceService(vaultRoot);
  await workspace.claimProjectsFolder('workspace');
  const repositoryPath = path.join(vaultRoot, 'workspace', PROJECT_ID);
  await mkdir(repositoryPath);
  await git(repositoryPath, ['init', '--initial-branch=main']);
  await git(repositoryPath, ['config', 'user.name', 'Cloud Recovery']);
  await git(repositoryPath, ['config', 'user.email', 'recovery@claudian.local']);
  await writeFile(path.join(repositoryPath, 'shared.md'), 'shared state\n');
  await git(repositoryPath, ['add', 'shared.md']);
  await git(repositoryPath, ['commit', '-m', 'main']);
  const mainOid = await git(repositoryPath, ['rev-parse', 'HEAD']);
  await git(repositoryPath, ['update-ref', PERSONAL_REF, mainOid]);
  await git(repositoryPath, ['update-ref', OTHER_PERSONAL_REF, mainOid]);
  await git(repositoryPath, ['remote', 'add', 'origin', OLD_REMOTE]);
  await writeFile(path.join(repositoryPath, 'unpublished.md'), 'preserved local work\n');

  await projects.upsertProject({
    authorityKind: 'lan',
    createdAt: '2026-08-20T00:00:00.000Z',
    id: PROJECT_ID,
    name: 'Cloud Recovery',
    updatedAt: '2026-08-21T00:00:00.000Z',
    workspacePath: `workspace/${PROJECT_ID}`,
  });
  await projects.saveMembership(lanMembership());
  const authorityDirectory = await projects.ensureAuthorityDirectory(PROJECT_ID);
  await writeFile(path.join(authorityDirectory, 'collab.db'), 'retired authority evidence');

  const capturedManifest = manifest(mainOid);
  const store = new CloudBootstrapTransitionStore(vaultRoot);
  let record = await store.create(createCloudBootstrapTransitionRecord({
    developmentActorId: MEMBER_ID,
    fenceId: 'bootstrap-cloud-recovery-fence',
    manifest: capturedManifest,
    manifestSha256: developmentBootstrapManifestSha256(capturedManifest),
    memberId: MEMBER_ID,
    oldEndpoint: OLD_ENDPOINT,
    oldGitRemoteUrl: OLD_REMOTE,
    serverUrl: CLOUD_ORIGIN,
    timestamp: '2026-08-22T00:00:01.000Z',
  }));
  record = markCloudBootstrapHostStopped(
    record,
    '2026-08-22T00:00:02.000Z',
    '2026-08-22T00:00:02.000Z',
  );
  await store.save(record);
  record = observeCloudBootstrapAttemptStatus(record, {
    activationPhase: 'completed',
    activationResult: {
      activatedAt: '2026-08-22T00:00:03.000Z',
      activationOperationId: 'activation-cloud-recovery',
      placementGeneration: 1,
      projectId: PROJECT_ID,
    },
    attemptId: capturedManifest.attemptId,
    bundleState: 'validated',
    createdAt: '2026-08-22T00:00:00.000Z',
    expiresAt: '2026-08-23T00:00:00.000Z',
    manifestSha256: developmentBootstrapManifestSha256(capturedManifest),
    projectId: PROJECT_ID,
    reporterMemberIds: [MEMBER_ID, OTHER_MEMBER_ID],
    state: 'activated',
  }, '2026-08-22T00:00:03.000Z');
  await store.save(record);
  return { mainOid, manifest: capturedManifest, record, repositoryPath, vaultRoot };
}

async function createEffects(fixture: RecoveryFixture): Promise<CloudBootstrapBindingEffects> {
  const projects = new CollabLocalProjectRepository(fixture.vaultRoot);
  const workspace = new CollabWorkspaceService(fixture.vaultRoot);
  const repositories = new GitRepositoryService(new GitCommandRunner({
    emptyConfigPath: await projects.ensureGitEmptyConfig(),
    executablePath: GIT_EXECUTABLE,
  }));
  const snapshot = {
    currentMember: {
      activatedAt: '2026-08-21T00:00:00.000Z',
      createdAt: '2026-08-20T00:00:00.000Z',
      displayName: 'Alice',
      id: MEMBER_ID,
      personalRef: PERSONAL_REF,
      role: 'manager' as const,
      status: 'active' as const,
    },
    eventSequence: 18,
    members: [{
      activatedAt: '2026-08-21T00:00:00.000Z',
      createdAt: '2026-08-20T00:00:00.000Z',
      displayName: 'Alice',
      id: MEMBER_ID,
      personalRef: PERSONAL_REF,
      role: 'manager' as const,
      status: 'active' as const,
    }, {
      activatedAt: '2026-08-21T00:00:01.000Z',
      createdAt: '2026-08-20T00:00:01.000Z',
      displayName: 'Bob',
      id: OTHER_MEMBER_ID,
      personalRef: OTHER_PERSONAL_REF,
      role: 'member' as const,
      status: 'active' as const,
    }],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityKind: 'cloud' as const,
      createdAt: '2026-08-20T00:00:00.000Z',
      id: PROJECT_ID,
      mainOid: fixture.mainOid,
      mainRef: COLLAB_MAIN_REF,
      name: 'Cloud Recovery',
    },
    ticketHighlights: [],
  };
  const adapter = {
    authorityKind: 'cloud' as const,
    create: async () => ({
      authorityKind: 'cloud' as const,
      control: { readSnapshot: async () => snapshot },
      dispose: () => undefined,
      events: { connect: () => ({ dispose: () => undefined }) },
      git: {
        headers: [{ name: 'X-Claudian-Development-Actor', value: MEMBER_ID }],
        remoteUrl: CLOUD_REMOTE,
      },
      supports: (capability: string) => [
        'git-upload-pack',
        'project-events',
        'project-snapshot',
      ].includes(capability),
    }),
  } as unknown as CollabAuthorityAdapter;

  return new LocalCloudBootstrapBindingEffects({
    activation: {
      get: async () => ({
        activationPhase: 'completed',
        activationResult: fixture.record.activationResult,
        attemptId: fixture.record.attemptId,
        bundleState: 'validated',
        createdAt: fixture.record.createdAt,
        expiresAt: '2026-08-23T00:00:00.000Z',
        manifestSha256: fixture.record.manifestSha256,
        projectId: fixture.record.projectId,
        reporterMemberIds: [MEMBER_ID, OTHER_MEMBER_ID],
        state: 'activated',
      } as never),
    },
    authorityAdapter: adapter,
    authorityLifecycle: { closeAuthority: async () => undefined },
    git: {
      assertOrigin: (record, repositoryPath) => ensureTrustedCollabOrigin(repositories, {
        allowHostRemoteRepair: false,
        projectId: record.projectId,
        remoteUrl: record.newAuthority.gitRemoteUrl,
        repositoryPath,
      }, 'cloud-bootstrap-binding-origin-mismatch'),
      fetchFromUrl: async (repositoryPath, remote, _refspecs, network) => {
        expect(remote).toBe(CLOUD_REMOTE);
        expect(network?.headers).toEqual([
          { name: 'X-Claudian-Development-Actor', value: MEMBER_ID },
        ]);
        await git(repositoryPath, [
          'update-ref',
          'refs/remotes/origin/main',
          fixture.mainOid,
        ]);
        await git(repositoryPath, [
          'update-ref',
          `refs/remotes/origin/members/${MEMBER_ID}`,
          fixture.mainOid,
        ]);
      },
      network: async (_projectId, facts) => ({ headers: facts.headers }),
      resolveRefs: (...input) => repositories.resolveRefs(...input),
      rotateOrigin: (record, repositoryPath) => rotateCloudBootstrapOrigin(repositories, {
        newRemoteUrl: record.newAuthority.gitRemoteUrl,
        oldRemoteUrl: record.oldAuthority.gitRemoteUrl,
        projectId: record.projectId,
        repositoryPath,
      }),
    },
    now: () => new Date('2026-08-22T00:01:00.000Z'),
    projects,
    readiness: {
      collect: async () => ({
        clientReadiness: {} as never,
        observedPersonalRefOid: fixture.mainOid,
      }),
    },
    workspace,
  });
}

function createFinalizer(
  fixture: RecoveryFixture,
  effects: CloudBootstrapBindingEffects,
  transitions: CloudBootstrapTransitionStorePort = new CloudBootstrapTransitionStore(
    fixture.vaultRoot,
  ),
): CloudBootstrapBindingFinalizer {
  return new CloudBootstrapBindingFinalizer({
    effects,
    now: () => new Date('2026-08-22T00:01:00.000Z'),
    transitions,
  });
}

function failAfterEffect(
  effects: CloudBootstrapBindingEffects,
  failureEffect: BindingEffectName,
): CloudBootstrapBindingEffects {
  let failed = false;
  const run = async (
    name: BindingEffectName,
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<void> => {
    await effects[name](record, signal);
    if (name === failureEffect && !failed) {
      failed = true;
      throw CRASH;
    }
  };
  return {
    confirmReadiness: (record, signal) => run('confirmReadiness', record, signal),
    repairIndex: (record, signal) => run('repairIndex', record, signal),
    replaceMembership: (record, signal) => run('replaceMembership', record, signal),
    retireLanAuthority: (record, signal) => run('retireLanAuthority', record, signal),
    rotateOrigin: (record, signal) => run('rotateOrigin', record, signal),
    verifyActivation: (record, signal) => run('verifyActivation', record, signal),
    verifyCloud: (record, signal) => run('verifyCloud', record, signal),
  };
}

async function expectTerminalRecovery(fixture: RecoveryFixture): Promise<void> {
  const restartedStore = new CloudBootstrapTransitionStore(fixture.vaultRoot);
  const pending = await restartedStore.load(PROJECT_ID);
  expect(pending).not.toBeNull();
  const restartedEffects = await createEffects(fixture);
  const restartedFinalizer = createFinalizer(
    fixture,
    restartedEffects,
    restartedStore,
  );
  const recovered = await restartedFinalizer.finalize(pending!);
  expect(recovered).toMatchObject({
    fence: { state: 'terminal' },
    phase: 'fence-terminal',
  });

  const restartedProjects = new CollabLocalProjectRepository(fixture.vaultRoot);
  const storedMembership = await restartedProjects.loadMembership(PROJECT_ID);
  expect(storedMembership && isCollabLocalCloudMembership(storedMembership)).toBe(true);
  expect(JSON.stringify(storedMembership)).not.toContain('credential');
  expect(JSON.stringify(storedMembership)).not.toContain('CERTIFICATE');
  expect((await restartedProjects.loadIndex()).projects[0]?.authorityKind).toBe('cloud');
  expect(await git(fixture.repositoryPath, ['remote', 'get-url', 'origin']))
    .toBe(CLOUD_REMOTE);
  await expect(readFile(path.join(fixture.repositoryPath, 'unpublished.md'), 'utf8'))
    .resolves.toBe('preserved local work\n');
  await expect(stat(path.join(
    fixture.vaultRoot,
    '.claudian',
    'collab',
    'authorities',
    PROJECT_ID,
  ))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(
    fixture.vaultRoot,
    '.claudian',
    'collab',
    'retired-lan-authorities',
    PROJECT_ID,
    'bootstrap-cloud-recovery',
    'collab.db',
  ), 'utf8')).resolves.toBe('retired authority evidence');
}

async function crashAfterCheckpoint(
  fixture: RecoveryFixture,
  phase: CloudBootstrapTransitionPhase,
): Promise<CloudBootstrapTransitionStore> {
  const persistedStore = new CloudBootstrapTransitionStore(fixture.vaultRoot);
  let failed = false;
  const crashStore: CloudBootstrapTransitionStorePort = {
    create: record => persistedStore.create(record),
    load: projectId => persistedStore.load(projectId),
    save: async record => {
      await persistedStore.save(record);
      if (record.phase === phase && !failed) {
        failed = true;
        throw CRASH;
      }
    },
  };
  await expect(createFinalizer(
    fixture,
    await createEffects(fixture),
    crashStore,
  ).finalize(fixture.record)).rejects.toBe(CRASH);
  return persistedStore;
}

describe('Cloud binding durable recovery', () => {
  it('restarts fresh stores from the durable intent checkpoint and completes forward-only', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-binding-checkpoint-'));
    try {
      const fixture = await createFixture(root);
      await expectTerminalRecovery(fixture);
      await expect(new CloudBootstrapTransitionStore(fixture.vaultRoot).load(PROJECT_ID))
        .resolves.toMatchObject({ phase: 'fence-terminal' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each(CLOUD_BOOTSTRAP_TRANSITION_PHASES.slice(1))(
    'restarts fresh stores from the durable %s checkpoint and completes forward-only',
    async phase => {
      expect.hasAssertions();
      const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-binding-checkpoint-'));
      try {
        const fixture = await createFixture(root);
        await crashAfterCheckpoint(fixture, phase);

        await expectTerminalRecovery(fixture);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it.each(EFFECT_PHASES)(
    'restarts after real %s effect %s completes before its checkpoint',
    async (_phase, effectName) => {
      const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-binding-effect-'));
      try {
        const fixture = await createFixture(root);
        const effects = failAfterEffect(await createEffects(fixture), effectName);
        const finalizer = createFinalizer(fixture, effects);

        await expect(finalizer.finalize(fixture.record)).rejects.toBe(CRASH);
        await expectTerminalRecovery(fixture);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it.each(['index-repaired', 'lan-authority-retired'] as const)(
    'blocks %s recovery when the exact Cloud origin drifts',
    async phase => {
      const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-binding-origin-drift-'));
      try {
        const fixture = await createFixture(root);
        const store = await crashAfterCheckpoint(fixture, phase);
        await git(fixture.repositoryPath, [
          'remote',
          'set-url',
          'origin',
          'https://untrusted.example.test/repository.git',
        ]);
        const pending = await store.load(PROJECT_ID);

        await expect(createFinalizer(
          fixture,
          await createEffects(fixture),
          store,
        ).finalize(pending!)).rejects.toMatchObject({
          code: 'repository-invalid',
          safeContext: { reason: 'cloud-bootstrap-binding-origin-mismatch' },
        });
        await expect(store.load(PROJECT_ID)).resolves.toMatchObject({ phase });
        const authorityExists = await stat(path.join(
          fixture.vaultRoot,
          '.claudian',
          'collab',
          'authorities',
          PROJECT_ID,
        )).then(
          () => true,
          error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          },
        );
        expect(authorityExists).toBe(phase === 'index-repaired');
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it.each(['index-repaired', 'lan-authority-retired'] as const)(
    'repairs Git refs and the complete index before advancing %s recovery',
    async phase => {
      const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-binding-repair-drift-'));
      try {
        const fixture = await createFixture(root);
        const store = await crashAfterCheckpoint(fixture, phase);
        await git(fixture.repositoryPath, ['update-ref', '-d', 'refs/remotes/origin/main']);
        await git(fixture.repositoryPath, [
          'update-ref',
          '-d',
          `refs/remotes/origin/members/${MEMBER_ID}`,
        ]);
        await writeFile(
          path.join(fixture.vaultRoot, '.claudian', 'collab', 'index.json'),
          JSON.stringify({ projects: [], schemaVersion: 3, selectedProjectId: null }),
        );
        const pending = await store.load(PROJECT_ID);

        await expect(createFinalizer(
          fixture,
          await createEffects(fixture),
          store,
        ).finalize(pending!)).resolves.toMatchObject({ phase: 'fence-terminal' });
        expect(await git(fixture.repositoryPath, ['rev-parse', 'refs/remotes/origin/main']))
          .toBe(fixture.mainOid);
        expect(await git(
          fixture.repositoryPath,
          ['rev-parse', `refs/remotes/origin/members/${MEMBER_ID}`],
        )).toBe(fixture.mainOid);
        await expect(new CollabLocalProjectRepository(fixture.vaultRoot).loadIndex())
          .resolves.toMatchObject({
            projects: [{ authorityKind: 'cloud', id: PROJECT_ID }],
          });
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it('refuses the terminal fence when the attempt-scoped retired authority is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-binding-retired-drift-'));
    try {
      const fixture = await createFixture(root);
      const store = await crashAfterCheckpoint(fixture, 'lan-authority-retired');
      await rm(path.join(
        fixture.vaultRoot,
        '.claudian',
        'collab',
        'retired-lan-authorities',
        PROJECT_ID,
        fixture.record.attemptId,
      ), { recursive: true });
      const pending = await store.load(PROJECT_ID);

      await expect(createFinalizer(
        fixture,
        await createEffects(fixture),
        store,
      ).finalize(pending!)).rejects.toMatchObject({
        code: 'durable-progress-recovery-required',
        safeContext: { reason: 'cloud-bootstrap-binding-retired-authority-missing' },
      });
      await expect(store.load(PROJECT_ID)).resolves.toMatchObject({
        phase: 'lan-authority-retired',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
