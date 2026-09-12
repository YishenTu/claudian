import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import type { PublishRepositorySnapshot } from '@/app/collab/publish/PublishCoordinator';
import { PersonalChangesReviewBaseline } from '@/app/collab/review/PersonalChangesReviewBaseline';

jest.setTimeout(30_000);

describe('PersonalChangesReviewBaseline', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(['clean', 'text-conflict', 'rename-delete', 'personal-file', 'personal-directory', 'no-request'] as const)(
    'excludes automatically received content while preserving the published %s baseline',
    async scenario => {
      root = await mkdtemp(path.join(tmpdir(), 'claudian-review-baseline-'));
      const repositoryPath = path.join(root, 'project');
      await mkdir(repositoryPath);
      const emptyConfigPath = path.join(root, 'gitconfig');
      await writeFile(emptyConfigPath, '');
      const resolution = await new GitRuntimeResolver().resolve();
      if (resolution.status !== 'available') throw new Error('Native Git required');
      const runner = new GitCommandRunner({ executablePath: resolution.runtime.executablePath, emptyConfigPath });
      const git = new GitRepositoryService(runner);
      const personalRef = 'refs/heads/members/member-a';
      const context = { memberId: 'member-a', personalRef, projectId: 'project-a', remoteUrl: null, repositoryPath };
      await git.initializeWorkingRepository(repositoryPath);
      await git.configureLocalRepository(repositoryPath, { ...context, userDisplayName: 'Member A' });
      const separation = 'shared\n'.repeat(12);
      await writeFile(path.join(repositoryPath, 'note.md'), `base choice\n${separation}base tail\n`);
      await git.stageAll(repositoryPath);
      const baseOid = await git.createCommitFromIndex(repositoryPath, {
        expectedRefOid: null, message: 'Base', parents: [], ref: 'refs/heads/main',
      });
      await git.createRef(repositoryPath, personalRef, baseOid);
      await writeFile(path.join(repositoryPath, 'team.md'), 'accepted team content\n');
      if (scenario === 'text-conflict') {
        await writeFile(path.join(repositoryPath, 'note.md'), `accepted choice\n${separation}accepted tail\n`);
      } else if (scenario === 'rename-delete') {
        await rm(path.join(repositoryPath, 'note.md'));
      } else if (scenario === 'personal-file') {
        await mkdir(path.join(repositoryPath, 'notes'));
        await writeFile(path.join(repositoryPath, 'notes', 'team.md'), 'accepted directory content\n');
      } else if (scenario === 'personal-directory') {
        await writeFile(path.join(repositoryPath, 'notes'), 'accepted file content\n');
      }
      await git.stageAll(repositoryPath);
      const mainOid = await git.createCommitFromIndex(repositoryPath, {
        expectedRefOid: baseOid, message: 'Accepted work', parents: [baseOid], ref: 'refs/heads/main',
      });
      await runner.run({ cwd: repositoryPath, args: ['switch', '--quiet', 'members/member-a'] });
      if (scenario === 'rename-delete') {
        await rename(path.join(repositoryPath, 'note.md'), path.join(repositoryPath, 'published.md'));
      } else if (scenario === 'personal-file') {
        await writeFile(path.join(repositoryPath, 'notes'), 'published file content\n');
      } else if (scenario === 'personal-directory') {
        await mkdir(path.join(repositoryPath, 'notes'));
        await writeFile(path.join(repositoryPath, 'notes', 'published.md'), 'published directory content\n');
      } else if (scenario !== 'no-request') {
        await writeFile(path.join(repositoryPath, 'note.md'), `published choice\n${separation}base tail\n`);
      }
      let publishedOid = baseOid;
      if (scenario !== 'no-request') {
        await git.stageAll(repositoryPath);
        publishedOid = await git.createCommitFromIndex(repositoryPath, {
          expectedRefOid: baseOid, message: 'Published work', parents: [baseOid], ref: personalRef,
        });
      }
      await git.createRef(repositoryPath, 'refs/remotes/origin/main', mainOid);
      await git.createRef(repositoryPath, 'refs/remotes/origin/members/member-a', publishedOid);
      await writeFile(path.join(repositoryPath, 'draft.md'), 'unfinished private contribution\n');
      const before = await git.getWorkingTreeStatus(repositoryPath);
      const snapshot: PublishRepositorySnapshot = {
        acceptedMainOid: mainOid, changedFiles: [], headOid: publishedOid, includesAcceptedMain: false,
        personalAheadBy: 0, personalBehindBy: 0, personalRemoteOid: publishedOid, workingTreeClean: false,
      };
      const baseline = new PersonalChangesReviewBaseline(git, runner, {
        readSnapshot: async () => ({
          currentMember: { id: context.memberId, personalRef },
          openRequests: scenario === 'no-request' ? [] : [{ memberId: context.memberId, latestHeadOid: publishedOid }],
          project: { id: context.projectId, mainOid },
        }),
      });
      const prepared = await baseline.prepare(context, snapshot);
      expect(prepared).toMatchObject({ acceptedMainOid: mainOid, sourceHeadOid: publishedOid });
      const read = (file: string) => git.readBlobAtPath(repositoryPath, prepared.baselineOid, file)
        .then(value => value?.toString('utf8') ?? null);
      await expect(read('team.md')).resolves.toBe('accepted team content\n');
      await expect(read('draft.md')).resolves.toBeNull();
      const expectedFiles: Record<string, string | null> = scenario === 'text-conflict'
        ? { 'note.md': `published choice\n${separation}accepted tail\n` }
        : scenario === 'rename-delete'
          ? { 'published.md': `base choice\n${separation}base tail\n`, 'note.md': null }
          : scenario === 'personal-file'
            ? { notes: 'published file content\n' }
            : scenario === 'personal-directory'
              ? { 'notes/published.md': 'published directory content\n' }
              : { 'note.md': `${scenario === 'no-request' ? 'base' : 'published'} choice\n${separation}base tail\n` };
      const actualFiles = Object.fromEntries(await Promise.all(Object.keys(expectedFiles).map(async file => [file, await read(file)])));
      expect(actualFiles).toEqual(expectedFiles);
      await baseline.releaseObsolete(context, prepared);
      await expect(baseline.prepare(context, snapshot)).resolves.toEqual(prepared);
      await expect(git.resolveRef(repositoryPath, personalRef)).resolves.toBe(publishedOid);
      await expect(git.resolveRef(repositoryPath, 'refs/remotes/origin/members/member-a')).resolves.toBe(publishedOid);
      await expect(git.getWorkingTreeStatus(repositoryPath)).resolves.toEqual(before);
      await expect(readFile(path.join(repositoryPath, 'draft.md'), 'utf8')).resolves.toBe('unfinished private contribution\n');
    },
  );
});
