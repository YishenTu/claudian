import { createHash } from 'node:crypto';

import type { CollabMemberId, CollabOperationId, CollabProjectId } from '@claudian/collab-protocol';

/** Stable across target restarts so an ambiguous Accept can be replayed exactly. */
export function hostTransferAcceptanceIdempotencyKey(
  projectId: CollabProjectId,
  transferId: CollabOperationId,
  targetMemberId: CollabMemberId,
): string {
  const digest = createHash('sha256')
    .update(`${projectId}\0${transferId}\0${targetMemberId}`, 'utf8')
    .digest('hex');
  return `accept-host-transfer-${digest}`;
}
