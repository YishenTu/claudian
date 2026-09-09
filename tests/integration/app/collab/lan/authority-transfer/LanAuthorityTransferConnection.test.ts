import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CollabAuthorityTransferStatus } from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';

import type { CollabDiscoveredHost } from '@/app/collab/discovery/CollabLanDiscoveryService';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import {
  LanAuthorityTransferRouter,
  type LanAuthorityTransferRouteRegistration,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { LanAuthorityTransferRouteRegistry } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouteRegistry';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-connection-recovery';
const MEMBER_CREDENTIAL = Buffer.alloc(32, 8).toString('base64url');
const STATUS: CollabAuthorityTransferStatus = {
  batchRevision: null, batchSha256: null, checkpointSha256: null,
  createdAt: '2026-09-09T00:00:00.000Z', direction: 'lan-to-cloud',
  expiresAt: '2026-10-09T00:00:00.000Z', phase: 'collecting-readiness',
  projectId: PROJECT_ID, relinquishmentProof: null,
  sourceAuthority: { generation: 1, kind: 'lan' }, state: 'active',
  targetAuthority: { generation: 2, kind: 'cloud' },
  targetUrl: 'https://cloud.example.test', transferId: 'transfer-connection-recovery',
  updatedAt: '2026-09-09T00:00:00.000Z',
};

describe('LAN authority-transfer connection recovery', () => {
  let directory: string;
  let identity: Awaited<ReturnType<LanTlsIdentity['issueServerIdentity']>>;
  let candidates: readonly CollabDiscoveredHost[];
  const servers: Server[] = [];
  const registries: LanAuthorityTransferRouteRegistry[] = [];
  const credentials: Array<{ readonly endpoint: string; readonly authorization: string }> = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-connection-'));
    identity = await new LanTlsIdentity(directory, {
      installationKey: TEST_INSTALLATION_A,
    }).issueServerIdentity('127.0.0.1');
    candidates = [];
    credentials.length = 0;
  });

  async function close(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    await Promise.all(registries.splice(0).map(registry => registry.close()));
    await rm(directory, { force: true, recursive: true });
  });

  function source(generation = 1): LanAuthorityTransferRouteRegistration {
    return {
      authorityGeneration: generation, hostMemberId: 'member-host', projectId: PROJECT_ID,
      service: {
        acceptLanToCloudTransferTarget: async () => STATUS,
        authenticateMemberCredential: async credential => {
          if (credential !== MEMBER_CREDENTIAL) throw new CollabError({ code: 'authentication-failed' });
          return { memberId: 'member-host' };
        },
        cancelProjectAuthorityTransfer: async () => STATUS,
        getProjectAuthorityTransfer: async () => STATUS,
        requestLanToCloudTransfer: async () => STATUS,
      },
      state: 'source-active',
    };
  }

  async function listen(
    registration = source(),
    tlsIdentity = identity,
  ): Promise<{ readonly endpoint: string; readonly server: Server }> {
    const registry = new LanAuthorityTransferRouteRegistry();
    registries.push(registry);
    await registry.install(registration);
    const router = new LanAuthorityTransferRouter(registry);
    let endpoint = '';
    const server = createServer({
      cert: tlsIdentity.certificateChainPem, key: tlsIdentity.privateKeyPem,
    }, (request, response) => {
      if (request.headers.authorization) credentials.push({
        authorization: request.headers.authorization, endpoint,
      });
      void router.handle(request, response).then(handled => {
        if (!handled) { response.statusCode = 404; response.end(); }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Listener address missing');
    endpoint = `https://127.0.0.1:${address.port}`;
    return { endpoint, server };
  }

  function client(endpoint: string): LanAuthorityTransferClient {
    const trust = {
      authorityGeneration: 1,
      caCertificatePem: identity.caCertificatePem, caFingerprint: identity.caFingerprint,
      endpoint, projectId: PROJECT_ID,
    };
    const options = {
      discovery: { discoverProjectCandidates: async () => candidates }, timeoutMs: 200,
    };
    return new LanAuthorityTransferClient(trust, options);
  }

  function discover(...endpoints: string[]): void {
    candidates = endpoints.map(endpoint => ({
      caFingerprint: identity.caFingerprint, endpoint, projectId: PROJECT_ID,
    }));
  }

  function request(connection: LanAuthorityTransferClient) {
    return connection.requestWithMember('getProjectAuthorityTransfer', {
      projectId: PROJECT_ID, transferId: STATUS.transferId,
    }, MEMBER_CREDENTIAL);
  }

  it('finds the same authority after successive listener replacements', async () => {
    const original = await listen();
    const next = await listen();
    const connection = client(original.endpoint);
    await close(original.server);
    discover(next.endpoint);

    await expect(request(connection)).resolves.toEqual(STATUS);
    expect(credentials).toEqual([{ authorization: `Bearer ${MEMBER_CREDENTIAL}`, endpoint: next.endpoint }]);

    const last = await listen();
    await close(next.server);
    discover(last.endpoint);
    await expect(request(connection)).resolves.toEqual(STATUS);
    expect(credentials.at(-1)?.endpoint).toBe(last.endpoint);
  });

  it('recovers when the historical location now belongs to another installation', async () => {
    const otherIdentity = await new LanTlsIdentity(directory, {
      installationKey: TEST_INSTALLATION_B,
    }).issueServerIdentity('127.0.0.1');
    const reassigned = await listen(source(), otherIdentity);
    const relocated = await listen();
    discover(relocated.endpoint);

    await expect(request(client(reassigned.endpoint))).resolves.toEqual(STATUS);
    expect(credentials).toEqual([{
      authorization: `Bearer ${MEMBER_CREDENTIAL}`, endpoint: relocated.endpoint,
    }]);
  });

  it('withholds credentials when two trusted locations both claim the authority', async () => {
    const original = await listen();
    const first = await listen();
    const second = await listen();
    await close(original.server);
    discover(first.endpoint, second.endpoint);

    await expect(request(client(original.endpoint))).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-endpoint-ambiguous' },
    });
    expect(credentials).toEqual([]);
  });

  it('withholds credentials when the trusted installation serves another generation', async () => {
    const original = await listen();
    const next = await listen(source(3));
    await close(original.server);
    discover(next.endpoint);

    await expect(request(client(original.endpoint))).rejects.toMatchObject({
      safeContext: { reason: 'authority-transfer-endpoint-identity-mismatch' },
    });
    expect(credentials).toEqual([]);
  });

  it('withholds credentials from a candidate with a different CA', async () => {
    const original = await listen();
    const otherIdentity = await new LanTlsIdentity(directory, {
      installationKey: TEST_INSTALLATION_B,
    }).issueServerIdentity('127.0.0.1');
    const impostor = await listen(source(), otherIdentity);
    await close(original.server);
    discover(impostor.endpoint);

    await expect(request(client(original.endpoint))).rejects.toMatchObject({ code: 'endpoint-unreachable' });
    expect(credentials).toEqual([]);
  });
});
