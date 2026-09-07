import { RetirementTerminalClient } from '@/app/collab/retirement/RetirementTerminalClient';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const INPUT = {
  hostCaCertificatePem: 'old-ca',
  hostCaFingerprint: 'a'.repeat(64),
  hostEndpoint: 'https://192.168.1.20:54545',
  idempotencyKey: 'retire-local-one',
  memberCredential: 'A'.repeat(43),
  projectId: 'project-a',
  retiredAt: '2026-08-13T00:00:00.000Z',
} as const;

describe('RetirementTerminalClient', () => {
  it('uses the stored pinned endpoint without discovery while it remains reachable', async () => {
    const request = jest.fn().mockResolvedValue(response());
    const resolve = jest.fn();
    const client = new RetirementTerminalClient({
      hostTransitionCandidates: { resolve },
      request,
    });

    await expect(client.acknowledge(INPUT)).resolves.toEqual(response());

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      caCertificatePem: 'old-ca',
      endpoint: INPUT.hostEndpoint,
    }), INPUT);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('discovers a same-CA terminal responder after the stored endpoint becomes unreachable', async () => {
    const replacement = 'https://10.0.0.8:61234';
    const request = jest.fn()
      .mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
      .mockResolvedValueOnce(response());
    const client = new RetirementTerminalClient({
      hostTransitionCandidates: {
        resolve: jest.fn().mockResolvedValue({
          caCertificatePem: 'old-ca',
          caFingerprint: INPUT.hostCaFingerprint,
          endpoint: replacement,
          projectId: INPUT.projectId,
        }),
      },
      request,
    });

    await expect(client.acknowledge(INPUT)).resolves.toEqual(response());

    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      caCertificatePem: 'old-ca',
      caFingerprint: INPUT.hostCaFingerprint,
      endpoint: replacement,
    }), INPUT);
  });

  it('verifies a changed-CA proof chain before sending the Member credential', async () => {
    const candidate = {
      caFingerprint: 'b'.repeat(64),
      endpoint: 'https://10.0.0.9:61235',
      projectId: INPUT.projectId,
    };
    const calls: string[] = [];
    const request = jest.fn(async trust => {
      calls.push(`request:${trust.caFingerprint}`);
      if (trust.endpoint === INPUT.hostEndpoint) {
        throw new CollabError({ code: 'endpoint-unreachable' });
      }
      return response();
    });
    const client = new RetirementTerminalClient({
      hostTransitionCandidates: {
        resolve: jest.fn(async () => {
          calls.push('proof');
          calls.push('verify');
          return {
            caCertificatePem: 'new-ca',
            caFingerprint: candidate.caFingerprint,
            endpoint: candidate.endpoint,
            projectId: candidate.projectId,
          };
        }),
      },
      request,
    });

    await expect(client.acknowledge(INPUT)).resolves.toEqual(response());

    expect(calls).toEqual([
      `request:${INPUT.hostCaFingerprint}`,
      'proof',
      'verify',
      `request:${candidate.caFingerprint}`,
    ]);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      caCertificatePem: 'new-ca',
      caFingerprint: candidate.caFingerprint,
      endpoint: candidate.endpoint,
    }), INPUT);
  });

  it('verifies a changed CA at the same endpoint after pinned trust fails', async () => {
    const candidate = {
      caFingerprint: 'b'.repeat(64),
      endpoint: INPUT.hostEndpoint,
      projectId: INPUT.projectId,
    };
    const request = jest.fn()
      .mockRejectedValueOnce(new CollabError({ code: 'tls-untrusted' }))
      .mockResolvedValueOnce(response());
    const client = new RetirementTerminalClient({
      hostTransitionCandidates: {
        resolve: jest.fn().mockResolvedValue({
          caCertificatePem: 'new-ca',
          caFingerprint: candidate.caFingerprint,
          endpoint: candidate.endpoint,
          projectId: candidate.projectId,
        }),
      },
      request,
    });

    await expect(client.acknowledge(INPUT)).resolves.toEqual(response());
    expect(request).toHaveBeenLastCalledWith({
      caCertificatePem: 'new-ca',
      caFingerprint: candidate.caFingerprint,
      endpoint: INPUT.hostEndpoint,
      projectId: INPUT.projectId,
    }, INPUT);
  });

  it('does not discover or transmit credentials after a non-transport rejection', async () => {
    const resolve = jest.fn(async ({ failure }: { failure: unknown }) => {
      throw failure;
    });
    const request = jest.fn().mockRejectedValue(new CollabError({ code: 'authentication-failed' }));
    const client = new RetirementTerminalClient({
      hostTransitionCandidates: { resolve },
      request,
    });

    await expect(client.acknowledge(INPUT)).rejects.toMatchObject({
      code: 'authentication-failed',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function response() {
  return {
    acknowledgedAt: '2026-08-13T00:01:00.000Z',
    projectId: INPUT.projectId,
    retiredAt: INPUT.retiredAt,
  } as const;
}
