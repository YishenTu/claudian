import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { NativeGitPublishRepository } from '@/app/collab/publish/NativeGitPublishRepository';
import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';

const MAIN = '1'.repeat(40);
const PERSONAL = '2'.repeat(40);
const CONTEXT: PublishProjectContext = {
  allowHostRemoteRepair: false,
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://192.168.0.2/repository.git',
  repositoryPath: '/vault/workspace/project-a',
};

function repository(includesAcceptedMain: boolean) {
  const git = {
    countDivergence: jest.fn().mockResolvedValue({ leftOnly: 0, rightOnly: 0 }),
    getWorkingTreeState: jest.fn().mockResolvedValue({
      branch: {
        aheadBy: 3,
        behindBy: 2,
        headName: 'members/member-a',
        headOid: PERSONAL,
        upstreamName: 'origin/members/member-a',
      },
      entries: [],
    }),
    getWorkingTreeStatus: jest.fn().mockResolvedValue([]),
    isAncestor: jest.fn().mockResolvedValue(includesAcceptedMain),
    resolveRefs: jest.fn().mockResolvedValue(new Map([
      [CONTEXT.personalRef, PERSONAL],
      ['refs/remotes/origin/members/member-a', PERSONAL],
      ['refs/remotes/origin/main', MAIN],
    ])),
    withReadSession: jest.fn(),
  } as unknown as jest.Mocked<GitRepositoryService>;
  git.withReadSession.mockImplementation(async (_path, _kind, operation) => operation({
    countDivergence: (leftOid: string, rightOid: string) => git.countDivergence(
      CONTEXT.repositoryPath, leftOid, rightOid,
    ),
    getWorkingTreeState: () => git.getWorkingTreeState(CONTEXT.repositoryPath),
    getWorkingTreeStatus: () => git.getWorkingTreeStatus(CONTEXT.repositoryPath),
    isAncestor: (ancestorOid: string, descendantOid: string) => git.isAncestor(
      CONTEXT.repositoryPath, ancestorOid, descendantOid,
    ),
    resolveRefs: (refs: readonly string[]) => git.resolveRefs(CONTEXT.repositoryPath, refs),
  } as never));
  return {
    git,
    subject: new NativeGitPublishRepository(git, {
      acceptedState: {
        classifyDivergence: jest.fn(),
      },
    }),
  };
}

describe('NativeGitPublishRepository', () => {
  it.each([true, false])(
    'reports whether the personal head contains the fetched main (%s)',
    async includesAcceptedMain => {
      const { git, subject } = repository(includesAcceptedMain);

      await expect(subject.inspect(CONTEXT)).resolves.toMatchObject({
        includesAcceptedMain,
        personalAheadBy: 3,
        personalBehindBy: 2,
      });
      expect(git.isAncestor).toHaveBeenCalledWith(CONTEXT.repositoryPath, MAIN, PERSONAL);
      expect(git.countDivergence).not.toHaveBeenCalled();
    },
  );
});
