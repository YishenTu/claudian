import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { NativeGitPublishRepository } from '@/app/collab/publish/NativeGitPublishRepository';

jest.setTimeout(30_000);

describe('NativeGitPublishRepository integration', () => {
  const roots: string[] = [];
  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-publish-boundary-'));
    roots.push(root);
    return root;
  }
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each([false, true])(
    'binds push to the captured head when local work advances during preflight (remote advanced: %s)',
    async remoteAdvanced => {
      const root = await temporaryRoot();
      const emptyConfigPath = path.join(root, 'empty.gitconfig');
      await writeFile(emptyConfigPath, '');
      const resolution = await new GitRuntimeResolver().resolve();
      if (resolution.status !== 'available') throw new Error('Native Git is required');
      const git = new GitRepositoryService(new GitCommandRunner({
        emptyConfigPath,
        executablePath: resolution.runtime.executablePath,
      }));
      const remote = path.join(root, 'authority.git');
      const repositoryPath = path.join(root, 'member');
      const personalRef = 'refs/heads/members/member-a';
      await Promise.all([mkdir(remote), mkdir(repositoryPath)]);
      await git.initializeBareRepository(remote);
      await git.initializeWorkingRepository(repositoryPath);
      await git.configureLocalRepository(repositoryPath, {
        memberId: 'member-a', personalRef, projectId: 'project-audit', userDisplayName: 'Audit member',
      });
      await git.stageAll(repositoryPath);
      const initial = await git.createCommitFromIndex(repositoryPath, {
        expectedRefOid: null, message: 'Initial', parents: [], ref: personalRef,
      });
      await git.addRemote(repositoryPath, 'origin', remote);
      await git.push(repositoryPath, 'origin', `${personalRef}:${personalRef}`);
      await git.createRef(repositoryPath, 'refs/remotes/origin/main', initial);
      await git.createRef(repositoryPath, 'refs/remotes/origin/members/member-a', initial);
      await writeFile(path.join(repositoryPath, 'confirmed.md'), 'User confirmed this change.\n');
      await git.stageAll(repositoryPath);
      const confirmed = await git.createCommitFromIndex(repositoryPath, {
        expectedRefOid: initial, message: 'Confirmed', parents: [initial], ref: personalRef,
      });
      let newLocalHead: string | null = null;
      const repository = new NativeGitPublishRepository(git, {
        acceptedState: { classifyDivergence: async () => { throw new Error('Not used'); } },
        network: {
          withNetwork: async (context, operation) => {
            // External writer acts during the network preflight boundary, after expected-state validation.
            await writeFile(path.join(repositoryPath, 'unpublished.md'), 'Not part of the confirmed publication.\n');
            await git.stageAll(repositoryPath);
            newLocalHead = await git.createCommitFromIndex(repositoryPath, {
              expectedRefOid: confirmed, message: 'Private later work', parents: [confirmed], ref: personalRef,
            });
            if (remoteAdvanced) await git.push(repositoryPath, 'origin', `${personalRef}:${personalRef}`);
            return operation(undefined, context.remoteUrl!);
          },
        },
      });
      const context = {
        memberId: 'member-a', personalRef, projectId: 'project-audit', remoteUrl: remote, repositoryPath,
      };
      const captured = await repository.inspect(context);
      expect(captured.headOid).toBe(confirmed);
      const pushed = repository.pushPersonal(context, captured);
      const outcome = await pushed.then(() => 'pushed', () => 'rejected');
      expect(outcome).toBe(remoteAdvanced ? 'rejected' : 'pushed');
      const remoteHead = await git.resolveRef(remote, personalRef);
      expect(newLocalHead).not.toBe(confirmed);
      expect(await git.resolveRef(repositoryPath, personalRef)).toBe(newLocalHead);
      expect(remoteHead).toBe(remoteAdvanced ? newLocalHead : confirmed);
    },
  );
});
