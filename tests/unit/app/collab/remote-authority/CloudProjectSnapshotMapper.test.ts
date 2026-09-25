import { testTime } from '@test/helpers/testClock';

import {
  decodeCloudAuthorityProjectSnapshot,
  decodeCloudProjectSnapshotCache,
} from '@/app/collab/remote-authority/CloudProjectSnapshotMapper';

const member = {
  activatedAt: testTime({ days: 4 }),
  createdAt: testTime({ days: 4 }),
  displayName: 'Member',
  id: 'member-current',
  personalRef: 'refs/heads/members/member-current',
  role: 'manager',
  status: 'active',
};
const snapshot = {
  currentMember: member,
  eventSequence: 0,
  members: [member],
  openRequests: [],
  openTicketCount: 0,
  project: {
    authorityGeneration: 7,
    createdAt: testTime({ days: 4 }),
    expectedMainOid: 'a'.repeat(40),
    id: 'project-current',
    mainRef: 'refs/heads/main',
    name: 'Project',
  },
  ticketHighlights: [],
};
const localProject = {
  authorityGeneration: 7,
  authorityKind: 'cloud',
  createdAt: testTime({ days: 4 }),
  id: 'project-current',
  mainOid: 'a'.repeat(40),
  mainRef: 'refs/heads/main',
  name: 'Project',
};

describe('CloudProjectSnapshotMapper', () => {
  it('preserves the authoritative generation in the client projection', () => {
    expect(decodeCloudAuthorityProjectSnapshot(snapshot).project).toEqual(localProject);
  });

  it('restores the same generation through the canonical cache decoder', () => {
    expect(decodeCloudProjectSnapshotCache({ ...snapshot, project: localProject }).project)
      .toEqual(localProject);
  });

  it('rejects a cache without current generation evidence', () => {
    const { authorityGeneration: _generation, ...oldProject } = localProject;
    expect(() => decodeCloudProjectSnapshotCache({ ...snapshot, project: oldProject })).toThrow();
  });
});
