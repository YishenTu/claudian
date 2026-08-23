import { type CollabProjectId } from '@claudian-collab/protocol';

import type { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  type CollabPublicationStateRecord,
  decodeCollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function stateError(projectId: CollabProjectId, reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    recoveryActions: ['open-diagnostics'],
    safeContext: { projectId, reason },
  });
}

export class CollabPublicationStateStore {
  constructor(
    private readonly projects: Pick<
      CollabLocalProjectRepository,
      'loadProjectDocument' | 'saveProjectDocument'
    >,
  ) {}

  async load(projectId: CollabProjectId): Promise<CollabPublicationStateRecord> {
    const record = await this.projects.loadProjectDocument(
      projectId,
      'publication-state',
      decodeCollabPublicationStateRecord,
    );
    if (!record) throw stateError(projectId, 'publication-state-missing');
    if (record.projectId !== projectId) {
      throw stateError(projectId, 'publication-state-project-mismatch');
    }
    return record;
  }

  save(record: CollabPublicationStateRecord): Promise<void> {
    return this.projects.saveProjectDocument(
      record.projectId,
      'publication-state',
      decodeCollabPublicationStateRecord(record),
    );
  }
}
