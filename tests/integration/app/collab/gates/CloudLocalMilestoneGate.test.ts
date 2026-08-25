import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapManifest,
} from '@claudian-collab/protocol';

import {
  CloudBootstrapBindingFinalizer,
} from '@/app/collab/bootstrap/CloudBootstrapBindingFinalizer';
import {
  CloudBootstrapReadinessCollector,
  type CloudBootstrapReadinessObservation,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import {
  type CloudBootstrapTransitionRecord,
  createCloudBootstrapTransitionRecord,
  developmentBootstrapManifestSha256,
  markCloudBootstrapHostStopped,
  markCloudBootstrapTerminalCleanupCompleted,
  observeCloudBootstrapAttemptStatus,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CloudBootstrapTransitionStore } from '@/app/collab/bootstrap/CloudBootstrapTransitionStore';
import {
  LocalCloudBootstrapBindingEffects,
} from '@/app/collab/bootstrap/LocalCloudBootstrapBindingEffects';
import {
  type CollabLocalCloudMembershipRecord,
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
import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';
import {
  COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
} from '@/app/collab/publish/CollabRequestDraftRecord';
import { CollabRequestDraftStore } from '@/app/collab/publish/CollabRequestDraftStore';
import {
  NativeGitPublishRepository,
  type PublishAcceptedStatePort,
  type PublishGitNetworkPort,
} from '@/app/collab/publish/NativeGitPublishRepository';
import {
  PublishCoordinator,
  type PublishProjectContext,
} from '@/app/collab/publish/PublishCoordinator';
import { NativeGitAcceptedStateIntegrator } from '@/app/collab/reconciliation/NativeGitAcceptedStateIntegrator';
import { ReconciliationCoordinator } from '@/app/collab/reconciliation/ReconciliationCoordinator';
import { ReconciliationMutationSafety } from '@/app/collab/reconciliation/ReconciliationMutationSafety';
import { ReconciliationRepository } from '@/app/collab/reconciliation/ReconciliationRepository';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import {
  CollabAuthorityGitNetworkEnvironment,
} from '@/app/collab/remote-authority/CollabAuthorityGitNetworkEnvironment';
import type {
  CollabAuthorityEventInvalidation,
  CollabAuthoritySession,
} from '@/app/collab/remote-authority/CollabAuthoritySession';

jest.setTimeout(120_000);

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const HOST_MEMBER_ID = 'member-alice';
const OTHER_MEMBER_ID = 'member-bob';
const OLD_ENDPOINT = 'https://192.168.1.20:54545/';

interface GateDescriptor {
  readonly activationStatus: DevelopmentBootstrapAttemptStatus;
  readonly manifest: DevelopmentBootstrapManifest;
  readonly origin: string;
  readonly resultPath: string;
  readonly seedPath: string;
}

interface ClientFixture {
  readonly git: GitRepositoryService;
  readonly memberId: string;
  readonly projects: CollabLocalProjectRepository;
  readonly publicationState: CollabPublicationStateStore;
  readonly repositoryPath: string;
  readonly runner: GitCommandRunner;
  readonly vaultRoot: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function sourceMembership(
  descriptor: GateDescriptor,
  memberId: string,
): CollabLocalLanMembershipRecord {
  const member = descriptor.manifest.comparison.members.find(candidate => (
    candidate.memberId === memberId
  ));
  if (!member) throw new Error('Gate Member is absent from the bootstrap manifest');
  const projectId = descriptor.manifest.comparison.projectId;
  const ownsAuthority = memberId === descriptor.manifest.comparison.sourceHostMemberId;
  return {
    authority: {
      endpoint: OLD_ENDPOINT,
      gitRemoteUrl: `${OLD_ENDPOINT}v1/git/${projectId}/repository.git`,
      hostCaCertificatePem: [
        '-----BEGIN CERTIFICATE-----',
        'LOCALMILESTONE',
        '-----END CERTIFICATE-----',
      ].join('\n'),
      hostCaFingerprint: descriptor.manifest.comparison.sourceCaFingerprint,
      kind: 'lan',
    },
    createdAt: member.createdAt,
    hostOwnership: { autoStart: false, ownsAuthority },
    lastEventSequence: descriptor.manifest.comparison.sourceEventSequence,
    lifecycle: 'active',
    member: {
      credential: 'A'.repeat(43),
      displayName: member.displayName,
      id: member.memberId,
      personalRef: member.personalRef,
      role: member.role,
    },
    project: {
      id: projectId,
      name: descriptor.manifest.comparison.projectName,
      workspacePath: `workspace/${projectId}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: member.activatedAt,
  };
}

function readiness(
  descriptor: GateDescriptor,
  memberId: string,
): CloudBootstrapReadinessObservation {
  const member = descriptor.manifest.comparison.members.find(candidate => (
    candidate.memberId === memberId
  ));
  const personal = descriptor.manifest.git.refs.find(candidate => (
    candidate.name === member?.personalRef
  ));
  if (!member || !personal) throw new Error('Gate readiness identity is incomplete');
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
      hasLocalOnlyCommits: false,
      hasPrivateDraft: memberId === HOST_MEMBER_ID,
      hasUnpublishedFiles: memberId === HOST_MEMBER_ID,
    },
    projectOperationQueue: { activeCount: 0, queuedCount: 0 },
    projectWorkSession: 'closed',
    repository: {
      mainOid: descriptor.manifest.comparison.mainOid,
      memberId,
      objectFormat: descriptor.manifest.git.objectFormat,
      personalRef: member.personalRef,
      personalRefOid: personal.oid,
      projectId: descriptor.manifest.comparison.projectId,
    },
  };
}

async function createClient(
  root: string,
  descriptor: GateDescriptor,
  memberId: string,
): Promise<ClientFixture> {
  const projectId = descriptor.manifest.comparison.projectId;
  const source = sourceMembership(descriptor, memberId);
  const vaultRoot = path.join(root, memberId);
  await mkdir(vaultRoot);
  const projects = new CollabLocalProjectRepository(vaultRoot);
  const workspace = new CollabWorkspaceService(vaultRoot);
  await workspace.claimProjectsFolder('workspace');
  const emptyConfigPath = await projects.ensureGitEmptyConfig();
  const runner = new GitCommandRunner({
    emptyConfigPath,
    executablePath: GIT_EXECUTABLE,
  });
  const repositories = new GitRepositoryService(runner);
  const repositoryPath = await repositories.cloneRepository({
    branch: source.member.personalRef.slice('refs/heads/'.length),
    directoryName: projectId,
    parentDirectory: path.join(vaultRoot, 'workspace'),
    remoteUrl: descriptor.seedPath,
  });
  await repositories.configureLocalRepository(repositoryPath, {
    memberId,
    personalRef: source.member.personalRef,
    projectId,
    userDisplayName: source.member.displayName,
  });
  await git(repositoryPath, ['remote', 'set-url', 'origin', source.authority.gitRemoteUrl!]);
  await projects.upsertProject({
    authorityKind: 'lan',
    createdAt: source.createdAt,
    id: projectId,
    name: source.project.name,
    updatedAt: source.updatedAt,
    workspacePath: source.project.workspacePath,
  });
  await projects.saveMembership(source);
  if (source.hostOwnership.ownsAuthority) {
    const authorityDirectory = await projects.ensureAuthorityDirectory(projectId);
    await writeFile(path.join(authorityDirectory, 'collab.db'), 'must remain retired');
    await writeFile(path.join(repositoryPath, 'unpublished.md'), 'Alice local unpublished work\n');
    await new CollabRequestDraftStore(projects).save({
      createdAt: '2026-08-23T00:00:00.000Z',
      description: 'Alice private local draft',
      projectId,
      schemaVersion: COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
      syncState: 'local',
      updatedAt: '2026-08-23T00:00:00.000Z',
    });
  }
  const publicationState = new CollabPublicationStateStore(projects);
  await publicationState.save({
    baseMainOid: descriptor.manifest.comparison.mainOid,
    operation: null,
    projectId,
    schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
    updatedAt: '2026-08-23T00:00:00.000Z',
  });

  const transitions = new CloudBootstrapTransitionStore(vaultRoot);
  let transition: CloudBootstrapTransitionRecord = await transitions.create(
    createCloudBootstrapTransitionRecord({
      developmentActorId: memberId,
      ...(source.hostOwnership.ownsAuthority ? { fenceId: 'local-milestone-fence' } : {}),
      manifest: descriptor.manifest,
      manifestSha256: developmentBootstrapManifestSha256(descriptor.manifest),
      memberId,
      oldEndpoint: OLD_ENDPOINT,
      oldGitRemoteUrl: source.authority.gitRemoteUrl!,
      serverUrl: descriptor.origin,
      timestamp: '2026-08-23T00:00:01.000Z',
    }),
  );
  if (source.hostOwnership.ownsAuthority) {
    transition = markCloudBootstrapHostStopped(
      transition,
      '2026-08-23T00:00:02.000Z',
      '2026-08-23T00:00:02.000Z',
    );
    await transitions.save(transition);
  }
  transition = observeCloudBootstrapAttemptStatus(
    transition,
    descriptor.activationStatus,
    '2026-08-23T00:00:03.000Z',
  );
  await transitions.save(transition);

  const network = new CollabAuthorityGitNetworkEnvironment(vaultRoot);
  const finalizer = new CloudBootstrapBindingFinalizer({
    effects: new LocalCloudBootstrapBindingEffects({
      activation: { get: async () => descriptor.activationStatus },
      authorityAdapter: new CloudAuthorityAdapter(),
      authorityLifecycle: { closeAuthority: async () => undefined },
      git: {
        assertOrigin: (record, localPath) => ensureTrustedCollabOrigin(repositories, {
          allowHostRemoteRepair: false,
          projectId: record.projectId,
          remoteUrl: record.newAuthority.gitRemoteUrl,
          repositoryPath: localPath,
        }, 'cloud-local-milestone-origin-mismatch'),
        fetchFromUrl: (...input) => repositories.fetchFromUrl(...input),
        network: (resolvedProjectId, facts) => network.resolve(resolvedProjectId, facts),
        resolveRefs: (...input) => repositories.resolveRefs(...input),
        rotateOrigin: (record, localPath) => rotateCloudBootstrapOrigin(repositories, {
          newRemoteUrl: record.newAuthority.gitRemoteUrl,
          oldRemoteUrl: record.oldAuthority.gitRemoteUrl,
          projectId: record.projectId,
          repositoryPath: localPath,
        }),
      },
      projects,
      readiness: new CloudBootstrapReadinessCollector({
        inspect: async () => readiness(descriptor, memberId),
      }),
      workspace,
    }),
    now: () => new Date('2026-08-23T00:01:00.000Z'),
    transitions,
  });
  const completed = await finalizer.finalize(transition);
  expect(completed).toMatchObject({ attemptState: 'activated', phase: 'fence-terminal' });
  await transitions.save(markCloudBootstrapTerminalCleanupCompleted(
    completed,
    '2026-08-23T00:01:01.000Z',
  ));
  const stored = await projects.loadMembership(projectId);
  expect(stored && isCollabLocalCloudMembership(stored)).toBe(true);
  expect(await git(repositoryPath, ['remote', 'get-url', 'origin']))
    .toBe(`${descriptor.origin}/v2/projects/${projectId}/repository.git`);
  return {
    git: repositories,
    memberId,
    projects,
    publicationState,
    repositoryPath,
    runner,
    vaultRoot,
  };
}

class SessionNetwork implements PublishGitNetworkPort {
  private readonly environment: CollabAuthorityGitNetworkEnvironment;

  constructor(
    vaultRoot: string,
    private readonly session: CollabAuthoritySession,
  ) {
    this.environment = new CollabAuthorityGitNetworkEnvironment(vaultRoot);
  }

  withNetwork<T>(
    context: PublishProjectContext,
    operation: Parameters<PublishGitNetworkPort['withNetwork']>[1],
  ): Promise<T> {
    return this.environment.resolve(context.projectId, this.session.git)
      .then(network => operation(network) as Promise<T>);
  }
}

function fixedProject(context: PublishProjectContext) {
  return {
    load: async () => context,
    revalidate: async () => undefined,
  };
}

function unusedCandidates() {
  const unused = async () => {
    throw new Error('The local milestone Publish must not create a conflict candidate');
  };
  return {
    apply: unused,
    assertRetained: unused,
    cleanup: unused,
    prepare: unused,
  };
}

function rejectingAcceptedState(): PublishAcceptedStatePort {
  return {
    classifyDivergence: async () => {
      throw new Error('The local milestone Publish must begin at current main');
    },
  };
}

async function waitForEvents(
  events: readonly (readonly CollabAuthorityEventInvalidation[])[],
  expectedSequence: number,
): Promise<void> {
  const startedAt = Date.now();
  while (events.some(values => values.at(-1)?.sequence !== expectedSequence)) {
    if (Date.now() - startedAt > 10_000) throw new Error('Cloud event convergence timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const descriptorPath = process.env.CLAUDIAN_CLOUD_LOCAL_GATE_DESCRIPTOR;
const describeWithServer = descriptorPath === undefined ? describe.skip : describe;

describeWithServer('Cloud localhost client milestone gate', () => {
  it('binds, restarts, collaborates, accepts, and reconciles two independent clients', async () => {
    if (descriptorPath === undefined) throw new Error('Missing Cloud gate descriptor');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as GateDescriptor;
    const projectId = descriptor.manifest.comparison.projectId;
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-local-gate-'));
    const sessions: CollabAuthoritySession[] = [];
    const eventConnections: { dispose(): void }[] = [];
    try {
      const clients = await Promise.all([
        createClient(root, descriptor, HOST_MEMBER_ID),
        createClient(root, descriptor, OTHER_MEMBER_ID),
      ]);
      const clientByMember = new Map(clients.map(client => [client.memberId, client]));
      const initialSessions = await Promise.all(clients.map(async client => {
        const restartedProjects = new CollabLocalProjectRepository(client.vaultRoot);
        const transition = await new CloudBootstrapTransitionStore(client.vaultRoot)
          .load(projectId);
        expect(transition).toMatchObject({
          attemptState: 'activated',
          phase: 'fence-terminal',
          terminalCleanupCompleted: true,
        });
        const membership = await restartedProjects.loadMembership(projectId);
        if (!membership || !isCollabLocalCloudMembership(membership)) {
          throw new Error('Cloud membership was not durably bound');
        }
        return new CloudAuthorityAdapter().create(membership);
      }));
      sessions.push(...initialSessions);
      const events: CollabAuthorityEventInvalidation[][] = [[], []];
      for (const [index, session] of initialSessions.entries()) {
        eventConnections.push(session.events.connect({
          afterSequence: 0,
          onInvalidation: async invalidation => {
            events[index]!.push(invalidation);
            return invalidation.sequence;
          },
        }));
      }

      const bob = clientByMember.get(OTHER_MEMBER_ID)!;
      const bobSession = initialSessions[1]!;
      await writeFile(path.join(bob.repositoryPath, 'published.md'), 'Published by Bob\n');
      const bobMembership = await bob.projects.loadMembership(projectId) as
        CollabLocalCloudMembershipRecord;
      const publishContext: PublishProjectContext = {
        allowHostRemoteRepair: false,
        memberId: OTHER_MEMBER_ID,
        personalRef: bobMembership.member.personalRef,
        projectId,
        remoteUrl: bobSession.git.remoteUrl,
        repositoryPath: bob.repositoryPath,
      };
      const publishRepository = new NativeGitPublishRepository(bob.git, {
        acceptedState: rejectingAcceptedState(),
        network: new SessionNetwork(bob.vaultRoot, bobSession),
      });
      const publish = new PublishCoordinator(
        fixedProject(publishContext),
        publishRepository,
        bobSession.control,
        { assertSafe: async () => undefined },
        bob.publicationState,
        unusedCandidates(),
        { compare: async () => [] },
        { createOperationId: () => 'local-milestone-publish' },
      );
      await expect(publish.publish({
        description: 'Bob local milestone contribution',
        projectId,
      })).resolves.toMatchObject({
        status: 'success',
        value: { state: 'request-synchronized' },
      });

      const aliceSession = initialSessions[0]!;
      const aliceSnapshot = await aliceSession.control.readSnapshot(projectId);
      const request = aliceSnapshot.openRequests.find(candidate => (
        candidate.memberId === OTHER_MEMBER_ID
      ));
      expect(request).toBeDefined();
      const ticket = await aliceSession.control.createTicket({
        body: 'Track the localhost milestone',
        projectId,
        title: 'Local milestone',
      }, 'local-milestone-ticket');
      await bobSession.control.addTicketComment({
        body: 'Observed by the publishing client',
        projectId,
        ticketId: ticket.ticket.id,
      }, 'local-milestone-ticket-comment');
      await aliceSession.control.createComment({
        body: 'Reviewed through the Cloud authority',
        idempotencyKey: 'local-milestone-request-comment',
        projectId,
        requestId: request!.id,
      });
      await expect(bobSession.control.readTicket(projectId, ticket.ticket.id))
        .resolves.toMatchObject({
          comments: { comments: [expect.objectContaining({ authorMemberId: OTHER_MEMBER_ID })] },
        });
      const reviewed = await aliceSession.control.readRequest(projectId, request!.id);
      expect(reviewed.comments.comments).toHaveLength(1);
      const accepted = await aliceSession.control.acceptRequest({
        expectedHeadOid: reviewed.request.latestHeadOid,
        expectedMainOid: reviewed.currentMainOid,
        expectedRequestRevision: reviewed.request.revision,
        expectedResolvingTickets: [],
        idempotencyKey: 'local-milestone-accept',
        projectId,
        requestId: request!.id,
      });
      expect(accepted.request.status).toBe('merged');
      expect(accepted.mainOid).toBe(accepted.mergeCommitOid);

      const finalSnapshots = await Promise.all(initialSessions.map(session => (
        session.control.readSnapshot(projectId)
      )));
      await waitForEvents(events, finalSnapshots[0]!.eventSequence);
      expect(finalSnapshots[1]!.eventSequence).toBe(finalSnapshots[0]!.eventSequence);
      expect(finalSnapshots.map(value => value.project.mainOid))
        .toEqual([accepted.mainOid, accepted.mainOid]);
      for (const [client, snapshot] of clients.map((client, index) => (
        [client, finalSnapshots[index]!] as const
      ))) {
        await client.projects.updateMembershipProjection(
          projectId,
          snapshot.currentMember.id,
          snapshot.currentMember.role,
          snapshot.eventSequence,
        );
      }

      for (const connection of eventConnections.splice(0)) connection.dispose();
      for (const session of sessions.splice(0)) session.dispose();
      const restartedSessions = await Promise.all(clients.map(async client => {
        const restartedProjects = new CollabLocalProjectRepository(client.vaultRoot);
        const membership = await restartedProjects.loadMembership(projectId);
        if (!membership || !isCollabLocalCloudMembership(membership)) {
          throw new Error('Restart did not retain Cloud authority binding');
        }
        return new CloudAuthorityAdapter().create(membership);
      }));
      sessions.push(...restartedSessions);
      await expect(Promise.all(restartedSessions.map(session => (
        session.control.readSnapshot(projectId)
      )))).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ project: expect.objectContaining({ mainOid: accepted.mainOid }) }),
      ]));

      const acceptedState = new NativeGitAcceptedStateIntegrator(bob.git, bob.runner);
      const restartedBobNetwork = new SessionNetwork(bob.vaultRoot, restartedSessions[1]!);
      const reconciliationPublish = new NativeGitPublishRepository(bob.git, {
        acceptedState,
        network: restartedBobNetwork,
      });
      const reconciliation = new ReconciliationCoordinator(
        fixedProject(publishContext),
        new ReconciliationRepository(reconciliationPublish, acceptedState),
        restartedSessions[1]!.control,
        new ReconciliationMutationSafety(acceptedState),
        bob.publicationState,
        { createOperationId: () => 'local-milestone-reconcile' },
      );
      await expect(reconciliation.reconcile(projectId)).resolves.toMatchObject({
        status: 'success',
        value: { headOid: accepted.mainOid, state: 'fast-forwarded' },
      });

      const alice = clientByMember.get(HOST_MEMBER_ID)!;
      const aliceMembership = await alice.projects.loadMembership(projectId) as
        CollabLocalCloudMembershipRecord;
      const aliceContext: PublishProjectContext = {
        allowHostRemoteRepair: false,
        memberId: HOST_MEMBER_ID,
        personalRef: aliceMembership.member.personalRef,
        projectId,
        remoteUrl: restartedSessions[0]!.git.remoteUrl,
        repositoryPath: alice.repositoryPath,
      };
      const aliceAcceptedState = new NativeGitAcceptedStateIntegrator(alice.git, alice.runner);
      const aliceRepository = new NativeGitPublishRepository(alice.git, {
        acceptedState: aliceAcceptedState,
        network: new SessionNetwork(alice.vaultRoot, restartedSessions[0]!),
      });
      const aliceBeforeFetch = await aliceRepository.inspect(aliceContext);
      await aliceRepository.fetch(aliceContext, aliceBeforeFetch);
      await expect(aliceRepository.inspect(aliceContext)).resolves.toMatchObject({
        acceptedMainOid: accepted.mainOid,
        workingTreeClean: false,
      });

      const retiredAuthority = path.join(
        alice.vaultRoot,
        '.claudian',
        'collab',
        'retired-lan-authorities',
        projectId,
        descriptor.manifest.attemptId,
        'collab.db',
      );
      await expect(stat(path.join(
        alice.vaultRoot,
        '.claudian',
        'collab',
        'authorities',
        projectId,
      ))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(retiredAuthority, 'utf8')).resolves.toBe('must remain retired');
      await expect(readFile(path.join(alice.repositoryPath, 'unpublished.md'), 'utf8'))
        .resolves.toBe('Alice local unpublished work\n');
      await expect(new CollabRequestDraftStore(alice.projects).load(projectId))
        .resolves.toMatchObject({ description: 'Alice private local draft', syncState: 'local' });

      await writeFile(descriptor.resultPath, JSON.stringify({
        acceptedMainOid: accepted.mainOid,
        formerHostRetired: true,
        localWorkPreserved: true,
        requestId: request!.id,
      }), { mode: 0o600 });
    } finally {
      for (const connection of eventConnections) connection.dispose();
      for (const session of sessions) session.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
