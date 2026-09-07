import type { CollabProjectId } from '@claudian-collab/protocol';

export interface ManagerResponsibilityOperationPort {
  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T>;
}

export class ManagerResponsibilityOperationCoordinator
implements ManagerResponsibilityOperationPort {
  private readonly tails = new Map<CollabProjectId, Promise<void>>();

  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    const pending = previous.then(operation);
    const tail = pending.then(() => undefined, () => undefined);
    this.tails.set(projectId, tail);
    void tail.then(() => {
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    });
    return pending;
  }
}
