import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type {
  AcceptCloudToLanTransferTargetRequest,
  AcceptLanToCloudTransferTargetRequest,
  ClaimTransferredMembershipRequest,
  CollabAuthorityTransferStatus,
  GetTransferredMembershipClaimRequest,
  RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';

import { collabLanAuthorityTransferOperationPath } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferBinding';
import {
  LanAuthorityTransferRouter,
  type LanAuthorityTransferRouteRegistration,
  type LanAuthorityTransferSourceActiveService,
  type LanAuthorityTransferTargetActiveService,
  type LanAuthorityTransferTargetStagedService,
  type LanAuthorityTransferTerminalSourceService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';

const PROJECT_ID = 'project-alpha';
const HOST_MEMBER_ID = 'member-host';
const OTHER_MEMBER_ID = 'member-other';
const HOST_CREDENTIAL = Buffer.alloc(32, 1).toString('base64url');
const OTHER_CREDENTIAL = Buffer.alloc(32, 2).toString('base64url');
const TRANSFER_CREDENTIAL = Buffer.alloc(32, 3).toString('base64url');
const NONCANONICAL_CREDENTIAL = `${HOST_CREDENTIAL.slice(0, -1)}B`;
const CLAIM = Buffer.alloc(32, 4).toString('base64url');

function mockAsync<Method extends (...args: never[]) => Promise<unknown>>(
  implementation: Method,
): jest.MockedFunction<Method> {
  return jest.fn(implementation) as unknown as jest.MockedFunction<Method>;
}

function status(): CollabAuthorityTransferStatus {
  return {
    batchRevision: null,
    batchSha256: null,
    checkpointSha256: null,
    createdAt: '2026-08-26T00:00:00.000Z',
    direction: 'lan-to-cloud',
    expiresAt: '2026-09-25T00:00:00.000Z',
    phase: 'collecting-readiness',
    projectId: PROJECT_ID,
    relinquishmentProof: null,
    sourceAuthority: { generation: 1, kind: 'lan' },
    state: 'active',
    targetAuthority: { generation: 2, kind: 'cloud' },
    targetUrl: 'https://cloud.example.test',
    transferId: 'transfer-alpha',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
}

function sourceService(): jest.Mocked<LanAuthorityTransferSourceActiveService> {
  const transferStatus = status();
  return {
    acceptLanToCloudTransferTarget: mockAsync<
      LanAuthorityTransferSourceActiveService['acceptLanToCloudTransferTarget']
    >(async () => transferStatus),
    authenticateMemberCredential: mockAsync<
      LanAuthorityTransferSourceActiveService['authenticateMemberCredential']
    >(async credential => ({
        memberId: credential === HOST_CREDENTIAL ? HOST_MEMBER_ID : OTHER_MEMBER_ID,
      })),
    cancelProjectAuthorityTransfer: mockAsync<
      LanAuthorityTransferSourceActiveService['cancelProjectAuthorityTransfer']
    >(async () => transferStatus),
    getProjectAuthorityTransfer: mockAsync<
      LanAuthorityTransferSourceActiveService['getProjectAuthorityTransfer']
    >(async () => transferStatus),
    requestLanToCloudTransfer: mockAsync<
      LanAuthorityTransferSourceActiveService['requestLanToCloudTransfer']
    >(async () => transferStatus),
  };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe('LanAuthorityTransferRouter', () => {
  let registration: LanAuthorityTransferRouteRegistration | null;
  let router: LanAuthorityTransferRouter;
  let server: Server;
  let endpoint: string;

  beforeEach(async () => {
    registration = null;
    router = new LanAuthorityTransferRouter({
      resolve: projectId => projectId === PROJECT_ID ? registration : null,
      runIfCurrent: async (projectId, expected, operation) => {
        if (projectId !== PROJECT_ID || registration !== expected) {
          return { admitted: false };
        }
        return { admitted: true, value: await operation() };
      },
    });
    server = createServer((request, response) => {
      void router.handle(request, response).then(handled => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      });
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
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  async function post(
    operation: Parameters<typeof collabLanAuthorityTransferOperationPath>[1],
    body: unknown,
    authorization?: string,
    version = 1,
  ): Promise<Response> {
    const path = collabLanAuthorityTransferOperationPath(PROJECT_ID, operation)
      .replace('/v1/', `/v${version}/`);
    return fetch(`${endpoint}${path}`, {
      body: JSON.stringify(body),
      headers: {
        ...(authorization ? { authorization } : {}),
        'content-type': 'application/json',
        'x-request-id': 'request-alpha',
      },
      method: 'POST',
    });
  }

  it('allows any authenticated Member to propose but only the exact Host to accept', async () => {
    const service = sourceService();
    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service,
      state: 'source-active',
    };
    const proposal: RequestLanToCloudTransferRequest = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-propose',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test',
    };

    const proposed = await post(
      'requestLanToCloudTransfer',
      proposal,
      `Bearer ${OTHER_CREDENTIAL}`,
    );
    expect(proposed.status).toBe(200);
    expect(await responseJson(proposed)).toMatchObject({
      bindingVersion: 1,
      data: { projectId: PROJECT_ID, transferId: 'transfer-alpha' },
      protocolVersion: 6,
      requestId: 'request-alpha',
    });
    expect(service.requestLanToCloudTransfer).toHaveBeenCalledWith(
      { memberId: OTHER_MEMBER_ID },
      proposal,
    );

    const acceptance: AcceptLanToCloudTransferTargetRequest = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-accept',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test',
      transferId: 'transfer-alpha',
    };
    const denied = await post(
      'acceptLanToCloudTransferTarget',
      acceptance,
      `Bearer ${OTHER_CREDENTIAL}`,
    );
    expect(denied.status).toBe(403);
    expect(service.acceptLanToCloudTransferTarget).not.toHaveBeenCalled();

    const accepted = await post(
      'acceptLanToCloudTransferTarget',
      acceptance,
      `Bearer ${HOST_CREDENTIAL}`,
    );
    expect(accepted.status).toBe(200);
    expect(service.acceptLanToCloudTransferTarget).toHaveBeenCalledWith(
      { memberId: HOST_MEMBER_ID },
      acceptance,
    );
  });

  it('rejects an unsupported binding version before body read or authentication', async () => {
    const service = sourceService();
    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service,
      state: 'source-active',
    };
    const response = await post(
      'requestLanToCloudTransfer',
      { malformed: true },
      `Bearer ${HOST_CREDENTIAL}`,
      2,
    );

    expect(response.status).toBe(426);
    expect(await responseJson(response)).toMatchObject({
      bindingVersion: 1,
      error: {
        code: 'protocol-version-unsupported',
        safeContext: { receivedVersion: 2, supportedVersion: 1 },
      },
      protocolVersion: 6,
    });
    expect(service.authenticateMemberCredential).not.toHaveBeenCalled();
  });

  it('rejects a resolver registration belonging to another Project', async () => {
    const service = sourceService();
    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: 'project-beta',
      service,
      state: 'source-active',
    };

    const response = await post(
      'requestLanToCloudTransfer',
      {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-cross-project',
        projectId: 'project-beta',
        targetUrl: 'https://cloud.example.test',
      } satisfies RequestLanToCloudTransferRequest,
      `Bearer ${HOST_CREDENTIAL}`,
    );

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toMatchObject({
      error: {
        code: 'authentication-failed',
        safeContext: { reason: 'authority-transfer-authentication-failed' },
      },
    });
    expect(service.authenticateMemberCredential).not.toHaveBeenCalled();
    expect(service.requestLanToCloudTransfer).not.toHaveBeenCalled();
  });

  it('does not expose Project existence or route state to invalid credentials', async () => {
    const transferStatus = status();
    const staged: jest.Mocked<LanAuthorityTransferTargetStagedService> = {
      acceptCloudToLanTransferTarget: mockAsync<
        LanAuthorityTransferTargetStagedService['acceptCloudToLanTransferTarget']
      >(async () => transferStatus),
      confirmCloudToLanTargetActive: jest.fn(),
      getProjectAuthorityTransfer: jest.fn(),
      reportCloudToLanTargetStaged: jest.fn(),
    };
    const request: AcceptCloudToLanTransferTargetRequest = {
      idempotencyKey: 'intent-private-route',
      projectId: PROJECT_ID,
      targetHostMemberId: HOST_MEMBER_ID,
      targetProof: 'target-proof',
      transferId: 'transfer-alpha',
    };

    registration = null;
    const missing = await post(
      'acceptCloudToLanTransferTarget',
      request,
      `Claudian-Authority-Transfer ${HOST_CREDENTIAL}`,
    );
    const missingBody = await responseJson(missing);

    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service: sourceService(),
      state: 'source-active',
    };
    const source = await post(
      'acceptCloudToLanTransferTarget',
      request,
      `Claudian-Authority-Transfer ${HOST_CREDENTIAL}`,
    );

    registration = {
      credentialHash: createHash('sha256')
        .update(Buffer.from(TRANSFER_CREDENTIAL, 'base64url'))
        .digest('hex'),
      projectId: PROJECT_ID,
      service: staged,
      state: 'target-only-staged',
      transferId: 'transfer-alpha',
    };
    const target = await post(
      'acceptCloudToLanTransferTarget',
      request,
      `Claudian-Authority-Transfer ${HOST_CREDENTIAL}`,
    );
    const noncanonicalTarget = await post(
      'acceptCloudToLanTransferTarget',
      request,
      `Claudian-Authority-Transfer ${NONCANONICAL_CREDENTIAL}`,
    );

    expect([
      missing.status,
      source.status,
      target.status,
      noncanonicalTarget.status,
    ]).toEqual([401, 401, 401, 401]);
    await expect(responseJson(source)).resolves.toEqual(missingBody);
    await expect(responseJson(target)).resolves.toEqual(missingBody);
    await expect(responseJson(noncanonicalTarget)).resolves.toEqual(missingBody);
    expect(staged.acceptCloudToLanTransferTarget).not.toHaveBeenCalled();
  });

  it.each([
    ['Project', { ...status(), projectId: 'project-beta' }],
    ['transfer', { ...status(), transferId: 'transfer-beta' }],
  ])('rejects a service response for a different %s', async (_field, serviceStatus) => {
    const service = sourceService();
    service.getProjectAuthorityTransfer.mockResolvedValueOnce(serviceStatus);
    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service,
      state: 'source-active',
    };

    const response = await post(
      'getProjectAuthorityTransfer',
      { projectId: PROJECT_ID, transferId: 'transfer-alpha' },
      `Bearer ${HOST_CREDENTIAL}`,
    );

    expect(response.status).toBe(500);
    expect(await responseJson(response)).toMatchObject({
      error: {
        code: 'operation-failed',
        safeContext: { reason: 'authority-transfer-response-mismatch' },
      },
    });
  });

  it('admits only staged operations under the exact transfer credential', async () => {
    const transferStatus = status();
    const service: jest.Mocked<LanAuthorityTransferTargetStagedService> = {
      acceptCloudToLanTransferTarget: mockAsync<
        LanAuthorityTransferTargetStagedService['acceptCloudToLanTransferTarget']
      >(async () => transferStatus),
      confirmCloudToLanTargetActive: mockAsync<
        LanAuthorityTransferTargetStagedService['confirmCloudToLanTargetActive']
      >(async () => transferStatus),
      getProjectAuthorityTransfer: mockAsync<
        LanAuthorityTransferTargetStagedService['getProjectAuthorityTransfer']
      >(async () => transferStatus),
      reportCloudToLanTargetStaged: jest.fn(),
    };
    registration = {
      credentialHash: createHash('sha256')
        .update(Buffer.from(TRANSFER_CREDENTIAL, 'base64url'))
        .digest('hex'),
      projectId: PROJECT_ID,
      service,
      state: 'target-only-staged',
      transferId: 'transfer-alpha',
    };
    const request: AcceptCloudToLanTransferTargetRequest = {
      idempotencyKey: 'intent-target-accept',
      projectId: PROJECT_ID,
      targetHostMemberId: HOST_MEMBER_ID,
      targetProof: 'target-proof',
      transferId: 'transfer-alpha',
    };

    const accepted = await post(
      'acceptCloudToLanTransferTarget',
      request,
      `Claudian-Authority-Transfer ${TRANSFER_CREDENTIAL}`,
    );
    expect(accepted.status).toBe(200);
    expect(service.acceptCloudToLanTransferTarget).toHaveBeenCalledWith(request);

    const wrongCredential = await post(
      'acceptCloudToLanTransferTarget',
      request,
      `Claudian-Authority-Transfer ${HOST_CREDENTIAL}`,
    );
    expect(wrongCredential.status).toBe(401);

    const sourceOnly = await post(
      'requestLanToCloudTransfer',
      {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-propose',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test',
      } satisfies RequestLanToCloudTransferRequest,
      `Claudian-Authority-Transfer ${TRANSFER_CREDENTIAL}`,
    );
    expect(sourceOnly.status).toBe(404);
  });

  it('admits only LAN claim redemption on an owner-provided target-active route', async () => {
    const staged: jest.Mocked<LanAuthorityTransferTargetStagedService> = {
      acceptCloudToLanTransferTarget: jest.fn(),
      confirmCloudToLanTargetActive: jest.fn(),
      getProjectAuthorityTransfer: jest.fn(),
      reportCloudToLanTargetStaged: jest.fn(),
    };
    registration = {
      credentialHash: createHash('sha256')
        .update(Buffer.from(TRANSFER_CREDENTIAL, 'base64url'))
        .digest('hex'),
      projectId: PROJECT_ID,
      service: staged,
      state: 'target-only-staged',
      transferId: 'transfer-alpha',
    };
    const active: jest.Mocked<LanAuthorityTransferTargetActiveService> = {
      expire: jest.fn(async () => undefined),
      expiresAt: '2026-09-26T00:00:00.000Z',
      claimTransferredMembership: mockAsync<
        LanAuthorityTransferTargetActiveService['claimTransferredMembership']
      >(async () => ({
        checkpointSha256: 'a'.repeat(64),
        claimSha256: 'b'.repeat(64),
        memberId: OTHER_MEMBER_ID,
        operationIntentId: 'intent-claim',
        projectId: PROJECT_ID,
        receiptId: 'receipt-alpha',
        receiptKeyId: 'key-alpha',
        redeemedAt: '2026-08-26T00:01:00.000Z',
        signature: Buffer.alloc(64, 5).toString('base64url'),
        signatureAlgorithm: 'ed25519' as const,
        targetAuthorityGeneration: 2,
        transferId: 'transfer-alpha',
      })),
    };

    registration = {
      projectId: PROJECT_ID,
      service: active,
      state: 'target-active',
      transferId: 'transfer-alpha',
    };
    const request: ClaimTransferredMembershipRequest = {
      claim: CLAIM,
      credentialHash: 'c'.repeat(64),
      idempotencyKey: 'intent-claim',
      projectId: PROJECT_ID,
      transferId: 'transfer-alpha',
    };
    const claimed = await post(
      'claimTransferredMembership',
      request,
      `Claudian-Transfer-Claim ${CLAIM}`,
    );
    expect(claimed.status).toBe(200);
    const replayed = await post(
      'claimTransferredMembership',
      request,
      `Claudian-Transfer-Claim ${CLAIM}`,
    );
    expect(replayed.status).toBe(200);
    expect(await responseJson(replayed)).toEqual(await responseJson(claimed));
    expect(active.claimTransferredMembership).toHaveBeenCalledWith(request);

    const mismatchedClaim = await post(
      'claimTransferredMembership',
      request,
      `Claudian-Transfer-Claim ${Buffer.alloc(32, 6).toString('base64url')}`,
    );
    expect(mismatchedClaim.status).toBe(401);
    expect(active.claimTransferredMembership).toHaveBeenCalledTimes(2);

    const hashless = await post(
      'claimTransferredMembership',
      {
        claim: CLAIM,
        idempotencyKey: 'intent-cloud-variant',
        projectId: PROJECT_ID,
        transferId: 'transfer-alpha',
      },
      `Claudian-Transfer-Claim ${CLAIM}`,
    );
    expect(hashless.status).toBe(401);
    expect(active.claimTransferredMembership).toHaveBeenCalledTimes(2);
  });

  it('keeps terminal status, own-claim retrieval, and receipt forwarding Member-bound', async () => {
    const transferStatus = status();
    const service: jest.Mocked<LanAuthorityTransferTerminalSourceService> = {
      acknowledgeTransferredMembershipClaimRedemption: mockAsync<
        LanAuthorityTransferTerminalSourceService[
          'acknowledgeTransferredMembershipClaimRedemption'
        ]
      >(async (_actor, request) => ({
        acknowledgedAt: '2026-08-26T00:02:00.000Z',
        memberId: OTHER_MEMBER_ID,
        projectId: PROJECT_ID,
        receiptId: request.receipt.receiptId,
        transferId: request.transferId,
      })),
      authenticateMemberCredential: mockAsync<
        LanAuthorityTransferTerminalSourceService['authenticateMemberCredential']
      >(async () => ({ memberId: OTHER_MEMBER_ID })),
      expire: jest.fn(),
      expiresAt: '2026-09-25T00:00:00.000Z',
      getProjectAuthorityTransfer: mockAsync<
        LanAuthorityTransferTerminalSourceService['getProjectAuthorityTransfer']
      >(async () => transferStatus),
      getTransferredMembershipClaim: mockAsync<
        LanAuthorityTransferTerminalSourceService['getTransferredMembershipClaim']
      >(async actor => ({
        claim: CLAIM,
        expiresAt: '2026-09-25T00:00:00.000Z',
        memberId: actor.memberId,
        projectId: PROJECT_ID,
        targetAuthorityGeneration: 2,
        transferId: 'transfer-alpha',
      })),
    };
    registration = {
      projectId: PROJECT_ID,
      service,
      state: 'terminal-source',
      transferId: 'transfer-alpha',
    };
    const request: GetTransferredMembershipClaimRequest = {
      projectId: PROJECT_ID,
      transferId: 'transfer-alpha',
    };
    const response = await post(
      'getTransferredMembershipClaim',
      request,
      `Bearer ${OTHER_CREDENTIAL}`,
    );

    expect(response.status).toBe(200);
    expect(service.getTransferredMembershipClaim).toHaveBeenCalledWith(
      { memberId: OTHER_MEMBER_ID },
      request,
    );
  });

  it('fails closed when the lifecycle owner replaces a route before admission', async () => {
    const source = sourceService();
    let reportAdmission!: () => void;
    const admissionStarted = new Promise<void>(resolve => {
      reportAdmission = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionReleased = new Promise<void>(resolve => {
      releaseAdmission = resolve;
    });
    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service: source,
      state: 'source-active',
    };
    router = new LanAuthorityTransferRouter({
      resolve: projectId => projectId === PROJECT_ID ? registration : null,
      runIfCurrent: async (projectId, expected, operation) => {
        reportAdmission();
        await admissionReleased;
        if (projectId !== PROJECT_ID || registration !== expected) {
          return { admitted: false };
        }
        return { admitted: true, value: await operation() };
      },
    });
    const terminal: jest.Mocked<LanAuthorityTransferTerminalSourceService> = {
      acknowledgeTransferredMembershipClaimRedemption: jest.fn(),
      authenticateMemberCredential: mockAsync<
        LanAuthorityTransferTerminalSourceService['authenticateMemberCredential']
      >(async () => ({ memberId: OTHER_MEMBER_ID })),
      expire: jest.fn(),
      expiresAt: '2026-09-25T00:00:00.000Z',
      getProjectAuthorityTransfer: mockAsync<
        LanAuthorityTransferTerminalSourceService['getProjectAuthorityTransfer']
      >(async () => status()),
      getTransferredMembershipClaim: jest.fn(),
    };

    const pending = post(
      'requestLanToCloudTransfer',
      {
        expectedAuthorityGeneration: 1,
        idempotencyKey: 'intent-racing',
        projectId: PROJECT_ID,
        targetUrl: 'https://cloud.example.test',
      },
      `Bearer ${HOST_CREDENTIAL}`,
    );
    await admissionStarted;
    registration = {
      projectId: PROJECT_ID,
      service: terminal,
      state: 'terminal-source',
      transferId: 'transfer-alpha',
    };
    releaseAdmission();

    expect((await pending).status).toBe(401);
    expect(source.authenticateMemberCredential).not.toHaveBeenCalled();
    expect(source.requestLanToCloudTransfer).not.toHaveBeenCalled();
  });

  it('bounds JSON requests and leaves legacy LAN paths unclaimed', async () => {
    const service = sourceService();
    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service,
      state: 'source-active',
    };
    const legacy = await fetch(`${endpoint}/v9/projects/${PROJECT_ID}/snapshot`);
    expect(legacy.status).toBe(404);

    const path = collabLanAuthorityTransferOperationPath(
      PROJECT_ID,
      'getProjectAuthorityTransfer',
    );
    const response = await fetch(`${endpoint}${path}`, {
      body: JSON.stringify({
        padding: 'x'.repeat(1024 * 1024),
        projectId: PROJECT_ID,
        transferId: 'transfer-alpha',
      }),
      headers: {
        authorization: `Bearer ${HOST_CREDENTIAL}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(response.status).toBe(413);
    expect(service.getProjectAuthorityTransfer).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON media type before authentication or dispatch', async () => {
    const service = sourceService();
    registration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service,
      state: 'source-active',
    };
    const path = collabLanAuthorityTransferOperationPath(
      PROJECT_ID,
      'getProjectAuthorityTransfer',
    );

    const response = await fetch(`${endpoint}${path}`, {
      body: JSON.stringify({
        projectId: PROJECT_ID,
        transferId: 'transfer-alpha',
      }),
      headers: {
        authorization: `Bearer ${HOST_CREDENTIAL}`,
        'content-type': 'text/plain',
      },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      error: {
        code: 'protocol-payload-invalid',
        safeContext: {
          reason: 'authority-transfer-request-content-type-invalid',
        },
      },
    });
    expect(service.authenticateMemberCredential).not.toHaveBeenCalled();
    expect(service.getProjectAuthorityTransfer).not.toHaveBeenCalled();
  });
});
