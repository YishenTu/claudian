import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';
import {
  ReconciliationMutationSafety,
  type ReconciliationRepositoryLockPort,
} from '@/app/collab/reconciliation/ReconciliationMutationSafety';

const CONTEXT: PublishProjectContext = {
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://192.168.0.2/repository.git',
  repositoryPath: '/vault/workspace/project-a',
};

describe('ReconciliationMutationSafety', () => {
  it('defers accepted integration while the repository mutation lock is held', async () => {
    const { safety } = createSubject(true);

    await expect(safety.inspect(CONTEXT)).resolves.toEqual({
      reason: 'repository-lock',
      safe: false,
    });
    await expect(safety.assertSafe(CONTEXT)).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'repository-lock' },
    });
    await expect(safety.assertSafe(CONTEXT, 'integrate')).rejects.toMatchObject({
      code: 'working-tree-busy',
    });
  });

  it('allows a safe reconciliation and does not block non-integration Publish boundaries', async () => {
    const { locks, safety } = createSubject(false);

    await expect(safety.inspect(CONTEXT)).resolves.toEqual({ safe: true });
    await expect(safety.assertSafe(CONTEXT)).resolves.toBeUndefined();
    await expect(safety.assertSafe(CONTEXT, 'stage')).resolves.toBeUndefined();
    await expect(safety.assertSafe(CONTEXT, 'commit')).resolves.toBeUndefined();
    await expect(safety.assertSafe(CONTEXT, 'fetch')).resolves.toBeUndefined();
    await expect(safety.assertSafe(CONTEXT, 'push')).resolves.toBeUndefined();
    expect(locks.hasMutationLock).toHaveBeenCalledTimes(2);
  });
});

function createSubject(repositoryLock: boolean) {
  const locks = {
    hasMutationLock: jest.fn(async () => repositoryLock),
  } satisfies ReconciliationRepositoryLockPort;
  return {
    locks,
    safety: new ReconciliationMutationSafety(locks),
  };
}
