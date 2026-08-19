import type {
  PublishProjectContext,
  PublishProjectPort,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import {
  type WorkingTreeReviewFilePort,
  WorkingTreeReviewService,
} from '@/app/collab/review/WorkingTreeReviewService';

const HEAD = '2'.repeat(40);
const BASE = '1'.repeat(40);

describe('WorkingTreeReviewService', () => {
  it('derives a local review through read-only ports', async () => {
    const projects = projectPort();
    const snapshots = snapshotPort(snapshot());
    const files = reviewFiles();
    const service = new WorkingTreeReviewService(projects, snapshots, files);

    await expect(service.prepare('project-a', BASE)).resolves.toMatchObject({
      baseOid: BASE,
      files: [{ kind: 'modified', path: 'note.md' }],
      headOid: HEAD,
      kind: 'working-tree',
      projectId: 'project-a',
      snapshotId: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    expect(projects.load).toHaveBeenCalledTimes(1);
    expect(snapshots.inspect).toHaveBeenCalledTimes(1);
    expect(files.listChanges).toHaveBeenCalledWith(
      '/vault/workspace/project-a',
      BASE,
      HEAD,
      undefined,
    );
    expect(files.readFile).not.toHaveBeenCalled();
  });

  it('rejects a file read when the working tree changed after review preparation', async () => {
    const projects = projectPort();
    const snapshots = snapshotPort(snapshot());
    const files = reviewFiles();
    const service = new WorkingTreeReviewService(projects, snapshots, files);
    const review = await service.prepare('project-a', BASE);
    snapshots.inspect.mockResolvedValue(snapshot({ modifiedAtMs: 11 }));

    await expect(service.readFile({
      baseOid: review.baseOid,
      file: review.files[0],
      headOid: review.headOid,
      projectId: review.projectId,
      snapshotId: review.snapshotId,
    })).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'working-tree-review-stale' },
    });
    expect(files.readFile).not.toHaveBeenCalled();
  });
});

function reviewFiles(): jest.Mocked<WorkingTreeReviewFilePort> {
  return {
    listChanges: jest.fn().mockResolvedValue([{
      binary: false,
      kind: 'modified',
      largeForReview: false,
      path: 'note.md',
    }]),
    readFile: jest.fn(),
  };
}

function projectPort(): jest.Mocked<PublishProjectPort> {
  return {
    load: jest.fn().mockResolvedValue({
      allowHostRemoteRepair: false,
      memberId: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
      remoteUrl: 'https://192.168.1.20/repository.git',
      repositoryPath: '/vault/workspace/project-a',
    } satisfies PublishProjectContext),
    revalidate: jest.fn(),
  };
}

function snapshot(
  changed: { readonly modifiedAtMs?: number } = {},
): PublishRepositorySnapshot {
  return {
    acceptedMainOid: '1'.repeat(40),
    changedFiles: [{
      modifiedAtMs: changed.modifiedAtMs ?? 10,
      path: 'note.md',
      size: 8,
      status: 'modified',
    }],
    headOid: HEAD,
    includesAcceptedMain: true,
    personalAheadBy: 0,
    personalBehindBy: 0,
    personalRemoteOid: HEAD,
    workingTreeClean: false,
  };
}

function snapshotPort(initial: PublishRepositorySnapshot) {
  return { inspect: jest.fn().mockResolvedValue(initial) };
}
