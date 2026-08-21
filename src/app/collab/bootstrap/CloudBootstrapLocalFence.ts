import type { CollabProjectId } from '@claudian/collab-protocol';

import type {
  CollabProjectWorkSessionSuspension,
} from '@/app/collab/activity/CollabProjectWorkSession';
import type { ProjectOperationSuspension } from '@/app/collab/ProjectOperationAdmission';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudBootstrapAdmissionPort {
  closeProjectAdmission(projectId: CollabProjectId): void;
  drainAdmittedOperations(): Promise<void>;
  resumeProjectAdmission(suspension: ProjectOperationSuspension): boolean;
  suspendProjectAdmission(projectId: CollabProjectId): ProjectOperationSuspension;
}

export interface CloudBootstrapWorkSessionPort {
  closeProject(projectId: CollabProjectId): void;
  completeProjectSuspension(
    suspension: CollabProjectWorkSessionSuspension,
  ): Promise<void>;
  drainProject(projectId: CollabProjectId): Promise<void>;
  resumeProject(suspension: CollabProjectWorkSessionSuspension): Promise<void>;
  suspendProject(
    projectId: CollabProjectId,
  ): Promise<CollabProjectWorkSessionSuspension>;
}

interface CloudBootstrapLocalSuspension {
  readonly admission: ProjectOperationSuspension;
  readonly workSession: CollabProjectWorkSessionSuspension;
}

export const CLOUD_BOOTSTRAP_ADMISSION_RESUME_FAILED_REASON =
  'cloud-bootstrap-admission-resume-failed';

export interface CloudBootstrapLocalFenceOptions {
  readonly admission: CloudBootstrapAdmissionPort;
  readonly workSessions: CloudBootstrapWorkSessionPort;
}

function recoveryRequired(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

export class CloudBootstrapLocalFence {
  private readonly admission: CloudBootstrapAdmissionPort;
  private readonly quiescedProjects = new Set<CollabProjectId>();
  private readonly suspensions = new Map<
    CollabProjectId,
    CloudBootstrapLocalSuspension
  >();
  private readonly workSessions: CloudBootstrapWorkSessionPort;

  constructor(options: CloudBootstrapLocalFenceOptions) {
    this.admission = options.admission;
    this.workSessions = options.workSessions;
  }

  isProjectQuiesced(projectId: CollabProjectId): boolean {
    return this.quiescedProjects.has(projectId);
  }

  async closeAndDrain(projectId: CollabProjectId): Promise<void> {
    let suspension = this.suspensions.get(projectId);
    if (!suspension) {
      const admission = this.admission.suspendProjectAdmission(projectId);
      try {
        const workSession = await this.workSessions.suspendProject(projectId);
        suspension = Object.freeze({ admission, workSession });
        this.suspensions.set(projectId, suspension);
      } catch (error) {
        this.admission.resumeProjectAdmission(admission);
        throw error;
      }
    }
    await this.admission.drainAdmittedOperations();
    this.quiescedProjects.add(projectId);
  }

  async completeAfterActivation(projectId: CollabProjectId): Promise<void> {
    const suspension = this.suspensions.get(projectId);
    this.admission.closeProjectAdmission(projectId);
    if (suspension) {
      await this.workSessions.completeProjectSuspension(suspension.workSession);
    } else {
      this.workSessions.closeProject(projectId);
      await this.workSessions.drainProject(projectId);
    }
    this.suspensions.delete(projectId);
    this.quiescedProjects.add(projectId);
  }

  async resumeAfterCancellation(projectId: CollabProjectId): Promise<void> {
    const suspension = this.suspensions.get(projectId);
    if (!suspension) {
      this.quiescedProjects.delete(projectId);
      return;
    }
    await this.workSessions.resumeProject(suspension.workSession);
    if (!this.admission.resumeProjectAdmission(suspension.admission)) {
      const workSession = await this.workSessions.suspendProject(projectId);
      const admission = this.admission.suspendProjectAdmission(projectId);
      this.suspensions.set(projectId, Object.freeze({ admission, workSession }));
      throw recoveryRequired(CLOUD_BOOTSTRAP_ADMISSION_RESUME_FAILED_REASON);
    }
    this.suspensions.delete(projectId);
    this.quiescedProjects.delete(projectId);
  }
}
