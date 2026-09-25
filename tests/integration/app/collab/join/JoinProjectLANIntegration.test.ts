import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer,type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_MAIN_REF, collabMemberRef } from '@claudian-collab/protocol';
import {
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
} from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SQLJSProjectDatabase } from '@/app/collab/authority/SQLJSProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { isCollabLocalLANMembership } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_ORIGIN_MAIN_REF } from '@/app/collab/git/collabGitRefs';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { type GitRuntime,GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { JoinProjectCoordinator } from '@/app/collab/join/JoinProjectCoordinator';
import { decodeJoinProjectRecord } from '@/app/collab/join/JoinProjectRecord';
import {
  type CollabControlProjectService,
  CollabControlRouter,
} from '@/app/collab/lan/CollabControlRouter';
import { CollabHTTPClient } from '@/app/collab/lan/CollabHTTPClient';
import { isGitHTTPRoute } from '@/app/collab/lan/git/GitHTTPRoute';
import { GitHTTPBackendProxy } from '@/app/collab/lan/GitHTTPBackendProxy';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { LANTLSIdentity } from '@/app/collab/lan/LANTLSIdentity';
import { PendingMembershipService } from '@/app/collab/lan/PendingMembershipService';
import { CollabWorkingCopyLocationService } from '@/app/collab/project/CollabWorkingCopyLocationService';

const PROJECT_ID = 'project-alpha';
const HOST_CREDENTIAL = Buffer.alloc(32, 1).toString('base64url');

jest.setTimeout(60_000);

describe('Join Project same-device LAN integration', () => {
  let tlsRoot: string;
  let serverIdentity: Awaited<ReturnType<LANTLSIdentity['issueServerIdentity']>>;

  // Certificate creation has its own native tests. These cases retain real TLS
  // handshakes while sharing only immutable certificate/key material.
  beforeAll(async () => {
    tlsRoot = await mkdtemp(path.join(tmpdir(), 'claudian-lan-tls-fixture-'));
    serverIdentity = await new LANTLSIdentity(tlsRoot, {
      installationKey: TEST_INSTALLATION_A,
    }).issueServerIdentity('127.0.0.1');
  });

  afterAll(async () => {
    if (tlsRoot) await rm(tlsRoot, { recursive: true, force: true });
  });

  let SQL: SqlJsStatic;
  let database: SQLJSProjectDatabase;
  let hostRoot: string;
  let memberFoundation: ClaudianCollabService;
  let memberRoot: string;
  let proxy: GitHTTPBackendProxy;
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

  it.each([
    { generation: 1, legacyPhase: null, recovery: null },
    { generation: 3, legacyPhase: null, recovery: null },
    { generation: 5, legacyPhase: null, recovery: null },
    { generation: 3, legacyPhase: 'membership-created', recovery: null },
    { generation: 3, legacyPhase: 'clone-completed', recovery: null },
    { generation: 3, legacyPhase: null, recovery: 'activated' },
    { generation: 3, legacyPhase: null, recovery: 'activation-save-lost-expired' },
    { generation: 3, legacyPhase: null, recovery: 'legacy-activated' },
    { generation: 3, legacyPhase: null, recovery: 'legacy-membership-saved' },
    { generation: 3, legacyPhase: null, recovery: 'legacy-response-lost' },
  ] as const)('joins through pinned control and production Smart HTTP (%j)', async ({ generation, legacyPhase, recovery }) => {
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

    database = new SQLJSProjectDatabase(authorityDirectory, {
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

    await database.mutate(connection => connection.run(
      'UPDATE authority_metadata SET authority_generation = ? WHERE singleton = 1', [generation],
    ));

    const identity = serverIdentity;
    const router = new CollabControlRouter();
    server = createServer({
      cert: identity.certificateChainPem,
      key: identity.privateKeyPem,
    }, (request, response) => {
      if (isGitHTTPRoute(request.url)) {
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
    proxy = new GitHTTPBackendProxy({
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
      installationKey: TEST_INSTALLATION_B,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: memberRoot,
    });
    let clientNow = new Date();
    const createCoordinator = () => new JoinProjectCoordinator(memberFoundation, {
      createHttpClient: trustStore => new CollabHTTPClient(trustStore, {
        invitationCodec,
      }),
      createJoinAttemptId: () => 'join-member-alpha',
      invitationCodec,
      vaultRoot: memberRoot,
      now: () => clientNow,
    });

    let interruptClone = legacyPhase !== null;
    let interruptActivation = recovery !== null;
    const localProjects = memberFoundation.local.projects;
    const save = localProjects.saveProjectDocument.bind(localProjects);
    const cut = jest.spyOn(localProjects, 'saveProjectDocument').mockImplementation(async (...args) => {
      if (interruptActivation && recovery === 'activation-save-lost-expired'
        && args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'activated') {
        interruptActivation = false;
        throw new Error('Injected lost activation save');
      }
      await save(...args);
      if (interruptActivation && args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'activated') {
        interruptActivation = false;
        throw new Error('Injected durable activation interruption');
      }
      if (interruptClone && args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'clone-completed') {
        interruptClone = false;
        throw new Error('Injected durable clone interruption');
      }
    });
    let result = await createCoordinator().joinProject({
      encodedInvitation: invitationCodec.encode(invitation),
      memberDisplayName: 'Alice',
      ...(legacyPhase || recovery?.startsWith('legacy-') ? { projectSlug: PROJECT_ID } : {}),
    });
    if (legacyPhase) {
      if (result.status !== 'recovery-required') throw new Error('Expected interrupted staged Join');
      const pending = await localProjects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeJoinProjectRecord);
      if (!pending) throw new Error('Missing staged Join');
      await memberFoundation.local.workspace.releaseReservedProjectsFolderChild('workspace', {
        childName: pending.stagingDirectoryName, operationId: pending.operationId, projectId: PROJECT_ID, purpose: 'join-staging',
      });
      const { projectsFolder: _projectsFolder, ...legacy } = pending;
      await save(PROJECT_ID, 'pending-operation', { ...legacy, schemaVersion: 1, phase: legacyPhase });
      if (legacyPhase === 'membership-created') {
        interruptClone = true;
        const interrupted = await createCoordinator().resumeJoin({ operationId: pending.operationId });
        if (interrupted.status !== 'recovery-required') throw new Error('Expected interrupted legacy clone checkpoint');
      }
      result = await createCoordinator().resumeJoin({ operationId: pending.operationId });
    }
    const recoveryObservations: unknown[] = [];
    if (recovery) {
      if (result.status !== 'recovery-required') throw new Error('Expected interrupted activated Join');
      const pending = await localProjects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeJoinProjectRecord);
      if (!pending) throw new Error('Missing activated Join');
      if (recovery === 'activation-save-lost-expired') {
        clientNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      } else if (recovery === 'activated') {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      } else {
        const { authorityGeneration: _generation, ...legacyRecord } = pending;
        const legacy = { ...legacyRecord, schemaVersion: 2 };
        if (recovery === 'legacy-response-lost') {
          legacy.phase = 'placed';
          legacy.lastEventSequence = null;
          legacy.memberRole = null;
          legacy.projectName = null;
          await database.mutate(connection => {
            const row = connection.get(
              'SELECT response_json FROM idempotency_results WHERE idempotency_key = ?',
              ['activate-join-member-alpha'],
            );
            if (!row) throw new Error('Missing activation receipt');
            const response = JSON.parse(String(row.response_json));
            delete response.project.authorityGeneration;
            const trigger = connection.get("SELECT sql FROM sqlite_master WHERE name = 'idempotency_results_immutable_update'");
            connection.run('DROP TRIGGER idempotency_results_immutable_update');
            connection.run('UPDATE idempotency_results SET response_json = ? WHERE idempotency_key = ?',
              [JSON.stringify(response), 'activate-join-member-alpha']);
            connection.run(String(trigger!.sql));
          });
        }
        await save(PROJECT_ID, 'pending-operation', legacy);
        if (recovery === 'legacy-membership-saved') {
          await localProjects.saveMembership({
            authority: {
              authorityGeneration: 1, endpoint,
              gitRemoteUrl: `${endpoint}/v1/git/${PROJECT_ID}/repository.git`,
              hostCaCertificatePem: identity.caCertificatePem,
              hostCaFingerprint: identity.caFingerprint, kind: 'lan',
            },
            createdAt: pending.createdAt, updatedAt: pending.updatedAt,
            hostOwnership: { ownsAuthority: false }, lastEventSequence: pending.lastEventSequence!,
            member: {
              credential: pending.memberCredential!, displayName: 'Alice', id: pending.memberId!,
              personalRef: collabMemberRef(pending.memberId!), role: 'member',
            },
            project: { id: PROJECT_ID, name: 'Alpha', workspacePath: `workspace/${PROJECT_ID}` },
            schemaVersion: 3,
          });
          const retained = await localProjects.loadMembership(PROJECT_ID);
          if (!retained || !isCollabLocalLANMembership(retained)) throw new Error('Missing legacy membership');
          const foreignCredential = Buffer.alloc(32, 17).toString('base64url');
          await localProjects.saveMembership({ ...retained, member: { ...retained.member, credential: foreignCredential } });
          const rejected = await createCoordinator().resumeJoin({ operationId: pending.operationId });
          const unchanged = await localProjects.loadMembership(PROJECT_ID);
          recoveryObservations.push({
            result: rejected.status,
            unchanged: unchanged !== null && isCollabLocalLANMembership(unchanged) && unchanged.member.credential === foreignCredential,
          });
          await localProjects.saveMembership(retained);
          const saveMembership = localProjects.saveMembership.bind(localProjects);
          const interruptRepair = jest.spyOn(localProjects, 'saveMembership').mockImplementation(async value => {
            await saveMembership(value);
            throw new Error('Injected interruption after legacy binding repair');
          });
          const interrupted = await createCoordinator().resumeJoin({ operationId: pending.operationId });
          interruptRepair.mockRestore();
          const stillPending = await localProjects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeJoinProjectRecord);
          recoveryObservations.push({ result: interrupted.status, journalGeneration: stillPending?.authorityGeneration });
        }
      }
      result = await createCoordinator().resumeJoin({ operationId: pending.operationId });
    }
    cut.mockRestore();
    expect(recoveryObservations).toEqual(recovery === 'legacy-membership-saved' ? [
      { result: 'recovery-required', unchanged: true },
      { result: 'recovery-required', journalGeneration: null },
    ] : []);
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
    if (!localMembership || !isCollabLocalLANMembership(localMembership)) {
      throw new Error('Joined LAN membership missing');
    }
    expect(localMembership).toMatchObject({
      authority: {
        authorityGeneration: generation,
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
    const expectedSlug = legacyPhase || recovery?.startsWith('legacy-') ? PROJECT_ID : 'alpha';
    expect(localMembership.project.workspacePath).toBe(`workspace/${expectedSlug}`);
    const workingCopy = path.join(memberRoot, 'workspace', expectedSlug);
    expect(await readFile(path.join(workingCopy, 'note.md'), 'utf8')).toBe('shared\n');
    expect(await hostGit.resolveRef(
      workingCopy,
      localMembership.member.personalRef,
    )).toBe(initialOid);
    expect(await hostGit.resolveRef(
      workingCopy,
      COLLAB_ORIGIN_MAIN_REF,
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
    const renamedPath = 'workspace/我的 LAN Demo';
    await rename(workingCopy, path.join(memberRoot, renamedPath));
    const locations = new CollabWorkingCopyLocationService(memberFoundation, {
      vaultRoot: memberRoot, transitionProject: async (_projectId, operation) => operation(),
    });
    await locations.reconcile({ oldPath: localMembership.project.workspacePath, newPath: renamedPath });
    expect(await localProjects.loadMembership(PROJECT_ID)).toMatchObject({
      authority: localMembership.authority, member: localMembership.member,
      project: { name: 'Alpha', workspacePath: renamedPath },
    });
    expect(await readFile(path.join(memberRoot, renamedPath, 'note.md'), 'utf8')).toBe('shared\n');
  });
});
