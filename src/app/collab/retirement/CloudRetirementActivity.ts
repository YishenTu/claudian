import type { CollabProjectId } from '@claudian-collab/protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

import type { CollabProjectActivityAdmission, CollabProjectWorkSuspensionPort } from '../activity/CollabProjectActivity';
import type { CollabProjectWorkSessionSuspension } from '../activity/CollabProjectWorkSession';
import type { ProjectOperationSuspension } from '../ProjectOperationAdmission';
import type { CloudRetirementActivityPort } from './CloudRetirementClient';

type CloudRetirementSuspension = {
  readonly admission: ProjectOperationSuspension;
  readonly workSession: CollabProjectWorkSessionSuspension;
};

export class CloudRetirementActivity implements CloudRetirementActivityPort {
  private readonly suspensions = new Map<CollabProjectId, CloudRetirementSuspension>();

  constructor(
    private readonly admission: CollabProjectActivityAdmission,
    private readonly workSessions: CollabProjectWorkSuspensionPort,
  ) {}

  async complete(projectId: CollabProjectId): Promise<void> {
    const suspension = this.suspensions.get(projectId);
    if (!suspension) return;
    this.suspensions.delete(projectId);
    await this.workSessions.completeProjectSuspension(suspension.workSession);
    this.admission.closeProjectAdmission(projectId);
  }

  async resume(projectId: CollabProjectId): Promise<void> {
    const suspension = this.suspensions.get(projectId);
    if (!suspension) return;
    await this.workSessions.resumeProject(suspension.workSession);
    if (!this.admission.resumeProjectAdmission(suspension.admission)) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['retry', 'open-diagnostics'],
        safeContext: { reason: 'cloud-retirement-admission-resume-failed' },
      });
    }
    this.suspensions.delete(projectId);
  }

  async suspend(projectId: CollabProjectId): Promise<void> {
    if (this.suspensions.has(projectId)) return;
    const admission = this.admission.suspendProjectAdmission(projectId);
    try {
      const workSession = await this.workSessions.suspendProject(projectId);
      this.suspensions.set(projectId, { admission, workSession });
    } catch (error) {
      this.admission.resumeProjectAdmission(admission);
      throw error;
    }
  }
}
