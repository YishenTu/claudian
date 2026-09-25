import { testTime } from '@test/helpers/testClock';

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
  createdAt: testTime({ days: -14 }),
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
