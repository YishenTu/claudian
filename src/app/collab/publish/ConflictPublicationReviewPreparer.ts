import type { ConflictPublicationInput, ConflictPublicationPort } from '@/app/collab/conflicts/ConflictResolutionCoordinator';
import type {
  CollabPublicationOperationRecord,
  CollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import type {
  PublishCandidatePort,
  PublishCoordinator,
  PublishProjectContext,
} from '@/app/collab/publish/PublishCoordinator';
import { type CollabPublicationReview } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface ConflictPublicationStatePort {
  load(projectId: string): Promise<CollabPublicationStateRecord>;
  save(record: CollabPublicationStateRecord): Promise<void>;
}

function preparationError(reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class ConflictPublicationReviewPreparer implements ConflictPublicationPort {
  constructor(
    private readonly state: ConflictPublicationStatePort,
    private readonly candidates: PublishCandidatePort,
    private readonly publications: Pick<PublishCoordinator, 'prepareReview'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async isResolutionRetained(
    context: PublishProjectContext,
    input: ConflictPublicationInput,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    const state = await this.state.load(context.projectId);
    this.#assertOperation(state.operation, input);
    if (state.operation.phase !== 'review-ready') return false;
    await this.candidates.assertRetained(context, input, signal);
    return true;
  }

  async prepareResolvedReview(
    context: PublishProjectContext,
    input: ConflictPublicationInput,
    signal?: AbortSignal,
  ): Promise<CollabPublicationReview> {
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    let state = await this.state.load(context.projectId);
    const operation = state.operation;
    this.#assertOperation(operation, input);
    await this.candidates.assertRetained(context, input, signal);
    if (operation.phase === 'captured') {
      const updatedAt = this.now().toISOString();
      state = {
        ...state,
        operation: {
          ...operation,
          candidateOid: input.candidateOid,
          currentMainOid: input.currentMainOid,
          phase: 'review-ready',
          updatedAt,
        },
        updatedAt,
      };
      await this.state.save(state);
    }
    return this.publications.prepareReview(
      context.projectId,
      input.operationId,
      { signal },
    );
  }

  #assertOperation(
    operation: CollabPublicationOperationRecord | null,
    input: ConflictPublicationInput,
  ): asserts operation is CollabPublicationOperationRecord & {
    readonly phase: 'captured' | 'review-ready';
  } {
    if (
      !operation
      || operation.operationId !== input.operationId
      || operation.contributionHeadOid !== input.contributionHeadOid
      || (operation.phase !== 'captured' && operation.phase !== 'review-ready')
      || (operation.phase === 'captured'
        && (operation.candidateOid !== null || operation.currentMainOid !== null))
      || (operation.phase === 'review-ready'
        && (
          operation.candidateOid !== input.candidateOid
          || operation.currentMainOid !== input.currentMainOid
        ))
    ) {
      throw preparationError('conflict-publication-state-mismatch');
    }
  }
}
