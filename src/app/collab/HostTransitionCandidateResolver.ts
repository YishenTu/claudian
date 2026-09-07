import type { CollabLanDiscoveryPort } from '@/app/collab/discovery/CollabLanDiscoveryService';
import type { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import type {
  CollabHttpOperationOptions,
  CollabTrustedEndpointCandidate,
  CollabTrustedHost,
} from '@/app/collab/lan/CollabHttpClient';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const DISCOVERED_ENDPOINT_TIMEOUT_MS = 2_000;
const REDISCOVERY_CODES = new Set([
  'endpoint-unreachable',
  'host-stopped',
  'local-network-permission-required',
  'offline',
  'operation-timeout',
  'tls-ca-mismatch',
  'tls-untrusted',
]);

export interface HostTransitionProofClientPort {
  fetchHostTransitions(
    candidate: CollabTrustedEndpointCandidate,
    options?: CollabHttpOperationOptions,
  ): Promise<readonly CollabHostTrustTransitionProof[]>;
}

export interface HostTransitionCandidateResolverOptions {
  readonly discovery: Pick<
    CollabLanDiscoveryPort,
    'discoverProjectCandidatesForTrustTransition'
  >;
  readonly proofClient: HostTransitionProofClientPort;
  readonly trustTransitions: Pick<HostTrustTransitionService, 'verifyChain'>;
}

export interface ResolveHostTransitionCandidateInput {
  readonly failure: unknown;
  readonly pinnedCaCertificatePem: string;
  readonly projectId: string;
  readonly signal?: AbortSignal;
}

export class HostTransitionCandidateResolver {
  constructor(private readonly options: HostTransitionCandidateResolverOptions) {}

  async resolve(input: ResolveHostTransitionCandidateInput): Promise<CollabTrustedHost> {
    if (
      !(input.failure instanceof CollabError)
      || !REDISCOVERY_CODES.has(input.failure.code)
    ) {
      throw input.failure;
    }
    if (input.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    const candidates = await this.options.discovery.discoverProjectCandidatesForTrustTransition(
      input.projectId,
      input.signal ? { signal: input.signal } : {},
    );
    const verified = (await Promise.all(candidates.map(candidate => (
      this.verifyCandidate(candidate, input)
    )))).flatMap(candidate => candidate ? [candidate] : []);
    if (verified.length !== 1) {
      throw new CollabError({
        code: verified.length > 1 ? 'authority-integrity-error' : 'endpoint-unreachable',
        recoveryActions: verified.length > 1 ? ['open-diagnostics'] : ['retry'],
        safeContext: {
          reason: verified.length > 1
            ? 'multiple-host-transition-candidates-confirmed'
            : 'host-transition-candidate-unavailable',
        },
      });
    }
    return verified[0];
  }

  private async verifyCandidate(
    candidate: CollabTrustedEndpointCandidate,
    input: ResolveHostTransitionCandidateInput,
  ): Promise<CollabTrustedHost | null> {
    if (candidate.projectId !== input.projectId) return null;
    try {
      const proofs = await this.options.proofClient.fetchHostTransitions(candidate, {
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: DISCOVERED_ENDPOINT_TIMEOUT_MS,
      });
      const caCertificatePem = this.options.trustTransitions.verifyChain({
        expectedCurrentCaFingerprint: candidate.caFingerprint,
        pinnedCaCertificatePem: input.pinnedCaCertificatePem,
        projectId: input.projectId,
        proofs,
      });
      return {
        caCertificatePem,
        caFingerprint: candidate.caFingerprint,
        endpoint: candidate.endpoint,
        projectId: input.projectId,
      };
    } catch (error) {
      if (
        input.signal?.aborted
        || (error instanceof CollabError && error.code === 'cancelled')
      ) {
        throw new CollabError({ code: 'cancelled' });
      }
      return null;
    }
  }
}
