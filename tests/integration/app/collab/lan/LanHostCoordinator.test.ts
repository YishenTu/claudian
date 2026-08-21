import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_LIMITS } from '@claudian/collab-protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { WebSocket } from 'ws';

import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { ManagerResponsibilityService } from '@/app/collab/authority/ManagerResponsibilityService';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { RequestQueryService } from '@/app/collab/authority/RequestQueryService';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketService } from '@/app/collab/authority/TicketService';
import { CollabClientProjection } from '@/app/collab/client/CollabClientProjection';
import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  createHostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecovery';
import {
  type CollabHostTrustStore,
  CollabHttpClient,
  type CollabTrustedHost,
} from '@/app/collab/lan/CollabHttpClient';
import { HostTransferTargetTransport } from '@/app/collab/lan/HostTransferTargetTransport';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import type { LanCollabEnvelope } from '@/app/collab/lan/LanCollabEnvelope';
import {
  LanHostCoordinator,
  listPrivateIpv4Addresses,
} from '@/app/collab/lan/LanHostCoordinator';
import {
  LanTlsIdentity,
  type LanTlsServerIdentity,
} from '@/app/collab/lan/LanTlsIdentity';
import {
  ProjectEventHub,
  SqlJsProjectEventSource,
} from '@/app/collab/lan/ProjectEventHub';
import { CollabMembershipService } from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { LocalProjectControlPort } from '@/app/collab/publish/LocalProjectControlPort';
import { ReconnectProjectCoordinator } from '@/app/collab/reconnect/ReconnectProjectCoordinator';

const HOST_CREDENTIAL = Buffer.alloc(32, 1).toString('base64url');
const PROJECT_ID = 'project-alpha';
const MAIN_OID = 'a'.repeat(40);

class MemoryTrustStore implements CollabHostTrustStore {
  readonly values = new Map<string, CollabTrustedHost>();

  async read(projectId: string): Promise<CollabTrustedHost | null> {
    return this.values.get(projectId) ?? null;
  }

  async save(trust: CollabTrustedHost): Promise<'ca-mismatch' | 'saved'> {
    const existing = this.values.get(trust.projectId);
    if (existing && existing.caFingerprint !== trust.caFingerprint) return 'ca-mismatch';
    this.values.set(trust.projectId, trust);
    return 'saved';
  }
}

function envelopeData<T>(value: unknown): T {
  const envelope = value as LanCollabEnvelope<T>;
  if (
    envelope.protocolVersion !== COLLAB_CONTROL_PROTOCOL_VERSION
    || typeof envelope.requestId !== 'string'
  ) {
    throw new TypeError('Invalid control envelope');
  }
  return envelope.data;
}

function readPinnedUrl(url: string, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ca, rejectUnauthorized: true }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.once('error', reject);
    request.end();
  });
}

function membershipAccess(
  projects: CollabLocalProjectRepository,
): { readonly projection: CollabClientProjection; readonly service: CollabMembershipService } {
  const membership = { service: null as CollabMembershipService | null };
  const projection = new CollabClientProjection(
    projects,
    new LocalProjectControlPort(projects),
    {
      managerResponsibility: {
        reconcileSnapshot: snapshot => {
          if (!membership.service) throw new Error('Membership service unavailable');
          return membership.service.reconcileManagerResponsibilitySnapshot(snapshot);
        },
      },
    },
  );
  const service = new CollabMembershipService(projects, {
    readCoordinationSnapshot: (projectId, options) => (
      projection.readSnapshot(projectId, options)
    ),
  }, {}, {
    managerReceipts: {
      load: async () => null,
      remove: async () => false,
      save: async () => undefined,
    },
    managerResponsibilityOperations: new ManagerResponsibilityOperationCoordinator(),
    pendingLeaves: { load: async () => null },
  });
  membership.service = service;
  return {
    projection,
    service,
  };
}

describe('LanHostCoordinator production transport', () => {
  let SQL: SqlJsStatic;
  let authorityDatabase: SqlJsProjectDatabase;
  let localProjects: CollabLocalProjectRepository;
  let root: string;
  let coordinator: LanHostCoordinator;
  let occupiedServer: Server;
  let occupiedPort: number;
  let sharedTlsIdentity: LanTlsIdentity;
  let tlsFixtureRoot = '';
  let ticketService: TicketService;
  let advertiseProject: jest.Mock;
  let advertisementStop: jest.Mock;
  let addressMonitorClose: jest.Mock;
  let checkHostAddress: () => Promise<void>;
  let issueServerIdentity: (address: string) => Promise<LanTlsServerIdentity>;
  let privateAddresses: readonly string[];
  let outgoingHostTransfer: {
    close?: jest.Mock;
    inspectStartupRecovery: jest.Mock;
    prepareCancellation?: jest.Mock;
    prepareTerminalRecoveryBeforeStartup?: jest.Mock;
    resume: jest.Mock;
  } | null;

  const createGitProxy = () => ({
    close: jest.fn(async () => undefined),
    enable: jest.fn(async () => undefined),
    handle: jest.fn(async (_request: unknown, response: {
      end(body: string): void;
      statusCode: number;
    }) => {
      response.statusCode = 200;
      response.end('git-ready');
      return true;
    }),
  });

  const gitRuntime = () => ({
    emptyConfigPath: process.execPath,
    gitExecutablePath: process.execPath,
    gitHttpBackendPath: process.execPath,
    prepareMemberRef: jest.fn(async () => undefined),
    repository: {
      assertHealthy: jest.fn(async () => undefined),
      configureHostedRepository: jest.fn(async () => undefined),
      installHook: jest.fn(async () => process.execPath),
      measureStorageBytes: jest.fn(async () => 1),
    },
  });

  const hostedControlCapabilities = () => ({
    lifecycle: {
      createRetirementCoordinator: () => ({ retireProject: jest.fn() }),
      getCurrentHostTransfer: jest.fn().mockResolvedValue(null),
      getCurrentManagerResponsibilityOffer: jest.fn().mockResolvedValue(null),
    } as never,
    requests: {} as never,
    tickets: {} as never,
  });

  beforeAll(async () => {
    SQL = await initSqlJs();
    tlsFixtureRoot = await mkdtemp(path.join(tmpdir(), 'claudian-lan-host-tls-'));
    const identity = new LanTlsIdentity(tlsFixtureRoot);
    const serverIdentities = new Map<string, LanTlsServerIdentity>();
    serverIdentities.set(
      '127.0.0.1',
      await identity.issueServerIdentity('127.0.0.1'),
    );
    sharedTlsIdentity = {
      issueServerIdentity: async (address: string) => {
        let serverIdentity = serverIdentities.get(address);
        if (!serverIdentity) {
          serverIdentity = await identity.issueServerIdentity(address);
          serverIdentities.set(address, serverIdentity);
        }
        return serverIdentity;
      },
    } as unknown as LanTlsIdentity;
  }, 30_000);

  afterAll(async () => {
    await rm(tlsFixtureRoot, { force: true, recursive: true });
  });

  beforeEach(async () => {
    advertisementStop = jest.fn(async () => undefined);
    advertiseProject = jest.fn(async () => ({ stop: advertisementStop }));
    addressMonitorClose = jest.fn();
    checkHostAddress = async () => undefined;
    issueServerIdentity = address => sharedTlsIdentity.issueServerIdentity(address);
    privateAddresses = ['127.0.0.1'];
    outgoingHostTransfer = null;
    root = await mkdtemp(path.join(tmpdir(), 'claudian-lan-host-'));
    localProjects = new CollabLocalProjectRepository(root);
    await localProjects.saveMembership({
      authority: {
        endpoint: null,
        gitRemoteUrl: null,
        hostCaCertificatePem: null,
        hostCaFingerprint: null,
        kind: 'lan',
      },
      createdAt: '2026-08-08T00:00:00.000Z',
      hostOwnership: { ownsAuthority: true },
      lastEventSequence: 0,
      member: {
        credential: HOST_CREDENTIAL,
        displayName: 'Host',
        id: 'member-host',
        personalRef: 'refs/heads/members/member-host',
        role: 'manager',
      },
      project: {
        id: PROJECT_ID,
        name: 'Alpha',
        workspacePath: 'workspace/alpha',
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: '2026-08-08T00:00:00.000Z',
    });
    const authorityDirectory = await localProjects.ensureAuthorityDirectory(PROJECT_ID);
    authorityDatabase = new SqlJsProjectDatabase(authorityDirectory, {
      loadSqlJs: async () => SQL,
    });
    await authorityDatabase.open();
    const projects = new ProjectAuthorityRepository();
    const events = new AuthorityEventRepository();
    const idempotency = new AuthorityIdempotencyRepository();
    await authorityDatabase.mutate(connection => projects.initialize(connection, {
      createdAt: '2026-08-08T00:00:00.000Z',
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Alpha',
      projectId: PROJECT_ID,
    }));
    ticketService = new TicketService(authorityDatabase);
    occupiedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedServer.once('error', reject);
      occupiedServer.listen(0, '127.0.0.1', resolve);
    });
    const address = occupiedServer.address();
    if (!address || typeof address === 'string') throw new Error('Occupied port missing');
    occupiedPort = address.port;
    coordinator = new LanHostCoordinator({
      createAddressMonitor: check => {
        checkHostAddress = check;
        return { close: addressMonitorClose };
      },
      createGitProxy,
      createInvitationCodec: hostAddress => new InvitationCodec({
        isAddressAllowed: addressValue => addressValue === hostAddress,
      }),
      getPrivateIpv4Addresses: () => privateAddresses,
      discovery: { advertiseProject },
      localProjects,
      openProject: async projectId => {
        if (projectId !== PROJECT_ID) throw new Error('Unexpected Project');
        const eventHub = new ProjectEventHub(
          projectId,
          new SqlJsProjectEventSource(authorityDatabase, projectId),
        );
        const managerResponsibilities = new ManagerResponsibilityService({
          database: authorityDatabase,
          events,
          idempotency,
          presence: eventHub,
        });
        const unsupportedLifecycle = jest.fn(async () => {
          throw new Error('Unexpected lifecycle operation');
        });
        const requestQueries = new RequestQueryService(
          authorityDatabase,
          { inspect: unsupportedLifecycle } as never,
        );
        return {
          authority: { database: authorityDatabase, events, idempotency, projects },
          authorityDirectory,
          events: eventHub,
          git: gitRuntime(),
          lifecycle: {
            acceptHostTransfer: unsupportedLifecycle,
            acknowledgeManagerResponsibility: (actorMemberId, request) => (
              managerResponsibilities.acknowledge(actorMemberId, request)
            ),
            cancelHostTransfer: unsupportedLifecycle,
            cancelManagerResponsibilityOffer: (actorMemberId, request) => (
              managerResponsibilities.cancel(actorMemberId, request)
            ),
            createHostTransfer: unsupportedLifecycle,
            createManagerResponsibilityOffer: (actorMemberId, request) => (
              managerResponsibilities.create(actorMemberId, request)
            ),
            createRetirementCoordinator: () => ({
              retireProject: unsupportedLifecycle,
            }),
            declineHostTransfer: unsupportedLifecycle,
            declineManagerResponsibility: (actorMemberId, request) => (
              managerResponsibilities.decline(actorMemberId, request)
            ),
            getCurrentManagerResponsibilityOffer: (actorMemberId, request) => (
              managerResponsibilities.getCurrent(actorMemberId, request.projectId)
            ),
            getCurrentHostTransfer: async () => null,
            getHostTransitions: unsupportedLifecycle,
            getManagerResponsibilityOffer: (actorMemberId, request) => (
              managerResponsibilities.getById(
                actorMemberId,
                request.projectId,
                request.offerId,
              )
            ),
          },
          readMainOid: async () => MAIN_OID,
          requests: {
            accept: unsupportedLifecycle,
            createComment: unsupportedLifecycle,
            ensure: unsupportedLifecycle,
            read: requestQueries.read.bind(requestQueries),
            readComments: requestQueries.readComments.bind(requestQueries),
            updateMetadata: unsupportedLifecycle,
          },
          ...(outgoingHostTransfer ? { outgoingHostTransfer: {
            cancelBeforeRelinquishment: jest.fn(),
            close: outgoingHostTransfer.close ?? jest.fn().mockResolvedValue(undefined),
            inspectStartupRecovery: outgoingHostTransfer.inspectStartupRecovery,
            prepareAccepted: jest.fn(),
            prepareCancellation: outgoingHostTransfer.prepareCancellation ?? jest.fn(),
            prepareTerminalRecoveryBeforeStartup:
              outgoingHostTransfer.prepareTerminalRecoveryBeforeStartup ?? jest.fn(),
            resume: outgoingHostTransfer.resume,
            run: jest.fn(),
          } } : {}),
          tickets: ticketService,
          validate: async () => undefined,
        };
      },
      portCandidates: [occupiedPort, 0],
      tlsIdentity: {
        issueServerIdentity: (address: string) => issueServerIdentity(address),
      } as unknown as LanTlsIdentity,
      vaultRoot: root,
    });
  });

  afterEach(async () => {
    await coordinator.close();
    await authorityDatabase.close();
    await new Promise<void>(resolve => {
      occupiedServer.close(() => resolve());
      occupiedServer.closeAllConnections();
    });
    await rm(root, { force: true, recursive: true });
  });

  it('starts explicitly, selects the next port, and completes pending activation', async () => {
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      status: 'stopped',
    });
    const starting = coordinator.startProject(PROJECT_ID);
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      status: 'starting',
    });
    const host = await starting;
    expect(host.status).toBe('running');
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      endpoint: host.endpoint,
      projectId: PROJECT_ID,
      status: 'running',
    });
    expect(new URL(host.endpoint).port).not.toBe(String(occupiedPort));
    expect(advertiseProject).toHaveBeenCalledWith({
      caFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      endpoint: host.endpoint,
      projectId: PROJECT_ID,
    });
    const localMembership = await localProjects.loadMembership(PROJECT_ID);
    expect(localMembership?.authority).toMatchObject({
      endpoint: host.endpoint,
      hostCaFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(localMembership?.hostOwnership.autoStart).toBe(true);
    const hostCa = localMembership?.authority.hostCaCertificatePem;
    if (!hostCa) throw new Error('Stored Host CA missing');
    await expect(readPinnedUrl(
      `${host.endpoint}/v1/git/${PROJECT_ID}/repository.git/info/refs?service=git-upload-pack`,
      hostCa,
    )).resolves.toBe('git-ready');

    const invitationView = await coordinator.createInvitation(PROJECT_ID);
    const codec = new InvitationCodec({
      isAddressAllowed: addressValue => addressValue === '127.0.0.1',
    });
    const invitation = codec.decode(invitationView.encodedInvitation);
    const transport = new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    });
    const client = await transport.bootstrapInvitation(invitation);
    const join = await client.requestWithInvitation({
      body: {
        displayName: 'Member',
        joinAttemptId: 'join-alpha',
        projectId: PROJECT_ID,
      },
      decode: value => envelopeData<{ joinAttempt: {
        member: { id: string };
        memberCredential: string;
      } }>(value),
      method: 'POST',
      path: `/v9/projects/${PROJECT_ID}/join-attempts`,
    }, invitation.invitationSecret);
    const activated = await client.requestWithMember({
      body: {
        idempotencyKey: 'activate-alpha',
        joinAttemptId: 'join-alpha',
        projectId: PROJECT_ID,
      },
      decode: value => envelopeData<{ currentMember: { status: string } }>(value),
      idempotencyKey: 'activate-alpha',
      method: 'POST',
      path: `/v9/projects/${PROJECT_ID}/join-attempts/join-alpha/activate`,
    }, join.joinAttempt.memberCredential);

    expect(activated.currentMember.status).toBe('active');
    await expect(client.requestWithMember({
      body: { invitation, projectId: PROJECT_ID },
      decode: value => envelopeData<{ caFingerprint: string; endpoint: string }>(value),
      method: 'POST',
      path: `/v9/projects/${PROJECT_ID}/endpoint-refresh`,
    }, join.joinAttempt.memberCredential)).resolves.toEqual({
      caFingerprint: invitation.caFingerprint,
      endpoint: host.endpoint,
    });

    const memberRoot = path.join(root, 'member-device');
    const memberProjects = new CollabLocalProjectRepository(memberRoot);
    const memberWorkspace = path.join(memberRoot, 'workspace', PROJECT_ID);
    const retainedRefPath = path.join(
      memberWorkspace,
      '.git',
      'refs',
      'heads',
      'members',
      join.joinAttempt.member.id,
    );
    await mkdir(path.dirname(retainedRefPath), { recursive: true });
    await writeFile(path.join(memberWorkspace, 'retained.md'), '# Local work\n');
    await writeFile(retainedRefPath, `${MAIN_OID}\n`);
    await memberProjects.saveMembership({
      authority: {
        endpoint: host.endpoint,
        gitRemoteUrl: `${host.endpoint}/v1/git/${PROJECT_ID}/repository.git`,
        hostCaCertificatePem: hostCa,
        hostCaFingerprint: invitation.caFingerprint,
        kind: 'lan',
      },
      createdAt: '2026-08-08T00:00:00.000Z',
      hostOwnership: { ownsAuthority: false },
      lastEventSequence: 0,
      member: {
        credential: join.joinAttempt.memberCredential,
        displayName: 'Member',
        id: join.joinAttempt.member.id,
        personalRef: `refs/heads/members/${join.joinAttempt.member.id}`,
        role: 'member',
      },
      project: {
        id: PROJECT_ID,
        name: 'Alpha',
        workspacePath: `workspace/${PROJECT_ID}`,
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: '2026-08-08T00:00:00.000Z',
    });
    const hostAccess = membershipAccess(localProjects);
    const memberAccess = membershipAccess(memberProjects);
    const events = new WebSocket(
      `${host.endpoint.replace('https:', 'wss:')}/v9/projects/${PROJECT_ID}/events`,
      {
        ca: hostCa,
        headers: { authorization: `Bearer ${join.joinAttempt.memberCredential}` },
        rejectUnauthorized: true,
      },
    );
    const hostEvents = new WebSocket(
      `${host.endpoint.replace('https:', 'wss:')}/v9/projects/${PROJECT_ID}/events`,
      {
        ca: hostCa,
        headers: { authorization: `Bearer ${HOST_CREDENTIAL}` },
        rejectUnauthorized: true,
      },
    );
    const firstEvent = new Promise<unknown>((resolve, reject) => {
      events.once('message', data => {
        try {
          resolve(JSON.parse(data.toString()) as unknown);
        } catch (error) {
          reject(error);
        }
      });
      events.once('error', reject);
    });
    await Promise.all([events, hostEvents].map(socket => new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('open', () => resolve());
    })));
    await expect(memberAccess.service.createInvitation(PROJECT_ID)).rejects.toMatchObject({
      code: 'authorization-denied',
    });
    const memberOffer = await hostAccess.service.createManagerResponsibilityOffer({
      projectId: PROJECT_ID,
      purpose: 'manager-promotion',
      targetMemberId: join.joinAttempt.member.id,
    });
    await memberAccess.projection.readSnapshot(PROJECT_ID);
    await hostAccess.service.promoteManager({
      managerResponsibilityOfferId: memberOffer.offerId,
      projectId: PROJECT_ID,
      targetMemberId: join.joinAttempt.member.id,
    });
    await memberAccess.service.listMembers(PROJECT_ID);
    expect(await localProjects.loadMembership(PROJECT_ID)).toMatchObject({
      member: { role: 'manager' },
    });
    expect(await memberProjects.loadMembership(PROJECT_ID)).toMatchObject({
      hostOwnership: { ownsAuthority: false },
      member: { role: 'manager' },
    });
    await expect(memberAccess.service.createInvitation(PROJECT_ID)).resolves.toMatchObject({
      encodedInvitation: expect.stringMatching(/^claudian-collab:v9:/),
    });
    await expect(memberAccess.service.removeMember({
      memberId: 'member-host',
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({ code: 'authorization-denied' });
    await hostAccess.service.demoteManager({
      projectId: PROJECT_ID,
      targetMemberId: join.joinAttempt.member.id,
    });
    await memberAccess.service.listMembers(PROJECT_ID);
    expect(await memberProjects.loadMembership(PROJECT_ID)).toMatchObject({
      member: { role: 'member' },
    });

    await expect(firstEvent).resolves.toMatchObject({
      kind: expect.stringMatching(/^(invitation-updated|membership-updated)$/),
      projectId: PROJECT_ID,
      sequence: expect.any(Number),
    });
    const closeOwnedChild = jest.fn(async () => undefined);
    coordinator.registerOwnedResource(
      PROJECT_ID,
      join.joinAttempt.member.id,
      closeOwnedChild,
    );
    const eventsClosed = new Promise<{ code: number; reason: string }>(resolve => {
      events.once('close', (code, reason) => resolve({
        code,
        reason: reason.toString(),
      }));
    });
    await expect(hostAccess.service.removeMember({
      memberId: join.joinAttempt.member.id,
      projectId: PROJECT_ID,
    })).resolves.toBeUndefined();
    expect(await memberProjects.loadMembership(PROJECT_ID)).toMatchObject({
      member: {
        id: join.joinAttempt.member.id,
        role: 'member',
      },
    });
    expect(closeOwnedChild).toHaveBeenCalledTimes(1);
    expect(closeOwnedChild).toHaveBeenCalledWith('access-removed');
    await expect(eventsClosed).resolves.toEqual({
      code: 1008,
      reason: 'Access removed',
    });
    hostEvents.close();
    await expect(client.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: `/v9/projects/${PROJECT_ID}/snapshot`,
    }, join.joinAttempt.memberCredential)).rejects.toMatchObject({
      code: 'membership-revoked',
    });
    await expect(readFile(path.join(memberWorkspace, 'retained.md'), 'utf8'))
      .resolves.toBe('# Local work\n');
    await expect(readFile(retainedRefPath, 'utf8')).resolves.toBe(`${MAIN_OID}\n`);
    hostAccess.projection.dispose();
    memberAccess.projection.dispose();
    const stopping = coordinator.stopProject(PROJECT_ID);
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      status: 'stopping',
    });
    await expect(stopping).resolves.toEqual({
      projectId: PROJECT_ID,
      status: 'stopped',
    });
    await expect(localProjects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      hostOwnership: { autoStart: false, ownsAuthority: true },
    });
    expect(advertisementStop).toHaveBeenCalledTimes(1);
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      status: 'stopped',
    });
    expect(await authorityDatabase.read(connection => ({
      invitation: connection.get(
        'SELECT revoked_at FROM invitations WHERE invitation_id = ?',
        [invitation.invitationId],
      ),
      member: connection.get(
        'SELECT status FROM members WHERE member_id = ?',
        [join.joinAttempt.member.id],
      ),
    }))).toEqual({
      invitation: { revoked_at: expect.any(String) },
      member: { status: 'revoked' },
    });
    await expect(fetch(`${host.endpoint}/v9/projects/${PROJECT_ID}/snapshot`))
      .rejects.toThrow();
  });

  it('quiesces and closes one old-Host route without reopening after cutover', async () => {
    await coordinator.startProject(PROJECT_ID);

    await coordinator.quiesceProjectForHostTransfer(PROJECT_ID);
    await coordinator.reopenProjectBeforeHostTransfer(PROJECT_ID);
    await coordinator.quiesceProjectForHostTransfer(PROJECT_ID);
    await coordinator.closeProjectForHostTransfer(PROJECT_ID);
    await coordinator.closeProjectForHostTransfer(PROJECT_ID);

    expect(coordinator.isProjectRunning(PROJECT_ID)).toBe(false);
    await expect(coordinator.reopenProjectBeforeHostTransfer(PROJECT_ID))
      .rejects.toMatchObject({ code: 'project-not-found' });
    await expect(coordinator.completeProjectHostTransfer(PROJECT_ID)).resolves.toBeUndefined();
  });

  it('drains outgoing work after the old Host route has already closed', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    outgoingHostTransfer = {
      close,
      inspectStartupRecovery: jest.fn().mockResolvedValue('none'),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    await coordinator.startProject(PROJECT_ID);
    await coordinator.quiesceProjectForHostTransfer(PROJECT_ID);
    await coordinator.closeProjectForHostTransfer(PROJECT_ID);

    await coordinator.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('lets post-relinquishment cleanup use the LAN queue while unload drains it', async () => {
    outgoingHostTransfer = {
      close: jest.fn(async () => {
        await Promise.resolve();
        await coordinator.closeProjectForHostTransfer(PROJECT_ID);
      }),
      inspectStartupRecovery: jest.fn().mockResolvedValue('none'),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    await coordinator.startProject(PROJECT_ID);
    await coordinator.quiesceProjectForHostTransfer(PROJECT_ID);

    await expect(coordinator.close()).resolves.toBeUndefined();

    expect(outgoingHostTransfer.close).toHaveBeenCalledTimes(1);
  });

  it('lets post-relinquishment cleanup use the LAN queue during explicit stop', async () => {
    outgoingHostTransfer = {
      close: jest.fn(async () => {
        await Promise.resolve();
        await coordinator.closeProjectForHostTransfer(PROJECT_ID);
      }),
      inspectStartupRecovery: jest.fn().mockResolvedValue('none'),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    await coordinator.startProject(PROJECT_ID);
    await coordinator.quiesceProjectForHostTransfer(PROJECT_ID);

    await expect(coordinator.stopProject(PROJECT_ID)).resolves.toEqual({
      projectId: PROJECT_ID,
      status: 'stopped',
    });

    expect(outgoingHostTransfer.close).toHaveBeenCalledTimes(1);
  });

  it('closes transfer runtime created by a start already queued before stop', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    outgoingHostTransfer = {
      close,
      inspectStartupRecovery: jest.fn().mockResolvedValue('none'),
      resume: jest.fn().mockResolvedValue(undefined),
    };

    const starting = coordinator.startProject(PROJECT_ID);
    const stopping = coordinator.stopProject(PROJECT_ID);

    await expect(starting).resolves.toMatchObject({ status: 'running' });
    await expect(stopping).resolves.toMatchObject({ status: 'stopped' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not register or advertise the old Host before post-relinquishment recovery', async () => {
    outgoingHostTransfer = {
      inspectStartupRecovery: jest.fn().mockResolvedValue('post-relinquishment'),
      resume: jest.fn().mockResolvedValue(undefined),
    };

    await expect(coordinator.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'host-transfer-post-relinquishment-recovery' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(outgoingHostTransfer.inspectStartupRecovery).toHaveBeenCalledTimes(1);
    expect(outgoingHostTransfer.resume).toHaveBeenCalledTimes(1);
    expect(advertiseProject).not.toHaveBeenCalled();
    expect(coordinator.isProjectRunning(PROJECT_ID)).toBe(false);
  });

  it('owns post-relinquishment recovery until unload drains it', async () => {
    let releaseResume!: () => void;
    const resumed = new Promise<void>(resolve => {
      releaseResume = resolve;
    });
    const close = jest.fn(async () => {
      releaseResume();
    });
    outgoingHostTransfer = {
      close,
      inspectStartupRecovery: jest.fn().mockResolvedValue('post-relinquishment'),
      resume: jest.fn(() => resumed),
    };

    await expect(coordinator.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await Promise.resolve();
    await coordinator.close();

    expect(close).toHaveBeenCalledTimes(1);
    await expect(resumed).resolves.toBeUndefined();
  });

  it('does not admit a late recovery owner after unload begins during inspection', async () => {
    let reportInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>(resolve => {
      reportInspectionStarted = resolve;
    });
    let releaseInspection!: () => void;
    const inspectionReleased = new Promise<void>(resolve => {
      releaseInspection = resolve;
    });
    outgoingHostTransfer = {
      close: jest.fn().mockResolvedValue(undefined),
      inspectStartupRecovery: jest.fn(async () => {
        reportInspectionStarted();
        await inspectionReleased;
        return 'post-relinquishment';
      }),
      resume: jest.fn().mockResolvedValue(undefined),
    };

    const starting = coordinator.startProject(PROJECT_ID);
    await inspectionStarted;
    const closing = coordinator.close();
    releaseInspection();

    await expect(starting).rejects.toMatchObject({ code: 'not-initialized' });
    await closing;
    expect(outgoingHostTransfer.resume).not.toHaveBeenCalled();
  });

  it('deduplicates post-relinquishment recovery until its owner settles', async () => {
    let releaseResume!: () => void;
    const resumed = new Promise<void>(resolve => {
      releaseResume = resolve;
    });
    outgoingHostTransfer = {
      close: jest.fn(async () => releaseResume()),
      inspectStartupRecovery: jest.fn().mockResolvedValue('post-relinquishment'),
      resume: jest.fn(() => resumed),
    };

    await expect(coordinator.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
    });
    await expect(coordinator.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'host-transfer-post-relinquishment-recovery-in-progress' },
    });

    expect(outgoingHostTransfer.inspectStartupRecovery).toHaveBeenCalledTimes(1);
    expect(outgoingHostTransfer.resume).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it('restores a pre-relinquishment Host fail-closed before advertising it', async () => {
    outgoingHostTransfer = {
      inspectStartupRecovery: jest.fn().mockResolvedValue('pre-relinquishment'),
      resume: jest.fn().mockResolvedValue(undefined),
    };

    const host = await coordinator.startProject(PROJECT_ID);
    const membership = await localProjects.loadMembership(PROJECT_ID);
    if (!membership?.authority.hostCaCertificatePem) {
      throw new Error('Missing Host CA fixture');
    }
    const response = JSON.parse(await readPinnedUrl(
      `${host.endpoint}/v9/projects/${PROJECT_ID}/snapshot`,
      membership.authority.hostCaCertificatePem,
    )) as { error?: { code?: string } };

    expect(response.error?.code).toBe('host-transfer-pending');
    expect(outgoingHostTransfer.resume).toHaveBeenCalledTimes(1);
  });

  it('finishes terminal target cleanup before reopening the old Host on startup', async () => {
    let releaseTargetCleanup!: () => void;
    const targetCleanupReleased = new Promise<void>(resolve => {
      releaseTargetCleanup = resolve;
    });
    let reportTargetCleanupStarted!: () => void;
    const targetCleanupStarted = new Promise<void>(resolve => {
      reportTargetCleanupStarted = resolve;
    });
    outgoingHostTransfer = {
      inspectStartupRecovery: jest.fn().mockResolvedValue('pre-relinquishment-cleanup'),
      prepareTerminalRecoveryBeforeStartup: jest.fn(async () => {
        reportTargetCleanupStarted();
        await targetCleanupReleased;
      }),
      resume: jest.fn().mockResolvedValue(undefined),
    };

    const starting = coordinator.startProject(PROJECT_ID);
    await targetCleanupStarted;

    expect(advertiseProject).not.toHaveBeenCalled();
    expect(coordinator.isProjectRunning(PROJECT_ID)).toBe(false);

    releaseTargetCleanup();
    await expect(starting).resolves.toMatchObject({ status: 'running' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(advertiseProject).toHaveBeenCalledTimes(1);
    expect(outgoingHostTransfer.prepareTerminalRecoveryBeforeStartup).toHaveBeenCalledTimes(1);
    expect(outgoingHostTransfer.resume).toHaveBeenCalledTimes(1);
  });

  it('resumes post-relinquishment recovery before rejecting stale local Host ownership', async () => {
    outgoingHostTransfer = {
      inspectStartupRecovery: jest.fn().mockResolvedValue('post-relinquishment'),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    const staleMembership = await localProjects.loadMembership(PROJECT_ID);
    if (!staleMembership) throw new Error('Missing local membership fixture');
    await localProjects.saveMembership({
      ...staleMembership,
      hostOwnership: { autoStart: true, ownsAuthority: false },
    });

    await expect(coordinator.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'host-transfer-post-relinquishment-recovery' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(outgoingHostTransfer.inspectStartupRecovery).toHaveBeenCalledTimes(1);
    expect(outgoingHostTransfer.resume).toHaveBeenCalledTimes(1);
    expect(advertiseProject).not.toHaveBeenCalled();
    expect(coordinator.isProjectRunning(PROJECT_ID)).toBe(false);
  });

  it('multiplexes an authenticated provisional Host-transfer receiver without advertising it', async () => {
    const receiverCredential = Buffer.alloc(32, 6).toString('base64url');
    const cancel = jest.fn().mockResolvedValue({
      afterResponseFlushed: jest.fn().mockResolvedValue(undefined),
    });
    const provisional = await coordinator.startProvisionalTransfer({
      coordinator: {
        activate: jest.fn().mockResolvedValue(undefined),
        cancel,
        complete: jest.fn().mockResolvedValue(undefined),
        confirm: jest.fn().mockResolvedValue({
          afterResponseFlushed: jest.fn().mockResolvedValue(undefined),
        }),
        stage: jest.fn().mockRejectedValue(new Error('Unexpected stage')),
      },
      projectId: PROJECT_ID,
      receiverCredential,
      transferId: 'transfer-provisional',
    });
    expect(advertiseProject).not.toHaveBeenCalled();
    const transport = new HostTransferTargetTransport();
    await transport.probe({
      endpoint: provisional.endpoint,
      receiverCredential,
      targetCaCertificatePem: provisional.caCertificatePem,
      targetCaFingerprint: provisional.caFingerprint,
      transferId: provisional.transferId,
    });
    await transport.cancel({
      endpoint: provisional.endpoint,
      receiverCredential,
      targetCaCertificatePem: provisional.caCertificatePem,
      targetCaFingerprint: provisional.caFingerprint,
      transferId: provisional.transferId,
    });
    expect(cancel).toHaveBeenCalledWith(PROJECT_ID, 'transfer-provisional');
  });

  it('traverses bounded activity pages larger than one LAN response', async () => {
    await coordinator.startProject(PROJECT_ID);
    const control = new LocalProjectControlPort(localProjects);
    const created = await control.createTicket({
      body: 'Paged Ticket',
      projectId: PROJECT_ID,
      title: 'Paged Ticket',
    }, 'ticket-paged-comments');
    const requestId = 'request-paged-comments';
    const headOid = 'b'.repeat(40);
    const mergeOid = 'c'.repeat(40);
    const ticketBodies = Array.from({ length: 8 }, (_value, index) => (
      `${index}${'\u0001'.repeat(COLLAB_LIMITS.maxTicketCommentBytes - 1)}`
    ));
    const requestBodies = Array.from({ length: 8 }, (_value, index) => (
      `${index}${'\u0001'.repeat(COLLAB_LIMITS.maxCommentBytes - 1)}`
    ));

    await authorityDatabase.mutate(connection => {
      connection.run(
        `INSERT INTO change_requests (
          request_id, member_id, status, first_base_oid, latest_head_oid,
          merged_oid, description, revision, created_at, updated_at
        ) VALUES (?, 'member-host', 'open', ?, ?, NULL, 'Paged request', 1, ?, ?)`,
        [requestId, MAIN_OID, headOid, '2026-08-08T00:01:00.000Z', '2026-08-08T00:01:00.000Z'],
      );
      for (const [index, body] of ticketBodies.entries()) {
        const createdAt = new Date(Date.UTC(2026, 7, 8, 0, 2, index)).toISOString();
        connection.run(
          `INSERT INTO ticket_comments (
            comment_id, ticket_id, author_member_id, body, created_at
          ) VALUES (?, ?, 'member-host', ?, ?)`,
          [`ticket-comment-${index}`, created.ticket.id, body, createdAt],
        );
      }
      connection.run(
        'UPDATE tickets SET comment_count = ? WHERE ticket_id = ?',
        [ticketBodies.length, created.ticket.id],
      );
      for (const [index, body] of requestBodies.entries()) {
        const createdAt = new Date(Date.UTC(2026, 7, 8, 0, 3, index)).toISOString();
        connection.run(
          `INSERT INTO comments (
            comment_id, request_id, author_member_id, body, created_at
          ) VALUES (?, ?, 'member-host', ?, ?)`,
          [`request-comment-${index}`, requestId, body, createdAt],
        );
      }
      for (let index = 0; index <= COLLAB_LIMITS.maxRelationsPerPage; index += 1) {
        const acceptedRequestId = `accepted-request-${index}`;
        const acceptedAt = new Date(Date.UTC(2026, 7, 8, 0, 4) + index * 1_000)
          .toISOString();
        connection.run(
          `INSERT INTO change_requests (
            request_id, member_id, status, first_base_oid, latest_head_oid,
            merged_oid, description, revision, created_at, updated_at
          ) VALUES (?, 'member-host', 'merged', ?, ?, ?, 'Accepted', 1, ?, ?)`,
          [acceptedRequestId, MAIN_OID, headOid, mergeOid, acceptedAt, acceptedAt],
        );
        connection.run(
          `INSERT INTO request_ticket_relations (
            relation_id, request_id, ticket_id, commit_oid, kind, state,
            created_by_member_id, created_at, updated_at, accepted_at, accepted_merge_oid
          ) VALUES (?, ?, ?, ?, 'references', 'accepted', 'member-host', ?, ?, ?, ?)`,
          [
            `accepted-relation-${index}`,
            acceptedRequestId,
            created.ticket.id,
            headOid,
            acceptedAt,
            acceptedAt,
            acceptedAt,
            mergeOid,
          ],
        );
      }
    });

    const firstTicketPage = await control.readTicketPage(PROJECT_ID, created.ticket.id)
      .catch(error => {
        throw new Error('Ticket first-page traversal failed', { cause: error });
      });
    expect(firstTicketPage.comments.nextCursor).toBeDefined();
    expect(firstTicketPage.acceptedRelations.nextCursor).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(firstTicketPage.comments), 'utf8'))
      .toBeLessThanOrEqual(COLLAB_LIMITS.commentPageMaxUtf8Bytes);
    expect(Buffer.byteLength(JSON.stringify(firstTicketPage.acceptedRelations), 'utf8'))
      .toBeLessThanOrEqual(COLLAB_LIMITS.relationPageMaxUtf8Bytes);

    const completeTicket = await control.readTicket(
      PROJECT_ID,
      created.ticket.id,
    ).catch(error => {
      throw new Error('Ticket continuation traversal failed', { cause: error });
    });
    expect(completeTicket.comments.comments.map(comment => comment.body)).toEqual(ticketBodies);
    expect(completeTicket.acceptedRelations.acceptedRelations).toHaveLength(
      COLLAB_LIMITS.maxRelationsPerPage + 1,
    );
    expect(Buffer.byteLength(JSON.stringify(completeTicket.comments), 'utf8'))
      .toBeGreaterThan(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes);

    const requestBodiesSeen: string[] = [];
    let requestCursor: string | undefined;
    let requestPageCount = 0;
    do {
      const page = await control.listRequestComments(PROJECT_ID, requestId, {
        ...(requestCursor ? { cursor: requestCursor } : {}),
        limit: COLLAB_LIMITS.maxCommentPageSize,
      }).catch(error => {
        throw new Error('Request-comment continuation traversal failed', { cause: error });
      });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8'))
        .toBeLessThanOrEqual(COLLAB_LIMITS.commentPageMaxUtf8Bytes);
      requestBodiesSeen.push(...page.comments.map(comment => comment.body));
      requestCursor = page.nextCursor;
      requestPageCount += 1;
    } while (requestCursor);
    expect(requestPageCount).toBeGreaterThan(1);
    expect(requestBodiesSeen).toEqual(requestBodies);
    expect(Buffer.byteLength(JSON.stringify({ comments: requestBodiesSeen }), 'utf8'))
      .toBeGreaterThan(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes);
  }, 30_000);

  it('reads a maximal-body Ticket detail through the real Host and client', async () => {
    await coordinator.startProject(PROJECT_ID);
    const control = new LocalProjectControlPort(localProjects);
    const projection = new CollabClientProjection(localProjects, control);
    await projection.readSnapshot(PROJECT_ID);

    // Quotes maximize escaping for this body while remaining valid Markdown;
    // control characters below exercise the six-byte JSON escape worst case.
    const body = '"'.repeat(COLLAB_LIMITS.maxTicketBodyBytes);
    const created = await control.createTicket({
      body,
      projectId: PROJECT_ID,
      title: 'Maximal Ticket',
    }, 'ticket-maximal-detail');
    const bodies = ['\u0001'.repeat(COLLAB_LIMITS.maxTicketCommentBytes)];
    await control.addTicketComment({
      body: bodies[0]!,
      projectId: PROJECT_ID,
      ticketId: created.ticket.id,
    }, 'maximal-comment-escaped');

    const projected = await projection.readTicket(PROJECT_ID, created.ticket.id);
    expect(projected.source).toBe('online');
    expect(projected.detail.body).toBe(body);
    expect(projected.detail.comments.comments.map(comment => comment.body)).toEqual(bodies);
    expect(new Set(projected.detail.comments.comments.map(comment => comment.id)).size)
      .toBe(bodies.length);

    projection.dispose();
  }, 30_000);

  it('replays lost-response Ticket mutations and serves prior reads after disconnect', async () => {
    await coordinator.startProject(PROJECT_ID);
    const control = new LocalProjectControlPort(localProjects);
    const projection = new CollabClientProjection(localProjects, control, {
      now: () => new Date('2026-08-08T00:10:00.000Z'),
    });
    await projection.readSnapshot(PROJECT_ID);

    const request = {
      body: 'Coordinate with @Host before retrying.',
      projectId: PROJECT_ID,
      title: 'Retry-safe Ticket',
    };
    const first = await control.createTicket(request, 'ticket-lost-response');
    const replay = await control.createTicket(request, 'ticket-lost-response');
    expect(replay.ticket.id).toBe(first.ticket.id);

    const commentRequest = {
      body: 'Retry-safe comment',
      projectId: PROJECT_ID,
      ticketId: first.ticket.id,
    };
    const firstComment = await control.addTicketComment(
      commentRequest,
      'ticket-comment-lost-response',
    );
    const replayedComment = await control.addTicketComment(
      commentRequest,
      'ticket-comment-lost-response',
    );
    expect(replayedComment.id).toBe(firstComment.id);

    await expect(projection.listTickets({
      projectId: PROJECT_ID,
      status: 'open',
    })).resolves.toMatchObject({
      page: { tickets: [expect.objectContaining({ id: first.ticket.id })] },
      source: 'online',
    });
    await expect(projection.readTicket(PROJECT_ID, first.ticket.id)).resolves.toMatchObject({
      detail: { comments: { comments: [expect.objectContaining({ id: firstComment.id })] } },
      source: 'online',
    });

    await coordinator.stopProject(PROJECT_ID);

    await expect(projection.listTickets({
      projectId: PROJECT_ID,
      status: 'open',
    })).resolves.toMatchObject({
      page: { tickets: [expect.objectContaining({ id: first.ticket.id })] },
      source: 'cache',
    });
    await expect(projection.readTicket(PROJECT_ID, first.ticket.id)).resolves.toMatchObject({
      detail: { comments: { comments: [expect.objectContaining({ id: firstComment.id })] } },
      source: 'cache',
    });
    projection.dispose();
  });

  it('clears auto-start intent when an already stopped Host is explicitly stopped', async () => {
    await expect(coordinator.stopProject(PROJECT_ID)).resolves.toEqual({
      projectId: PROJECT_ID,
      status: 'stopped',
    });

    await expect(localProjects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      hostOwnership: { autoStart: false, ownsAuthority: true },
    });
  });

  it('preserves auto-start intent when plugin shutdown only closes Host resources', async () => {
    await coordinator.startProject(PROJECT_ID);

    await coordinator.close();

    await expect(localProjects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      hostOwnership: { autoStart: true, ownsAuthority: true },
    });
  });

  it('rebinds every hosted Project after the preferred LAN address changes', async () => {
    const nextAddress = listPrivateIpv4Addresses()[0];
    if (!nextAddress) return;
    const first = await coordinator.startProject(PROJECT_ID);
    const firstMembership = await localProjects.loadMembership(PROJECT_ID);
    const ca = firstMembership?.authority.hostCaCertificatePem;
    if (!ca) throw new Error('Stored Host CA missing');

    privateAddresses = [nextAddress];
    await checkHostAddress();

    const state = coordinator.getProjectState(PROJECT_ID);
    expect(state).toMatchObject({
      status: 'running',
    });
    const nextEndpoint = state.endpoint!;
    expect(new URL(nextEndpoint).hostname).toBe(nextAddress);
    expect(nextEndpoint).not.toBe(first.endpoint);
    await expect(readPinnedUrl(
      `${nextEndpoint}/v1/git/${PROJECT_ID}/repository.git/info/refs?service=git-upload-pack`,
      ca,
    )).resolves.toBe('git-ready');
    await expect(fetch(`${first.endpoint}/v9/projects/${PROJECT_ID}/snapshot`))
      .rejects.toThrow();
    await expect(localProjects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: {
        endpoint: nextEndpoint,
        gitRemoteUrl: `${nextEndpoint}/v1/git/${PROJECT_ID}/repository.git`,
      },
    });
    const invitation = new InvitationCodec({
      isAddressAllowed: address => address === nextAddress,
    }).decode((await coordinator.createInvitation(PROJECT_ID)).encodedInvitation);
    expect(invitation.endpoint).toBe(nextEndpoint);
    expect(advertiseProject).toHaveBeenNthCalledWith(2, {
      caFingerprint: invitation.caFingerprint,
      endpoint: nextEndpoint,
      projectId: PROJECT_ID,
    });
    expect(advertisementStop).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('closes cleanly when unload begins during an address rebind', async () => {
    const nextAddress = listPrivateIpv4Addresses()[0];
    if (!nextAddress) return;
    const first = await coordinator.startProject(PROJECT_ID);

    privateAddresses = [nextAddress];
    let identityRequested!: () => void;
    let releaseIdentity!: () => void;
    const requested = new Promise<void>(resolve => { identityRequested = resolve; });
    const gate = new Promise<void>(resolve => { releaseIdentity = resolve; });
    const base = issueServerIdentity;
    issueServerIdentity = address => {
      if (address !== nextAddress) return base(address);
      identityRequested();
      return gate.then(() => base(address));
    };

    const rebind = checkHostAddress();
    await requested;
    const closing = coordinator.close();
    releaseIdentity();
    await expect(rebind).rejects.toMatchObject({ code: 'not-initialized' });
    await closing;

    const internals = coordinator as unknown as {
      hostLock: unknown;
      listener: unknown;
    };
    expect(internals.listener).toBeNull();
    expect(internals.hostLock).toBeNull();
    expect(advertiseProject).toHaveBeenCalledTimes(1);
    expect(advertisementStop).toHaveBeenCalled();
    await expect(localProjects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: { endpoint: first.endpoint },
    });
    await expect(access(path.join(root, '.claudian', 'collab', 'lan-host.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('closes the superseded listener when unload interrupts a rebind mid-advertisement', async () => {
    const nextAddress = listPrivateIpv4Addresses()
      .find(address => address !== '127.0.0.1');
    if (!nextAddress) return;
    const first = await coordinator.startProject(PROJECT_ID);
    const firstPort = Number(new URL(first.endpoint).port);

    privateAddresses = [nextAddress];
    let rebindAdvertiseReached!: () => void;
    let releaseRebindAdvertise!: () => void;
    const reached = new Promise<void>(resolve => { rebindAdvertiseReached = resolve; });
    const gate = new Promise<void>(resolve => { releaseRebindAdvertise = resolve; });
    // Installed after the initial start: the first call through this mock is
    // the rebind re-advertising the hosted Project on the new endpoint. The
    // replacement listener has already been promoted at that point.
    advertiseProject.mockImplementation(() => {
      rebindAdvertiseReached();
      return gate.then(() => ({ stop: advertisementStop }));
    });

    const rebind = checkHostAddress();
    await reached;
    const closing = coordinator.close();
    releaseRebindAdvertise();
    await expect(rebind).rejects.toMatchObject({ code: 'not-initialized' });
    await closing;

    // The interrupted rebind must not leave the superseded listener bound.
    await expect(new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(firstPort, '127.0.0.1', () => {
        probe.close(() => resolve());
      });
    })).resolves.toBeUndefined();
    await expect(localProjects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
      authority: { endpoint: first.endpoint },
    });
    await expect(access(path.join(root, '.claudian', 'collab', 'lan-host.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('closes cleanly when unload begins during a terminal responder start', async () => {
    let identityRequested!: () => void;
    let releaseIdentity!: () => void;
    const requested = new Promise<void>(resolve => { identityRequested = resolve; });
    const gate = new Promise<void>(resolve => { releaseIdentity = resolve; });
    const base = issueServerIdentity;
    issueServerIdentity = address => {
      identityRequested();
      return gate.then(() => base(address));
    };

    const terminalService = { getRetirement: jest.fn() };
    const starting = coordinator.startTerminalProject({
      projectId: PROJECT_ID,
      service: terminalService as never,
    });
    await requested;
    const closing = coordinator.close();
    releaseIdentity();
    await expect(starting).rejects.toMatchObject({ code: 'not-initialized' });
    await closing;

    const internals = coordinator as unknown as {
      hostLock: unknown;
      listener: unknown;
      terminalProjects: Map<string, unknown>;
    };
    expect(internals.listener).toBeNull();
    expect(internals.hostLock).toBeNull();
    expect(internals.terminalProjects.size).toBe(0);
    expect(advertiseProject).not.toHaveBeenCalled();
    await expect(access(path.join(root, '.claudian', 'collab', 'lan-host.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('closes cleanly when unload begins during a provisional Host-transfer start', async () => {
    let identityRequested!: () => void;
    let releaseIdentity!: () => void;
    const requested = new Promise<void>(resolve => { identityRequested = resolve; });
    const gate = new Promise<void>(resolve => { releaseIdentity = resolve; });
    const base = issueServerIdentity;
    issueServerIdentity = address => {
      identityRequested();
      return gate.then(() => base(address));
    };

    const starting = coordinator.startProvisionalTransfer({
      coordinator: {
        activate: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn().mockResolvedValue({}),
        complete: jest.fn().mockResolvedValue(undefined),
        confirm: jest.fn().mockResolvedValue({}),
        stage: jest.fn().mockResolvedValue(undefined),
      },
      projectId: PROJECT_ID,
      receiverCredential: Buffer.alloc(32, 6).toString('base64url'),
      transferId: 'transfer-close-race',
    });
    await requested;
    const closing = coordinator.close();
    releaseIdentity();
    await expect(starting).rejects.toMatchObject({ code: 'not-initialized' });
    await closing;

    const internals = coordinator as unknown as {
      hostLock: unknown;
      listener: unknown;
      provisionalTransfers: { size: number };
    };
    expect(internals.listener).toBeNull();
    expect(internals.hostLock).toBeNull();
    expect(internals.provisionalTransfers.size).toBe(0);
    expect(advertiseProject).not.toHaveBeenCalled();
    await expect(access(path.join(root, '.claudian', 'collab', 'lan-host.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('keeps the current listener alive while network interfaces are temporarily absent', async () => {
    const first = await coordinator.startProject(PROJECT_ID);
    const membership = await localProjects.loadMembership(PROJECT_ID);
    const ca = membership?.authority.hostCaCertificatePem;
    if (!ca) throw new Error('Stored Host CA missing');

    privateAddresses = [];
    await expect(checkHostAddress()).rejects.toMatchObject({
      code: 'endpoint-unreachable',
    });
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      status: 'needs-attention',
    });
    await expect(readPinnedUrl(
      `${first.endpoint}/v1/git/${PROJECT_ID}/repository.git/info/refs?service=git-upload-pack`,
      ca,
    )).resolves.toBe('git-ready');

    privateAddresses = ['127.0.0.1'];
    await checkHostAddress();
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      endpoint: first.endpoint,
      projectId: PROJECT_ID,
      status: 'running',
    });
  });

  it('reconnects one existing Member after the Host moves to another endpoint', async () => {
    const firstHost = await coordinator.startProject(PROJECT_ID);
    const firstHostMembership = await localProjects.loadMembership(PROJECT_ID);
    const hostCa = firstHostMembership?.authority.hostCaCertificatePem;
    const hostFingerprint = firstHostMembership?.authority.hostCaFingerprint;
    if (!hostCa || !hostFingerprint) throw new Error('Stored Host trust missing');
    const codec = new InvitationCodec({
      isAddressAllowed: addressValue => addressValue === '127.0.0.1',
    });
    const firstInvitationView = await coordinator.createInvitation(PROJECT_ID);
    const firstInvitation = codec.decode(firstInvitationView.encodedInvitation);
    const firstClient = await new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    }).bootstrapInvitation(firstInvitation);
    const joined = await firstClient.requestWithInvitation({
      body: {
        displayName: 'Member',
        joinAttemptId: 'join-roaming-member',
        projectId: PROJECT_ID,
      },
      decode: value => envelopeData<{ joinAttempt: {
        member: { id: string; personalRef: string };
        memberCredential: string;
      } }>(value),
      method: 'POST',
      path: `/v9/projects/${PROJECT_ID}/join-attempts`,
    }, firstInvitation.invitationSecret);
    await firstClient.requestWithMember({
      body: {
        idempotencyKey: 'activate-roaming-member',
        joinAttemptId: 'join-roaming-member',
        projectId: PROJECT_ID,
      },
      decode: value => envelopeData(value),
      idempotencyKey: 'activate-roaming-member',
      method: 'POST',
      path: `/v9/projects/${PROJECT_ID}/join-attempts/join-roaming-member/activate`,
    }, joined.joinAttempt.memberCredential);

    const memberRoot = path.join(root, 'roaming-member-device');
    const memberProjects = new CollabLocalProjectRepository(memberRoot);
    await mkdir(path.join(memberRoot, 'workspace', PROJECT_ID, '.git'), {
      recursive: true,
    });
    await memberProjects.saveMembership({
      authority: {
        endpoint: firstHost.endpoint,
        gitRemoteUrl: `${firstHost.endpoint}/v1/git/${PROJECT_ID}/repository.git`,
        hostCaCertificatePem: hostCa,
        hostCaFingerprint: hostFingerprint,
        kind: 'lan',
      },
      createdAt: '2026-08-08T00:00:00.000Z',
      hostOwnership: { ownsAuthority: false },
      lastEventSequence: 0,
      member: {
        credential: joined.joinAttempt.memberCredential,
        displayName: 'Member',
        id: joined.joinAttempt.member.id,
        personalRef: joined.joinAttempt.member.personalRef,
        role: 'member',
      },
      project: {
        id: PROJECT_ID,
        name: 'Alpha',
        workspacePath: `workspace/${PROJECT_ID}`,
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: '2026-08-08T00:00:00.000Z',
    });

    await coordinator.stopProject(PROJECT_ID);
    const previousAddress = new URL(firstHost.endpoint);
    const oldEndpointBlocker = createServer();
    await new Promise<void>((resolve, reject) => {
      oldEndpointBlocker.once('error', reject);
      oldEndpointBlocker.listen(Number(previousAddress.port), '127.0.0.1', resolve);
    });
    try {
      const nextHost = await coordinator.startProject(PROJECT_ID);
      expect(nextHost.endpoint).not.toBe(firstHost.endpoint);
      const nextInvitation = await coordinator.createInvitation(PROJECT_ID);
      let originUrls = [
        `${firstHost.endpoint}/v1/git/${PROJECT_ID}/repository.git`,
      ];
      const reconnect = new ReconnectProjectCoordinator({
        local: {
          projects: memberProjects,
          workspace: {
            resolveManagedProjectPath: async workspacePath => (
              path.join(memberRoot, ...workspacePath.split('/'))
            ),
          },
        },
        requireGitFoundation: async () => ({
          repositories: {
            addRemote: async (_repositoryPath: string, _remote: string, url: string) => {
              originUrls = [url];
            },
            assertLocalRepositoryIdentity: async () => undefined,
            listRemoteUrls: async () => originUrls,
          },
        } as never),
      }, {
        invitationCodec: codec,
        vaultRoot: memberRoot,
      });

      await expect(reconnect.reconnectProject({
        encodedInvitation: nextInvitation.encodedInvitation,
        projectId: PROJECT_ID,
      })).resolves.toMatchObject({
        status: 'success',
        value: { id: PROJECT_ID, role: 'member' },
      });

      const reconnectedMembership = await memberProjects.loadMembership(PROJECT_ID);
      expect(reconnectedMembership).toMatchObject({
        authority: {
          endpoint: nextHost.endpoint,
          gitRemoteUrl: `${nextHost.endpoint}/v1/git/${PROJECT_ID}/repository.git`,
          hostCaFingerprint: hostFingerprint,
        },
        member: {
          credential: joined.joinAttempt.memberCredential,
          id: joined.joinAttempt.member.id,
          personalRef: joined.joinAttempt.member.personalRef,
        },
      });
      await expect(new LocalProjectControlPort(memberProjects).readSnapshot(PROJECT_ID))
        .resolves.toMatchObject({
          currentMember: { id: joined.joinAttempt.member.id },
          members: [
            expect.objectContaining({ id: 'member-host' }),
            expect.objectContaining({ id: joined.joinAttempt.member.id }),
          ],
        });
    } finally {
      await new Promise<void>(resolve => {
        oldEndpointBlocker.close(() => resolve());
        oldEndpointBlocker.closeAllConnections();
      });
    }
  });

  it('holds one exclusive Vault Host lock before opening another authority', async () => {
    await coordinator.startProject(PROJECT_ID);
    const secondOpen = jest.fn();
    const second = new LanHostCoordinator({
      createGitProxy,
      createInvitationCodec: () => new InvitationCodec({
        isAddressAllowed: addressValue => addressValue === '127.0.0.1',
      }),
      getPrivateIpv4Addresses: () => ['127.0.0.1'],
      localProjects,
      openProject: secondOpen,
      portCandidates: [0],
      vaultRoot: root,
    });

    await expect(second.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'authorization-denied',
    });
    expect(secondOpen).not.toHaveBeenCalled();
    await second.close();
  });

  it('reclaims an orphaned Host lock left by an earlier renderer context', async () => {
    await localProjects.ensurePrivateStateContainer();
    const lockPath = path.join(root, '.claudian', 'collab', 'lan-host.lock');
    await writeFile(lockPath, JSON.stringify({
      nonce: 'orphaned-renderer-lock',
      pid: process.pid,
    }), { mode: 0o600 });

    await expect(coordinator.startProject(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      status: 'running',
    });
    expect(await readFile(lockPath, 'utf8')).not.toContain('orphaned-renderer-lock');
  });

  it('multiplexes only explicitly started Projects on one listener', async () => {
    const betaId = 'project-beta';
    await localProjects.saveMembership({
      authority: {
        endpoint: null,
        gitRemoteUrl: null,
        hostCaCertificatePem: null,
        hostCaFingerprint: null,
        kind: 'lan',
      },
      createdAt: '2026-08-08T00:00:00.000Z',
      hostOwnership: { ownsAuthority: true },
      lastEventSequence: 0,
      member: {
        credential: HOST_CREDENTIAL,
        displayName: 'Host',
        id: 'member-host',
        personalRef: 'refs/heads/members/member-host',
        role: 'manager',
      },
      project: {
        id: betaId,
        name: 'Beta',
        workspacePath: 'workspace/beta',
      },
      schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
      updatedAt: '2026-08-08T00:00:00.000Z',
    });
    const betaDirectory = await localProjects.ensureAuthorityDirectory(betaId);
    const betaDatabase = new SqlJsProjectDatabase(betaDirectory, {
      loadSqlJs: async () => SQL,
    });
    await betaDatabase.open();
    const betaProjects = new ProjectAuthorityRepository();
    const betaEvents = new AuthorityEventRepository();
    const betaIdempotency = new AuthorityIdempotencyRepository();
    await betaDatabase.mutate(connection => betaProjects.initialize(connection, {
      createdAt: '2026-08-08T00:00:00.000Z',
      hostCredentialHash: createHash('sha256').update(HOST_CREDENTIAL).digest(),
      hostDisplayName: 'Host',
      hostMemberId: 'member-host',
      name: 'Beta',
      projectId: betaId,
    }));

    await coordinator.close();
    coordinator = new LanHostCoordinator({
      createGitProxy,
      createInvitationCodec: () => new InvitationCodec({
        isAddressAllowed: addressValue => addressValue === '127.0.0.1',
      }),
      getPrivateIpv4Addresses: () => ['127.0.0.1'],
      localProjects,
      openProject: async projectId => projectId === PROJECT_ID
        ? {
            authority: {
              database: authorityDatabase,
              events: new AuthorityEventRepository(),
              idempotency: new AuthorityIdempotencyRepository(),
              projects: new ProjectAuthorityRepository(),
            },
            authorityDirectory: path.join(root, 'alpha'),
            git: gitRuntime(),
            ...hostedControlCapabilities(),
            readMainOid: async () => MAIN_OID,
            validate: async () => undefined,
          }
        : {
            authority: {
              database: betaDatabase,
              events: betaEvents,
              idempotency: betaIdempotency,
              projects: betaProjects,
            },
            authorityDirectory: betaDirectory,
            git: gitRuntime(),
            ...hostedControlCapabilities(),
            readMainOid: async () => MAIN_OID,
            validate: async () => undefined,
          },
      portCandidates: [0],
      tlsIdentity: sharedTlsIdentity,
      vaultRoot: root,
    });
    try {
      const alpha = await coordinator.startProject(PROJECT_ID);
      const beta = await coordinator.startProject(betaId);
      expect(beta.endpoint).toBe(alpha.endpoint);

      await coordinator.stopProject(PROJECT_ID);
      await expect(coordinator.createInvitation(betaId)).resolves.toMatchObject({
        encodedInvitation: expect.stringMatching(/^claudian-collab:v9:/),
      });
      await coordinator.stopProject(betaId);
      await expect(fetch(`${alpha.endpoint}/v9/projects/${betaId}/snapshot`))
        .rejects.toThrow();
    } finally {
      await betaDatabase.close();
    }
  });

  it('begins unload teardown synchronously and drains idempotently', async () => {
    const host = await coordinator.startProject(PROJECT_ID);
    const closeResource = jest.fn(async () => undefined);
    coordinator.registerOwnedResource(PROJECT_ID, 'member-host', closeResource);

    const closing = coordinator.close();

    expect(closeResource).toHaveBeenCalledWith('host-stopped');
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      status: 'stopping',
    });
    await closing;
    await expect(coordinator.close()).resolves.toBeUndefined();
    expect(coordinator.getProjectState(PROJECT_ID)).toEqual({
      projectId: PROJECT_ID,
      status: 'stopped',
    });
    await expect(fetch(`${host.endpoint}/v9/projects/${PROJECT_ID}/snapshot`))
      .rejects.toThrow();
  });

  it('drains outgoing Host-transfer work before unload completes', async () => {
    let releaseTransfer!: () => void;
    const transferClosed = new Promise<void>(resolve => {
      releaseTransfer = resolve;
    });
    const close = jest.fn(() => transferClosed);
    outgoingHostTransfer = {
      close,
      inspectStartupRecovery: jest.fn().mockResolvedValue('none'),
      resume: jest.fn().mockResolvedValue(undefined),
    };
    await coordinator.startProject(PROJECT_ID);

    let settled = false;
    const closing = coordinator.close().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseTransfer();
    await closing;
    expect(settled).toBe(true);
  });

  it('reloads without auto-start and preserves pending state across endpoint change', async () => {
    const first = await coordinator.startProject(PROJECT_ID);
    const invitation = await coordinator.createInvitation(PROJECT_ID);
    const pendingPath = path.join(
      root,
      '.claudian',
      'collab',
      'projects',
      PROJECT_ID,
      'pending-operation.json',
    );
    const pendingContents = '{"operationKind":"join-project"}\n';
    await writeFile(pendingPath, pendingContents, { mode: 0o600 });
    await coordinator.close();

    const oldPort = Number(new URL(first.endpoint).port);
    const oldEndpointBlocker = createServer();
    await new Promise<void>((resolve, reject) => {
      oldEndpointBlocker.once('error', reject);
      oldEndpointBlocker.listen(oldPort, '127.0.0.1', resolve);
    });
    const authorityDirectory = await localProjects.ensureAuthorityDirectory(PROJECT_ID);
    coordinator = new LanHostCoordinator({
      createGitProxy,
      createInvitationCodec: () => new InvitationCodec({
        isAddressAllowed: addressValue => addressValue === '127.0.0.1',
      }),
      getPrivateIpv4Addresses: () => ['127.0.0.1'],
      localProjects,
      openProject: async () => ({
        authority: {
          database: authorityDatabase,
          events: new AuthorityEventRepository(),
          idempotency: new AuthorityIdempotencyRepository(),
          projects: new ProjectAuthorityRepository(),
        },
        authorityDirectory,
        events: new ProjectEventHub(
          PROJECT_ID,
          new SqlJsProjectEventSource(authorityDatabase, PROJECT_ID),
        ),
        git: gitRuntime(),
        ...hostedControlCapabilities(),
        readMainOid: async () => MAIN_OID,
        validate: async () => undefined,
      }),
      portCandidates: [oldPort, 0],
      tlsIdentity: sharedTlsIdentity,
      vaultRoot: root,
    });
    try {
      expect(coordinator.isProjectRunning(PROJECT_ID)).toBe(false);
      expect(coordinator.getProjectState(PROJECT_ID).status).toBe('stopped');

      const restarted = await coordinator.startProject(PROJECT_ID);

      expect(restarted.endpoint).not.toBe(first.endpoint);
      expect(await readFile(pendingPath, 'utf8')).toBe(pendingContents);
      expect(await localProjects.loadMembership(PROJECT_ID)).toMatchObject({
        authority: { endpoint: restarted.endpoint },
      });
      expect(await authorityDatabase.read(connection => connection.get(
        'SELECT revoked_at FROM invitations ORDER BY created_at DESC LIMIT 1',
      ))).toEqual({ revoked_at: expect.any(String) });
      expect(invitation.encodedInvitation).toMatch(/^claudian-collab:v9:/);
    } finally {
      await coordinator.stopProject(PROJECT_ID);
      await new Promise<void>(resolve => {
        oldEndpointBlocker.close(() => resolve());
        oldEndpointBlocker.closeAllConnections();
      });
    }
  });

  it('reclaims a stale Vault Host lock without touching durable Project state', async () => {
    await localProjects.ensurePrivateStateContainer();
    const lockPath = path.join(root, '.claudian', 'collab', 'lan-host.lock');
    await writeFile(lockPath, JSON.stringify({
      nonce: 'stale-lock',
      pid: 2_000_000_000,
    }), { mode: 0o600 });

    await expect(coordinator.startProject(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      status: 'running',
    });
    expect(await readFile(lockPath, 'utf8')).toContain(`"pid":${process.pid}`);
    await coordinator.stopProject(PROJECT_ID);
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(authorityDatabase.read(connection => connection.get(
      'SELECT project_id FROM project WHERE singleton = 1',
    ))).resolves.toEqual({ project_id: PROJECT_ID });
  });
});

describe('LanHostCoordinator lazy construction', () => {
  it('applies the durable Project start guard before every Host recovery path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-lan-host-guard-'));
    const openProject = jest.fn();
    const runWithProjectStartGuard = jest.fn(async () => {
      throw new Error('durable Cloud fence');
    });
    const coordinator = new LanHostCoordinator({
      localProjects: {
        ensurePrivateStateContainer: jest.fn(),
        hostTransferRecovery: { load: jest.fn() },
        loadMembership: jest.fn(),
        saveMembership: jest.fn(),
      } as never,
      openProject,
      runWithProjectStartGuard,
      vaultRoot: root,
    });

    await expect(coordinator.startProject(PROJECT_ID)).rejects.toThrow('durable Cloud fence');
    expect(runWithProjectStartGuard).toHaveBeenCalledWith(PROJECT_ID, expect.any(Function));
    expect(openProject).not.toHaveBeenCalled();
    await coordinator.close();
    await rm(root, { force: true, recursive: true });
  });

  it('does not open ordinary Host authority ahead of incoming transfer recovery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-lan-host-incoming-'));
    const openProject = jest.fn();
    const recovery = createHostTransferRecoveryRecord({
      createdAt: '2026-08-13T00:00:00.000Z',
      direction: 'incoming',
      projectId: PROJECT_ID,
      receiverCredential: Buffer.alloc(32, 2).toString('base64url'),
      sourceHostMemberId: 'member-source',
      stagingDirectoryName: '.claudian-host-transfer-transfer-incoming',
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\ntarget\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:54545',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-incoming',
    });
    const coordinator = new LanHostCoordinator({
      localProjects: {
        ensurePrivateStateContainer: jest.fn(),
        hostTransferRecovery: {
          load: jest.fn().mockResolvedValue(recovery),
        },
        loadMembership: jest.fn().mockResolvedValue({
          hostOwnership: { autoStart: false, ownsAuthority: false },
        }),
        saveMembership: jest.fn(),
      } as never,
      openProject,
      vaultRoot: root,
    });

    await expect(coordinator.startProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'host-transfer-incoming-recovery-required' },
    });
    expect(openProject).not.toHaveBeenCalled();
    await coordinator.close();
    await rm(root, { force: true, recursive: true });
  });

  it('does not create private state or start network work in its constructor', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-lan-host-lazy-'));
    const coordinator = new LanHostCoordinator({
      getPrivateIpv4Addresses: () => {
        throw new Error('Network selection must stay lazy');
      },
      localProjects: new CollabLocalProjectRepository(root),
      openProject: async () => {
        throw new Error('Authority must stay lazy');
      },
      vaultRoot: root,
    });

    await expect(access(path.join(root, '.claudian'))).rejects.toMatchObject({ code: 'ENOENT' });
    await coordinator.close();
    await rm(root, { force: true, recursive: true });
  });
});
