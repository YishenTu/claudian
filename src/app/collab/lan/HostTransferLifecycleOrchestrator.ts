import type { CollabOperationId, CollabProjectId } from '@claudian-collab/protocol';

import type {
  HostedLifecycleControlPort,
} from '@/app/collab/lan/HostedProjectControlService';
import type {
  CollabControlDeferredResult,
} from '@/app/collab/lan/routes/RouteTypes';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabHostTransferSummary } from '@/core/collab';

export interface OutgoingHostTransferLifecyclePort {
  cancelBeforeRelinquishment(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void>;
  run(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void>;
  prepareAccepted(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void>;
  prepareCancellation(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void>;
}

export interface HostTransferLifecycleOrchestratorOptions {
  readonly onBackgroundError?: (error: unknown) => void;
}

export class HostTransferLifecycleOrchestrator {
  private readonly operationQueue = new SerialTaskQueue();

  constructor(
    private readonly lifecycle: Pick<
      HostedLifecycleControlPort,
      'acceptHostTransfer' | 'cancelHostTransfer'
    >,
    private readonly outgoing: OutgoingHostTransferLifecyclePort,
    private readonly options: HostTransferLifecycleOrchestratorOptions = {},
  ) {}

  async acceptHostTransfer(
    actorMemberId: Parameters<HostedLifecycleControlPort['acceptHostTransfer']>[0],
    request: Parameters<HostedLifecycleControlPort['acceptHostTransfer']>[1],
  ): Promise<CollabControlDeferredResult<CollabHostTransferSummary>> {
    return this.operationQueue.run(
      () => this.acceptHostTransferUnlocked(actorMemberId, request),
    );
  }

  private async acceptHostTransferUnlocked(
    actorMemberId: Parameters<HostedLifecycleControlPort['acceptHostTransfer']>[0],
    request: Parameters<HostedLifecycleControlPort['acceptHostTransfer']>[1],
  ): Promise<CollabControlDeferredResult<CollabHostTransferSummary>> {
    const result = await this.lifecycle.acceptHostTransfer(actorMemberId, request);
    const response = 'response' in result ? result.response : result;
    const beforeTransfer = 'response' in result
      ? result.afterResponseFlushed
      : undefined;
    if (response.phase !== 'accepted') {
      return {
        ...(beforeTransfer ? { afterResponseFlushed: beforeTransfer } : {}),
        response,
      };
    }
    await this.outgoing.prepareAccepted(request.projectId, request.transferId);
    return {
      ...(beforeTransfer ? { afterResponseFlushed: beforeTransfer } : {}),
      afterResponseSettled: () => {
        void this.outgoing.run(request.projectId, request.transferId)
          .catch(error => this.options.onBackgroundError?.(error));
      },
      response,
    };
  }

  async cancelHostTransfer(
    actorMemberId: Parameters<HostedLifecycleControlPort['cancelHostTransfer']>[0],
    request: Parameters<HostedLifecycleControlPort['cancelHostTransfer']>[1],
  ): Promise<CollabHostTransferSummary> {
    return this.operationQueue.run(
      () => this.cancelHostTransferUnlocked(actorMemberId, request),
    );
  }

  private async cancelHostTransferUnlocked(
    actorMemberId: Parameters<HostedLifecycleControlPort['cancelHostTransfer']>[0],
    request: Parameters<HostedLifecycleControlPort['cancelHostTransfer']>[1],
  ): Promise<CollabHostTransferSummary> {
    await this.outgoing.prepareCancellation(request.projectId, request.transferId);
    const result = await this.lifecycle.cancelHostTransfer(actorMemberId, request);
    await this.outgoing.cancelBeforeRelinquishment(request.projectId, request.transferId);
    return result;
  }
}
