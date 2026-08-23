import type { CollabProjectId } from '@claudian-collab/protocol';

import type { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';
import type { CollabHostTrustTransitionProof, CollabRetirementResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RetirementTerminalResponse<T> {
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
  constructor(
    private readonly tombstones: RetirementTombstoneRepository,
  ) {}

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
}
