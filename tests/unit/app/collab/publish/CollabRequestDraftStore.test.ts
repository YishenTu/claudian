import {
  COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
  type CollabRequestDraftRecord,
  decodeCollabRequestDraftRecord,
} from '@/app/collab/publish/CollabRequestDraftRecord';
import { CollabRequestDraftStore } from '@/app/collab/publish/CollabRequestDraftStore';

const CREATED_AT = '2026-08-10T00:00:00.000Z';

describe('CollabRequestDraftStore', () => {
  it('persists one private description draft without relation or secret fields', async () => {
    const documents = new Map<string, unknown>();
    const projects = {
      loadProjectDocument: jest.fn(async (
        projectId: string,
        kind: string,
        decode: (value: unknown) => CollabRequestDraftRecord,
      ) => {
        const value = documents.get(`${projectId}:${kind}`);
        return value === undefined ? null : decode(value);
      }),
      removeProjectDocument: jest.fn(async (projectId: string, kind: string) => (
        documents.delete(`${projectId}:${kind}`)
      )),
      saveProjectDocument: jest.fn(async (
        projectId: string,
        kind: string,
        value: unknown,
      ) => {
        documents.set(`${projectId}:${kind}`, value);
      }),
    };
    const store = new CollabRequestDraftStore(projects as never);
    const draft = record();

    await store.save(draft);
    await expect(store.load('project-a')).resolves.toEqual(draft);
    expect(projects.saveProjectDocument).toHaveBeenCalledWith(
      'project-a',
      'request-draft',
      draft,
    );
    await expect(store.remove('project-a')).resolves.toBe(true);
    await expect(store.load('project-a')).resolves.toBeNull();
  });

  it('fails closed on malformed, extra, secret, and relation selection state', () => {
    expect(() => decodeCollabRequestDraftRecord({
      ...record(),
      credential: 'secret',
    })).toThrow();
    expect(() => decodeCollabRequestDraftRecord({
      ...record(),
      description: '   ',
    })).toThrow();
    expect(() => decodeCollabRequestDraftRecord({
      ...record(),
      relations: [{ kind: 'resolves', ticketId: 'ticket-a' }],
    })).toThrow();
    expect(() => decodeCollabRequestDraftRecord({
      ...record(),
      targetHeadOid: '/vault/private/note.md',
    })).toThrow();
    expect(() => decodeCollabRequestDraftRecord({
      ...record(),
      baseRequestRevision: -1,
    })).toThrow();
  });

  it('accepts the zero revision used by migrated requests', () => {
    expect(decodeCollabRequestDraftRecord({
      ...record(),
      baseRequestRevision: 0,
    })).toMatchObject({ baseRequestRevision: 0 });
  });
});

function record(): CollabRequestDraftRecord {
  return {
    baseRequestRevision: 2,
    createdAt: CREATED_AT,
    description: 'Resolves #17',
    projectId: 'project-a',
    requestId: 'request-a',
    schemaVersion: COLLAB_REQUEST_DRAFT_SCHEMA_VERSION,
    syncState: 'local',
    targetHeadOid: 'a'.repeat(40),
    updatedAt: CREATED_AT,
  };
}
