import type { CollabProjectId } from '@claudian-collab/protocol';

import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';

export class ProjectTaskQueue {
  private readonly projects = new Map<CollabProjectId, { queue: SerialTaskQueue; pending: number }>();

  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
    let entry = this.projects.get(projectId);
    if (!entry) {
      entry = { queue: new SerialTaskQueue(), pending: 0 };
      this.projects.set(projectId, entry);
    }
    const current = entry;
    current.pending += 1;
    return current.queue.run(operation).finally(() => {
      current.pending -= 1;
      if (current.pending === 0) this.projects.delete(projectId);
    });
  }
}
