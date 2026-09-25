import { testTime } from '@test/helpers/testClock';

import type { PinnedCollabHTTPClient } from '@/app/collab/lan/CollabHTTPClient';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LANCollabConstants';
import { LANHostTransitionProofClient } from '@/app/collab/reconnect/LANHostTransitionProofClient';

describe('LANHostTransitionProofClient', () => {
  it('pins the advertised CA before fetching the public proof chain without credentials', async () => {
    const proof = {
      schemaVersion: 1 as const,
      projectId: 'project-a',
      transferId: 'transfer-a',
      previousCaFingerprint: 'a'.repeat(64),
      nextCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      nextCaFingerprint: 'b'.repeat(64),
      issuedAt: testTime({ days: -14 }),
      signatureAlgorithm: 'rsa-pss-sha256' as const,
      signature: Buffer.alloc(256, 1).toString('base64url'),
    };
    const requestPublic = jest.fn(async request => request.decode({
      data: { projectId: 'project-a', proofs: [proof] },
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      requestId: 'request-a',
    }));
    const bootstrapPublicEndpoint = jest.fn().mockResolvedValue({
      requestPublic,
    } as unknown as PinnedCollabHTTPClient);
    const client = new LANHostTransitionProofClient({
      createHttpClient: () => ({ bootstrapPublicEndpoint }),
    });
    const candidate = {
      caFingerprint: 'b'.repeat(64),
      endpoint: 'https://192.168.1.20:27001',
      projectId: 'project-a',
    };

    await expect(client.fetchHostTransitions(candidate)).resolves.toEqual([proof]);
    expect(bootstrapPublicEndpoint).toHaveBeenCalledWith(candidate, {});
    expect(requestPublic).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: '/v9/projects/project-a/host-transitions',
    }), {});
  });

  it('rejects a response for another Project', async () => {
    const requestPublic = jest.fn(async request => request.decode({
      data: { projectId: 'project-b', proofs: [] },
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      requestId: 'request-a',
    }));
    const client = new LANHostTransitionProofClient({
      createHttpClient: () => ({
        bootstrapPublicEndpoint: jest.fn().mockResolvedValue({ requestPublic }),
      }),
    });

    await expect(client.fetchHostTransitions({
      caFingerprint: 'b'.repeat(64),
      endpoint: 'https://192.168.1.20:27001',
      projectId: 'project-a',
    })).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'host-transition-project-mismatch' },
    });
  });
});
