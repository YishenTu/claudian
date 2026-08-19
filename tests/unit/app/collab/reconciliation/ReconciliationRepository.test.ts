import type { NativeGitPublishRepository } from '@/app/collab/publish/NativeGitPublishRepository';
import type {
  PublishProjectContext,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import type { NativeGitAcceptedStateIntegrator } from '@/app/collab/reconciliation/NativeGitAcceptedStateIntegrator';
import { ReconciliationRepository } from '@/app/collab/reconciliation/ReconciliationRepository';

const CONTEXT: PublishProjectContext = {
  allowHostRemoteRepair: false,
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://192.168.0.2/repository.git',
  repositoryPath: '/vault/workspace/project-a',
};
const SNAPSHOT: PublishRepositorySnapshot = {
  acceptedMainOid: '1'.repeat(40),
  changedFiles: [],
  headOid: '2'.repeat(40),
  includesAcceptedMain: true,
  personalAheadBy: 0,
  personalBehindBy: 0,
  personalRemoteOid: '2'.repeat(40),
  workingTreeClean: true,
};

describe('ReconciliationRepository', () => {
  it('routes network and fast-forward operations to their owning repositories', async () => {
    const publish = {
      fetch: jest.fn(async () => undefined),
      inspect: jest.fn(async () => SNAPSHOT),
      pushPersonal: jest.fn(async () => undefined),
    } as unknown as NativeGitPublishRepository;
    const integrator = {
      fastForward: jest.fn(async () => ({
        kind: 'fast-forwarded' as const,
        snapshot: SNAPSHOT,
      })),
      plan: jest.fn(async () => ({ kind: 'diverged' as const })),
    } as unknown as NativeGitAcceptedStateIntegrator;
    const repository = new ReconciliationRepository(publish, integrator);
    const signal = new AbortController().signal;

    await expect(repository.inspect(CONTEXT, signal)).resolves.toBe(SNAPSHOT);
    await repository.fetch(CONTEXT, SNAPSHOT, signal);
    await expect(repository.plan(
      CONTEXT,
      SNAPSHOT,
      'operation-a',
      signal,
    )).resolves.toEqual({ kind: 'diverged' });
    await expect(repository.fastForward(CONTEXT, SNAPSHOT, signal)).resolves.toEqual({
      kind: 'fast-forwarded',
      snapshot: SNAPSHOT,
    });
    await repository.pushPersonal(CONTEXT, SNAPSHOT, signal);

    expect(publish.fetch).toHaveBeenCalledWith(CONTEXT, SNAPSHOT, signal);
    expect(publish.pushPersonal).toHaveBeenCalledWith(CONTEXT, SNAPSHOT, signal);
    expect(integrator.plan).toHaveBeenCalledWith(
      CONTEXT,
      SNAPSHOT,
      'operation-a',
      signal,
    );
  });
});
