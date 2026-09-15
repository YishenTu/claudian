import type { CollabProjectUpdateInspection } from '@/core/collab';

export function projectUpdateProjection(
  facts: Omit<CollabProjectUpdateInspection, 'action'>,
): CollabProjectUpdateInspection {
  const { freshness, incoming } = facts;
  const operation = facts.operation.kind === 'update-review' && freshness !== 'fresh'
    ? { ...facts.operation, review: { ...facts.operation.review, canConfirm: false } }
    : facts.operation;
  const kind = operation.kind === 'publish' ? 'complete-publish'
    : operation.kind === 'update-conflict' || operation.kind === 'update-recovery' ? 'continue-update'
    : operation.kind === 'update-review' ? 'review-update'
    : incoming === 'available' ? 'update'
    : 'none';
  const enabled = kind !== 'none' && (kind === 'complete-publish' || kind === 'review-update' || freshness === 'fresh');
  return { ...facts, operation, action: { kind, enabled } };
}
