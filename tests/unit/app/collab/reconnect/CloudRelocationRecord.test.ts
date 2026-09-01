import { decodeCloudRelocationRecord } from '@/app/collab/reconnect/CloudRelocationRecord';

const CREATED_AT = '2026-09-01T00:00:00.000Z';

function record() {
  return {
    authorityGeneration: 4,
    createdAt: CREATED_AT,
    memberId: 'member-manager',
    newAuthority: {
      bindingVersion: 3,
      gitRemoteUrl: 'http://new.example.test/operator/v3/v3/projects/project-cloud/repository.git',
      serverUrl: 'http://new.example.test/operator/v3',
      wireVersion: 7,
    },
    oldAuthority: {
      bindingVersion: 3,
      gitRemoteUrl: 'https://old.example.test/root/v3/projects/project-cloud/repository.git',
      serverUrl: 'https://old.example.test/root',
      wireVersion: 7,
    },
    operationId: 'relocate-cloud-one',
    operationKind: 'cloud-relocation' as const,
    personalRef: 'refs/heads/members/member-manager',
    phase: 'prepared' as const,
    projectId: 'project-cloud',
    schemaVersion: 1 as const,
    updatedAt: CREATED_AT,
  };
}

describe('CloudRelocationRecord', () => {
  it('round-trips exact prefix-preserving Cloud bindings and durable phases', () => {
    expect(decodeCloudRelocationRecord(record())).toEqual(record());
    expect(decodeCloudRelocationRecord({
      ...record(),
      phase: 'origin-updated',
    })).toEqual({ ...record(), phase: 'origin-updated' });
    expect(decodeCloudRelocationRecord({
      ...record(),
      phase: 'membership-updated',
    })).toEqual({ ...record(), phase: 'membership-updated' });
  });

  it.each([
    { ...record(), schemaVersion: 2 },
    { ...record(), cloudDevelopmentActorId: 'principal-device' },
    { ...record(), authorityGeneration: 0 },
    { ...record(), personalRef: 'refs/heads/members/member-other' },
    { ...record(), newAuthority: { ...record().newAuthority, bindingVersion: 2 } },
    { ...record(), newAuthority: { ...record().newAuthority, wireVersion: 6 } },
    { ...record(), newAuthority: { ...record().newAuthority, gitRemoteUrl: 'http://new.example.test/v1/projects/project-cloud/repository.git' } },
    { ...record(), newAuthority: record().oldAuthority },
    { ...record(), updatedAt: '2025-01-01T00:00:00.000Z' },
  ])('rejects incompatible, identity-changing, or reconstructed state', value => {
    expect(() => decodeCloudRelocationRecord(value)).toThrow(TypeError);
  });
});
