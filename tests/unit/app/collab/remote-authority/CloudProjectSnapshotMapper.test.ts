import {
  decodeCloudAuthorityProjectSnapshot,
  decodeCloudProjectSnapshotCache,
} from '@/app/collab/remote-authority/CloudProjectSnapshotMapper';

const member = {
  activatedAt: '2026-08-31T00:00:00.000Z',
  createdAt: '2026-08-31T00:00:00.000Z',
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
    createdAt: '2026-08-31T00:00:00.000Z',
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
  createdAt: '2026-08-31T00:00:00.000Z',
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
