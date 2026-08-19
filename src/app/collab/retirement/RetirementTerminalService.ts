import type { CollabProjectId } from '@claudian/collab-protocol';

import type { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';
import type { CollabHostTrustTransitionProof, CollabRetirementResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RetirementTrustChainVerifier {
  verifyChain(input: {
    readonly expectedCurrentCaFingerprint?: string;
    readonly pinnedCaCertificatePem: string;
    readonly projectId: CollabProjectId;
    readonly proofs: readonly CollabHostTrustTransitionProof[];
  }): string;
}

export interface RetirementTerminalServiceOptions {
  readonly trustChainVerifier?: RetirementTrustChainVerifier;
}

export interface RetirementTerminalResponse<T> {
  readonly afterResponseFlushed?: () => void;
  readonly body: T;
}

export interface RetirementAcknowledgementBody extends CollabRetirementResult {
  readonly acknowledgedAt: string;
}

function terminalError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class RetirementTerminalService {
  private readonly trustChainVerifier?: RetirementTrustChainVerifier;

  constructor(
    private readonly tombstones: RetirementTombstoneRepository,
    options: RetirementTerminalServiceOptions = {},
  ) {
    this.trustChainVerifier = options.trustChainVerifier;
  }

  async getResult(
    projectId: CollabProjectId,
    memberCredential: string,
  ): Promise<CollabRetirementResult> {
    return (await this.tombstones.authenticate(projectId, memberCredential)).tombstone.result;
  }

  async getHostTransitions(
    projectId: CollabProjectId,
  ): Promise<readonly CollabHostTrustTransitionProof[]> {
    const tombstone = await this.tombstones.load(projectId);
    if (!tombstone) throw terminalError('retirement-tombstone-missing');
    return tombstone.hostTransitionProofs;
  }

  async acknowledge(
    projectId: CollabProjectId,
    memberCredential: string,
    expectedRetiredAt: string,
  ): Promise<RetirementTerminalResponse<RetirementAcknowledgementBody>> {
    const acknowledgement = await this.tombstones.acknowledge(
      projectId,
      memberCredential,
      expectedRetiredAt,
    );
    return {
      body: {
        acknowledgedAt: acknowledgement.acknowledgedAt,
        ...acknowledgement.result,
      },
    };
  }

  async verifyTrust(input: {
    readonly expectedCurrentCaFingerprint?: string;
    readonly pinnedCaCertificatePem: string;
    readonly projectId: CollabProjectId;
  }): Promise<string> {
    if (!this.trustChainVerifier) throw terminalError('retirement-trust-verifier-missing');
    const tombstone = await this.tombstones.load(input.projectId);
    if (!tombstone) throw terminalError('retirement-tombstone-missing');
    return this.trustChainVerifier.verifyChain({
      ...input,
      proofs: tombstone.hostTransitionProofs,
    });
  }
}
