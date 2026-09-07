import type { LocalProjectCleanupPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import { RetiredProjectFinalizer } from '@/app/collab/exit/RetiredProjectFinalizer';
import { CollabError } from '@/core/collab/ClaudianCollabError';

describe('RetiredProjectFinalizer', () => {
  it.each(['keep-files', 'delete-files'] as const)(
    'replays an applied %s choice after projection finalization fails',
    async choice => {
      let choiceApplied = false;
      let journalRemoved = false;
      const cleanup: jest.Mocked<Pick<
        LocalProjectCleanupPort,
        'completeRetiredFinalization' | 'finalizeRetiredChoice'
      >> = {
        completeRetiredFinalization: jest.fn(async (_projectId: string) => {
          journalRemoved = true;
        }),
        finalizeRetiredChoice: jest.fn(async intent => {
          expect(intent.choice).toBe(choice);
          choiceApplied = true;
          return {
            filesPreserved: choice === 'keep-files',
            gitDataRemoved: true as const,
            markerRetained: false,
            status: 'complete' as const,
          };
        }),
      };
      const projects = {
        finalizeRetiredProject: jest.fn()
          .mockRejectedValueOnce(new Error('index write failed'))
          .mockResolvedValueOnce(undefined),
      };
      const subject = new RetiredProjectFinalizer(cleanup, projects);
      const intent = { choice, projectId: 'project-alpha' };

      await expect(subject.finalize(intent)).rejects.toThrow('index write failed');
      expect(choiceApplied).toBe(true);
      expect(journalRemoved).toBe(false);

      await expect(subject.finalize(intent)).resolves.toBeUndefined();
      expect(cleanup.finalizeRetiredChoice).toHaveBeenCalledTimes(2);
      expect(projects.finalizeRetiredProject).toHaveBeenCalledTimes(2);
      expect(cleanup.completeRetiredFinalization).toHaveBeenCalledTimes(1);
    },
  );

  it('removes the exact applied journal after projection finalization already committed', async () => {
    const cleanup = {
      completeRetiredFinalization: jest.fn().mockResolvedValue(undefined),
      finalizeRetiredChoice: jest.fn().mockResolvedValue({
        filesPreserved: true,
        gitDataRemoved: true,
        markerRetained: false,
        status: 'complete',
      }),
    };
    const projects = {
      finalizeRetiredProject: jest.fn().mockRejectedValue(new CollabError({
        code: 'project-not-found',
      })),
    };
    const subject = new RetiredProjectFinalizer(cleanup, projects);

    await expect(subject.finalize({
      choice: 'keep-files',
      projectId: 'project-alpha',
    })).resolves.toBeUndefined();

    expect(cleanup.finalizeRetiredChoice).toHaveBeenCalledTimes(2);
    expect(cleanup.completeRetiredFinalization).toHaveBeenCalledWith('project-alpha');
  });
});
