import { createHash } from 'node:crypto';

import type { CollabIdempotencyKey, CollabMemberId, CollabProjectId } from '@claudian/collab-protocol';

export interface RetirementIntentInput {
  readonly expectedHostMemberId: CollabMemberId;
  readonly managerActorMemberId: CollabMemberId;
  readonly projectId: CollabProjectId;
}

export interface RetirementIntent {
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly requestFingerprint: string;
}

export function createRetirementIntent(input: RetirementIntentInput): RetirementIntent {
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({
      expectedHostMemberId: input.expectedHostMemberId,
      expectedManagerMemberId: input.managerActorMemberId,
      projectId: input.projectId,
    }))
    .digest('hex');
  return {
    idempotencyKey: `retire-${requestFingerprint.slice(0, 32)}`,
    requestFingerprint,
  };
}
