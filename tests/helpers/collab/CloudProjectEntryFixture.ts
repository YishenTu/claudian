import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_LIMITS,
  collabCloudCapabilityDocument,
  collabCloudErrorEnvelope,
  collabCloudProjectOperationRoute,
  collabCloudSuccessEnvelope,
  collabControlOperationCodec,
  CollabError,
  decodeCollabProtocolEnvelope,
  matchCollabCloudRoute,
} from '@claudian-collab/protocol';
import { runGitHttpBackendFixture } from '@test/helpers/collab/GitHttpBackendFixture';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { testTime } from '@test/helpers/testClock';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';

import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { CloudProjectEntryCoordinator } from '@/app/collab/project/CloudProjectEntryCoordinator';
import { decodeCloudProjectEntryRecord } from '@/app/collab/project/CloudProjectEntryRecord';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type { CollabAuthoritySession } from '@/app/collab/remote-authority/CollabAuthoritySession';

export const PROJECT_ID = 'project-cloud-entry';
export const MEMBER_ID = 'member-server-selected';
export const OPERATION_ID = 'entry-one';
export const CREATED_AT = testTime({ days: 5 });
const execFileAsync = promisify(execFile);
export const gitRuntimeResolver = new GitRuntimeResolver();
const remoteSeeds = new Map<string, { barePath: string; mainOid: string }>();
let remoteSeedRoot: string;
let crashFixtureBundle: Promise<string> | undefined;

beforeAll(async () => { remoteSeedRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-entry-seeds-')); });
afterAll(async () => { if (remoteSeedRoot) await rm(remoteSeedRoot, { recursive: true, force: true }); });

// The executable is immutable; each crash case still forks a fresh process and Vault.
export function prepareCrashFixture(): Promise<string> {
  return crashFixtureBundle ??= (async () => {
    const bundle = path.join(remoteSeedRoot, 'crash-fixture.cjs');
    await build({
      bundle: true, entryPoints: [path.resolve('tests/helpers/collab/CloudEntryCrashFixture.ts')],
      logLevel: 'silent', outfile: bundle, packages: 'external', platform: 'node',
      target: 'node24', tsconfig: path.resolve('tsconfig.json'),
    });
    return bundle;
  })();
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

export function createFeatureFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const setup = new CollabProjectSetupService(fixture.foundation, {
    installationKey: TEST_INSTALLATION_A, vaultRoot: fixture.vaultRoot,
  });
  return createCollabFeatureSubcomposition({
    cloudAuthority: fixture.adapter,
    foundation: fixture.foundation,
    getProjectsFolder: () => 'Shared/Projects',
    projectSetup: setup,
    vaultRoot: fixture.vaultRoot,
  }).feature;
}

// Build each remote history once; every case still clones from its own copy
// through the real HTTP backend and owns fresh local state, sockets and services.
async function remoteSeed(options: { nonempty?: boolean; remoteContribution?: boolean }) {
  const key = `${!!options.nonempty}-${!!options.remoteContribution}`;
  const existing = remoteSeeds.get(key);
  if (existing) return existing;
  const root = path.join(remoteSeedRoot, key);
  const seed = path.join(root, 'seed');
  const barePath = path.join(root, 'authority.git');
  await mkdir(root);
  await mkdir(seed);
  await git(seed, ['init', '--initial-branch=main']);
  if (options.nonempty) {
    await writeFile(path.join(seed, 'unexpected.md'), 'Unexpected remote content\n');
    await git(seed, ['add', 'unexpected.md']);
  }
  await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Empty Project']);
  const mainOid = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['branch', `members/${MEMBER_ID}`]);
  if (options.remoteContribution) {
    await git(seed, ['checkout', `members/${MEMBER_ID}`]);
    await writeFile(path.join(seed, 'personal.md'), 'Remote personal contribution\n');
    await git(seed, ['add', 'personal.md']);
    await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Personal contribution']);
  }
  await git(root, ['clone', '--bare', seed, barePath]);
  const prepared = { barePath, mainOid };
  remoteSeeds.set(key, prepared);
  return prepared;
}

export async function createFixture(options: {
  projectName?: string;
  nonempty?: boolean; generatedProjectId?: boolean; join?: boolean; alreadyBound?: boolean; remoteContribution?: boolean;
  snapshotFailure?: 'authorization' | 'transport' | 'malformed' | 'settled'; joinFailure?: 'rejected' | 'wrong-member' | 'expired' | 'revoked' | 'wrong-secret';
} = {}) {
  let projectId = PROJECT_ID;
  let projectsFolder = 'Shared/Projects';
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-entry-'));
  const vaultRoot = path.join(root, 'vault');
  const barePath = path.join(root, 'authority.git');
  await mkdir(vaultRoot);
  const seed = await remoteSeed(options);
  await fs.cp(seed.barePath, barePath, { recursive: true });
  const mainOid = seed.mainOid;

  const foundation = new ClaudianCollabService({
    getConfiguredGitPath: () => '',
    gitRuntimeResolver,
    installationKey: TEST_INSTALLATION_A,
    obsidianConfigDirectory: '.obsidian',
    vaultRoot,
  });
  const sessions = new CollabProjectWorkSessionRegistry();
  const member = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: options.join ? 'Bob' : 'Alice',
    id: MEMBER_ID,
    personalRef: `refs/heads/members/${MEMBER_ID}`,
    role: options.join ? 'member' : 'manager',
    status: 'active',
  };
  const snapshot = {
    currentMember: member,
    eventSequence: 7,
    members: [member],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityGeneration: 7,
      createdAt: CREATED_AT,
      expectedMainOid: mainOid,
      id: projectId,
      mainRef: 'refs/heads/main',
      name: options.projectName ?? 'Cloud Notes',
    },
    ticketHighlights: [],
  };
  const admittedRequests: unknown[] = [];
  const joinRequests: unknown[] = [];
  let bound = !options.join || options.alreadyBound === true;
  let loseNextReply = false;
  let failActivation = false;
  let onCapabilities = () => {};
  let onCreate: () => void | Promise<void> = () => {};
  let onSnapshot: (projectId: string) => void | Promise<void> = () => {};
  const failures: unknown[] = [];
  const transportRequests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? '';
      transportRequests.push(`${request.method} ${target}`);
      assert.match(target, /^\/operator\/cloud\//);
      assert.equal(request.headers['x-claudian-development-actor'], undefined);
      const routeTarget = target.slice('/operator/cloud'.length);
      const route = matchCollabCloudRoute(request.method ?? '', routeTarget);
      if (route?.kind === 'git-info-refs' || route?.kind === 'git-upload-pack') {
        return runGitHttpBackendFixture(request, response, {
          barePath,
          executablePath: 'git',
          remoteUser: MEMBER_ID,
        }, new URL(routeTarget, 'http://localhost').pathname.slice(`/v10/projects/${projectId}/repository.git`.length));
      }
      response.setHeader('content-type', 'application/json');
      if (route?.kind === 'capabilities') {
        onCapabilities();
        response.end(JSON.stringify(collabCloudCapabilityDocument([
          'cloud-project-create', 'cloud-project-join', 'git-upload-pack', 'project-snapshot', 'project-events',
        ], {
          maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
          maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
          maxCheckpointRepositoryBundleBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
          maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
          maxDevelopmentBootstrapGitBundleBytes: 1_024,
          maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
          maxDevelopmentBootstrapReportUtf8Bytes: 1_024,
          maxEventReplay: 100,
          maxGitReceivePackBytes: 1_024,
          maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
          maxRepositoryBytes: 1_024 * 1_024,
        })));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = decodeCollabProtocolEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (envelope.status !== 'ok') throw envelope.error;
      if (routeTarget === collabCloudProjectOperationRoute(projectId, 'getProjectSnapshot').target) {
        await onSnapshot(projectId);
        if (options.snapshotFailure === 'transport') { request.socket.destroy(); return; }
        if (options.snapshotFailure === 'malformed') { response.end('{"invalid":true}'); return; }
        if (options.snapshotFailure === 'authorization') {
          response.writeHead(403).end(JSON.stringify(collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' }))));
          return;
        }
        if (options.snapshotFailure === 'settled') {
          response.writeHead(403).end(JSON.stringify({
            ...collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' })),
            mutationOutcome: 'rejected',
          }));
          return;
        }
        if (!bound) {
          response.writeHead(404).end(JSON.stringify(collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'project-not-found' }))));
          return;
        }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, snapshot)));
        return;
      }
      if (routeTarget === collabCloudProjectOperationRoute(projectId, 'joinCloudProject').target) {
        const decoded = collabControlOperationCodec('joinCloudProject').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const intent = await foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCloudProjectEntryRecord);
        assert.equal(intent?.phase, 'intent');
        assert.equal(intent?.operationKind, 'cloud-join-project');
        assert.deepEqual(intent?.request, decoded.value);
        joinRequests.push(decoded.value);
        if (options.joinFailure === 'rejected') {
          response.writeHead(403).end(JSON.stringify(collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' }))));
          return;
        }
        if (options.joinFailure === 'expired' || options.joinFailure === 'revoked' || options.joinFailure === 'wrong-secret') {
          response.writeHead(403).end(JSON.stringify({
            ...collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' })),
            mutationOutcome: 'rejected',
          }));
          return;
        }
        bound = true;
        if (loseNextReply) {
          loseNextReply = false;
          request.socket.destroy();
          return;
        }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          joinedAt: CREATED_AT, mainOid, managerSetGeneration: 1, memberId: options.joinFailure === 'wrong-member' ? 'member-wrong' : MEMBER_ID,
          membershipRevision: 2, personalRef: `refs/heads/members/${options.joinFailure === 'wrong-member' ? 'member-wrong' : MEMBER_ID}`, projectId, role: 'member',
        })));
        return;
      }
      const decoded = collabControlOperationCodec('createCloudProject').decodeRequest(envelope.value.data);
      if (decoded.status !== 'ok') throw decoded.error;
      if (options.generatedProjectId) {
        projectId = decoded.value.projectId;
        snapshot.project.id = projectId;
      }
      admittedRequests.push(decoded.value);
      await onCreate();
      const intent = await foundation.local.projects.loadProjectDocument(
        projectId, 'pending-operation', decodeCloudProjectEntryRecord,
      );
      assert.deepEqual({
        operationId: intent?.operationId, phase: intent?.phase, projectId: intent?.projectId,
        projectsFolder: intent?.projectsFolder, request: intent?.request,
      }, {
        operationId: decoded.value.idempotencyKey,
        phase: 'intent',
        projectId: projectId,
        projectsFolder: 'Shared/Projects',
        request: {
          idempotencyKey: decoded.value.idempotencyKey,
          managerDisplayName: 'Alice',
          projectId: projectId,
          projectName: options.projectName ?? 'Cloud Notes',
        },
      });
      if (loseNextReply) {
        loseNextReply = false;
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
        createdAt: CREATED_AT,
        mainOid,
        managerSetGeneration: 1,
        memberId: MEMBER_ID,
        membershipRevision: 2,
        personalRef: `refs/heads/members/${MEMBER_ID}`,
        projectId: projectId,
        role: 'manager',
      })));
    })().catch(error => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  const sockets = new WebSocketServer({ server });
  server.on('upgrade', request => transportRequests.push(`UPGRADE ${request.url}`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const serverUrl = `http://127.0.0.1:${address.port}/operator/cloud`;
  const encodedInvitation = `claudian-cloud:v1:${Buffer.from(JSON.stringify({ serverUrl, invitation: {
    createdAt: CREATED_AT, expiresAt: testTime({ days: 6 }), invitationId: 'invitation-entry',
    issuedState: 'active', projectId, secret: 'A'.repeat(43), secretReplayExpiresAt: testTime({ days: 35 }),
  } })).toString('base64url')}`;
  const adapter = new CloudAuthorityAdapter(vaultRoot);
  const createCoordinator = () => new CloudProjectEntryCoordinator(foundation, {
    activateProject: async membership => {
      if (failActivation) { failActivation = false; throw new Error('Injected activation cut'); }
      expect(await foundation.local.projects.loadMembership(projectId)).toEqual(membership);
      expect(await foundation.local.projects.loadProjectDocument(
        projectId, 'publication-state', decodeCollabPublicationStateRecord,
      )).toMatchObject({ baseMainOid: mainOid });
      expect((await foundation.local.projects.loadIndex()).projects)
        .toEqual(expect.arrayContaining([expect.objectContaining({ authorityKind: 'cloud', id: projectId })]));
      const session = await sessions.acquire(projectId).ensureAuthoritySession<CollabAuthoritySession>(
        () => adapter.create(membership),
      );
      await session.control.readSnapshot(projectId);
    },
    cloudAuthority: adapter,
    createId: kind => kind === 'project' ? projectId : OPERATION_ID,
    getProjectsFolder: () => projectsFolder,
    now: () => new Date(CREATED_AT),
    vaultRoot,
  });

  return {
    adapter, admittedRequests, joinRequests, encodedInvitation, coordinator: createCoordinator(), createCoordinator, failures, foundation, mainOid, serverUrl, vaultRoot, transportRequests,
    loseNextReply: () => { loseNextReply = true; },
    setProjectsFolder: (folder: string) => { projectsFolder = folder; },
    failNextActivation: () => { failActivation = true; },
    onCapabilities: (callback: () => void) => { onCapabilities = callback; },
    onCreate: (callback: () => void | Promise<void>) => { onCreate = callback; },
    onSnapshot: (callback: (projectId: string) => void | Promise<void>) => { onSnapshot = callback; },
    driftIdentity: (kind: 'member' | 'generation') => {
      if (kind === 'generation') snapshot.project.authorityGeneration = 8;
      else { member.id = 'member-other'; member.personalRef = 'refs/heads/members/member-other'; }
    },
    close: async () => {
      await sessions.close();
      await foundation.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
