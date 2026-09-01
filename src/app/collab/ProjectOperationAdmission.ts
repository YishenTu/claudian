import { type CollabProjectId } from '@claudian-collab/protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';
import { toError } from '@/utils/error';

export type ProjectOperationPolicy = 'active' | 'retired-local';

export interface ProjectOperationSuspension {
  readonly projectId: CollabProjectId;
  readonly token: symbol;
}

function closingError(): CollabError {
  return new CollabError({
    code: 'cancelled',
    safeContext: { reason: 'collab-feature-closing' },
  });
}

export class ProjectOperationAdmission {
  private readonly active = new Set<Promise<unknown>>();
  private readonly projectOperations = new Map<
    CollabProjectId,
    Set<Promise<unknown>>
  >();
  private readonly transitions = new Set<Promise<unknown>>();
  private readonly closedProjects = new Set<CollabProjectId>();
  private readonly suspensions = new Map<CollabProjectId, ProjectOperationSuspension>();
  private closing = false;

  beginClose(): void {
    this.closing = true;
  }

  closeProject(projectId: CollabProjectId): void {
    this.suspensions.delete(projectId);
    this.closedProjects.add(projectId);
  }

  suspendProject(projectId: CollabProjectId): ProjectOperationSuspension {
    const existing = this.suspensions.get(projectId);
    if (existing) return existing;
    const suspension = Object.freeze({ projectId, token: Symbol(projectId) });
    if (!this.closedProjects.has(projectId)) this.suspensions.set(projectId, suspension);
    return suspension;
  }

  resumeProject(suspension: ProjectOperationSuspension): boolean {
    const { projectId } = suspension;
    if (
      this.closing
      || this.closedProjects.has(projectId)
      || this.suspensions.get(projectId) !== suspension
    ) return false;
    this.suspensions.delete(projectId);
    return true;
  }

  drain(): Promise<void> {
    return Promise.allSettled([...this.active, ...this.transitions]).then(() => undefined);
  }

  drainAdmittedOperations(projectId: CollabProjectId): Promise<void> {
    return Promise.allSettled([
      ...(this.projectOperations.get(projectId) ?? []),
    ]).then(() => undefined);
  }

  runGlobal<T>(operation: () => Promise<T>): Promise<T> {
    return this.runAdmitted(operation);
  }

  runLifecycleRecovery<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(closingError());
    return Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        throw toError(error, 'Collab lifecycle recovery failed.');
      });
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
    if (policy === 'active' && this.suspensions.has(projectId)) {
      return Promise.reject(new CollabError({
        code: 'cancelled',
        safeContext: { projectId, reason: 'collab-feature-project-suspended' },
      }));
    }
    return this.runAdmitted(operation, projectId);
  }

  runProjectTransition<T>(
    resolveProjectId: () => CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing) return Promise.reject(closingError());
    let projectId: CollabProjectId;
    try {
      projectId = resolveProjectId();
    } catch (error) {
      return Promise.reject(toError(error, 'Collab Project transition admission failed.'));
    }
    if (this.closedProjects.has(projectId)) {
      return Promise.reject(new CollabError({
        code: 'project-retired',
        safeContext: { projectId, reason: 'collab-feature-project-closed' },
      }));
    }
    return this.runTracked(
      operation,
      this.transitions,
      'Collab Project transition failed.',
    );
  }

  private runAdmitted<T>(
    operation: () => Promise<T>,
    projectId?: CollabProjectId,
  ): Promise<T> {
    if (this.closing) return Promise.reject(closingError());
    const admitted = this.runTracked(
      operation,
      this.active,
      'Admitted Collab Project operation failed.',
    );
    if (projectId === undefined) return admitted;
    let projectOperations = this.projectOperations.get(projectId);
    if (!projectOperations) {
      projectOperations = new Set();
      this.projectOperations.set(projectId, projectOperations);
    }
    projectOperations.add(admitted);
    const remove = () => {
      projectOperations.delete(admitted);
      if (projectOperations.size === 0) this.projectOperations.delete(projectId);
    };
    void admitted.then(remove, remove);
    return admitted;
  }

  private runTracked<T>(
    operation: () => Promise<T>,
    operations: Set<Promise<unknown>>,
    failureMessage: string,
  ): Promise<T> {
    const tracked = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        throw toError(error, failureMessage);
      });
    operations.add(tracked);
    const remove = () => operations.delete(tracked);
    void tracked.then(remove, remove);
    return tracked;
  }
}
