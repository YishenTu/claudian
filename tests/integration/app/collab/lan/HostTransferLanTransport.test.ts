import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { createHostTransferPackageManifest } from '@/app/collab/host-transfer/HostTransferPackage';
import type { HostTransferActivationCertificate } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { CollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import { HostTransferProvisionalRouter } from '@/app/collab/lan/HostTransferProvisionalRouter';
import { HostTransferTargetTransport } from '@/app/collab/lan/HostTransferTargetTransport';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { LanHostTransitionProofClient } from '@/app/collab/reconnect/LanHostTransitionProofClient';

jest.setTimeout(60_000);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function iterableBytes(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('Host transfer provisional LAN transport', () => {
  let vaultRoot: string;
  let server: Server;

  afterEach(async () => {
    await new Promise<void>(resolve => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    if (vaultRoot) await rm(vaultRoot, { force: true, recursive: true });
  });

  it('pins the target CA and authenticates probe, streamed stage, activation, and cancellation', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-lan-'));
    const tls = new LanTlsIdentity(vaultRoot, { installationKey: TEST_INSTALLATION_A });
    const identity = await tls.issueServerIdentity('127.0.0.1');
    const router = new HostTransferProvisionalRouter();
    const gitBundle = Buffer.from('git bundle bytes');
    const authoritySnapshot = Buffer.from('authority snapshot bytes');
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: 'a'.repeat(40),
      authoritySnapshot: {
        byteCount: authoritySnapshot.byteLength,
        sha256: sha256(authoritySnapshot),
      },
      createdAt: '2026-08-13T00:00:00.000Z',
      gitBundle: { byteCount: gitBundle.byteLength, sha256: sha256(gitBundle) },
      gitObjectFormat: 'sha1',
      projectId: 'project-a',
      proofChainDigest: 'c'.repeat(64),
      sourceAuthorityGeneration: 4,
      targetCaFingerprint: identity.caFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-a',
    });
    const manifestDigest = sha256(Buffer.from(JSON.stringify(manifest), 'utf8'));
    const stage = jest.fn(async input => {
      expect(await iterableBytes(input.gitBundle)).toEqual(gitBundle);
      expect(await iterableBytes(input.authoritySnapshot)).toEqual(authoritySnapshot);
      return { manifestDigest };
    });
    const activate = jest.fn().mockResolvedValue(undefined);
    const confirm = jest.fn().mockResolvedValue({
      afterResponseFlushed: jest.fn().mockResolvedValue(undefined),
    });
    const cancel = jest.fn().mockResolvedValue({
      afterResponseFlushed: jest.fn().mockResolvedValue(undefined),
    });
    let releaseCompletion!: () => void;
    const completionReleased = new Promise<void>(resolve => {
      releaseCompletion = resolve;
    });
    let reportCompletionCleanupStarted!: () => void;
    const completionCleanupStarted = new Promise<void>(resolve => {
      reportCompletionCleanupStarted = resolve;
    });
    const complete = jest.fn().mockResolvedValue({
      afterResponseFlushed: jest.fn(async () => {
        reportCompletionCleanupStarted();
        await completionReleased;
      }),
    });
    const credential = Buffer.alloc(32, 7).toString('base64url');
    router.register({
      coordinator: { activate, cancel, complete, confirm, stage },
      projectId: 'project-a',
      receiverCredential: credential,
      transferId: 'transfer-a',
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
    const endpoint = `https://127.0.0.1:${address.port}`;
    const target = new HostTransferTargetTransport();

    await target.probe({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    });
    await expect(target.stage({
      authoritySnapshot: (async function* () { yield authoritySnapshot; })(),
      endpoint,
      gitBundle: (async function* () { yield gitBundle; })(),
      manifest,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    })).resolves.toEqual({ manifestDigest });

    const certificate: HostTransferActivationCertificate = {
      cutoverAt: '2026-08-13T00:01:00.000Z',
      manifestDigest,
      projectId: 'project-a',
      schemaVersion: 1,
      signature: Buffer.alloc(256, 8).toString('base64url'),
      signatureAlgorithm: 'rsa-pss-sha256',
      targetCaFingerprint: identity.caFingerprint,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-a',
    };
    await target.activate({
      activationCertificate: certificate,
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    });
    await target.activate({
      activationCertificate: certificate,
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    });
    await target.markCompleted?.({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    });
    await completionCleanupStarted;
    expect(router.size).toBe(1);
    await target.probe({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    });
    await expect(target.probe({
      endpoint,
      receiverCredential: Buffer.alloc(32, 9).toString('base64url'),
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    })).rejects.toMatchObject({ code: 'authentication-failed' });
    releaseCompletion();
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(target.markCompleted?.({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    })).resolves.toBeUndefined();
    await expect(target.confirmTerminal({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-a',
    })).resolves.toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 0));
    router.register({
      coordinator: { activate, cancel, complete, confirm, stage },
      projectId: 'project-a',
      receiverCredential: credential,
      transferId: 'transfer-cancel',
    });
    await expect(target.cancel({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-cancel',
    })).resolves.toBeUndefined();
    await expect(target.cancel({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-cancel',
    })).resolves.toBeUndefined();

    expect(stage).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledWith('project-a', 'transfer-a', certificate);
    expect(complete).toHaveBeenCalledWith('project-a', 'transfer-a');
    expect(cancel).toHaveBeenCalledWith('project-a', 'transfer-cancel');
    await expect(target.confirmTerminal({
      endpoint,
      receiverCredential: credential,
      targetCaCertificatePem: identity.caCertificatePem,
      targetCaFingerprint: identity.caFingerprint,
      transferId: 'transfer-cancel',
    })).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith('project-a', 'transfer-cancel');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(router.size).toBe(0);
  });

  it('fetches only the public Host-transition chain after pinning the advertised CA', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transition-lan-'));
    const tls = new LanTlsIdentity(vaultRoot, { installationKey: TEST_INSTALLATION_A });
    const identity = await tls.issueServerIdentity('127.0.0.1');
    const proof = {
      issuedAt: '2026-08-13T00:00:00.000Z',
      nextCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      nextCaFingerprint: 'b'.repeat(64),
      previousCaFingerprint: 'a'.repeat(64),
      projectId: 'project-a',
      schemaVersion: 1 as const,
      signature: Buffer.alloc(256, 8).toString('base64url'),
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      transferId: 'transfer-a',
    };
    let observedAuthorization: string | undefined;
    server = createServer({
      cert: identity.certificateChainPem,
      key: identity.privateKeyPem,
    }, (request, response) => {
      observedAuthorization = request.headers.authorization;
      const bytes = Buffer.from(JSON.stringify({
        data: { projectId: 'project-a', proofs: [proof] },
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        requestId: 'request-a',
      }), 'utf8');
      response.writeHead(200, {
        'content-length': String(bytes.byteLength),
        'content-type': 'application/json',
      });
      response.end(bytes);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');

    const proofClient = new LanHostTransitionProofClient({
      createHttpClient: () => new CollabHttpClient({
        read: async () => null,
        save: async () => 'ca-mismatch',
      }, {
        invitationCodec: new InvitationCodec({
          isAddressAllowed: addressValue => addressValue === '127.0.0.1',
        }),
      }),
    });
    await expect(proofClient.fetchHostTransitions({
      caFingerprint: identity.caFingerprint,
      endpoint: `https://127.0.0.1:${address.port}`,
      projectId: 'project-a',
    })).resolves.toEqual([proof]);
    expect(observedAuthorization).toBeUndefined();
  });
});
