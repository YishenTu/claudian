import type { CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabProjectWorkSessionSuspension,
} from '@/app/collab/activity/CollabProjectWorkSession';
import type { ProjectOperationSuspension } from '@/app/collab/ProjectOperationAdmission';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface AuthorityTransferAdmissionPort {
  drainAdmittedOperations(): Promise<void>;
  resumeProjectAdmission(suspension: ProjectOperationSuspension): boolean;
  suspendProjectAdmission(projectId: CollabProjectId): ProjectOperationSuspension;
}

interface AuthorityTransferWorkSessionPort {
  resumeProject(suspension: CollabProjectWorkSessionSuspension): Promise<void>;
  suspendProject(projectId: CollabProjectId): Promise<CollabProjectWorkSessionSuspension>;
}

interface AuthorityTransferLocalSuspension {
  readonly admission: ProjectOperationSuspension;
  readonly workSession: CollabProjectWorkSessionSuspension;
}

export interface AuthorityTransferLocalFenceOptions {
  readonly admission: AuthorityTransferAdmissionPort;
  readonly workSessions: AuthorityTransferWorkSessionPort;
}

function recoveryRequired(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

/**
 * Closes locally admitted work around an authority-binding replacement.
 * A failed transition remains suspended so recovery cannot reopen the old
 * authority after origin or membership state may already have changed.
 */
export class AuthorityTransferLocalFence {
  private readonly suspensions = new Map<
    CollabProjectId,
    AuthorityTransferLocalSuspension
  >();

  constructor(private readonly options: AuthorityTransferLocalFenceOptions) {}

  async run(projectId: CollabProjectId, operation: () => Promise<void>): Promise<void> {
    let suspension = this.suspensions.get(projectId);
    if (!suspension) {
      const admission = this.options.admission.suspendProjectAdmission(projectId);
      try {
        const workSession = await this.options.workSessions.suspendProject(projectId);
        suspension = Object.freeze({ admission, workSession });
        this.suspensions.set(projectId, suspension);
      } catch (error) {
        this.options.admission.resumeProjectAdmission(admission);
        throw error;
      }
    }
    await this.options.admission.drainAdmittedOperations();
    await operation();
    await this.resume(projectId, suspension);
  }

  private async resume(
    projectId: CollabProjectId,
    suspension: AuthorityTransferLocalSuspension,
  ): Promise<void> {
    await this.options.workSessions.resumeProject(suspension.workSession);
    if (!this.options.admission.resumeProjectAdmission(suspension.admission)) {
      const admission = this.options.admission.suspendProjectAdmission(projectId);
      try {
        const workSession = await this.options.workSessions.suspendProject(projectId);
        this.suspensions.set(projectId, Object.freeze({ admission, workSession }));
      } catch (error) {
        this.options.admission.resumeProjectAdmission(admission);
        throw error;
      }
      throw recoveryRequired('authority-transfer-admission-resume-failed');
    }
    this.suspensions.delete(projectId);
  }
}
