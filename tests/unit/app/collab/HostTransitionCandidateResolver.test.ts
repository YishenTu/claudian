import { HostTransitionCandidateResolver } from '@/app/collab/HostTransitionCandidateResolver';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-alpha';
const PINNED_CA = '-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n';

function candidate(suffix: string) {
  return {
    caFingerprint: suffix.repeat(64),
    endpoint: `https://10.0.0.${suffix === 'a' ? '1' : '2'}:54545`,
    projectId: PROJECT_ID,
  };
}

describe('HostTransitionCandidateResolver', () => {
  it('proves and returns the unique current Host trust', async () => {
    const current = candidate('b');
    const fetchHostTransitions = jest.fn().mockResolvedValue([{ transferId: 'transfer-one' }]);
    const verifyChain = jest.fn().mockReturnValue('new-ca');
    const resolver = new HostTransitionCandidateResolver({
      discovery: {
        discoverProjectCandidatesForTrustTransition: jest.fn().mockResolvedValue([current]),
      },
      proofClient: { fetchHostTransitions },
      trustTransitions: { verifyChain },
    });

    await expect(resolver.resolve({
      failure: new CollabError({ code: 'endpoint-unreachable' }),
      pinnedCaCertificatePem: PINNED_CA,
      projectId: PROJECT_ID,
    })).resolves.toEqual({
      caCertificatePem: 'new-ca',
      caFingerprint: current.caFingerprint,
      endpoint: current.endpoint,
      projectId: PROJECT_ID,
    });
    expect(fetchHostTransitions).toHaveBeenCalledWith(current, { timeoutMs: 2_000 });
    expect(verifyChain).toHaveBeenCalledWith({
      expectedCurrentCaFingerprint: current.caFingerprint,
      pinnedCaCertificatePem: PINNED_CA,
      projectId: PROJECT_ID,
      proofs: [{ transferId: 'transfer-one' }],
    });
  });

  it('isolates invalid candidates and rejects zero or multiple valid authorities', async () => {
    const first = candidate('a');
    const second = candidate('b');
    const discovery = {
      discoverProjectCandidatesForTrustTransition: jest.fn().mockResolvedValue([
        { ...first, projectId: 'project-other' },
        first,
        second,
      ]),
    };
    const verifyChain = jest.fn(({ expectedCurrentCaFingerprint }) => {
      if (expectedCurrentCaFingerprint === first.caFingerprint) throw new Error('invalid proof');
      return 'new-ca';
    });
    const resolver = new HostTransitionCandidateResolver({
      discovery,
      proofClient: { fetchHostTransitions: jest.fn().mockResolvedValue([]) },
      trustTransitions: { verifyChain },
    });
    await expect(resolver.resolve({
      failure: new CollabError({ code: 'tls-untrusted' }),
      pinnedCaCertificatePem: PINNED_CA,
      projectId: PROJECT_ID,
    })).resolves.toMatchObject({ caFingerprint: second.caFingerprint });

    verifyChain.mockReturnValue('new-ca');
    await expect(resolver.resolve({
      failure: new CollabError({ code: 'tls-untrusted' }),
      pinnedCaCertificatePem: PINNED_CA,
      projectId: PROJECT_ID,
    })).rejects.toMatchObject({
      code: 'authority-integrity-error',
      safeContext: { reason: 'multiple-host-transition-candidates-confirmed' },
    });
  });

  it('does not rediscover non-transport failures and preserves cancellation', async () => {
    const discover = jest.fn().mockResolvedValue([candidate('a')]);
    const resolver = new HostTransitionCandidateResolver({
      discovery: { discoverProjectCandidatesForTrustTransition: discover },
      proofClient: { fetchHostTransitions: jest.fn().mockResolvedValue([]) },
      trustTransitions: { verifyChain: jest.fn().mockReturnValue('new-ca') },
    });
    const authenticationFailure = new CollabError({ code: 'authentication-failed' });
    await expect(resolver.resolve({
      failure: authenticationFailure,
      pinnedCaCertificatePem: PINNED_CA,
      projectId: PROJECT_ID,
    })).rejects.toBe(authenticationFailure);
    expect(discover).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(resolver.resolve({
      failure: new CollabError({ code: 'endpoint-unreachable' }),
      pinnedCaCertificatePem: PINNED_CA,
      projectId: PROJECT_ID,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(discover).not.toHaveBeenCalled();
  });
});
