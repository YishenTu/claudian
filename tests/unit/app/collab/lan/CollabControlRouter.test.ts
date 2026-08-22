import { createServer, request as httpRequest, type Server } from 'node:http';

import { COLLAB_LIMITS } from '@claudian/collab-protocol';

import {
  type CollabControlAdmissionPort,
  type CollabControlProjectService,
  CollabControlRouter,
  type CollabTerminalProjectService,
} from '@/app/collab/lan/CollabControlRouter';
import type { LanCollabInvitation } from '@/app/collab/lan/InvitationCodec';
import type { CollabLanProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-alpha';
const INVITATION_SECRET = Buffer.alloc(32, 2).toString('base64url');
const MEMBER_CREDENTIAL = Buffer.alloc(32, 3).toString('base64url');
const REQUEST_ID = 'request-alpha';

function snapshot(): CollabLanProjectSnapshot {
  const createdAt = '2026-08-08T00:00:00.000Z';
  const member = {
    activatedAt: createdAt,
    createdAt,
    displayName: 'Host',
    id: 'member-host',
    personalRef: 'refs/heads/members/member-host',
    role: 'manager' as const,
    status: 'active' as const,
  };
  return {
    currentMember: member,
    eventSequence: 1,
    members: [member],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityKind: 'lan',
      createdAt,
      hostMemberId: member.id,
      id: PROJECT_ID,
      mainOid: 'a'.repeat(40),
      mainRef: 'refs/heads/main',
      managerSetGeneration: 0,
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

function service(): jest.Mocked<CollabControlProjectService> {
  const value = snapshot();
  return {
    acceptRequest: jest.fn(),
    activateJoinAttempt: jest.fn<
      ReturnType<CollabControlProjectService['activateJoinAttempt']>,
      Parameters<CollabControlProjectService['activateJoinAttempt']>
    >(
      async () => value,
    ),
    authenticateMemberCredential: jest.fn<
      ReturnType<CollabControlProjectService['authenticateMemberCredential']>,
      Parameters<CollabControlProjectService['authenticateMemberCredential']>
    >(async () => ({ member: value.currentMember })),
    confirmEndpoint: jest.fn<
      ReturnType<CollabControlProjectService['confirmEndpoint']>,
      Parameters<CollabControlProjectService['confirmEndpoint']>
    >(async () => ({
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://127.0.0.1:54545',
      })),
    createInvitation: jest.fn<
      ReturnType<CollabControlProjectService['createInvitation']>,
      Parameters<CollabControlProjectService['createInvitation']>
    >(async () => ({
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://127.0.0.1:54545',
        expiresAt: '2026-08-08T00:15:00.000Z',
        invitationId: 'invitation-alpha',
        invitationSecret: INVITATION_SECRET,
        projectId: PROJECT_ID,
        protocolVersion: 9,
      })),
    createJoinAttempt: jest.fn<
      ReturnType<CollabControlProjectService['createJoinAttempt']>,
      Parameters<CollabControlProjectService['createJoinAttempt']>
    >(
      async (_secret, request) => ({
        expiresAt: '2026-08-08T00:30:00.000Z',
        id: request.joinAttemptId,
        member: {
          createdAt: '2026-08-08T00:00:00.000Z',
          displayName: request.displayName,
          id: 'member-second',
          personalRef: 'refs/heads/members/member-second',
          role: 'member',
          status: 'pending',
        },
        memberCredential: MEMBER_CREDENTIAL,
        projectId: request.projectId,
      }),
    ),
    createComment: jest.fn(async (_credential, request) => ({
      comment: {
        authorMemberId: 'member-host',
        body: request.body,
        createdAt: '2026-08-08T00:01:00.000Z',
        id: 'comment-alpha',
        requestId: request.requestId,
      },
      request: {
        commentCount: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
        description: 'Published change',
        firstBaseOid: 'a'.repeat(40),
        id: request.requestId,
        latestHeadOid: 'b'.repeat(40),
        memberId: 'member-host',
        revision: 0,
        status: 'open' as const,
        ticketRelations: [],
        updatedAt: '2026-08-08T00:01:00.000Z',
      },
    })),
    createTicket: jest.fn(),
    createTicketComment: jest.fn(),
    closeTicket: jest.fn(),
    encodeInvitation: jest.fn<
      ReturnType<CollabControlProjectService['encodeInvitation']>,
      Parameters<CollabControlProjectService['encodeInvitation']>
    >(
      (invitation: LanCollabInvitation) => `encoded:${invitation.invitationId}`,
    ),
    ensureMyRequest: jest.fn(async (_credential, request) => ({
      mainOid: request.expectedMainOid,
      request: {
        commentCount: 0,
        createdAt: '2026-08-08T00:00:00.000Z',
        description: request.description,
        firstBaseOid: 'a'.repeat(40),
        id: 'request-member-host',
        latestHeadOid: request.headOid,
        memberId: 'member-host',
        revision: 0,
        status: 'open' as const,
        ticketRelations: [],
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
    })),
    getTicket: jest.fn(),
    listRequestComments: jest.fn(),
    listTicketAcceptedRelations: jest.fn(),
    listTicketComments: jest.fn(),
    listTickets: jest.fn(),
    readSnapshot: jest.fn<
      ReturnType<CollabControlProjectService['readSnapshot']>,
      Parameters<CollabControlProjectService['readSnapshot']>
    >(async () => value),
    readRequest: jest.fn(async (_credential, request) => ({
      comments: { comments: [] },
      currentMainOid: 'a'.repeat(40),
      request: {
        commentCount: 0,
        createdAt: '2026-08-08T00:00:00.000Z',
        description: 'Published change',
        firstBaseOid: 'a'.repeat(40),
        id: request.requestId,
        latestHeadOid: 'b'.repeat(40),
        memberId: 'member-host',
        revision: 0,
        status: 'open' as const,
        ticketRelations: [],
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
      reviewCondition: 'clean' as const,
      reviewedHeadOid: 'b'.repeat(40),
    })),
    removeMember: jest.fn(),
    reopenTicket: jest.fn(),
    refreshEndpoint: jest.fn<
      ReturnType<CollabControlProjectService['refreshEndpoint']>,
      Parameters<CollabControlProjectService['refreshEndpoint']>
    >(async () => ({
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://127.0.0.1:54545',
      })),
    revokeInvitation: jest.fn<
      ReturnType<CollabControlProjectService['revokeInvitation']>,
      Parameters<CollabControlProjectService['revokeInvitation']>
    >(
      async () => undefined,
    ),
    updateMyRequestMetadata: jest.fn(),
    updateTicketContent: jest.fn(),
  };
}

describe('CollabControlRouter', () => {
  let router: CollabControlRouter;
  let server: Server;
  let endpoint: string;
  let projectService: jest.Mocked<CollabControlProjectService>;

  beforeEach(async () => {
    router = new CollabControlRouter();
    projectService = service();
    router.registerProject(PROJECT_ID, projectService, {
      lifecycle: { execute: jest.fn() },
    });
    server = createServer((request, response) => {
      void router.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });

  it('dispatches a schema-validated join and returns a versioned request envelope', async () => {
    const response = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/join-attempts`, {
      body: JSON.stringify({
        displayName: 'Member',
        joinAttemptId: 'join-alpha',
        projectId: PROJECT_ID,
      }),
      headers: {
        authorization: `Claudian-Invitation ${INVITATION_SECRET}`,
        'content-type': 'application/json',
        'x-request-id': REQUEST_ID,
      },
      method: 'POST',
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    await expect(response.json()).resolves.toMatchObject({
      data: { joinAttempt: { id: 'join-alpha', projectId: PROJECT_ID } },
      protocolVersion: 9,
      requestId: REQUEST_ID,
    });
    expect(projectService.createJoinAttempt).toHaveBeenCalledWith(
      INVITATION_SECRET,
      {
        displayName: 'Member',
        joinAttemptId: 'join-alpha',
        projectId: PROJECT_ID,
      },
      { remoteAddress: '127.0.0.1' },
    );
  });

  it('keeps Project routes isolated and unregisters them explicitly', async () => {
    const unknown = await fetch(`${endpoint}/v9/projects/project-other/snapshot`, {
      headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` },
    });
    expect(unknown.status).toBe(404);
    expect(projectService.readSnapshot).not.toHaveBeenCalled();

    expect(router.unregisterProject(PROJECT_ID)).toBe(true);
    const stopped = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/snapshot`, {
      headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` },
    });
    expect(stopped.status).toBe(404);
  });

  it('rejects a body when the operation binding declares a path-only request', async () => {
    const body = '{}';
    const response = await new Promise<{
      body: string;
      status: number | undefined;
    }>((resolve, reject) => {
      const request = httpRequest(`${endpoint}/v9/projects/${PROJECT_ID}/snapshot`, {
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json',
        },
        method: 'GET',
      }, incoming => {
        let responseBody = '';
        incoming.setEncoding('utf8');
        incoming.on('data', chunk => { responseBody += chunk; });
        incoming.on('end', () => resolve({
          body: responseBody,
          status: incoming.statusCode,
        }));
      });
      request.once('error', reject);
      request.end(body);
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: 'protocol-payload-invalid',
        safeContext: { reason: 'control-request-body-forbidden' },
      },
    });
    expect(projectService.readSnapshot).not.toHaveBeenCalled();
  });

  it.each([1, 6])(
    'rejects v%s Project control before body read, authentication, admission, or dispatch',
    async protocolVersion => {
      const run = jest.fn(async (operation: () => Promise<unknown>) => operation());
      const execute = jest.fn();
      router.unregisterProject(PROJECT_ID);
      router.registerProject(PROJECT_ID, projectService, {
        admission: { run: operation => run(operation) as never },
        lifecycle: { execute },
      });

      const result = await new Promise<{ body: string; status: number | undefined }>((
        resolve,
        reject,
      ) => {
        const request = httpRequest(
          `${endpoint}/v${protocolVersion}/projects/${PROJECT_ID}/snapshot`,
          {
            headers: {
              authorization: 'Bearer malformed',
              'content-length': '1',
              'content-type': 'application/json',
            },
            method: 'GET',
          },
          incoming => {
            let responseBody = '';
            incoming.setEncoding('utf8');
            incoming.on('data', chunk => { responseBody += chunk; });
            incoming.on('end', () => {
              clearTimeout(timeout);
              request.destroy();
              resolve({ body: responseBody, status: incoming.statusCode });
            });
          },
        );
        const timeout = setTimeout(() => {
          request.destroy();
          reject(new Error('Old protocol request waited for its body'));
        }, 1_000);
        request.once('error', error => {
          clearTimeout(timeout);
          reject(error);
        });
        request.flushHeaders();
      });

      expect(result.status).toBe(404);
      expect(JSON.parse(result.body)).toMatchObject({
        error: {
          code: 'project-not-found',
          safeContext: { reason: 'control-route-version-unsupported' },
        },
      });
      expect(projectService.authenticateMemberCredential).not.toHaveBeenCalled();
      expect(projectService.readSnapshot).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([1, 6])('rejects the v%s event stream before authentication or admission', async (
    protocolVersion,
  ) => {
    const run = jest.fn(async (operation: () => Promise<unknown>) => operation());
    router.unregisterProject(PROJECT_ID);
    router.registerProject(PROJECT_ID, projectService, {
      admission: { run: operation => run(operation) as never },
      lifecycle: { execute: jest.fn() },
    });

    await expect(router.authenticateEvent({
      authorization: `Bearer ${MEMBER_CREDENTIAL}`,
      url: `/v${protocolVersion}/projects/${PROJECT_ID}/events`,
    })).rejects.toMatchObject({ code: 'authentication-failed' });
    expect(projectService.authenticateMemberCredential).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('admits active control and event work through the Project lifecycle gate', async () => {
    const run = jest.fn(async (operation: () => Promise<unknown>) => operation());
    const admission: CollabControlAdmissionPort = {
      run: operation => run(operation) as Promise<ReturnType<typeof operation> extends Promise<infer T>
        ? T
        : never>,
    };
    router.unregisterProject(PROJECT_ID);
    router.registerProject(PROJECT_ID, projectService, {
      admission,
      lifecycle: { execute: jest.fn() },
    });

    const response = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/snapshot`, {
      headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` },
    });
    expect(response.status).toBe(200);
    await expect(router.authenticateEvent({
      authorization: `Bearer ${MEMBER_CREDENTIAL}`,
      url: `/v9/projects/${PROJECT_ID}/events`,
    })).resolves.toMatchObject({ projectId: PROJECT_ID });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects new Project work after lifecycle admission closes', async () => {
    const run = jest.fn(async (_operation: () => Promise<unknown>) => {
        throw new CollabError({ code: 'project-retired' });
    });
    const admission: CollabControlAdmissionPort = {
      run: operation => run(operation) as Promise<Awaited<ReturnType<typeof operation>>>,
    };
    router.unregisterProject(PROJECT_ID);
    router.registerProject(PROJECT_ID, projectService, {
      admission,
      lifecycle: { execute: jest.fn() },
    });

    const response = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/snapshot`, {
      headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` },
    });
    expect(response.status).toBe(410);
    expect(projectService.readSnapshot).not.toHaveBeenCalled();
    await expect(router.authenticateEvent({
      authorization: `Bearer ${MEMBER_CREDENTIAL}`,
      url: `/v9/projects/${PROJECT_ID}/events`,
    })).rejects.toMatchObject({ code: 'project-retired' });
  });

  it('settles accepted Host transfer work after a client disconnects before the response', async () => {
    let release!: () => void;
    let started!: () => void;
    const accepted = new Promise<void>(resolve => { started = resolve; });
    const afterResponseSettled = jest.fn();
    const executeLifecycle = jest.fn(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return {
        afterResponseSettled,
        response: {
          canAccept: false,
          canCancel: true,
          canDecline: false,
          expiresAt: '2026-08-13T00:10:00.000Z',
          offeredAt: '2026-08-13T00:00:00.000Z',
          phase: 'accepted' as const,
          targetMemberId: 'member-target',
          transferId: 'transfer-a',
        },
      };
    });
    router.unregisterProject(PROJECT_ID);
    router.registerProject(PROJECT_ID, projectService, {
      lifecycle: { execute: executeLifecycle as never },
    });
    const body = JSON.stringify({
      idempotencyKey: 'accept-a',
      projectId: PROJECT_ID,
      receiverCredential: 'B'.repeat(43),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'ab'.repeat(32),
      targetEndpoint: 'https://192.168.1.12:4545',
      transferId: 'transfer-a',
    });
    const client = httpRequest(`${endpoint}/v9/projects/${PROJECT_ID}/host-transfers/transfer-a/accept`, {
      headers: {
        authorization: `Bearer ${MEMBER_CREDENTIAL}`,
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
        'idempotency-key': 'accept-a',
      },
      method: 'POST',
    });
    client.on('error', () => undefined);
    client.end(body);
    await accepted;
    client.destroy();
    release();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(afterResponseSettled).toHaveBeenCalledTimes(1);
    expect(executeLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      credential: MEMBER_CREDENTIAL,
      operation: 'acceptHostTransfer',
    }));
  });

  it('gives an active Project precedence, then serves its terminal responder', async () => {
    const afterResponseFlushed = jest.fn();
    const terminal: CollabTerminalProjectService = {
      acknowledgeRetirement: jest.fn(async () => ({
        afterResponseFlushed,
        response: {
          acknowledgedAt: '2026-08-13T00:01:00.000Z',
          projectId: PROJECT_ID,
          retiredAt: '2026-08-13T00:00:00.000Z',
        },
      })),
      getHostTransitions: jest.fn(async () => ({ projectId: PROJECT_ID, proofs: [] })),
      getRetirement: jest.fn(async () => ({
        projectId: PROJECT_ID,
        retiredAt: '2026-08-13T00:00:00.000Z',
      })),
    };
    router.registerTerminalProject(PROJECT_ID, terminal);

    const active = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/snapshot`, {
      headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` },
    });
    expect(active.status).toBe(200);
    expect(terminal.getRetirement).not.toHaveBeenCalled();

    router.unregisterProject(PROJECT_ID);
    const retired = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/snapshot`, {
      headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` },
    });
    expect(retired.status).toBe(410);
    await expect(retired.json()).resolves.toMatchObject({
      error: {
        code: 'project-retired',
        safeContext: {
          projectId: PROJECT_ID,
          retiredAt: '2026-08-13T00:00:00.000Z',
        },
      },
    });

    const proof = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/host-transitions`,
    );
    expect(proof.status).toBe(200);
    expect(terminal.getHostTransitions).toHaveBeenCalledWith({ projectId: PROJECT_ID });

    const acknowledgement = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/retirement/acknowledgements/current`,
      {
        body: JSON.stringify({
          idempotencyKey: 'retirement-ack-alpha',
          projectId: PROJECT_ID,
          retiredAt: '2026-08-13T00:00:00.000Z',
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'retirement-ack-alpha',
        },
        method: 'POST',
      },
    );
    expect(acknowledgement.status).toBe(200);
    await acknowledgement.arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(afterResponseFlushed).toHaveBeenCalledTimes(1);
  });

  it('routes active-member snapshots and idempotent invitation management', async () => {
    const snapshotResponse = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/snapshot`,
      { headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` } },
    );
    expect(snapshotResponse.status).toBe(200);
    expect(projectService.readSnapshot).toHaveBeenCalledWith(MEMBER_CREDENTIAL);

    const endpointResponse = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/endpoint`,
      { headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` } },
    );
    expect(endpointResponse.status).toBe(200);
    await expect(endpointResponse.json()).resolves.toMatchObject({
      data: {
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://127.0.0.1:54545',
      },
    });
    expect(projectService.confirmEndpoint).toHaveBeenCalledWith(
      MEMBER_CREDENTIAL,
      PROJECT_ID,
    );

    const invitationResponse = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/invitations`,
      {
        body: JSON.stringify({
          idempotencyKey: 'create-invitation-alpha',
          projectId: PROJECT_ID,
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'create-invitation-alpha',
        },
        method: 'POST',
      },
    );
    expect(invitationResponse.status).toBe(201);
    await expect(invitationResponse.json()).resolves.toMatchObject({
      data: {
        encodedInvitation: 'encoded:invitation-alpha',
        invitation: { invitationId: 'invitation-alpha' },
      },
    });
    expect(projectService.createInvitation).toHaveBeenCalledWith(
      MEMBER_CREDENTIAL,
      {
        idempotencyKey: 'create-invitation-alpha',
        projectId: PROJECT_ID,
      },
    );

    const revokeResponse = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/invitations/current`,
      {
        body: JSON.stringify({
          idempotencyKey: 'revoke-invitation-alpha',
          projectId: PROJECT_ID,
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'revoke-invitation-alpha',
        },
        method: 'DELETE',
      },
    );
    expect(revokeResponse.status).toBe(200);
    expect(projectService.revokeInvitation).toHaveBeenCalledWith(
      MEMBER_CREDENTIAL,
      {
        idempotencyKey: 'revoke-invitation-alpha',
        projectId: PROJECT_ID,
      },
    );
  });

  it('dispatches the minimal idempotent Publish request endpoint', async () => {
    const headOid = 'b'.repeat(40);
    const expectedMainOid = 'a'.repeat(40);
    const legacyResponse = await fetch(
      `${endpoint}/v1/projects/${PROJECT_ID}/requests/mine`,
      {
        body: JSON.stringify({
          expectedMainOid,
          headOid,
          idempotencyKey: 'legacy-publish-member-head',
          projectId: PROJECT_ID,
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'legacy-publish-member-head',
        },
        method: 'PUT',
      },
    );
    expect(legacyResponse.status).toBe(404);
    expect(projectService.ensureMyRequest).not.toHaveBeenCalled();

    const response = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/requests/mine`,
      {
        body: JSON.stringify({
          description: 'Published change',
          expectedMainOid,
          headOid,
          idempotencyKey: 'publish-member-head',
          projectId: PROJECT_ID,
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'publish-member-head',
        },
        method: 'PUT',
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        mainOid: expectedMainOid,
        request: {
          id: 'request-member-host',
          latestHeadOid: headOid,
          status: 'open',
        },
      },
    });
    expect(projectService.ensureMyRequest).toHaveBeenCalledWith(
      MEMBER_CREDENTIAL,
      {
        description: 'Published change',
        expectedMainOid,
        headOid,
        idempotencyKey: 'publish-member-head',
        projectId: PROJECT_ID,
      },
    );
  });

  it('dispatches authenticated request detail and idempotent comment endpoints', async () => {
    const detail = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/requests/request-alpha`,
      { headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` } },
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: { request: { id: 'request-alpha' }, reviewedHeadOid: 'b'.repeat(40) },
    });

    const legacyComment = await fetch(
      `${endpoint}/v1/projects/${PROJECT_ID}/requests/request-alpha/comments`,
      {
        body: JSON.stringify({
          body: 'Must not be stored',
          idempotencyKey: 'legacy-comment-alpha',
          projectId: PROJECT_ID,
          requestId: 'request-alpha',
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'legacy-comment-alpha',
        },
        method: 'POST',
      },
    );
    expect(legacyComment.status).toBe(404);
    expect(projectService.createComment).not.toHaveBeenCalled();

    const comment = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/requests/request-alpha/comments`,
      {
        body: JSON.stringify({
          body: 'Please revise',
          idempotencyKey: 'comment-alpha',
          projectId: PROJECT_ID,
          requestId: 'request-alpha',
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'comment-alpha',
        },
        method: 'POST',
      },
    );
    expect(comment.status).toBe(201);
    await expect(comment.json()).resolves.toMatchObject({
      data: {
        comment: { body: 'Please revise', id: 'comment-alpha' },
        request: { commentCount: 1 },
      },
    });
    expect(projectService.readRequest).toHaveBeenCalledWith(MEMBER_CREDENTIAL, {
      projectId: PROJECT_ID,
      requestId: 'request-alpha',
    });
    expect(projectService.createComment).toHaveBeenCalledWith(MEMBER_CREDENTIAL, {
      body: 'Please revise',
      idempotencyKey: 'comment-alpha',
      projectId: PROJECT_ID,
      requestId: 'request-alpha',
    });
  });

  it('fails closed with a bounded error envelope when a producer exceeds the response cap', async () => {
    (projectService.readRequest as jest.Mock).mockResolvedValueOnce({
      comments: {
        comments: Array.from({ length: 6 }, (_value, index) => ({
          authorMemberId: 'member-host',
          body: '\u0001'.repeat(COLLAB_LIMITS.maxCommentBytes),
          createdAt: '2026-08-08T00:00:00.000Z',
          id: `comment-${index}`,
          requestId: 'request-alpha',
        })),
      },
      currentMainOid: 'a'.repeat(40),
      request: {
        commentCount: 6,
        createdAt: '2026-08-08T00:00:00.000Z',
        description: 'Oversized detail',
        firstBaseOid: 'a'.repeat(40),
        id: 'request-alpha',
        latestHeadOid: 'b'.repeat(40),
        memberId: 'member-host',
        revision: 0,
        status: 'open',
        ticketRelations: [],
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
      reviewCondition: 'clean',
      reviewedHeadOid: 'b'.repeat(40),
    });

    const response = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/requests/request-alpha`,
      { headers: { authorization: `Bearer ${MEMBER_CREDENTIAL}` } },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'operation-failed',
        safeContext: { reason: 'control-response-too-large' },
      },
      protocolVersion: 9,
    });
    expect(Number(response.headers.get('content-length')))
      .toBeLessThanOrEqual(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes);
  });

  it('maps request state failures without collapsing the error code', async () => {
    (projectService.ensureMyRequest as jest.Mock).mockRejectedValueOnce(new CollabError({
      code: 'request-head-not-pushed',
    }));
    const expectedMainOid = 'a'.repeat(40);
    const response = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/requests/mine`,
      {
        body: JSON.stringify({
          description: 'Published change',
          expectedMainOid,
          headOid: 'b'.repeat(40),
          idempotencyKey: 'publish-stale-head',
          projectId: PROJECT_ID,
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'publish-stale-head',
        },
        method: 'PUT',
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'request-head-not-pushed' },
    });
  });

  it('dispatches Manager promotion and preserves stale authority errors', async () => {
    const executeLifecycle = jest.fn().mockRejectedValueOnce(new CollabError({
      code: 'stale-project-selection',
      safeContext: { reason: 'membership-manager-changed' },
    }));
    router.unregisterProject(PROJECT_ID);
    router.registerProject(PROJECT_ID, projectService, {
      lifecycle: { execute: executeLifecycle },
    });
    const response = await fetch(
      `${endpoint}/v9/projects/${PROJECT_ID}/managers/member-second/promote`,
      {
        body: JSON.stringify({
          idempotencyKey: 'promote-manager-alpha',
          managerResponsibilityOfferId: 'offer-alpha',
          projectId: PROJECT_ID,
          targetMemberId: 'member-second',
        }),
        headers: {
          authorization: `Bearer ${MEMBER_CREDENTIAL}`,
          'content-type': 'application/json',
          'idempotency-key': 'promote-manager-alpha',
        },
        method: 'POST',
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'stale-project-selection',
        safeContext: { reason: 'membership-manager-changed' },
      },
    });
    expect(executeLifecycle).toHaveBeenCalledWith({
      credential: MEMBER_CREDENTIAL,
      operation: 'promoteManager',
      request: {
        idempotencyKey: 'promote-manager-alpha',
        managerResponsibilityOfferId: 'offer-alpha',
        projectId: PROJECT_ID,
        targetMemberId: 'member-second',
      },
    });
  });

  it('rejects malformed schemas and oversized bodies before domain dispatch', async () => {
    const malformed = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/join-attempts`, {
      body: JSON.stringify({ projectId: PROJECT_ID }),
      headers: {
        authorization: `Claudian-Invitation ${INVITATION_SECRET}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/join-attempts`, {
      body: JSON.stringify({ value: 'x'.repeat(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes) }),
      headers: {
        authorization: `Claudian-Invitation ${INVITATION_SECRET}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(oversized.status).toBe(413);
    expect(projectService.createJoinAttempt).not.toHaveBeenCalled();
  });

  it('authenticates the event upgrade shell from a header rather than the URL', async () => {
    await expect(router.authenticateEvent({
      authorization: `Bearer ${MEMBER_CREDENTIAL}`,
      url: `/v9/projects/${PROJECT_ID}/events`,
    })).resolves.toMatchObject({
      lastSequence: 0,
      memberId: 'member-host',
      projectId: PROJECT_ID,
    });
    expect(projectService.authenticateMemberCredential).toHaveBeenCalledWith(
      MEMBER_CREDENTIAL,
      ['active'],
    );

    await expect(router.authenticateEvent({
      url: `/v9/projects/${PROJECT_ID}/events?credential=${MEMBER_CREDENTIAL}`,
    })).rejects.toMatchObject({ code: 'authentication-failed' });

    await expect(router.authenticateEvent({
      authorization: `Bearer ${MEMBER_CREDENTIAL}`,
      lastSequence: '42',
      url: `/v9/projects/${PROJECT_ID}/events`,
    })).resolves.toMatchObject({ lastSequence: 42 });
    await expect(router.authenticateEvent({
      authorization: `Bearer ${MEMBER_CREDENTIAL}`,
      lastSequence: '-1',
      url: `/v9/projects/${PROJECT_ID}/events`,
    })).rejects.toMatchObject({ code: 'authentication-failed' });
  });
});
