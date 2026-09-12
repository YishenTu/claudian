import {
  type CloudPendingLeaveRecord,
  COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION,
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

  it('strictly separates a queued Cloud Leave from its frozen submitted request', () => {
    const queued: CloudPendingLeaveRecord = {
      authorityGeneration: 4,
      authorityKind: 'cloud',
      cleanupChoice: 'delete-files',
      cleanupMarkerNonce: 'q'.repeat(43),
      createdAt: '2026-08-13T00:00:00.000Z',
      idempotencyKey: 'leave-cloud-one',
      kind: 'pending-leave',
      localCleanupComplete: true,
      localRole: 'member',
      memberId: 'member-alice',
      operationId: 'leave-cloud-one',
      personalRef: 'refs/heads/members/member-alice',
      phase: 'queued',
      projectCreatedAt: '2026-08-12T00:00:00.000Z',
      projectId: 'project-alpha',
      projectName: 'Alpha',
      request: null,
      schemaVersion: COLLAB_CLOUD_PENDING_LEAVE_SCHEMA_VERSION,
      serverUrl: 'http://127.0.0.1:8787/cloud/prefix',
      updatedAt: '2026-08-13T00:00:00.000Z',
      workspacePath: 'workspace/project-alpha',
    };

    expect(decodePendingLeaveRecord(queued)).toEqual(queued);
    expect(decodePendingLeaveRecord({
      ...queued,
      phase: 'submitted',
      request: {
        expectedManagerSetGeneration: 7,
        expectedMembershipRevision: 9,
        expectedOfferRevision: null,
        expectedPersonalRefOid: 'a'.repeat(40),
        idempotencyKey: 'leave-cloud-one',
        managerResponsibilityOfferId: null,
        projectId: 'project-alpha',
      },
    })).toEqual(expect.objectContaining({
      authorityKind: 'cloud',
      phase: 'submitted',
      request: expect.objectContaining({
        expectedMembershipRevision: 9,
        idempotencyKey: 'leave-cloud-one',
      }),
    }));
  });

  it.each([
    { phase: 'submitted', request: null },
    {
      phase: 'queued',
      request: {
        expectedManagerSetGeneration: 7,
        expectedMembershipRevision: 9,
        expectedOfferRevision: null,
        expectedPersonalRefOid: 'a'.repeat(40),
        idempotencyKey: 'leave-cloud-one',
        managerResponsibilityOfferId: null,
        projectId: 'project-alpha',
      },
    },
  ])('rejects an incoherent Cloud Leave durable state', patch => {
    const queued = {
      authorityGeneration: 4,
      authorityKind: 'cloud',
      cleanupChoice: 'keep-files',
      cleanupMarkerNonce: 'q'.repeat(43),
      createdAt: '2026-08-13T00:00:00.000Z',
      idempotencyKey: 'leave-cloud-one',
      kind: 'pending-leave',
      localCleanupComplete: false,
      localRole: 'member',
      memberId: 'member-alice',
      operationId: 'leave-cloud-one',
      personalRef: 'refs/heads/members/member-alice',
      phase: 'queued',
      projectCreatedAt: '2026-08-12T00:00:00.000Z',
      projectId: 'project-alpha',
      projectName: 'Alpha',
      request: null,
      schemaVersion: 3,
      serverUrl: 'https://cloud.example.test/base',
      updatedAt: '2026-08-13T00:00:00.000Z',
      workspacePath: 'workspace/project-alpha',
    };
    expect(() => decodePendingLeaveRecord({ ...queued, ...patch })).toThrow(TypeError);
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
