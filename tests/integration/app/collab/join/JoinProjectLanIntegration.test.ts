import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer,type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_MAIN_REF, collabMemberRef } from '@claudian-collab/protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { type GitRuntime,GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { JoinProjectCoordinator } from '@/app/collab/join/JoinProjectCoordinator';
import {
  type CollabControlProjectService,
  CollabControlRouter,
} from '@/app/collab/lan/CollabControlRouter';
import { CollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import { isGitHttpRoute } from '@/app/collab/lan/git/GitHttpRoute';
import { GitHttpBackendProxy } from '@/app/collab/lan/GitHttpBackendProxy';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { PendingMembershipService } from '@/app/collab/lan/PendingMembershipService';

const PROJECT_ID = 'project-alpha';
const HOST_CREDENTIAL = Buffer.alloc(32, 1).toString('base64url');

jest.setTimeout(60_000);

describe('Join Project same-device LAN integration', () => {
  let SQL: SqlJsStatic;
  let database: SqlJsProjectDatabase;
  let hostRoot: string;
  let memberFoundation: ClaudianCollabService;
  let memberRoot: string;
  let proxy: GitHttpBackendProxy;
  let root: string;
  let server: Server;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  afterEach(async () => {
    await proxy?.close();
    server?.closeAllConnections();
    if (server?.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await memberFoundation?.close();
    await database?.close();
    await rm(root, { force: true, recursive: true });
  });

  it('joins through pinned control and production Smart HTTP before activation', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-join-lan-'));
    hostRoot = path.join(root, 'host-vault');
    memberRoot = path.join(root, 'member-vault');
    const authorityDirectory = path.join(hostRoot, '.claudian', 'collab', 'authorities', PROJECT_ID);
    const bareRepositoryPath = path.join(authorityDirectory, 'repository.git');
    await mkdir(authorityDirectory, { recursive: true });
    await mkdir(memberRoot);

    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available' || !resolution.runtime.httpBackendPath) {
      throw new Error('Native Git Smart HTTP is required for integration tests');
    }
    const runtime: GitRuntime = resolution.runtime;
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const hostRunner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: runtime.executablePath,
    });
    const hostGit = new GitRepositoryService(hostRunner);
    const seedPath = path.join(root, 'seed');
    await mkdir(seedPath);
    await hostGit.initializeWorkingRepository(seedPath);
    await hostGit.configureLocalRepository(seedPath, {
      memberId: 'member-host',
      personalRef: collabMemberRef('member-host'),
      projectId: PROJECT_ID,
      userDisplayName: 'Host',
    });
    await writeFile(path.join(seedPath, 'note.md'), 'shared\n');
    await hostGit.stageAll(seedPath);
    const initialOid = await hostGit.createCommitFromIndex(seedPath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: COLLAB_MAIN_REF,
    });
    await hostGit.createRef(seedPath, collabMemberRef('member-host'), initialOid);
    await mkdir(bareRepositoryPath);
    await hostGit.initializeBareRepository(bareRepositoryPath);
    await hostGit.addRemote(seedPath, 'origin', bareRepositoryPath);
    await hostGit.push(seedPath, 'origin', `${COLLAB_MAIN_REF}:${COLLAB_MAIN_REF}`);
    await hostGit.push(
      seedPath,
      'origin',
      `${collabMemberRef('member-host')}:${collabMemberRef('member-host')}`,
    );

    database = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await database.open();
    const projects = new ProjectAuthorityRepository();
    const events = new AuthorityEventRepository();
    const idempotency = new AuthorityIdempotencyRepository();
    const createdAt = new Date().toISOString();
    await database.mutate(connection => projects.initialize(connection, {
      createdAt,
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Alpha',
      projectId: PROJECT_ID,
    }));

    const identity = await new LanTlsIdentity(hostRoot).issueServerIdentity('127.0.0.1');
    const router = new CollabControlRouter();
    server = createServer({
      cert: identity.certificateChainPem,
      key: identity.privateKeyPem,
    }, (request, response) => {
      if (isGitHttpRoute(request.url)) {
        void proxy.handle(request, response);
      } else {
        void router.handle(request, response);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing Host address');
    const endpoint = `https://127.0.0.1:${address.port}`;
    const invitationCodec = new InvitationCodec({
      isAddressAllowed: candidate => candidate === '127.0.0.1',
    });
    const membership = new PendingMembershipService({
      database,
      events,
      idempotency,
      projects,
    }, {
      getHostEndpoint: () => ({
        caFingerprint: identity.caFingerprint,
        endpoint,
      }),
      invitationCodec,
      readMainOid: async () => (await hostGit.resolveRef(
        bareRepositoryPath,
        COLLAB_MAIN_REF,
      ))!,
    });
    router.registerProject(
      PROJECT_ID,
      membership as unknown as CollabControlProjectService,
      { lifecycle: { execute: jest.fn() } },
    );
    proxy = new GitHttpBackendProxy({
      authorityDirectory,
      authenticateMemberCredential: membership.authenticateMemberCredential.bind(membership),
      emptyConfigPath,
      gitExecutablePath: runtime.executablePath,
      gitHttpBackendPath: runtime.httpBackendPath!,
      prepareMemberRef: async memberId => {
        const ref = collabMemberRef(memberId);
        if (await hostGit.resolveRef(bareRepositoryPath, ref)) return;
        const mainOid = await hostGit.resolveRef(bareRepositoryPath, COLLAB_MAIN_REF);
        if (!mainOid) throw new Error('Missing main');
        await hostGit.createRef(bareRepositoryPath, ref, mainOid);
      },
      projectId: PROJECT_ID,
      repository: hostGit,
    });
    await proxy.enable();

    const invitation = await membership.createInvitation(HOST_CREDENTIAL, {
      idempotencyKey: 'create-invitation-alpha',
      projectId: PROJECT_ID,
    });
    memberFoundation = new ClaudianCollabService({
      getConfiguredGitPath: () => runtime.executablePath,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: memberRoot,
    });
    const coordinator = new JoinProjectCoordinator(memberFoundation, {
      createHttpClient: trustStore => new CollabHttpClient(trustStore, {
        invitationCodec,
      }),
      createJoinAttemptId: () => 'join-member-alpha',
      invitationCodec,
      vaultRoot: memberRoot,
    });

    const result = await coordinator.joinProject({
      encodedInvitation: invitationCodec.encode(invitation),
      memberDisplayName: 'Alice',
    });
    expect(result).toMatchObject({
      status: 'success',
      value: {
        connectionStatus: 'connected',
        id: PROJECT_ID,
        name: 'Alpha',
        role: 'member',
      },
    });
    const localMembership = await memberFoundation.local.projects.loadMembership(PROJECT_ID);
    if (!localMembership || !isCollabLocalLanMembership(localMembership)) {
      throw new Error('Joined LAN membership missing');
    }
    expect(localMembership).toMatchObject({
      authority: {
        endpoint,
        gitRemoteUrl: `${endpoint}/v1/git/${PROJECT_ID}/repository.git`,
        hostCaFingerprint: identity.caFingerprint,
      },
      member: {
        displayName: 'Alice',
        role: 'member',
      },
    });
    expect(localMembership.member.credential).not.toBe(invitation.invitationSecret);
    const snapshot = await membership.readSnapshot(localMembership.member.credential);
    expect(snapshot.currentMember).toMatchObject({
      id: localMembership.member.id,
      status: 'active',
    });
    const workingCopy = path.join(memberRoot, 'workspace', PROJECT_ID);
    expect(await readFile(path.join(workingCopy, 'note.md'), 'utf8')).toBe('shared\n');
    expect(await hostGit.resolveRef(
      workingCopy,
      localMembership.member.personalRef,
    )).toBe(initialOid);
    expect(await hostGit.resolveRef(
      bareRepositoryPath,
      localMembership.member.personalRef,
    )).toBe(initialOid);
    const remoteUrl = await hostRunner.run({
      args: ['config', '--local', '--get', 'remote.origin.url'],
      cwd: workingCopy,
    });
    expect(remoteUrl.stdout.toString('utf8').trim()).toBe(
      `${endpoint}/v1/git/${PROJECT_ID}/repository.git`,
    );
    expect(remoteUrl.stdout.toString('utf8')).not.toContain(localMembership.member.credential);
    await expect(hostRunner.run({
      acceptedExitCodes: [1],
      args: ['config', '--local', '--get-all', 'http.extraHeader'],
      cwd: workingCopy,
    })).resolves.toMatchObject({ exitCode: 1 });
    await expect(readFile(path.join(
      memberRoot,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'join-ca.pem',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(hostGit.assertHealthy(bareRepositoryPath)).resolves.toBeUndefined();
    expect(proxy.activeChildCount).toBe(0);
  });
});
