import type { CollabLocalCloudMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { CollabAuthoritySessionFactory } from '@/app/collab/remote-authority/CollabAuthoritySessionFactory';

function cloudMembership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      bindingVersion: 2,
      developmentActorId: 'member-alice',
      gitRemoteUrl: 'https://cloud.example.test/v2/projects/project-cloud/repository.git',
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test',
      wireVersion: 6,
    },
    createdAt: '2026-08-22T00:00:00.000Z',
    lastEventSequence: 0,
    lifecycle: 'active',
    member: {
      displayName: 'Alice',
      id: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      role: 'manager',
    },
    project: {
      id: 'project-cloud',
      name: 'Cloud Project',
      workspacePath: 'workspace/project-cloud',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

describe('CollabAuthoritySessionFactory', () => {
  it('dispatches a deeply frozen membership without retaining a session registry', async () => {
    const session = { dispose: jest.fn() } as never;
    const cloud = {
      authorityKind: 'cloud' as const,
      create: jest.fn(async record => {
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record.authority)).toBe(true);
        expect(Object.isFrozen(record.member)).toBe(true);
        return session;
      }),
    };
    const factory = new CollabAuthoritySessionFactory([
      { authorityKind: 'lan', create: jest.fn() },
      cloud,
    ]);

    await expect(factory.create(cloudMembership())).resolves.toBe(session);
    await expect(factory.create(cloudMembership())).resolves.toBe(session);
    expect(cloud.create).toHaveBeenCalledTimes(2);
  });
});
