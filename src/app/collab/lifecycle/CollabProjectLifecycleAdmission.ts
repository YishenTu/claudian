import { type CollabProjectId } from '@claudian-collab/protocol';

export type CollabProjectLifecycleAdmission = (
  projectId: CollabProjectId,
  operation: () => Promise<void>,
) => Promise<void>;

export type CollabProjectLifecycleAuthorityAdmission = <T>(
  projectId: CollabProjectId,
  operation: () => Promise<T>,
) => Promise<T>;
