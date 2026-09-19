import type { CollabProjectId } from '@claudian-collab/protocol';

import { type CollabOperationOptions, isCollabCloudProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

import type { CollabProjectActivityAdmission, CollabProjectWorkSuspensionPort } from '../activity/CollabProjectActivity';
import type { CollabProjectWorkSessionSuspension } from '../activity/CollabProjectWorkSession';
import { type CollabLocalProjectRepository, isCollabLocalCloudMembership } from '../CollabLocalProjectRepository';
import type { ProjectOperationSuspension } from '../ProjectOperationAdmission';
import type { CollabPublicationService } from '../publish/CollabPublicationService';
import type { CloudRelocationActivityPort } from './ReconnectProjectCoordinator';

type CloudRelocationSuspension = {
  readonly admission: ProjectOperationSuspension;
  workSession: CollabProjectWorkSessionSuspension | null;
};

export class CloudRelocationActivity implements CloudRelocationActivityPort {
  private readonly suspensions = new Map<CollabProjectId, CloudRelocationSuspension>();

  constructor(
    private readonly admission: CollabProjectActivityAdmission,
    private readonly workSessions: CollabProjectWorkSuspensionPort & Pick<CollabPublicationService, 'resetProjectConnection' | 'readAuthoritySnapshot'>,
    private readonly projects: Pick<CollabLocalProjectRepository, 'loadMembership'>,
  ) {}

  async activate(
    projectId: CollabProjectId,
    operationOptions: CollabOperationOptions = {},
  ): Promise<void> {
    const suspension = this.suspensions.get(projectId);
    if (!suspension) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume', 'open-diagnostics'],
        safeContext: { reason: 'cloud-relocation-suspension-missing' },
      });
    }
    if (suspension.workSession) {
      await this.workSessions.resumeProject(suspension.workSession);
      suspension.workSession = null;
    }
    this.workSessions.resetProjectConnection(projectId);
    const [membership, authoritySnapshot] = await Promise.all([
      this.projects.loadMembership(projectId),
      this.workSessions.readAuthoritySnapshot(projectId, operationOptions),
    ]);
    const snapshot = authoritySnapshot.snapshot;
    if (
      !membership
      || !isCollabLocalCloudMembership(membership)
      || !isCollabCloudProjectSnapshot(snapshot)
      || snapshot.project.id !== membership.project.id
      || snapshot.project.authorityGeneration
        !== membership.authority.authorityGeneration
      || snapshot.currentMember.id !== membership.member.id
      || snapshot.currentMember.personalRef !== membership.member.personalRef
      || snapshot.currentMember.status !== 'active'
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'cloud-relocation-activation-mismatch' },
      });
    }
  }

  async resume(projectId: CollabProjectId): Promise<void> {
    const suspension = this.suspensions.get(projectId);
    if (!suspension) return;
    if (suspension.workSession) {
      await this.workSessions.resumeProject(suspension.workSession);
    }
    if (!this.admission.resumeProjectAdmission(suspension.admission)) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume', 'open-diagnostics'],
        safeContext: { reason: 'cloud-relocation-admission-resume-failed' },
      });
    }
    this.suspensions.delete(projectId);
  }

  async suspend(projectId: CollabProjectId): Promise<void> {
    if (this.suspensions.has(projectId)) return;
    const admission = this.admission.suspendProjectAdmission(projectId);
    try {
      await this.admission.drainAdmittedOperations(projectId);
      const workSession = await this.workSessions.suspendProject(projectId);
      this.suspensions.set(projectId, { admission, workSession });
    } catch (error) {
      this.admission.resumeProjectAdmission(admission);
      throw error;
    }
  }
}
