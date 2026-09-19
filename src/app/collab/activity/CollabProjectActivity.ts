import type { CollabProjectId } from '@claudian-collab/protocol';

import type { ProjectOperationSuspension } from '../ProjectOperationAdmission';
import type { CollabProjectWorkSessionSuspension } from './CollabProjectWorkSession';

export interface CollabProjectActivityAdmission {
  closeProjectAdmission(projectId: CollabProjectId): void;
  drainAdmittedOperations(projectId: CollabProjectId): Promise<void>;
  resumeProjectAdmission(suspension: ProjectOperationSuspension): boolean;
  suspendProjectAdmission(projectId: CollabProjectId): ProjectOperationSuspension;
}

export interface CollabProjectWorkSuspensionPort {
  completeProjectSuspension(suspension: CollabProjectWorkSessionSuspension): Promise<void>;
  resumeProject(suspension: CollabProjectWorkSessionSuspension): Promise<void>;
  suspendProject(projectId: CollabProjectId): Promise<CollabProjectWorkSessionSuspension>;
}
