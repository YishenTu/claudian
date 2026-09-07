import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import type {
  GitRepositoryReadSession,
  GitRepositoryService,
} from '@/app/collab/git/GitRepositoryService';
import {
  NativeGitWorkingTreeReviewRepository,
} from '@/app/collab/review/NativeGitWorkingTreeReviewRepository';

const HEAD = '2'.repeat(40);

describe('NativeGitWorkingTreeReviewRepository', () => {
  let repositoryPath: string;

  beforeEach(async () => {
    repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'claudian-working-review-'));
  });

  afterEach(async () => {
    await rm(repositoryPath, { force: true, recursive: true });
  });

  it('reads the old side from the published base and the new side from the working directory', async () => {
    await writeFile(path.join(repositoryPath, 'note.md'), 'working\n');
    const session = readSession([Buffer.from('head\n')]);
    const git = gitService(session);
    const repository = new NativeGitWorkingTreeReviewRepository(
      git,
      new CollabPathPolicy(),
    );
    const file = {
      binary: false,
      kind: 'modified' as const,
      largeForReview: false,
      newBytes: 8,
      path: 'note.md',
      workingTreeContentHash: contentHash('working\n'),
    };

    await expect(repository.readFile(repositoryPath, {
      baseOid: '1'.repeat(40),
      file,
      headOid: HEAD,
      projectId: 'project-a',
      snapshotId: '4'.repeat(64),
    })).resolves.toEqual({
      file: { ...file, newBytes: 8, oldBytes: 5 },
      kind: 'text',
      newText: 'working\n',
      oldText: 'head\n',
    });
    expect(session.readBlobsAtPaths).toHaveBeenCalledWith([{
      repositoryRelativePath: 'note.md',
      treeish: '1'.repeat(40),
    }]);
  });

  it('projects the aggregate diff from the published base to the working result', async () => {
    await writeFile(path.join(repositoryPath, 'note.md'), 'working\n');
    const session = {
      getWorkingTreeState: jest.fn().mockResolvedValue({
        branch: { headOid: HEAD },
        entries: [],
      }),
      listWorkingTreeChangedFiles: jest.fn().mockResolvedValue([{
        kind: 'modified',
        path: 'note.md',
      }]),
    } as unknown as jest.Mocked<GitRepositoryReadSession>;
    const repository = new NativeGitWorkingTreeReviewRepository(
      gitService(session),
      new CollabPathPolicy(),
    );

    await expect(repository.listChanges(
      repositoryPath,
      '1'.repeat(40),
      HEAD,
    )).resolves.toEqual([{
      binary: false,
      kind: 'modified',
      largeForReview: false,
      newBytes: 8,
      path: 'note.md',
      workingTreeContentHash: contentHash('working\n'),
    }]);
    expect(session.listWorkingTreeChangedFiles).toHaveBeenCalledWith('1'.repeat(40));
  });

  it('rejects a symlink instead of following it outside the Project', async () => {
    const outside = path.join(repositoryPath, '..', 'outside-working-review.md');
    await writeFile(outside, 'outside\n');
    await symlink(outside, path.join(repositoryPath, 'note.md'));
    const repository = new NativeGitWorkingTreeReviewRepository(
      gitService(readSession([Buffer.from('head\n')])),
      new CollabPathPolicy(),
    );

    await expect(repository.readFile(repositoryPath, {
      baseOid: '1'.repeat(40),
      file: {
        binary: false,
        kind: 'modified',
        largeForReview: false,
        path: 'note.md',
      },
      headOid: HEAD,
      projectId: 'project-a',
      snapshotId: '4'.repeat(64),
    })).rejects.toMatchObject({ code: 'unsupported-file-type' });

    await rm(outside, { force: true });
  });

  it('rejects working content that no longer matches the captured identity', async () => {
    await writeFile(path.join(repositoryPath, 'note.md'), 'changed\n');
    const repository = new NativeGitWorkingTreeReviewRepository(
      gitService(readSession([Buffer.from('head\n')])),
      new CollabPathPolicy(),
    );

    await expect(repository.readFile(repositoryPath, {
      baseOid: '1'.repeat(40),
      file: {
        binary: false,
        kind: 'modified',
        largeForReview: false,
        newBytes: 8,
        path: 'note.md',
        workingTreeContentHash: contentHash('working\n'),
      },
      headOid: HEAD,
      projectId: 'project-a',
      snapshotId: '4'.repeat(64),
    })).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'working-tree-review-file-content-changed' },
    });
  });
});

function contentHash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function readSession(contents: readonly (Buffer | null)[]) {
  return {
    readBlobsAtPaths: jest.fn().mockResolvedValue(contents),
  } as unknown as jest.Mocked<GitRepositoryReadSession>;
}

function gitService(session: GitRepositoryReadSession): GitRepositoryService {
  return {
    withReadSession: jest.fn(async (_path, _kind, operation) => operation(session)),
  } as unknown as GitRepositoryService;
}
