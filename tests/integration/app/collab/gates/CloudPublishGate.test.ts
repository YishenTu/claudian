import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  collabCloudCapabilityDocument,
  collabCloudSuccessEnvelope,
  collabControlOperationCodec,
  collabMemberRef,
  decodeCollabProtocolEnvelope,
  matchCollabCloudRoute,
} from '@claudian-collab/protocol';
import { createDevelopmentCloudAuthorityAdapter, developmentCloudGitNetwork } from '@test/helpers/collab/developmentCloudTransports';
import { runGitHttpBackendFixture } from '@test/helpers/collab/GitHttpBackendFixture';

import type { CollabLocalCloudMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  type CollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import {
  NativeGitPublishRepository,
  type PublishAcceptedStatePort,
  type PublishGitNetworkPort,
} from '@/app/collab/publish/NativeGitPublishRepository';
import {
  PublishCoordinator,
  type PublishProjectContext,
} from '@/app/collab/publish/PublishCoordinator';
import { CollabAuthorityGitNetworkEnvironment } from '@/app/collab/remote-authority/CollabAuthorityGitNetworkEnvironment';
import type { CollabAuthoritySession } from '@/app/collab/remote-authority/CollabAuthoritySession';

jest.setTimeout(30_000);

const execFileAsync = promisify(execFile);
const GIT_EXECUTABLE = '/usr/bin/git';
const PROJECT_ID = 'project-cloud-publish-gate';
const CREATED_AT = '2026-08-23T00:00:00.000Z';
const ACTORS = ['member-alice', 'member-bob'] as const;

interface RepositoryFixture {
  readonly barePath: string;
  readonly mainOid: string;
}

interface GateServer {
  readonly errors: readonly string[];
  readonly ensureAttempts: ReadonlyMap<string, readonly string[]>;
  readonly origin: string;
  readonly requests: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  close(): Promise<void>;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(GIT_EXECUTABLE, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1_024 * 1_024,
  });
  return result.stdout.trim();
}

async function createRepository(root: string): Promise<RepositoryFixture> {
  const working = path.join(root, 'seed');
  const barePath = path.join(root, 'authority.git');
  await mkdir(working);
  await git(working, ['init', '--initial-branch=main']);
  await git(working, ['config', 'user.name', 'Cloud Publish Gate']);
  await git(working, ['config', 'user.email', 'gate@example.invalid']);
  await writeFile(path.join(working, 'shared.md'), 'shared\n');
  await git(working, ['add', 'shared.md']);
  await git(working, ['commit', '-m', 'main']);
  const mainOid = await git(working, ['rev-parse', 'HEAD']);
  for (const actor of ACTORS) {
    await git(working, ['branch', collabMemberRef(actor).slice('refs/heads/'.length)]);
  }
  await git(root, ['clone', '--bare', working, barePath]);
  await git(barePath, ['symbolic-ref', 'HEAD', COLLAB_MAIN_REF]);
  return { barePath, mainOid };
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
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}


function capabilityLimits() {
  return {
    maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
    maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
    maxCheckpointRepositoryBundleBytes:
      COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
    maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
    maxDevelopmentBootstrapGitBundleBytes:
      COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes,
    maxDevelopmentBootstrapManifestUtf8Bytes:
      COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapManifestUtf8Bytes,
    maxDevelopmentBootstrapReportUtf8Bytes:
      COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapReportUtf8Bytes,
    maxEventReplay: COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay,
    maxGitReceivePackBytes: COLLAB_CLOUD_BINDING_LIMITS.maxGitReceivePackBytes,
    maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
    maxRepositoryBytes: COLLAB_CLOUD_BINDING_LIMITS.maxRepositoryBytes,
  };
}

function projectSnapshot(actor: typeof ACTORS[number], mainOid: string) {
  const currentMember = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: actor,
    id: actor,
    personalRef: collabMemberRef(actor),
    role: actor === ACTORS[0] ? 'manager' as const : 'member' as const,
    status: 'active' as const,
  };
  return {
    currentMember,
    eventSequence: 0,
    members: [currentMember],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityGeneration: 1,
      createdAt: CREATED_AT,
      expectedMainOid: mainOid,
      id: PROJECT_ID,
      mainRef: COLLAB_MAIN_REF,
      name: 'Cloud Publish Gate',
    },
    ticketHighlights: [],
  };
}

async function startGateServer(repository: RepositoryFixture): Promise<GateServer> {
  const attempts = new Map<string, string[]>();
  const errors: string[] = [];
  const requests = new Map<string, Readonly<Record<string, unknown>>>();
  let aliceResponseLost = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (!request.url?.startsWith('/operator/cloud/')) {
        errors.push('deployment-prefix-missing');
        response.writeHead(404).end();
        return;
      }
      const target = request.url.slice('/operator/cloud'.length);
      const match = matchCollabCloudRoute(request.method ?? '', target);
      if (match?.kind === 'capabilities') {
        writeJson(response, 200, collabCloudCapabilityDocument([
          'git-receive-pack-personal-ref',
          'git-upload-pack',
          'project-snapshot',
          'requests',
        ], capabilityLimits()));
        return;
      }
      const actor = request.headers['x-claudian-development-actor'];
      if (
        typeof actor !== 'string'
        || !ACTORS.includes(actor as typeof ACTORS[number])
        || !match
        || ('projectId' in match && match.projectId !== PROJECT_ID)
      ) {
        errors.push('request-rejected');
        response.writeHead(403).end();
        return;
      }
      if (
        match.kind === 'git-info-refs'
        || match.kind === 'git-receive-pack'
        || match.kind === 'git-upload-pack'
      ) {
        const prefix = `/v5/projects/${PROJECT_ID}/repository.git`;
        const pathname = new URL(target, 'http://127.0.0.1').pathname;
        await runGitHttpBackendFixture(
          request,
          response,
          { ...repository, executablePath: GIT_EXECUTABLE, remoteUser: actor },
          pathname.slice(prefix.length),
        );
        return;
      }
      if (match.kind === 'project-operation' && match.operation === 'getProjectSnapshot') {
        const envelope = decodeCollabProtocolEnvelope(
          JSON.parse((await readBody(request)).toString('utf8')) as unknown,
        );
        if (envelope.status !== 'ok') throw new Error('snapshot-envelope-invalid');
        writeJson(response, 200, collabCloudSuccessEnvelope(
          envelope.value.requestId,
          projectSnapshot(actor as typeof ACTORS[number], repository.mainOid),
        ));
        return;
      }
      if (match.kind === 'project-operation' && match.operation === 'ensureMyRequest') {
        const envelope = decodeCollabProtocolEnvelope(
          JSON.parse((await readBody(request)).toString('utf8')) as unknown,
        );
        if (envelope.status !== 'ok') throw new Error('publish-envelope-invalid');
        const decoded = collabControlOperationCodec('ensureMyRequest')
          .decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw new Error('publish-request-invalid');
        const input = decoded.value;
        if (input.projectId !== PROJECT_ID || input.expectedMainOid !== repository.mainOid) {
          throw new Error('publish-request-authority-mismatch');
        }
        const pushedHead = await git(repository.barePath, [
          'rev-parse',
          collabMemberRef(actor),
        ]);
        if (pushedHead !== input.headOid) throw new Error('publish-head-not-pushed');
        const actorAttempts = attempts.get(actor) ?? [];
        actorAttempts.push(input.idempotencyKey);
        attempts.set(actor, actorAttempts);
        let changeRequest = requests.get(actor);
        if (changeRequest === undefined) {
          changeRequest = Object.freeze({
            commentCount: 0,
            createdAt: CREATED_AT,
            description: input.description,
            firstBaseOid: repository.mainOid,
            id: `request-${actor}`,
            latestHeadOid: input.headOid,
            memberId: actor,
            revision: 1,
            status: 'open',
            ticketRelations: [],
            updatedAt: CREATED_AT,
          });
          requests.set(actor, changeRequest);
        }
        if (actor === ACTORS[0] && !aliceResponseLost) {
          aliceResponseLost = true;
          response.destroy();
          return;
        }
        writeJson(response, 200, collabCloudSuccessEnvelope(envelope.value.requestId, {
          mainOid: repository.mainOid,
          request: changeRequest,
        }));
        return;
      }
      response.writeHead(404).end();
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : 'unknown');
      if (!response.headersSent && !response.destroyed) response.writeHead(500).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('gate-server-address');
  return {
    ensureAttempts: attempts,
    errors,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (
      error ? reject(error) : resolve()
    ))),
    origin: `http://127.0.0.1:${String(address.port)}/operator/cloud`,
    requests,
  };
}

function membership(
  actor: typeof ACTORS[number],
  origin: string,
): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      bindingVersion: 5,
      gitRemoteUrl: `${origin}/v5/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: origin,
      wireVersion: 9,
    },
    createdAt: CREATED_AT,
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      displayName: actor,
      id: actor,
      personalRef: collabMemberRef(actor),
      role: actor === ACTORS[0] ? 'manager' : 'member',
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Publish Gate',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
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
    return this.environment.resolve(context.projectId, developmentCloudGitNetwork(this.session.git, context.memberId))
      .then(network => operation(network, this.session.git.remoteUrl) as Promise<T>);
  }
}

class MemoryPublicationState {
  current: CollabPublicationStateRecord;

  constructor(baseMainOid: string) {
    this.current = {
      baseMainOid,
      operation: null,
      projectId: PROJECT_ID,
      schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
      updatedAt: CREATED_AT,
    };
  }

  load(): Promise<CollabPublicationStateRecord> { return Promise.resolve(this.current); }
  save(record: CollabPublicationStateRecord): Promise<void> {
    this.current = record;
    return Promise.resolve();
  }
}

function fixedProject(context: PublishProjectContext) {
  return {
    load: async () => context,
    revalidate: async () => undefined,
  };
}

function rejectingAcceptedState(): PublishAcceptedStatePort {
  return {
    classifyDivergence: async () => {
      throw new Error('Accepted integration is not expected');
    },
  };
}

function unusedCandidates() {
  const unused = async () => {
    throw new Error('A current-base Publish must not use a publication candidate');
  };
  return {
    apply: unused,
    assertRetained: unused,
    cleanup: unused,
    prepare: unused,
  };
}

describe('Cloud Publish gate', () => {
  it('publishes two clients over real Git and canonical Cloud HTTP retry paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-publish-gate-'));
    const repository = await createRepository(root);
    const server = await startGateServer(repository);
    const sessions: CollabAuthoritySession[] = [];
    try {
      const emptyConfigPath = path.join(root, 'empty.gitconfig');
      await writeFile(emptyConfigPath, '');
      const gitService = new GitRepositoryService(new GitCommandRunner({
        emptyConfigPath,
        executablePath: GIT_EXECUTABLE,
      }));
      const outcomes: Readonly<{
        actor: typeof ACTORS[number];
        first: unknown;
        second?: unknown;
      }>[] = [];
      const heads: Readonly<{
        actor: typeof ACTORS[number];
        bareHead: string;
        localHead: string;
      }>[] = [];

      for (const actor of ACTORS) {
        const clientRoot = path.join(root, `client-${actor}`);
        await mkdir(clientRoot);
        const repositoryPath = await gitService.cloneRepository({
          branch: collabMemberRef(actor).slice('refs/heads/'.length),
          directoryName: PROJECT_ID,
          parentDirectory: clientRoot,
          remoteUrl: repository.barePath,
        });
        await gitService.configureLocalRepository(repositoryPath, {
          memberId: actor,
          personalRef: collabMemberRef(actor),
          projectId: PROJECT_ID,
          userDisplayName: actor,
        });
        await git(repositoryPath, [
          'remote',
          'set-url',
          'origin',
          `${server.origin}/v5/projects/${PROJECT_ID}/repository.git`,
        ]);
        await writeFile(path.join(repositoryPath, `${actor}.md`), `${actor}\n`);

        const session = await createDevelopmentCloudAuthorityAdapter(actor).create(
          membership(actor, server.origin),
        );
        sessions.push(session);
        const context: PublishProjectContext = {
          memberId: actor,
          personalRef: collabMemberRef(actor),
          projectId: PROJECT_ID,
          remoteUrl: session.git.remoteUrl,
          repositoryPath,
        };
        const state = new MemoryPublicationState(repository.mainOid);
        const publishRepository = new NativeGitPublishRepository(gitService, {
          acceptedState: rejectingAcceptedState(),
          network: new SessionNetwork(clientRoot, session),
        });
        const createCoordinator = () => new PublishCoordinator(
          fixedProject(context),
          publishRepository,
          session.control,
          { assertSafe: async () => undefined },
          state,
          unusedCandidates(),
          { compare: async () => [] },
          { createOperationId: () => `operation-${actor}` },
        );

        const first = await createCoordinator().publish({
          description: `Publish from ${actor}`,
          projectId: PROJECT_ID,
        });
        if (actor === ACTORS[0]) {
          const second = await createCoordinator().publish({
            description: `Publish from ${actor}`,
            projectId: PROJECT_ID,
          });
          outcomes.push({ actor, first, second });
        } else {
          outcomes.push({ actor, first });
        }
        const localHead = await git(repositoryPath, ['rev-parse', collabMemberRef(actor)]);
        const bareHead = await git(repository.barePath, [
          'rev-parse',
          collabMemberRef(actor),
        ]);
        heads.push({ actor, bareHead, localHead });
      }

      expect(server.errors).toEqual([]);
      expect(outcomes).toEqual([
        expect.objectContaining({
          actor: ACTORS[0],
          first: expect.objectContaining({
            status: 'success',
            value: expect.objectContaining({ state: 'pushed' }),
          }),
          second: expect.objectContaining({
            status: 'success',
            value: expect.objectContaining({ state: 'request-synchronized' }),
          }),
        }),
        expect.objectContaining({
          actor: ACTORS[1],
          first: expect.objectContaining({
            status: 'success',
            value: expect.objectContaining({ state: 'request-synchronized' }),
          }),
        }),
      ]);
      expect(heads).toEqual(heads.map(head => ({
        actor: head.actor,
        bareHead: head.localHead,
        localHead: head.localHead,
      })));
      expect(server.requests.size).toBe(2);
      expect(server.ensureAttempts.get(ACTORS[0])).toHaveLength(2);
      expect(server.ensureAttempts.get(ACTORS[0])?.[0])
        .toBe(server.ensureAttempts.get(ACTORS[0])?.[1]);
      expect(server.ensureAttempts.get(ACTORS[1])).toHaveLength(1);
    } finally {
      for (const session of sessions) session.dispose();
      await server.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
