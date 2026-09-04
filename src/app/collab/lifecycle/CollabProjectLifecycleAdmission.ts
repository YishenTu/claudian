import { type CollabMemberId, type CollabProjectId } from '@claudian-collab/protocol';

export type CollabProjectLifecycleAdmission = (
  projectId: CollabProjectId,
  operation: () => Promise<void>,
) => Promise<void>;

export type CollabProjectLifecycleAuthorityAdmission = <T>(
  projectId: CollabProjectId,
  operation: () => Promise<T>,
) => Promise<T>;

export interface CollabImportedClaimManagementIdentity {
  readonly actorMemberId: CollabMemberId;
  readonly authorityGeneration: number;
  readonly importedMemberId: CollabMemberId;
}

export type CollabProjectLifecycleImportedClaimAdmission = <T>(
  projectId: CollabProjectId,
  identity: CollabImportedClaimManagementIdentity,
  operation: () => Promise<T>,
) => Promise<T>;
