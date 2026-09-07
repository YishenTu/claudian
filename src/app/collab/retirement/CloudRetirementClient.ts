import { createHash } from 'node:crypto';

import type {
  CollabProjectRetirementResult,
} from '@claudian-collab/protocol';

import type {
  CollabLocalCloudMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import type {
  CloudAuthorityLifecycleBinding,
  CloudAuthorityLifecycleSession,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type {
  CollabAuthoritySession,
} from '@/app/collab/remote-authority/CollabAuthoritySession';
import { createRetirementIntent } from '@/app/collab/retirement/RetirementIntent';
import type {
  CollabOperationOptions,
  CollabRetirementResult,
  CollabRetireProjectRequest,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudRetirementClientOptions {
  readonly createSession: (
    membership: CollabLocalCloudMembershipRecord,
  ) => Promise<CollabAuthoritySession>;
  readonly createLifecycle: (
    binding: CloudAuthorityLifecycleBinding,
  ) => Promise<CloudAuthorityLifecycleSession>;
}

export interface CloudRetirementAcknowledgementTarget extends CloudAuthorityLifecycleBinding {
  readonly retirementId: string;
}

function retirementError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

/** Adapts Cloud Retire and its durable terminal acknowledgement to local cleanup. */
export class CloudRetirementClient {
  constructor(private readonly options: CloudRetirementClientOptions) {}

  async retire(
    membership: CollabLocalCloudMembershipRecord,
    request: CollabRetireProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabRetirementResult> {
    if (
      membership.project.id !== request.projectId
      || membership.member.id !== request.managerActorMemberId
      || membership.member.role !== 'manager'
    ) throw retirementError('cloud-retirement-manager-membership-mismatch');
    const session = await this.options.createSession(membership);
    try {
      if (!session.lifecycle || !session.supports('project-retirement')) {
        throw retirementError('cloud-retirement-capability-unavailable');
      }
      const snapshot = await session.control.readSnapshot(request.projectId, options);
      if (
        snapshot.project.id !== request.projectId
        || snapshot.currentMember.id !== membership.member.id
        || snapshot.currentMember.role !== 'manager'
      ) throw retirementError('cloud-retirement-snapshot-mismatch');
      const intent = createRetirementIntent(request);
      const result: CollabProjectRetirementResult = await session.lifecycle.retirement(
        'retireProject',
        {
          expectedAuthorityGeneration: membership.authority.authorityGeneration ?? 1,
          expectedMainOid: snapshot.project.mainOid,
          idempotencyKey: intent.idempotencyKey,
          projectId: request.projectId,
        },
        options,
      );
      return {
        projectId: result.projectId,
        retiredAt: result.retiredAt,
        retirementId: result.retirementId,
      };
    } finally {
      session.dispose();
    }
  }

  async acknowledge(
    target: CloudRetirementAcknowledgementTarget,
    options: CollabOperationOptions = {},
  ) {
    const session = await this.options.createLifecycle(target);
    try {
      if (!session.supports('project-retirement')) {
        throw retirementError('cloud-retirement-capability-unavailable');
      }
      return await session.lifecycle.retirement('acknowledgeProjectRetirement', {
        idempotencyKey: this.acknowledgementIdempotencyKey(target.retirementId),
        projectId: target.projectId,
        retirementId: target.retirementId,
      }, options);
    } finally {
      session.dispose();
    }
  }

  private acknowledgementIdempotencyKey(retirementId: string): string {
    return `retire-ack-${createHash('sha256')
      .update(retirementId, 'utf8')
      .digest('hex')
      .slice(0, 32)}`;
  }
}
