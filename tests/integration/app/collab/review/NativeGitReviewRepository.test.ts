import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CollabRequestDetail } from '@claudian-collab/protocol';
import {
  writeGitFixtureBlob,
  writeGitFixtureTree,
} from '@test/helpers/collabGitObjects';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { NativeGitReviewRepository } from '@/app/collab/review/NativeGitReviewRepository';

jest.setTimeout(30_000);

describe('NativeGitReviewRepository integration', () => {
  let root: string;
  let git: GitRepositoryService;
  let runner: GitCommandRunner;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-review-'));
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') {
      throw new Error('Native Git is required for integration tests');
    }
    runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    });
    git = new GitRepositoryService(runner);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('fetches exact authority refs and reads the clean candidate without checkout', async () => {
    const sourcePath = path.join(root, 'source');
    const authorityPath = path.join(root, 'authority.git');
    const clonesPath = path.join(root, 'clones');
    await Promise.all([mkdir(sourcePath), mkdir(authorityPath), mkdir(clonesPath)]);
    await git.initializeWorkingRepository(sourcePath);
    await git.configureLocalRepository(sourcePath, {
      memberId: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
      userDisplayName: 'Member A',
    });
    await git.stageAll(sourcePath);
    const mainOid = await git.createCommitFromIndex(sourcePath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    });
    const noteBlob = await writeGitFixtureBlob(runner, sourcePath, Buffer.from('review me\n'));
    const memberTree = await writeGitFixtureTree(runner, sourcePath, [{
      mode: '100644',
      oid: noteBlob,
      path: 'note.md',
      type: 'blob',
    }]);
    const headOid = await git.commitTree(sourcePath, {
      message: 'Add note',
      parents: [mainOid],
      treeOid: memberTree,
    });
    await git.createRef(sourcePath, 'refs/heads/members/member-a', headOid);
    await git.initializeBareRepository(authorityPath);
    await git.addRemote(sourcePath, 'origin', authorityPath);
    await git.push(sourcePath, 'origin', 'refs/heads/main:refs/heads/main');
    await git.push(
      sourcePath,
      'origin',
      'refs/heads/members/member-a:refs/heads/members/member-a',
    );

    const repositoryPath = await git.cloneRepository({
      branch: 'main',
      directoryName: 'reviewer',
      parentDirectory: clonesPath,
      remoteUrl: authorityPath,
    });
    const detail = requestDetail(mainOid, headOid);
    const repository = new NativeGitReviewRepository(git, {
      withNetwork: async (context, operation) => operation(undefined, context.remoteUrl!),
    });
    const context = {
      memberId: 'member-reviewer',
      personalRef: 'refs/heads/members/member-reviewer',
      projectId: 'project-a',
      remoteUrl: authorityPath,
      repositoryPath,
      role: 'manager' as const,
    };

    const review = await repository.prepare(context, detail);
    expect(review).toMatchObject({
      comparisonBaseOid: mainOid,
      comparisonKind: 'candidate',
      detail,
      files: [{
        binary: false,
        kind: 'added',
        largeForReview: false,
        newBytes: 10,
        path: 'note.md',
      }],
      projectId: 'project-a',
    });
    await expect(repository.readFile(context, {
      comparisonBaseOid: review.comparisonBaseOid,
      comparisonTargetOid: review.comparisonTargetOid,
      file: review.files[0],
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toEqual({
      file: review.files[0],
      kind: 'text',
      newText: 'review me\n',
      oldText: null,
    });
    await expect(git.resolveRef(repositoryPath, 'HEAD')).resolves.toBe(mainOid);
  });
});

function requestDetail(mainOid: string, headOid: string): CollabRequestDetail {
  return {
    comments: { comments: [] },
    currentMainOid: mainOid,
    request: {
      commentCount: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
      description: 'Published change',
      firstBaseOid: mainOid,
      id: 'request-a',
      latestHeadOid: headOid,
      memberId: 'member-a',
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: '2026-08-08T00:00:00.000Z',
    },
    reviewCondition: 'clean',
    reviewedHeadOid: headOid,
  };
}
