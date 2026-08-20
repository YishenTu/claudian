import { type CollabProjectId } from '@claudian/collab-protocol';

import type { HostTransitionCandidateResolver } from '@/app/collab/HostTransitionCandidateResolver';
import type { CollabTrustedHost } from '@/app/collab/lan/CollabHttpClient';
import type { AcknowledgeRetirementResponse } from '@/app/collab/lan/LanCollabControlOperations';

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
  readonly hostTransitionCandidates: Pick<HostTransitionCandidateResolver, 'resolve'>;
  readonly request: (
    trust: CollabTrustedHost,
    input: RetirementAcknowledgementInput,
  ) => Promise<AcknowledgeRetirementResponse>;
}

export class RetirementTerminalClient {
  constructor(private readonly options: RetirementTerminalClientOptions) {}

  async acknowledge(
    input: RetirementAcknowledgementInput,
  ): Promise<AcknowledgeRetirementResponse> {
    try {
      return await this.options.request(storedTrust(input), input);
    } catch (error) {
      const trust = await this.options.hostTransitionCandidates.resolve({
        failure: error,
        pinnedCaCertificatePem: input.hostCaCertificatePem,
        projectId: input.projectId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return this.options.request(trust, input);
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
