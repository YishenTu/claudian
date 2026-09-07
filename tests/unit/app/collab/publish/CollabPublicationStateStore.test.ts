import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  type CollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import { CollabPublicationStateStore } from '@/app/collab/publish/CollabPublicationStateStore';

const RECORD: CollabPublicationStateRecord = {
  baseMainOid: '1'.repeat(40),
  operation: null,
  projectId: 'project-a',
  schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  updatedAt: '2026-08-09T00:00:00.000Z',
};

describe('CollabPublicationStateStore', () => {
  it('loads and saves only the publication-state document', async () => {
    const projects = {
      loadProjectDocument: jest.fn(async (_projectId, _kind, decode) => decode(RECORD)),
      saveProjectDocument: jest.fn(async () => undefined),
    };
    const store = new CollabPublicationStateStore(projects as never);

    await expect(store.load('project-a')).resolves.toEqual(RECORD);
    await store.save(RECORD);

    expect(projects.loadProjectDocument).toHaveBeenCalledWith(
      'project-a',
      'publication-state',
      expect.any(Function),
    );
    expect(projects.saveProjectDocument).toHaveBeenCalledWith(
      'project-a',
      'publication-state',
      RECORD,
    );
  });

  it('fails closed when required publication state is missing', async () => {
    const store = new CollabPublicationStateStore({
      loadProjectDocument: jest.fn(async () => null),
      saveProjectDocument: jest.fn(async () => undefined),
    } as never);

    await expect(store.load('project-a')).rejects.toMatchObject({
      code: 'repository-invalid',
      safeContext: { reason: 'publication-state-missing' },
    });
  });
});
