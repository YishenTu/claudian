import { type CollabProjectId } from '@claudian-collab/protocol';

import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';

export interface AuthorityProjectionTransitionPort {
  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T>;
}

export class AuthorityProjectionTransitionCoordinator
implements AuthorityProjectionTransitionPort {
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
