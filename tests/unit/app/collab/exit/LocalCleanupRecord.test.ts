import {
  COLLAB_LOCAL_CLEANUP_SCHEMA_VERSION,
  decodeLocalCleanupRecord,
  type LocalCleanupRecord,
} from '@/app/collab/exit/LocalCleanupRecord';

const record: LocalCleanupRecord = {
  schemaVersion: COLLAB_LOCAL_CLEANUP_SCHEMA_VERSION,
  kind: 'local-cleanup',
  projectId: 'project-alpha',
  memberId: 'member-alice',
  operationId: 'cleanup-one',
  workspacePath: 'workspace/project-alpha',
  choice: 'keep-files',
  purpose: 'leave',
  phase: 'planned',
  markerNonce: 'A'.repeat(43),
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('LocalCleanupRecord', () => {
  it('round-trips operation-bound relative cleanup identity', () => {
    expect(decodeLocalCleanupRecord(record)).toEqual(record);
  });

  it.each(['git-detaching', 'marker-removing', 'choice-applied'] as const)(
    'accepts the durable %s recovery checkpoint',
    phase => {
      expect(decodeLocalCleanupRecord({ ...record, phase })).toMatchObject({ phase });
    },
  );

  it.each([
    { ...record, absolutePath: '/Users/alice/project' },
    { ...record, workspacePath: '/Users/alice/project' },
    { ...record, workspacePath: '../project-alpha' },
    { ...record, markerNonce: 'too-short' },
    { ...record, phase: 'recovery-required' },
  ])('rejects unsafe cleanup state', value => {
    expect(() => decodeLocalCleanupRecord(value)).toThrow(TypeError);
  });
});
