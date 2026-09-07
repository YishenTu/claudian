import type {
  PublishMutationBoundary,
  PublishMutationSafetyPort,
  PublishProjectContext,
} from '@/app/collab/publish/PublishCoordinator';
import type {
  ReconciliationSafety,
  ReconciliationSafetyPort,
} from '@/app/collab/reconciliation/ReconciliationCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface ReconciliationRepositoryLockPort {
  hasMutationLock(context: PublishProjectContext): Promise<boolean>;
}

export class ReconciliationMutationSafety implements
  PublishMutationSafetyPort,
  ReconciliationSafetyPort {
  constructor(
    private readonly locks: ReconciliationRepositoryLockPort,
  ) {}

  async inspect(context: PublishProjectContext): Promise<ReconciliationSafety> {
    if (await this.locks.hasMutationLock(context)) {
      return { reason: 'repository-lock', safe: false };
    }
    return { safe: true };
  }

  async assertSafe(
    context: PublishProjectContext,
    boundary?: PublishMutationBoundary,
  ): Promise<void> {
    if (boundary !== undefined && boundary !== 'integrate') return;
    const safety = await this.inspect(context);
    if (safety.safe) return;
    throw new CollabError({
      code: 'working-tree-busy',
      recoveryActions: ['retry'],
      safeContext: { reason: safety.reason },
    });
  }
}
