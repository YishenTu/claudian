import { COLLAB_MAIN_REF } from '@claudian-collab/protocol';

import { RequestQueryGitPolicy } from '@/app/collab/authority/RequestQueryGitPolicy';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';

const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);

describe('RequestQueryGitPolicy', () => {
  it('resolves the exact review condition without computing a raw changed-file manifest', async () => {
    const git = fakeGit();
    git.resolveRefs.mockResolvedValue(new Map([
      [COLLAB_MAIN_REF, MAIN],
      ['refs/heads/members/member-a', HEAD],
    ]));
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
    expect(git.mergeTree).toHaveBeenCalledWith('/repo.git', MAIN, HEAD);
    expect(git.listChangedFiles).not.toHaveBeenCalled();
    expect(result).toEqual({
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
