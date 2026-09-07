import type { CollabProjectId } from '@claudian-collab/protocol';

import type { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  type CollabRequestDraftRecord,
  decodeCollabRequestDraftRecord,
} from '@/app/collab/publish/CollabRequestDraftRecord';

export class CollabRequestDraftStore {
  constructor(
    private readonly projects: Pick<
      CollabLocalProjectRepository,
      'loadProjectDocument' | 'removeProjectDocument' | 'saveProjectDocument'
    >,
  ) {}

  load(projectId: CollabProjectId): Promise<CollabRequestDraftRecord | null> {
    return this.projects.loadProjectDocument(
      projectId,
      'request-draft',
      decodeCollabRequestDraftRecord,
    );
  }

  save(record: CollabRequestDraftRecord): Promise<void> {
    return this.projects.saveProjectDocument(
      record.projectId,
      'request-draft',
      decodeCollabRequestDraftRecord(record),
    );
  }

  remove(projectId: CollabProjectId): Promise<boolean> {
    return this.projects.removeProjectDocument(projectId, 'request-draft');
  }
}
