import { COLLAB_MAIN_REF } from '@claudian/collab-protocol';

import { RequestQueryGitPolicy } from '@/app/collab/authority/RequestQueryGitPolicy';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);

describe('RequestQueryGitPolicy', () => {
  it('reviews the exact request head against current main and classifies binary paths', async () => {
    const git = fakeGit();
    git.resolveRefs.mockResolvedValue(new Map([
      [COLLAB_MAIN_REF, MAIN],
      ['refs/heads/members/member-a', HEAD],
    ]));
    git.listChangedFiles.mockResolvedValue([
      { kind: 'modified', path: 'README.md' },
      { kind: 'renamed', path: 'image-new.png', previousPath: 'image.png' },
    ]);
    git.mergeTree.mockResolvedValue({ kind: 'conflicting', treeOid: null });

    const result = await new RequestQueryGitPolicy('/repo.git', git).inspect({
      firstBaseOid: MAIN,
      latestHeadOid: HEAD,
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
    });

    expect(git.resolveRefs).toHaveBeenCalledWith('/repo.git', [
      COLLAB_MAIN_REF,
      'refs/heads/members/member-a',
    ]);
    expect(git.listChangedFiles).toHaveBeenCalledWith('/repo.git', MAIN, HEAD);
    expect(git.mergeTree).toHaveBeenCalledWith('/repo.git', MAIN, HEAD);
    expect(result).toEqual({
      changedFiles: [
        { binary: false, kind: 'modified', largeForReview: false, path: 'README.md' },
        {
          binary: true,
          kind: 'renamed',
          largeForReview: false,
          path: 'image-new.png',
          previousPath: 'image.png',
        },
      ],
      currentMainOid: MAIN,
      reviewCondition: 'conflicting',
      reviewedHeadOid: HEAD,
    });
  });

  it('marks a request stale when the personal ref has advanced past its reviewed head', async () => {
    const git = fakeGit();
    git.resolveRefs.mockResolvedValue(new Map([
      [COLLAB_MAIN_REF, MAIN],
      ['refs/heads/members/member-a', '3'.repeat(40)],
    ]));

    await expect(new RequestQueryGitPolicy('/repo.git', git).inspect({
      firstBaseOid: MAIN,
      latestHeadOid: HEAD,
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
    })).resolves.toMatchObject({ reviewCondition: 'stale' });
  });

  it('rejects changed-path overflow instead of returning a partial review', async () => {
    const git = fakeGit();
    git.resolveRefs.mockResolvedValue(new Map([
      [COLLAB_MAIN_REF, MAIN],
      ['refs/heads/members/member-a', HEAD],
    ]));
    git.listChangedFiles.mockResolvedValue(Array.from(
      { length: CLAUDIAN_COLLAB_LIMITS.maxChangedPaths + 1 },
      (_, index) => ({ kind: 'modified' as const, path: `file-${index}.md` }),
    ));

    await expect(new RequestQueryGitPolicy('/repo.git', git).inspect({
      firstBaseOid: MAIN,
      latestHeadOid: HEAD,
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
    })).rejects.toMatchObject({ code: 'quota-exceeded' });
  });
});

function fakeGit() {
  const git = {
    listChangedFiles: jest.fn().mockResolvedValue([]),
    mergeTree: jest.fn().mockResolvedValue({ kind: 'clean', treeOid: '4'.repeat(40) }),
    resolveRefs: jest.fn(),
    withReadSession: jest.fn(),
  } as unknown as jest.Mocked<GitRepositoryService>;
  git.withReadSession.mockImplementation(async (_path, _kind, operation) => operation({
    listChangedFiles: (baseOid: string, headOid: string) => git.listChangedFiles(
      '/repo.git', baseOid, headOid,
    ),
    mergeTree: (acceptedOid: string, memberOid: string) => git.mergeTree(
      '/repo.git', acceptedOid, memberOid,
    ),
    resolveRefs: (refs: readonly string[]) => git.resolveRefs('/repo.git', refs),
  } as never));
  return git;
}
