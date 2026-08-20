import { type CollabProjectId } from '@claudian/collab-protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';
import { toError } from '@/utils/error';

export type ProjectOperationPolicy = 'active' | 'retired-local';

function closingError(): CollabError {
  return new CollabError({
    code: 'cancelled',
    safeContext: { reason: 'collab-feature-closing' },
  });
}

export class ProjectOperationAdmission {
  private readonly active = new Set<Promise<unknown>>();
  private readonly closedProjects = new Set<CollabProjectId>();
  private closing = false;

  beginClose(): void {
    this.closing = true;
  }

  closeProject(projectId: CollabProjectId): void {
    this.closedProjects.add(projectId);
  }

  drain(): Promise<void> {
    return Promise.allSettled([...this.active]).then(() => undefined);
  }

  runGlobal<T>(operation: () => Promise<T>): Promise<T> {
    return this.runAdmitted(operation);
  }

  runProject<T>(
    resolveProjectId: () => CollabProjectId,
    policy: ProjectOperationPolicy,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing) return Promise.reject(closingError());
    let projectId: CollabProjectId;
    try {
      projectId = resolveProjectId();
    } catch (error) {
      return Promise.reject(toError(error, 'Collab Project operation admission failed.'));
    }
    if (policy === 'active' && this.closedProjects.has(projectId)) {
      return Promise.reject(new CollabError({
        code: 'project-retired',
        safeContext: { projectId, reason: 'collab-feature-project-closed' },
      }));
    }
    return this.runAdmitted(operation);
  }

  private runAdmitted<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(closingError());
    const admitted = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        throw toError(error, 'Admitted Collab Project operation failed.');
      });
    this.active.add(admitted);
    const remove = () => this.active.delete(admitted);
    void admitted.then(remove, remove);
    return admitted;
  }
}
