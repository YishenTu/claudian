import {
  COLLAB_PENDING_LEAVE_SCHEMA_VERSION,
  decodePendingLeaveRecord,
  type PendingLeaveRecord,
} from '@/app/collab/exit/PendingLeaveRecord';

const record: PendingLeaveRecord = {
  schemaVersion: COLLAB_PENDING_LEAVE_SCHEMA_VERSION,
  kind: 'pending-leave',
  projectId: 'project-alpha',
  memberId: 'member-alice',
  operationId: 'leave-one',
  idempotencyKey: 'leave-one',
  authorityReplay: null,
  cleanupChoice: 'keep-files',
  cleanupMarkerNonce: 'n'.repeat(43),
  localCleanupComplete: false,
  localRole: 'member',
  phase: 'queued',
  memberCredential: 'A'.repeat(43),
  hostEndpoint: 'https://192.168.1.20:54545',
  hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
  hostCaFingerprint: 'a'.repeat(64),
  projectCreatedAt: '2026-08-12T00:00:00.000Z',
  projectName: 'Alpha',
  workspacePath: 'workspace/project-alpha',
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('PendingLeaveRecord', () => {
  it('strictly round-trips the minimum authority settlement state', () => {
    expect(decodePendingLeaveRecord(record)).toEqual(record);
  });

  it('migrates schema 1 Manager identity into private fingerprint continuity material', () => {
    expect(decodePendingLeaveRecord({
      ...record,
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        expectedManagerMemberId: 'member-manager',
        managerResponsibilityOfferId: 'offer-one',
      },
      schemaVersion: 1,
    })).toEqual({
      ...record,
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        idempotencyManagerMemberId: 'member-manager',
        managerResponsibilityOfferId: 'offer-one',
      },
      schemaVersion: 2,
    });
  });

  it.each([
    { ...record, future: true },
    { ...record, projectId: '../escape' },
    { ...record, hostEndpoint: '/Users/alice/private' },
    { ...record, memberCredential: 'short' },
    { ...record, authorityReplay: { expectedHostMemberId: 'member-host' } },
    {
      ...record,
      authorityReplay: {
        expectedHostMemberId: 'member-host',
        expectedManagerMemberId: 'member-manager',
        idempotencyManagerMemberId: 'member-manager',
        managerResponsibilityOfferId: null,
      },
    },
    { ...record, workspacePath: '../escape/project-alpha' },
    { ...record, updatedAt: 'yesterday' },
  ])('rejects corrupt or unsafe state', value => {
    expect(() => decodePendingLeaveRecord(value)).toThrow(TypeError);
  });
});
