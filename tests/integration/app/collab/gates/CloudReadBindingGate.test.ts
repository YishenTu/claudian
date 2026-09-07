import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
  collabMemberRef,
  type DevelopmentBootstrapManifest,
  matchCollabCloudRoute,
} from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { WebSocketServer } from 'ws';

import {
  CloudBootstrapBindingFinalizer,
} from '@/app/collab/bootstrap/CloudBootstrapBindingFinalizer';
import type { CloudBootstrapCoordinator } from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import {
  CloudBootstrapReadinessCollector,
  type CloudBootstrapReadinessObservation,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import { CloudBootstrapService } from '@/app/collab/bootstrap/CloudBootstrapService';
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
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import {
  CollabAuthorityGitNetworkEnvironment,
} from '@/app/collab/remote-authority/CollabAuthorityGitNetworkEnvironment';

jest.setTimeout(30_000);

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const PROJECT_ID = 'project-cloud-gate';
const HOST_MEMBER_ID = 'member-alice';
const OTHER_MEMBER_ID = 'member-bob';
const OLD_ENDPOINT = 'https://192.168.1.20:54545/';
const OLD_REMOTE = `${OLD_ENDPOINT}v1/git/${PROJECT_ID}/repository.git`;

jest.setTimeout(30_000);

interface RepositoryFixture {
  readonly barePath: string;
  readonly mainOid: string;
  readonly memberOids: Readonly<Record<string, string>>;
}

interface GateServer {
  readonly origin: string;
  close(): Promise<void>;
}

interface ClientFixture {
  readonly finalizer: CloudBootstrapBindingFinalizer;
  readonly projects: CollabLocalProjectRepository;
  readonly repositoryPath: string;
  readonly store: CloudBootstrapTransitionStore;
  readonly transition: CloudBootstrapTransitionRecord;
  readonly vaultRoot: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function createRepository(root: string): Promise<RepositoryFixture> {
  const working = path.join(root, 'cloud-working');
  const barePath = path.join(root, 'repository.git');
  await mkdir(working);
  await git(working, ['init', '--initial-branch=main']);
  await git(working, ['config', 'user.name', 'Cloud Gate']);
  await git(working, ['config', 'user.email', 'gate@claudian.local']);
  await writeFile(path.join(working, 'shared.md'), 'shared cloud state\n');
  await git(working, ['add', 'shared.md']);
  await git(working, ['commit', '-m', 'main']);
  const mainOid = await git(working, ['rev-parse', 'HEAD']);
  const memberOids: Record<string, string> = {};
  for (const memberId of [HOST_MEMBER_ID, OTHER_MEMBER_ID]) {
    await git(working, ['switch', '-C', `members/${memberId}`, 'main']);
    await writeFile(path.join(working, `${memberId}.md`), `${memberId}\n`);
    await git(working, ['add', `${memberId}.md`]);
    await git(working, ['commit', '-m', memberId]);
    memberOids[memberId] = await git(working, ['rev-parse', 'HEAD']);
  }
  await git(root, ['clone', '--bare', working, barePath]);
  await git(barePath, ['symbolic-ref', 'HEAD', COLLAB_MAIN_REF]);
  return { barePath, mainOid, memberOids };
}

function bootstrapManifest(repository: RepositoryFixture): DevelopmentBootstrapManifest {
  return {
    attemptId: 'bootstrap-cloud-gate',
    comparison: {
      mainOid: repository.mainOid,
      mainRef: COLLAB_MAIN_REF,
      managerSetGeneration: 1,
      members: [{
        activatedAt: '2026-08-21T00:00:00.000Z',
        createdAt: '2026-08-20T00:00:00.000Z',
        displayName: 'Alice',
        memberId: HOST_MEMBER_ID,
        personalRef: collabMemberRef(HOST_MEMBER_ID),
        role: 'manager',
        status: 'active',
      }, {
        activatedAt: '2026-08-21T00:00:01.000Z',
        createdAt: '2026-08-20T00:00:01.000Z',
        displayName: 'Bob',
        memberId: OTHER_MEMBER_ID,
        personalRef: collabMemberRef(OTHER_MEMBER_ID),
        role: 'member',
        status: 'active',
      }],
      projectCreatedAt: '2026-08-20T00:00:00.000Z',
      projectId: PROJECT_ID,
      projectName: 'Cloud Gate',
      sourceCaFingerprint: 'b'.repeat(64),
      sourceEventSequence: 12,
      sourceHostMemberId: HOST_MEMBER_ID,
    },
    createdAt: '2026-08-22T00:00:00.000Z',
    git: {
      bundle: { byteCount: 128, sha256: 'c'.repeat(64) },
      objectFormat: 'sha1',
      refs: [
        { name: COLLAB_MAIN_REF, oid: repository.mainOid },
        {
          name: collabMemberRef(HOST_MEMBER_ID),
          oid: repository.memberOids[HOST_MEMBER_ID]!,
        },
        {
          name: collabMemberRef(OTHER_MEMBER_ID),
          oid: repository.memberOids[OTHER_MEMBER_ID]!,
        },
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

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function runGitHttpBackend(
  request: IncomingMessage,
  response: ServerResponse,
  repository: RepositoryFixture,
  suffix: string,
): Promise<void> {
  const gitProtocolHeader = request.headers['git-protocol'];
  const gitProtocol = Array.isArray(gitProtocolHeader)
    ? gitProtocolHeader[0]
    : gitProtocolHeader;
  const environment: NodeJS.ProcessEnv = {
    GIT_HTTP_EXPORT_ALL: '1',
    GIT_PROJECT_ROOT: path.dirname(repository.barePath),
    HTTP_GIT_PROTOCOL: gitProtocol ?? '',
    PATH_INFO: `/repository.git${suffix}`,
    QUERY_STRING: new URL(request.url ?? '/', 'http://127.0.0.1').search.slice(1),
    REMOTE_ADDR: '127.0.0.1',
    REQUEST_METHOD: request.method ?? 'GET',
    SERVER_PROTOCOL: 'HTTP/1.1',
    ...(request.headers['content-length'] === undefined
      ? {}
      : { CONTENT_LENGTH: request.headers['content-length'] }),
    ...(request.headers['content-type'] === undefined
      ? {}
      : { CONTENT_TYPE: request.headers['content-type'] }),
  };
  const child = spawn(GIT_EXECUTABLE, ['http-backend'], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.resume();
  request.pipe(child.stdin);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`git-http-backend:${String(code)}`)));
  });
  const output = Buffer.concat(stdout);
  const headerEnd = output.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new Error('git-http-backend-headers');
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, headerEnd).toString('ascii').split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (name.toLocaleLowerCase('en-US') === 'status') status = Number(value.slice(0, 3));
    else headers[name] = value;
  }
  response.writeHead(status, headers);
  response.end(output.subarray(headerEnd + 4));
}

async function startGateServer(repository: RepositoryFixture): Promise<GateServer> {
  const manifest = bootstrapManifest(repository);
  const limits = {
    maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
    maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
    maxCheckpointRepositoryBundleBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
    maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    maxDevelopmentBootstrapGitBundleBytes: 1024,
    maxDevelopmentBootstrapManifestUtf8Bytes: 1024,
    maxDevelopmentBootstrapReportUtf8Bytes: 1024,
    maxEventReplay: COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay,
    maxGitReceivePackBytes: 1024,
    maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
    maxRepositoryBytes: 1024 * 1024,
  };
  const webSockets = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    void (async () => {
      const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
      if (match?.kind === 'capabilities') {
        writeJson(response, 200, collabCloudCapabilityDocument([
          'git-upload-pack',
          'project-events',
          'project-snapshot',
        ], limits));
        return;
      }
      const actor = request.headers['x-claudian-development-actor'];
      if (
        typeof actor !== 'string'
        || ![HOST_MEMBER_ID, OTHER_MEMBER_ID].includes(actor)
        || !match
        || ('projectId' in match && match.projectId !== PROJECT_ID)
      ) {
        response.writeHead(403).end();
        return;
      }
      if (match.kind === 'project-operation' && match.operation === 'getProjectSnapshot') {
        const requestEnvelope = JSON.parse((await readBody(request)).toString('utf8')) as {
          requestId: string;
        };
        const member = manifest.comparison.members.find(candidate => candidate.memberId === actor)!;
        writeJson(response, 200, collabCloudSuccessEnvelope(requestEnvelope.requestId, {
          currentMember: {
            activatedAt: member.activatedAt,
            createdAt: member.createdAt,
            displayName: member.displayName,
            id: member.memberId,
            personalRef: member.personalRef,
            role: member.role,
            status: member.status,
          },
          eventSequence: 18,
          members: manifest.comparison.members.map(candidate => ({
            activatedAt: candidate.activatedAt,
            createdAt: candidate.createdAt,
            displayName: candidate.displayName,
            id: candidate.memberId,
            personalRef: candidate.personalRef,
            role: candidate.role,
            status: candidate.status,
          })),
          openRequests: [],
          openTicketCount: 0,
          project: {
            createdAt: manifest.comparison.projectCreatedAt,
            expectedMainOid: manifest.comparison.mainOid,
            id: PROJECT_ID,
            mainRef: COLLAB_MAIN_REF,
            name: manifest.comparison.projectName,
          },
          ticketHighlights: [],
        }));
        return;
      }
      if (
        match.kind === 'git-info-refs'
        || match.kind === 'git-upload-pack'
      ) {
        const prefix = `/v2/projects/${PROJECT_ID}/repository.git`;
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        await runGitHttpBackend(request, response, repository, pathname.slice(prefix.length));
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.writeHead(500).end());
  });
  server.on('upgrade', (request, socket, head) => {
    const match = matchCollabCloudRoute(request.method ?? '', request.url ?? '');
    const actor = request.headers['x-claudian-development-actor'];
    if (
      match?.kind !== 'project-events'
      || match.projectId !== PROJECT_ID
      || typeof actor !== 'string'
      || ![HOST_MEMBER_ID, OTHER_MEMBER_ID].includes(actor)
    ) {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, client => {
      webSockets.emit('connection', client, request);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('gate-server-address');
  return {
    close: async () => {
      for (const client of webSockets.clients) client.terminate();
      webSockets.close();
      await new Promise<void>((resolve, reject) => server.close(error => (
        error ? reject(error) : resolve()
      )));
    },
    origin: `http://127.0.0.1:${String(address.port)}`,
  };
}

function membership(memberId: string, ownsAuthority: boolean): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: OLD_ENDPOINT,
      gitRemoteUrl: OLD_REMOTE,
      hostCaCertificatePem: [
        '-----BEGIN CERTIFICATE-----',
        'GATE',
        '-----END CERTIFICATE-----',
      ].join('\n'),
      hostCaFingerprint: 'b'.repeat(64),
      kind: 'lan',
    },
    createdAt: '2026-08-20T00:00:00.000Z',
    hostOwnership: { autoStart: false, ownsAuthority },
    lastEventSequence: 12,
    lifecycle: 'active',
    member: {
      credential: 'A'.repeat(43),
      displayName: ownsAuthority ? 'Alice' : 'Bob',
      id: memberId,
      personalRef: collabMemberRef(memberId),
      role: ownsAuthority ? 'manager' : 'member',
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Gate',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

function readiness(
  manifest: DevelopmentBootstrapManifest,
  memberId: string,
): CloudBootstrapReadinessObservation {
  const member = manifest.comparison.members.find(candidate => candidate.memberId === memberId)!;
  const personalOid = manifest.git.refs.find(candidate => candidate.name === member.personalRef)!.oid;
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
      hasPrivateDraft: false,
      hasUnpublishedFiles: true,
    },
    projectOperationQueue: { activeCount: 0, queuedCount: 0 },
    projectWorkSession: 'closed',
    repository: {
      mainOid: manifest.comparison.mainOid,
      memberId,
      objectFormat: manifest.git.objectFormat,
      personalRef: member.personalRef,
      personalRefOid: personalOid,
      projectId: manifest.comparison.projectId,
    },
  };
}

async function createClient(
  root: string,
  repository: RepositoryFixture,
  serverOrigin: string,
  memberId: string,
): Promise<ClientFixture> {
  const vaultRoot = path.join(root, memberId);
  await mkdir(vaultRoot);
  const projects = new CollabLocalProjectRepository(vaultRoot, {
    installationKey: TEST_INSTALLATION_A,
  });
  const workspace = new CollabWorkspaceService(vaultRoot);
  await workspace.claimProjectsFolder('workspace');
  const repositoryPath = path.join(vaultRoot, 'workspace', PROJECT_ID);
  await git(path.join(vaultRoot, 'workspace'), ['clone', repository.barePath, PROJECT_ID]);
  await git(repositoryPath, ['remote', 'set-url', 'origin', OLD_REMOTE]);
  await writeFile(path.join(repositoryPath, 'unpublished.md'), `${memberId} local work\n`);
  const ownsAuthority = memberId === HOST_MEMBER_ID;
  await projects.upsertProject({
    authorityKind: 'lan',
    createdAt: '2026-08-20T00:00:00.000Z',
    id: PROJECT_ID,
    name: 'Cloud Gate',
    updatedAt: '2026-08-21T00:00:00.000Z',
    workspacePath: `workspace/${PROJECT_ID}`,
  });
  await projects.saveMembership(membership(memberId, ownsAuthority));
  if (ownsAuthority) {
    const authorityDirectory = (
      await projects.createOwnedAuthorityDirectory(PROJECT_ID)
    ).authorityDirectory;
    await writeFile(path.join(authorityDirectory, 'collab.db'), 'inert after binding');
  }
  const manifest = bootstrapManifest(repository);
  const store = new CloudBootstrapTransitionStore(vaultRoot, { isRecoveryOwner: () => true });
  let transition = await store.create(createCloudBootstrapTransitionRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
    developmentActorId: memberId,
    ...(ownsAuthority ? { fenceId: 'bootstrap-cloud-gate-fence' } : {}),
    manifest,
    manifestSha256: developmentBootstrapManifestSha256(manifest),
    memberId,
    oldEndpoint: OLD_ENDPOINT,
    oldGitRemoteUrl: OLD_REMOTE,
    serverUrl: serverOrigin,
    timestamp: '2026-08-22T00:00:01.000Z',
  }));
  if (ownsAuthority) {
    transition = markCloudBootstrapHostStopped(
      transition,
      '2026-08-22T00:00:02.000Z',
      '2026-08-22T00:00:02.000Z',
    );
    await store.save(transition);
  }
  transition = observeCloudBootstrapAttemptStatus(transition, {
    activationPhase: 'completed',
    activationResult: {
      activatedAt: '2026-08-22T00:00:03.000Z',
      activationOperationId: 'activation-cloud-gate',
      placementGeneration: 1,
      projectId: PROJECT_ID,
    },
    attemptId: manifest.attemptId,
    bundleState: 'validated',
    createdAt: '2026-08-22T00:00:00.000Z',
    expiresAt: '2026-08-23T00:00:00.000Z',
    manifestSha256: developmentBootstrapManifestSha256(manifest),
    projectId: PROJECT_ID,
    reporterMemberIds: [HOST_MEMBER_ID, OTHER_MEMBER_ID],
    state: 'activated',
  }, '2026-08-22T00:00:03.000Z');
  await store.save(transition);
  const runner = new GitCommandRunner({
    emptyConfigPath: await projects.ensureGitEmptyConfig(),
    executablePath: GIT_EXECUTABLE,
  });
  const repositories = new GitRepositoryService(runner);
  const network = new CollabAuthorityGitNetworkEnvironment(vaultRoot);
  const finalizer = new CloudBootstrapBindingFinalizer({
    effects: new LocalCloudBootstrapBindingEffects({
      activation: {
        get: async () => ({
          activationPhase: 'completed',
          activationResult: transition.activationResult,
          attemptId: transition.attemptId,
          bundleState: 'validated',
          createdAt: transition.createdAt,
          expiresAt: '2026-08-23T00:00:00.000Z',
          manifestSha256: transition.manifestSha256,
          projectId: transition.projectId,
          reporterMemberIds: [HOST_MEMBER_ID, OTHER_MEMBER_ID],
          state: 'activated',
        } as never),
      },
      authorityAdapter: new CloudAuthorityAdapter(),
      authorityLifecycle: { closeAuthority: async () => undefined },
      git: {
        assertOrigin: (record, localPath) => ensureTrustedCollabOrigin(repositories, {
          projectId: record.projectId,
          remoteUrl: record.newAuthority.gitRemoteUrl,
          repositoryPath: localPath,
        }, 'cloud-bootstrap-binding-origin-mismatch'),
        fetchFromUrl: (...input) => repositories.fetchFromUrl(...input),
        network: (projectId, facts) => network.resolve(projectId, facts),
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
        inspect: async () => readiness(manifest, memberId),
      }),
      retireLanAuthorityDirectory: async (retiredProjectId, attemptId) => (
        projects.retireOwnedAuthorityDirectory(
          await projects.assertOwnedAuthorityRetirement(retiredProjectId, attemptId),
          attemptId,
        )
      ),
      workspace,
    }),
    now: () => new Date('2026-08-22T00:01:00.000Z'),
    transitions: store,
  });
  return { finalizer, projects, repositoryPath, store, transition, vaultRoot };
}

describe('Cloud read and binding gate', () => {
  it('binds and restarts two clients through real upload-pack without reviving LAN', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-read-binding-'));
    const repository = await createRepository(root);
    const server = await startGateServer(repository);
    try {
      const clients = await Promise.all([
        createClient(root, repository, server.origin, HOST_MEMBER_ID),
        createClient(root, repository, server.origin, OTHER_MEMBER_ID),
      ]);
      const snapshots = [];
      for (const client of clients) {
        const completed = await client.finalizer.finalize(client.transition);
        expect(completed).toMatchObject({
          attemptState: 'activated',
          phase: 'fence-terminal',
        });
        const storedMembership = await client.projects.loadMembership(PROJECT_ID);
        expect(storedMembership && isCollabLocalCloudMembership(storedMembership)).toBe(true);
        expect(JSON.stringify(storedMembership)).not.toContain('credential');
        expect(JSON.stringify(storedMembership)).not.toContain('CERTIFICATE');
        expect((await client.projects.loadIndex()).projects[0]?.authorityKind).toBe('cloud');
        expect(await git(client.repositoryPath, ['remote', 'get-url', 'origin']))
          .toBe(`${server.origin}/v2/projects/${PROJECT_ID}/repository.git`);
        expect(await readFile(path.join(client.repositoryPath, 'unpublished.md'), 'utf8'))
          .toBe(`${storedMembership?.member.id} local work\n`);

        const session = await new CloudAuthorityAdapter().create(storedMembership!);
        snapshots.push(await session.control.readSnapshot(PROJECT_ID));
        let eventConnection: { dispose(): void } | undefined;
        const invalidation = new Promise(resolve => {
          eventConnection = session.events.connect({
            afterSequence: storedMembership!.lastEventSequence,
            onInvalidation: async value => {
              resolve(value);
              return value.sequence;
            },
          });
        });
        await expect(invalidation).resolves.toMatchObject({ kind: 'snapshot' });
        eventConnection?.dispose();
        session.dispose();

        await client.store.save(markCloudBootstrapTerminalCleanupCompleted(
          completed,
          '2026-08-22T00:02:00.000Z',
        ));

        const restarted = await client.store.load(PROJECT_ID);
        expect(restarted).not.toBeNull();
        const fenceUncertainProject = jest.fn(async () => undefined);
        const recoverProject = jest.fn(async () => restarted);
        const restartService = new CloudBootstrapService({
          assertHostInstallationOwned: async () => undefined,
          assertRecoveryOwner: () => undefined,
          createCoordinator: () => ({ recoverProject } as unknown as CloudBootstrapCoordinator),
          fenceUncertainProject,
          projectRecoveryAdmission: async (_projectId, operation) => operation(),
          recoverLocalArtifacts: async () => undefined,
          transitions: client.store,
        });
        await restartService.recoverPending();
        expect(fenceUncertainProject).not.toHaveBeenCalled();
        expect(recoverProject).not.toHaveBeenCalled();
        await restartService.close();
      }
      expect(snapshots[0]?.project).toEqual(snapshots[1]?.project);
      expect(snapshots[0]?.members).toEqual(snapshots[1]?.members);
      expect(snapshots.map(snapshot => snapshot.currentMember.id))
        .toEqual([HOST_MEMBER_ID, OTHER_MEMBER_ID]);

      await expect(stat(path.join(
        clients[0]!.vaultRoot,
        '.claudian',
        'collab',
        'authorities',
        PROJECT_ID,
      ))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(
        clients[0]!.vaultRoot,
        '.claudian',
        'collab',
        'retired-lan-authorities',
        PROJECT_ID,
        'bootstrap-cloud-gate',
        'collab.db',
      ), 'utf8')).resolves.toBe('inert after binding');
      await expect(stat(path.join(
        clients[1]!.vaultRoot,
        '.claudian',
        'collab',
        'retired-lan-authorities',
      ))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await server.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
