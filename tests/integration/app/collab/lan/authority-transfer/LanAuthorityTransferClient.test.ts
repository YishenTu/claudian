import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CollabAuthorityTransferStatus } from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';

import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import {
  LanAuthorityTransferRouter,
  type LanAuthorityTransferRouteRegistration,
  type LanAuthorityTransferSourceActiveService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-alpha';
const HOST_MEMBER_ID = 'member-host';
const MEMBER_CREDENTIAL = Buffer.alloc(32, 8).toString('base64url');

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

describe('LanAuthorityTransferClient', () => {
  let directory: string;
  let server: Server;

  afterEach(async () => {
    await new Promise<void>(resolve => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  it('uses pinned TLS, sends Member auth, decodes the independent envelope, and replays', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'claudian-authority-transfer-client-'));
    const identity = await new LanTlsIdentity(directory, {
      installationKey: TEST_INSTALLATION_A,
    }).issueServerIdentity('127.0.0.1');
    const requestLanToCloudTransfer = jest.fn(async () => status());
    const service: LanAuthorityTransferSourceActiveService = {
      acceptLanToCloudTransferTarget: jest.fn(),
      authenticateMemberCredential: jest.fn(async credential => {
        if (credential !== MEMBER_CREDENTIAL) {
          throw new CollabError({ code: 'authentication-failed' });
        }
        return { memberId: HOST_MEMBER_ID };
      }),
      cancelProjectAuthorityTransfer: jest.fn(),
      getProjectAuthorityTransfer: jest.fn(),
      requestLanToCloudTransfer,
    };
    const registration: LanAuthorityTransferRouteRegistration = {
      hostMemberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      service,
      state: 'source-active',
    };
    const router = new LanAuthorityTransferRouter({
      resolve: projectId => projectId === PROJECT_ID ? registration : null,
      runIfCurrent: async (projectId, expected, operation) => (
        projectId === PROJECT_ID && registration === expected
          ? { admitted: true, value: await operation() }
          : { admitted: false }
      ),
    });
    server = createServer({
      cert: identity.certificateChainPem,
      key: identity.privateKeyPem,
    }, (request, response) => {
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
    const client = new LanAuthorityTransferClient({
      caCertificatePem: identity.caCertificatePem,
      caFingerprint: identity.caFingerprint,
      endpoint: `https://127.0.0.1:${address.port}`,
      projectId: PROJECT_ID,
    });
    const request = {
      expectedAuthorityGeneration: 1,
      idempotencyKey: 'intent-propose',
      projectId: PROJECT_ID,
      targetUrl: 'https://cloud.example.test',
    } as const;

    await expect(client.requestWithMember(
      'requestLanToCloudTransfer',
      request,
      MEMBER_CREDENTIAL,
    )).resolves.toEqual(status());
    await expect(client.requestWithMember(
      'requestLanToCloudTransfer',
      request,
      MEMBER_CREDENTIAL,
    )).resolves.toEqual(status());
    expect(requestLanToCloudTransfer).toHaveBeenCalledTimes(2);

    requestLanToCloudTransfer.mockRejectedValueOnce(new CollabError({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-phase-stale' },
    }));
    await expect(client.requestWithMember(
      'requestLanToCloudTransfer',
      request,
      MEMBER_CREDENTIAL,
    )).rejects.toMatchObject({
      code: 'authority-transfer-stale',
      safeContext: { reason: 'authority-transfer-phase-stale' },
    });
  });

  it('rejects an appended CA even when the pinned CA is first', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'claudian-authority-transfer-ca-'));
    const pinnedDirectory = path.join(directory, 'pinned');
    const attackerDirectory = path.join(directory, 'attacker');
    await Promise.all([
      mkdir(pinnedDirectory),
      mkdir(attackerDirectory),
    ]);
    const pinnedIdentity = await new LanTlsIdentity(
      pinnedDirectory,
      { installationKey: TEST_INSTALLATION_A },
    ).issueServerIdentity('127.0.0.1');
    const attackerIdentity = await new LanTlsIdentity(
      attackerDirectory,
      { installationKey: TEST_INSTALLATION_B },
    ).issueServerIdentity('127.0.0.1');

    expect(() => new LanAuthorityTransferClient({
      caCertificatePem: `${pinnedIdentity.caCertificatePem}${attackerIdentity.caCertificatePem}`,
      caFingerprint: pinnedIdentity.caFingerprint,
      endpoint: 'https://127.0.0.1:443',
      projectId: PROJECT_ID,
    })).toThrow(expect.objectContaining({
      code: 'tls-ca-mismatch',
      safeContext: { reason: 'authority-transfer-ca-mismatch' },
    }));
  }, 20_000);

  it('rejects a response with the wrong LAN binding version', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'claudian-authority-transfer-version-'));
    const identity = await new LanTlsIdentity(directory, {
      installationKey: TEST_INSTALLATION_A,
    }).issueServerIdentity('127.0.0.1');
    server = createServer({
      cert: identity.certificateChainPem,
      key: identity.privateKeyPem,
    }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        bindingVersion: 2,
        data: status(),
        protocolVersion: 6,
        requestId: 'wrong-request',
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const client = new LanAuthorityTransferClient({
      caCertificatePem: identity.caCertificatePem,
      caFingerprint: identity.caFingerprint,
      endpoint: `https://127.0.0.1:${address.port}`,
      projectId: PROJECT_ID,
    });

    await expect(client.requestWithMember(
      'getProjectAuthorityTransfer',
      { projectId: PROJECT_ID, transferId: 'transfer-alpha' },
      MEMBER_CREDENTIAL,
    )).rejects.toMatchObject({
      code: 'protocol-version-unsupported',
      safeContext: { receivedVersion: 2, supportedVersion: 1 },
    });
  });
});
