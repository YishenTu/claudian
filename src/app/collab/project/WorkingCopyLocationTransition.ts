import type { CollabProjectId } from '@claudian-collab/protocol';

import type { CollabProjectActivityAdmission, CollabProjectWorkSuspensionPort } from '../activity/CollabProjectActivity';
import type { CollabProjectWorkSessionSuspension } from '../activity/CollabProjectWorkSession';

interface WorkingCopyLocationTransitionOptions {
  readonly admission: CollabProjectActivityAdmission;
  readonly workSessions: CollabProjectWorkSuspensionPort;
  runTransition<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T>;
  runExclusive<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T>;
  runProjection<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T>;
}

export class WorkingCopyLocationTransition {
  constructor(private readonly options: WorkingCopyLocationTransitionOptions) {}

  run<T>(projectId: CollabProjectId, operation: () => Promise<T>): Promise<T> {
    const { admission, workSessions } = this.options;
    return this.options.runTransition(projectId, () => this.options.runExclusive(projectId, async () => {
      const suspension = admission.suspendProjectAdmission(projectId);
      let workSession: CollabProjectWorkSessionSuspension | undefined;
      try {
        workSession = await workSessions.suspendProject(projectId);
        await admission.drainAdmittedOperations(projectId);
        return await this.options.runProjection(projectId, operation);
      } finally {
        if (workSession) await workSessions.resumeProject(workSession);
        admission.resumeProjectAdmission(suspension);
      }
    }));
  }
}
