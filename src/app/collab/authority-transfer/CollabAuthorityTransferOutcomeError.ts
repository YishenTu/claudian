import type { CollabResult } from '@/core/collab';

/** Carries one durable transfer operation's safe recovery identity across the feature seam. */
export class CollabAuthorityTransferOutcomeError extends Error {
  constructor(readonly result: Extract<CollabResult<never>, { status: 'recovery-required' }>) {
    super('Authority transfer did not complete');
  }
}
