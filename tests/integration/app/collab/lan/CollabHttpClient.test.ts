import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type CollabHostTrustStore,
  CollabHttpClient,
  type CollabTrustedHost,
} from '@/app/collab/lan/CollabHttpClient';
import { InvitationCodec, type LanCollabInvitation as CollabInvitation } from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import {
  LanTlsIdentity,
  type LanTlsServerIdentity,
} from '@/app/collab/lan/LanTlsIdentity';

jest.setTimeout(60_000);

class MemoryTrustStore implements CollabHostTrustStore {
  readonly records = new Map<string, CollabTrustedHost>();

  async read(projectId: string): Promise<CollabTrustedHost | null> {
    return this.records.get(projectId) ?? null;
  }

  async save(trust: CollabTrustedHost): Promise<'saved' | 'ca-mismatch'> {
    const existing = this.records.get(trust.projectId);
    if (existing && existing.caFingerprint !== trust.caFingerprint) return 'ca-mismatch';
    this.records.set(trust.projectId, trust);
    return 'saved';
  }
}

interface TestServer {
  readonly endpoint: string;
  readonly requests: Array<{ authorization?: string; path?: string }>;
  close(): Promise<void>;
}

async function startServer(
  identity: LanTlsServerIdentity,
  onRequest: Parameters<typeof createServer>[1] = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  },
): Promise<TestServer> {
  const requests: Array<{ authorization?: string; path?: string }> = [];
  const server: Server = createServer({
    cert: identity.certificateChainPem,
    key: identity.privateKeyPem,
  }, (request, response) => {
    requests.push({
      ...(typeof request.headers.authorization === 'string'
        ? { authorization: request.headers.authorization }
        : {}),
      ...(request.url ? { path: request.url } : {}),
    });
    onRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address missing');
  return {
    endpoint: `https://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

describe('CollabHttpClient pinned transport', () => {
  let vaultRoot: string;
  let hostIdentity: LanTlsIdentity;
  let hostCaFingerprint: string;
  let serverIdentity: LanTlsServerIdentity;
  let servers: TestServer[];
  let codec: InvitationCodec;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-http-client-'));
    hostIdentity = new LanTlsIdentity(vaultRoot);
    const hostCa = await hostIdentity.loadOrCreate();
    hostCaFingerprint = hostCa.caFingerprint;
    serverIdentity = await hostIdentity.issueServerIdentity('127.0.0.1');
  });

  afterAll(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  beforeEach(() => {
    servers = [];
    codec = new InvitationCodec({
      isAddressAllowed: address => address === '127.0.0.1',
    });
  });

  afterEach(async () => {
    await Promise.all(servers.map(server => server.close()));
  });

  function invitation(endpoint: string, overrides: Partial<CollabInvitation> = {}) {
    return codec.createInvitation({
      caFingerprint: hostCaFingerprint,
      endpoint,
      invitationId: 'invite-alpha',
      projectId: 'project-alpha',
      ...overrides,
    });
  }

  it('pins a probed CA before transmitting an invitation secret', async () => {
    const server = await startServer(serverIdentity);
    servers.push(server);
    const trustStore = new MemoryTrustStore();
    const client = new CollabHttpClient(trustStore, { invitationCodec: codec });
    const invite = invitation(server.endpoint);

    const pinned = await client.bootstrapInvitation(invite);
    expect(server.requests).toEqual([]);
    expect(trustStore.records.get('project-alpha')).toMatchObject({
      caFingerprint: hostCaFingerprint,
      endpoint: server.endpoint,
      projectId: 'project-alpha',
    });
    const storedCa = trustStore.records.get('project-alpha')?.caCertificatePem;
    expect(storedCa).toBeDefined();
    expect(new X509Certificate(storedCa!).raw.equals(
      new X509Certificate(serverIdentity.caCertificatePem).raw,
    )).toBe(true);

    await expect(pinned.requestWithInvitation({
      decode: value => value as { ok: boolean },
      method: 'POST',
      path: '/v9/projects/project-alpha/join-attempts',
    }, invite.invitationSecret)).resolves.toEqual({ ok: true });
    expect(server.requests).toEqual([{
      authorization: `Claudian-Invitation ${invite.invitationSecret}`,
      path: '/v9/projects/project-alpha/join-attempts',
    }]);
  });

  it('rejects the wrong CA fingerprint without sending HTTP credentials', async () => {
    const server = await startServer(serverIdentity);
    servers.push(server);
    const trustStore = new MemoryTrustStore();
    const client = new CollabHttpClient(trustStore, { invitationCodec: codec });
    const invite = invitation(server.endpoint, { caFingerprint: '00'.repeat(32) });

    await expect(client.bootstrapInvitation(invite)).rejects.toEqual(
      expect.objectContaining({ code: 'tls-ca-mismatch' }),
    );
    expect(server.requests).toEqual([]);
    expect(trustStore.records.size).toBe(0);
  });

  it('uses normal IP SAN validation after the fingerprint probe', async () => {
    const wrongIpIdentity = await hostIdentity.issueServerIdentity('192.168.1.99');
    const server = await startServer(wrongIpIdentity);
    servers.push(server);
    const client = new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    });

    await expect(client.bootstrapInvitation(invitation(server.endpoint))).rejects.toEqual(
      expect.objectContaining({ code: 'tls-untrusted' }),
    );
    expect(server.requests).toEqual([]);
  });

  it('rejects an expired leaf after matching the persistent CA', async () => {
    const expiredIdentity = await hostIdentity.issueServerIdentity('127.0.0.1', {
      now: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    const server = await startServer(expiredIdentity);
    servers.push(server);
    const client = new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    });

    await expect(client.bootstrapInvitation(invitation(server.endpoint))).rejects.toEqual(
      expect.objectContaining({ code: 'tls-untrusted' }),
    );
  });

  it('refreshes an endpoint only under the already trusted Project CA', async () => {
    const firstServer = await startServer(serverIdentity);
    const nextServer = await startServer(serverIdentity);
    servers.push(firstServer, nextServer);
    const trustStore = new MemoryTrustStore();
    const client = new CollabHttpClient(trustStore, { invitationCodec: codec });
    await client.bootstrapInvitation(invitation(firstServer.endpoint));

    await client.bootstrapInvitation(invitation(nextServer.endpoint, {
      invitationId: 'invite-refresh',
    }));
    expect(trustStore.records.get('project-alpha')?.endpoint).toBe(nextServer.endpoint);

    await expect(client.bootstrapInvitation(invitation(nextServer.endpoint, {
      caFingerprint: '11'.repeat(32),
      invitationId: 'invite-replacement',
    }))).rejects.toEqual(expect.objectContaining({ code: 'tls-ca-mismatch' }));
    expect(trustStore.records.get('project-alpha')?.caFingerprint).toBe(hostCaFingerprint);
  });

  it('proves a discovered endpoint under stored CA trust before member auth', async () => {
    const firstServer = await startServer(serverIdentity);
    const nextServer = await startServer(serverIdentity);
    servers.push(firstServer, nextServer);
    const trustStore = new MemoryTrustStore();
    const client = new CollabHttpClient(trustStore, { invitationCodec: codec });
    await client.bootstrapInvitation(invitation(firstServer.endpoint));

    const pinned = await client.bootstrapTrustedEndpoint({
      caFingerprint: hostCaFingerprint,
      endpoint: nextServer.endpoint,
      projectId: 'project-alpha',
    });

    expect(nextServer.requests).toEqual([]);
    expect(trustStore.records.get('project-alpha')?.endpoint).toBe(nextServer.endpoint);
    await pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/endpoint',
    }, Buffer.alloc(32, 7).toString('base64url'));
    expect(nextServer.requests).toHaveLength(1);

    await expect(client.bootstrapTrustedEndpoint({
      caFingerprint: '11'.repeat(32),
      endpoint: nextServer.endpoint,
      projectId: 'project-alpha',
    })).rejects.toEqual(expect.objectContaining({ code: 'tls-ca-mismatch' }));
  });

  it('allows queries only on the bound Ticket list GET route', async () => {
    const secret = Buffer.alloc(32, 6).toString('base64url');
    const server = await startServer(serverIdentity);
    servers.push(server);
    const pinned = await new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    }).bootstrapInvitation(invitation(server.endpoint));

    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/tickets?status=open&limit=50',
    }, secret)).resolves.toEqual({ ok: true });
    expect(server.requests).toHaveLength(1);

    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/endpoint?status=open',
    }, secret)).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'control-request-path-invalid' },
    });
    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'POST',
      path: '/v5/projects/project-alpha/tickets?status=open',
    }, secret)).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'control-request-path-invalid' },
    });
    await expect(pinned.requestWithMember({
      body: {},
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/snapshot',
    }, secret)).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'control-request-body-forbidden' },
    });
    expect(server.requests).toHaveLength(1);
  });

  it.each([1, 6])('rejects v%s Project-control paths before network access', async (
    protocolVersion,
  ) => {
    const secret = Buffer.alloc(32, 6).toString('base64url');
    const server = await startServer(serverIdentity);
    servers.push(server);
    const pinned = await new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    }).bootstrapInvitation(invitation(server.endpoint));

    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: `/v${protocolVersion}/projects/project-alpha/snapshot`,
    }, secret)).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'control-request-path-invalid' },
    });
    expect(server.requests).toEqual([]);
  });

  it('redacts credentials from authentication errors, aborts, and timeouts', async () => {
    const secret = Buffer.alloc(32, 7).toString('base64url');
    const server = await startServer(serverIdentity, (request, response) => {
      if (request.url?.endsWith('/endpoint')) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ echoed: request.headers.authorization }));
      } else if (request.url?.endsWith('/join-attempts')) {
        response.writeHead(410, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ echoed: request.headers.authorization }));
      }
    });
    servers.push(server);
    const client = new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    });
    const pinned = await client.bootstrapInvitation(invitation(server.endpoint));

    const unauthorizedError = await pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/endpoint',
    }, secret).catch((error: unknown) => error);
    expect(unauthorizedError).toEqual(
      expect.objectContaining({ code: 'authentication-failed' }),
    );
    expect(JSON.stringify(unauthorizedError)).not.toContain(secret);

    const revokedError = await pinned.requestWithInvitation({
      decode: value => value,
      method: 'POST',
      path: '/v9/projects/project-alpha/join-attempts',
    }, secret).catch((error: unknown) => error);
    expect(revokedError).toEqual(
      expect.objectContaining({ code: 'invitation-revoked' }),
    );
    expect(JSON.stringify(revokedError)).not.toContain(secret);

    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/snapshot',
    }, secret, { timeoutMs: 25 })).rejects.toEqual(
      expect.objectContaining({ code: 'operation-timeout' }),
    );

    const controller = new AbortController();
    const aborted = pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/snapshot',
    }, secret, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toEqual(expect.objectContaining({ code: 'cancelled' }));
  });

  it('preserves a structured terminal retirement result from an authenticated 410', async () => {
    const secret = Buffer.alloc(32, 9).toString('base64url');
    const server = await startServer(serverIdentity, (_request, response) => {
      response.writeHead(410, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          code: 'project-retired',
          safeContext: {
            projectId: 'project-alpha',
            retiredAt: '2026-08-13T08:00:00.000Z',
          },
        },
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: 'terminal-retirement',
      }));
    });
    servers.push(server);
    const pinned = await new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    }).bootstrapInvitation(invitation(server.endpoint));

    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'GET',
      path: '/v9/projects/project-alpha/tickets?status=open',
    }, secret)).rejects.toMatchObject({
      code: 'project-retired',
      safeContext: {
        projectId: 'project-alpha',
        retiredAt: '2026-08-13T08:00:00.000Z',
      },
    });
  });

  it.each([
    ['stale-request-head', 'accept-expected-head-mismatch'],
    ['stale-request-metadata', 'accept-request-revision-mismatch'],
    ['stale-ticket', 'accept-ticket-revision-mismatch'],
  ] as const)(
    'preserves authenticated %s errors from a valid protocol envelope',
    async (code, reason) => {
    const secret = Buffer.alloc(32, 8).toString('base64url');
    const server = await startServer(serverIdentity, (_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          code,
          safeContext: { reason },
        },
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: 'request-state-error',
      }));
    });
    servers.push(server);
    const pinned = await new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    }).bootstrapInvitation(invitation(server.endpoint));

    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'POST',
      path: '/v9/projects/project-alpha/requests/request-alpha/accept',
    }, secret)).rejects.toMatchObject({
      code,
      safeContext: { reason },
    });
    },
  );

  it('preserves stale Manager promotion errors from the authority envelope', async () => {
    const secret = Buffer.alloc(32, 9).toString('base64url');
    const server = await startServer(serverIdentity, (_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          code: 'stale-project-selection',
          safeContext: { reason: 'membership-manager-changed' },
        },
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: 'manager-promotion-error',
      }));
    });
    servers.push(server);
    const pinned = await new CollabHttpClient(new MemoryTrustStore(), {
      invitationCodec: codec,
    }).bootstrapInvitation(invitation(server.endpoint));

    await expect(pinned.requestWithMember({
      decode: value => value,
      method: 'POST',
      path: '/v9/projects/project-alpha/managers/member-a/promote',
    }, secret)).rejects.toMatchObject({
      code: 'stale-project-selection',
      safeContext: { reason: 'membership-manager-changed' },
    });
  });
});
