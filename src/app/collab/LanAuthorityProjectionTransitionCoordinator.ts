import { type CollabProjectId } from '@claudian-collab/protocol';

import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';

export interface LanAuthorityProjectionTransitionPort {
  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T>;
}

export class LanAuthorityProjectionTransitionCoordinator
implements LanAuthorityProjectionTransitionPort {
  readonly #queues = new Map<CollabProjectId, SerialTaskQueue>();

  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
    let queue = this.#queues.get(projectId);
    if (!queue) {
      queue = new SerialTaskQueue();
      this.#queues.set(projectId, queue);
    }
    return queue.run(operation);
  }
}
