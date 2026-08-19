import { type CollabProjectId } from '@claudian/collab-protocol';

import type { CollabLanDiscoveryPort } from '@/app/collab/discovery/CollabLanDiscoveryService';
import type { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import type {
  CollabTrustedEndpointCandidate,
  CollabTrustedHost,
} from '@/app/collab/lan/CollabHttpClient';
import type { AcknowledgeRetirementResponse } from '@/app/collab/lan/LanCollabControlOperations';
import type { HostTransitionProofClientPort } from '@/app/collab/reconnect/ReconnectProjectCoordinator';
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

export interface RetirementAcknowledgementInput {
  readonly hostCaCertificatePem: string;
  readonly hostCaFingerprint: string;
  readonly hostEndpoint: string;
  readonly idempotencyKey: string;
  readonly memberCredential: string;
  readonly projectId: CollabProjectId;
  readonly retiredAt: string;
  readonly signal?: AbortSignal;
}

export interface RetirementTerminalClientOptions {
  readonly discovery: Pick<
    CollabLanDiscoveryPort,
    'discoverProjectCandidatesForTrustTransition'
  >;
  readonly proofClient: HostTransitionProofClientPort;
  readonly request: (
    trust: CollabTrustedHost,
    input: RetirementAcknowledgementInput,
  ) => Promise<AcknowledgeRetirementResponse>;
  readonly trustTransitions: Pick<HostTrustTransitionService, 'verifyChain'>;
}

interface VerifiedCandidate {
  readonly candidate: CollabTrustedEndpointCandidate;
  readonly caCertificatePem: string;
}

export class RetirementTerminalClient {
  constructor(private readonly options: RetirementTerminalClientOptions) {}

  async acknowledge(
    input: RetirementAcknowledgementInput,
  ): Promise<AcknowledgeRetirementResponse> {
    try {
      return await this.options.request(storedTrust(input), input);
    } catch (error) {
      if (!(error instanceof CollabError) || !REDISCOVERY_CODES.has(error.code)) {
        throw error;
      }
    }

    const candidates = await this.options.discovery
      .discoverProjectCandidatesForTrustTransition(
        input.projectId,
        input.signal ? { signal: input.signal } : {},
      );
    const validations = await Promise.all(candidates
      .map(candidate => this.verifyCandidate(candidate, input)));
    const verified = validations.flatMap(candidate => candidate ? [candidate] : []);
    if (verified.length !== 1) {
      throw new CollabError({
        code: verified.length > 1 ? 'authority-integrity-error' : 'endpoint-unreachable',
        recoveryActions: verified.length > 1 ? ['open-diagnostics'] : ['retry'],
        safeContext: {
          reason: verified.length > 1
            ? 'multiple-retirement-responders-confirmed'
            : 'retirement-responder-unavailable',
        },
      });
    }
    const selected = verified[0];
    return this.options.request({
      caCertificatePem: selected.caCertificatePem,
      caFingerprint: selected.candidate.caFingerprint,
      endpoint: selected.candidate.endpoint,
      projectId: input.projectId,
    }, input);
  }

  private async verifyCandidate(
    candidate: CollabTrustedEndpointCandidate,
    input: RetirementAcknowledgementInput,
  ): Promise<VerifiedCandidate | null> {
    if (candidate.projectId !== input.projectId) return null;
    try {
      const proofs = await this.options.proofClient.fetchHostTransitions(candidate, {
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: DISCOVERED_ENDPOINT_TIMEOUT_MS,
      });
      const caCertificatePem = this.options.trustTransitions.verifyChain({
        expectedCurrentCaFingerprint: candidate.caFingerprint,
        pinnedCaCertificatePem: input.hostCaCertificatePem,
        projectId: input.projectId,
        proofs,
      });
      return { caCertificatePem, candidate };
    } catch {
      return null;
    }
  }
}

function storedTrust(input: RetirementAcknowledgementInput): CollabTrustedHost {
  return {
    caCertificatePem: input.hostCaCertificatePem,
    caFingerprint: input.hostCaFingerprint,
    endpoint: input.hostEndpoint,
    projectId: input.projectId,
  };
}
