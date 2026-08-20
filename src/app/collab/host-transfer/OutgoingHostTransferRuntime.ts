import { type CollabOperationId, type CollabProjectId } from '@claudian/collab-protocol';

import type {
  HostTransferRecoveryStorePort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import type {
  OutgoingHostTransferCoordinator,
} from '@/app/collab/host-transfer/OutgoingHostTransferCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { toError } from '@/utils/error';

export class OutgoingHostTransferRuntime {
  private readonly abortController = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly coordinators = new Map<
    CollabOperationId,
    Pick<
      OutgoingHostTransferCoordinator,
      | 'cancelBeforeRelinquishment'
      | 'inspectStartupRecovery'
      | 'prepareAccepted'
      | 'prepareCancellation'
      | 'prepareTerminalRecoveryBeforeStartup'
      | 'run'
    >
  >();

  constructor(
    private readonly projectId: CollabProjectId,
    private readonly createCoordinator: (
      transferId: CollabOperationId,
    ) => Pick<
      OutgoingHostTransferCoordinator,
      | 'cancelBeforeRelinquishment'
      | 'inspectStartupRecovery'
      | 'prepareAccepted'
      | 'prepareCancellation'
      | 'prepareTerminalRecoveryBeforeStartup'
      | 'run'
    >,
    private readonly recovery: Pick<HostTransferRecoveryStorePort, 'load'>,
  ) {}

  run(projectId: CollabProjectId, transferId: CollabOperationId): Promise<void> {
    return this.track(() => this.coordinator(transferId).run(
      projectId,
      transferId,
      this.abortController.signal,
    ));
  }

  prepareAccepted(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    return this.track(() => (
      this.coordinator(transferId).prepareAccepted(projectId, transferId)
    ));
  }

  prepareCancellation(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    return this.track(() => (
      this.coordinator(transferId).prepareCancellation(projectId, transferId)
    ));
  }

  cancelBeforeRelinquishment(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
  ): Promise<void> {
    return this.track(() => (
      this.coordinator(transferId).cancelBeforeRelinquishment(projectId, transferId)
    ));
  }

  inspectStartupRecovery(): Promise<
    | 'none'
    | 'post-relinquishment'
    | 'pre-relinquishment'
    | 'pre-relinquishment-cleanup'
  > {
    return this.track(async () => {
      const record = await this.recovery.load(this.projectId, 'outgoing');
      if (!record) return 'none';
      return this.coordinator(record.transferId).inspectStartupRecovery(
        record.projectId,
        record.transferId,
      );
    });
  }

  prepareTerminalRecoveryBeforeStartup(): Promise<void> {
    return this.track(async () => {
      const record = await this.recovery.load(this.projectId, 'outgoing');
      if (!record) return;
      await this.coordinator(record.transferId).prepareTerminalRecoveryBeforeStartup(
        record.projectId,
        record.transferId,
      );
    });
  }

  resume(): Promise<void> {
    return this.track(async () => {
      const record = await this.recovery.load(this.projectId, 'outgoing');
      if (!record) return;
      await this.coordinator(record.transferId).run(
        record.projectId,
        record.transferId,
        this.abortController.signal,
      );
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abortController.abort();
    const active = [...this.active];
    this.closePromise = Promise.allSettled(active).then(() => undefined);
    return this.closePromise;
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CollabError({
        code: 'cancelled',
        recoveryActions: ['retry'],
        safeContext: { reason: 'host-transfer-runtime-closed' },
      }));
    }
    const pending = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        throw toError(error, 'Outgoing Host transfer operation failed.');
      });
    this.active.add(pending);
    const remove = () => this.active.delete(pending);
    void pending.then(remove, remove);
    return pending;
  }

  private coordinator(
    transferId: CollabOperationId,
  ): Pick<
    OutgoingHostTransferCoordinator,
    | 'cancelBeforeRelinquishment'
    | 'inspectStartupRecovery'
    | 'prepareAccepted'
    | 'prepareCancellation'
    | 'prepareTerminalRecoveryBeforeStartup'
    | 'run'
  > {
    const existing = this.coordinators.get(transferId);
    if (existing) return existing;
    const created = this.createCoordinator(transferId);
    this.coordinators.set(transferId, created);
    return created;
  }
}
