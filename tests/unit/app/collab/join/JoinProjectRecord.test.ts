import {
  COLLAB_JOIN_PROJECT_SCHEMA_VERSION,
  decodeJoinProjectRecord,
  type JoinProjectRecord,
} from '@/app/collab/join/JoinProjectRecord';

const baseRecord: JoinProjectRecord = {
  createdAt: '2026-08-08T00:00:00.000Z',
  encodedInvitation: 'claudian-collab:v2:payload',
  endpoint: 'https://192.168.1.10:54545',
  hostCaCertificatePem: null,
  hostCaFingerprint: 'ab'.repeat(32),
  joinAttemptId: 'join-alpha',
  memberCredential: null,
  memberDisplayName: 'Alice',
  memberId: null,
  memberRole: null,
  membershipExpiresAt: null,
  operationKind: 'join-project',
  operationId: 'join-alpha',
  phase: 'planned',
  projectId: 'project-alpha',
  projectName: null,
  projectsFolder: 'Shared/Collab Projects',
  schemaVersion: COLLAB_JOIN_PROJECT_SCHEMA_VERSION,
  slug: 'project-alpha',
  stagingDirectoryName: '.claudian-join-join-alpha',
  lastEventSequence: null,
  updatedAt: '2026-08-08T00:00:00.000Z',
};

describe('JoinProjectRecord', () => {
  it('decodes each durable phase and tolerates unknown fields', () => {
    const trusted = {
      ...baseRecord,
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n',
      phase: 'trusted' as const,
      unknown: true,
    };
    const membership = {
      ...trusted,
      encodedInvitation: null,
      memberCredential: Buffer.alloc(32, 4).toString('base64url'),
      memberId: 'member-alice',
      membershipExpiresAt: '2026-08-08T00:30:00.000Z',
      phase: 'membership-created' as const,
    };
    const activated = {
      ...membership,
      lastEventSequence: 4,
      memberRole: 'member' as const,
      phase: 'activated' as const,
      projectName: 'Alpha',
    };

    expect(decodeJoinProjectRecord(baseRecord)).toEqual(baseRecord);
    expect(decodeJoinProjectRecord(trusted)).toEqual(expect.objectContaining({
      phase: 'trusted',
    }));
    expect(decodeJoinProjectRecord(membership)).toEqual(expect.objectContaining({
      encodedInvitation: null,
      memberId: 'member-alice',
      phase: 'membership-created',
    }));
    expect(decodeJoinProjectRecord(activated)).toEqual(expect.objectContaining({
      lastEventSequence: 4,
      memberRole: 'member',
      phase: 'activated',
      projectName: 'Alpha',
    }));
  });

  it.each([
    { ...baseRecord, projectId: '../project' },
    { ...baseRecord, slug: 'nested/project' },
    { ...baseRecord, stagingDirectoryName: 'project-alpha' },
    { ...baseRecord, phase: 'trusted', hostCaCertificatePem: null },
    { ...baseRecord, phase: 'membership-created', hostCaCertificatePem: 'x' },
    { ...baseRecord, encodedInvitation: null },
    { ...baseRecord, updatedAt: 'not-a-date' },
  ])('rejects corrupt or phase-incomplete records', value => {
    expect(() => decodeJoinProjectRecord(value)).toThrow();
  });

  it('maps a version-1 record to the historical workspace root', () => {
    expect(decodeJoinProjectRecord({
      ...baseRecord,
      projectsFolder: undefined,
      schemaVersion: 1,
    })).toEqual(expect.objectContaining({
      legacyJoinRecord: true,
      projectsFolder: 'workspace',
      schemaVersion: COLLAB_JOIN_PROJECT_SCHEMA_VERSION,
    }));
  });
});
