import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { NativeGitPublicationCandidateRepository } from '@/app/collab/publish/NativeGitPublicationCandidateRepository';

const IDENTITY = { email: 'fixture@example.invalid', name: 'Fixture' };

it.each(['matching', 'different', 'deleted', 'renamed'] as const)('previews %s working content without changing local Git state or invoking hooks', async scenario => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-update-preview-'));
  try {
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') throw new Error('Git required');
    const runner = new GitCommandRunner({ emptyConfigPath, executablePath: resolution.runtime.executablePath });
    const repository = path.join(root, 'repository');
    await mkdir(repository);
    const git = new GitRepositoryService(runner);
    await git.initializeWorkingRepository(repository);
    const run = (args: string[]) => runner.run({ args, cwd: repository, identity: IDENTITY });
    const commit = async () => {
      await run(['add', '--all']);
      await run(['commit', '-m', 'Fixture']);
      return (await run(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
    };
    await writeFile(path.join(repository, 'note.md'), 'base\n');
    const base = await commit();
    await writeFile(path.join(repository, 'note.md'), 'team content\n');
    if (scenario === 'deleted' || scenario === 'renamed') await rm(path.join(repository, 'note.md'));
    if (scenario === 'renamed') await writeFile(path.join(repository, 'renamed.md'), 'base\n');
    const accepted = await commit();
    await run(['checkout', '-b', 'member', base]);
    await writeFile(path.join(repository, 'draft.md'), 'staged private draft\n');
    await run(['add', 'draft.md']);
    await writeFile(path.join(repository, 'draft.md'), 'unstaged private draft\n');
    await writeFile(path.join(repository, 'note.md'), scenario === 'different' ? 'different local content\n' : 'team content\n');
    if (scenario === 'deleted' || scenario === 'renamed') await rm(path.join(repository, 'note.md'));
    if (scenario === 'renamed') await writeFile(path.join(repository, 'renamed.md'), 'base\n');
    await writeFile(path.join(repository, '.git', 'hooks', 'post-index-change'), '#!/bin/sh\nprintf changed > hook-ran\n', { mode: 0o700 });
    const indexBefore = await readFile(path.join(repository, '.git', 'index'));
    const refsBefore = (await run(['show-ref'])).stdout;
    const subject = new NativeGitPublicationCandidateRepository(git, runner);
    expect(await subject.hasIncomingChanges(repository, base, accepted, true)).toBe(scenario === 'different');
    expect(await readFile(path.join(repository, '.git', 'index'))).toEqual(indexBefore);
    expect((await run(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim()).toBe(base);
    expect((await run(['show-ref'])).stdout).toEqual(refsBefore);
    expect(await readFile(path.join(repository, 'draft.md'), 'utf8')).toBe('unstaged private draft\n');
    expect(await readFile(path.join(repository, 'hook-ran'), 'utf8').catch(() => null)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
