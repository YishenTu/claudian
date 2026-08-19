import type { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import type { LocalPublishProjectPort } from '@/app/collab/publish/LocalPublishProjectPort';
import { LocalReviewProjectPort } from '@/app/collab/review/LocalReviewProjectPort';

describe('LocalReviewProjectPort', () => {
  it('adds the current membership role to the validated publish context', async () => {
    const publish = publishPort();
    const projects = projectRepository(membership('manager'));
    const port = new LocalReviewProjectPort(publish, projects);

    await expect(port.load('project-a')).resolves.toEqual({
      ...publishContext(),
      role: 'manager',
    });
  });

  it('rejects a role change during revalidation', async () => {
    const publish = publishPort();
    const projects = projectRepository(membership('member'));
    const port = new LocalReviewProjectPort(publish, projects);

    await expect(port.revalidate({
      ...publishContext(),
      role: 'manager',
    })).rejects.toMatchObject({ code: 'stale-project-selection' });
    expect(publish.revalidate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
    }));
  });
});

function publishContext() {
  return {
    allowHostRemoteRepair: false,
    memberId: 'member-reviewer',
    personalRef: 'refs/heads/members/member-reviewer',
    projectId: 'project-a',
    remoteUrl: 'https://192.168.1.20/repository.git',
    repositoryPath: '/vault/workspace/project-a',
  };
}

function publishPort() {
  return {
    load: jest.fn().mockResolvedValue(publishContext()),
    revalidate: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<LocalPublishProjectPort>;
}

function membership(role: 'manager' | 'member') {
  return {
    authority: {
      endpoint: 'https://192.168.1.20',
      gitRemoteUrl: 'https://192.168.1.20/repository.git',
      hostCaCertificatePem: 'certificate',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan' as const,
    },
    createdAt: '2026-08-08T00:00:00.000Z',
    hostOwnership: { ownsAuthority: false },
    lastEventSequence: 0,
    member: {
      credential: 'secret',
      displayName: 'Reviewer',
      id: 'member-reviewer',
      personalRef: 'refs/heads/members/member-reviewer',
      role,
    },
    project: {
      id: 'project-a',
      name: 'Project A',
      workspacePath: 'workspace/project-a',
    },
    schemaVersion: 1 as const,
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
}

function projectRepository(value: ReturnType<typeof membership>) {
  return {
    loadMembership: jest.fn().mockResolvedValue(value),
  } as unknown as jest.Mocked<CollabLocalProjectRepository>;
}
