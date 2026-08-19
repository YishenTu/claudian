import type {
  LocalProjectCleanupPort,
  RetiredCleanupChoiceIntent,
} from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RetiredProjectProjectionFinalizerPort {
  finalizeRetiredProject(projectId: string): Promise<void>;
}

/** Owns the two-store Retired finalization order and its idempotent retry. */
export class RetiredProjectFinalizer {
  constructor(
    private readonly cleanup: Pick<
      LocalProjectCleanupPort,
      'completeRetiredFinalization' | 'finalizeRetiredChoice'
    >,
    private readonly projects: RetiredProjectProjectionFinalizerPort,
  ) {}

  async finalize(
    intent: RetiredCleanupChoiceIntent,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    try {
      const result = await this.cleanup.finalizeRetiredChoice(intent, options);
      if (result.status === 'cancelled') throw new CollabError({ code: 'cancelled' });
      await this.projects.finalizeRetiredProject(intent.projectId);
      await this.cleanup.completeRetiredFinalization(intent.projectId);
    } catch (error) {
      if (!(error instanceof CollabError) || error.code !== 'project-not-found') throw error;
      // The projection may already be gone after a crash between the two durable
      // finalization stores. Only an exact applied cleanup journal can reach here.
      await this.cleanup.finalizeRetiredChoice(intent, options);
      await this.cleanup.completeRetiredFinalization(intent.projectId);
    }
  }
}
