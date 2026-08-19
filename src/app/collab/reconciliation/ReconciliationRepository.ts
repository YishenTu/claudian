import type { CollabOperationId } from '@claudian/collab-protocol';

import type { NativeGitPublishRepository } from '@/app/collab/publish/NativeGitPublishRepository';
import type {
  PublishProjectContext,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import type { NativeGitAcceptedStateIntegrator } from '@/app/collab/reconciliation/NativeGitAcceptedStateIntegrator';
import type {
  ReconciliationFastForwardResult,
  ReconciliationPlan,
  ReconciliationRepositoryPort,
} from '@/app/collab/reconciliation/ReconciliationCoordinator';

type PublishReconciliationOperations = Pick<
  NativeGitPublishRepository,
  'fetch' | 'inspect' | 'pushPersonal'
>;

type AcceptedStateOperations = Pick<
  NativeGitAcceptedStateIntegrator,
  'fastForward' | 'plan'
>;

export class ReconciliationRepository implements ReconciliationRepositoryPort {
  constructor(
    private readonly publish: PublishReconciliationOperations,
    private readonly acceptedState: AcceptedStateOperations,
  ) {}

  inspect(
    context: PublishProjectContext,
    signal?: AbortSignal,
  ): Promise<PublishRepositorySnapshot> {
    return this.publish.inspect(context, signal);
  }

  fetch(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.publish.fetch(context, expected, signal);
  }

  plan(
    context: PublishProjectContext,
    snapshot: PublishRepositorySnapshot,
    operationId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<ReconciliationPlan> {
    return this.acceptedState.plan(context, snapshot, operationId, signal);
  }

  fastForward(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<ReconciliationFastForwardResult> {
    return this.acceptedState.fastForward(context, expected, signal);
  }

  pushPersonal(
    context: PublishProjectContext,
    expected: PublishRepositorySnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.publish.pushPersonal(context, expected, signal);
  }
}
