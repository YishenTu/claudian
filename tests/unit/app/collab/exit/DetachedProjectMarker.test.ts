import {
  COLLAB_DETACHED_PROJECT_MARKER_SCHEMA_VERSION,
  decodeDetachedProjectMarker,
  type DetachedProjectMarker,
} from '@/app/collab/exit/DetachedProjectMarker';

const marker: DetachedProjectMarker = {
  schemaVersion: COLLAB_DETACHED_PROJECT_MARKER_SCHEMA_VERSION,
  projectId: 'project-alpha',
  memberId: 'member-alice',
  cleanupOperationId: 'cleanup-one',
  purpose: 'retire',
  createdAt: '2026-08-13T00:00:00.000Z',
  nonce: 'A'.repeat(43),
};

describe('DetachedProjectMarker', () => {
  it('round-trips the exact private-record identity', () => {
    expect(decodeDetachedProjectMarker(marker)).toEqual(marker);
  });

  it.each([
    { ...marker, path: 'workspace/project-alpha' },
    { ...marker, nonce: 'short' },
    { ...marker, cleanupOperationId: '../cleanup' },
  ])('rejects forged marker state', value => {
    expect(() => decodeDetachedProjectMarker(value)).toThrow(TypeError);
  });
});
