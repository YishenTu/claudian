import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConflictScratchGitRepository } from '@/app/collab/conflicts/ConflictScratchGitRepository';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';
import type { CollabConflictDescriptor } from '@/core/collab';

jest.setTimeout(30_000);

describe('ConflictScratchGitRepository', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });

  it('uses Native Git conflict stages without mutating the visible Project', async () => {
    const harness = await createHarness();
    const runSpy = jest.spyOn(harness.runner, 'run');

    const inspected = await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );

    expect(inspected.stages.map(stage => ({ path: stage.path, stage: stage.stage })))
      .toEqual([
        { path: 'note.md', stage: 1 },
        { path: 'note.md', stage: 2 },
        { path: 'note.md', stage: 3 },
      ]);
    await expect(harness.scratch.readStage(
      harness.scratchPath,
      inspected,
      'note.md',
      1,
    )).resolves.toEqual(Buffer.from('base\n'));
    await expect(harness.scratch.readStage(
      harness.scratchPath,
      inspected,
      'note.md',
      2,
    )).resolves.toEqual(Buffer.from('personal\n'));
    await expect(harness.scratch.readStage(
      harness.scratchPath,
      inspected,
      'note.md',
      3,
    )).resolves.toEqual(Buffer.from('accepted\n'));
    await expect(readFile(path.join(harness.repositoryPath, 'note.md'), 'utf8'))
      .resolves.toBe('personal\n');
    expect(await harness.git.getWorkingTreeStatus(harness.repositoryPath)).toEqual([]);
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['merge']),
      identity: {
        email: 'collab@claudian.local',
        name: 'Claudian Collab',
      },
    }));
  });

  it('derives independently selectable conflict hunks through Native Git', async () => {
    const harness = await createHarness();
    const middle = Array.from({ length: 12 }, (_, index) => `shared ${index}\n`).join('');

    await expect(harness.scratch.readTextMergeSegments(
      harness.scratchPath,
      Buffer.from(`start\npersonal one\n${middle}personal two\nend\n`),
      Buffer.from(`start\nbase one\n${middle}base two\nend\n`),
      Buffer.from(`start\naccepted one\n${middle}accepted two\nend\n`),
    )).resolves.toEqual([
      { kind: 'common', text: 'start\n' },
      expect.objectContaining({
        accepted: 'accepted one\n',
        id: 'hunk-1',
        kind: 'conflict',
        personal: 'personal one\n',
      }),
      { kind: 'common', text: middle },
      expect.objectContaining({
        accepted: 'accepted two\n',
        id: 'hunk-2',
        kind: 'conflict',
        personal: 'personal two\n',
      }),
      { kind: 'common', text: 'end\n' },
    ]);
  });

  it('keeps clean one-sided edits in the composed common segments', async () => {
    const harness = await createHarness();
    const separation = Array.from({ length: 12 }, (_, index) => `shared ${index}\n`).join('');
    const segments = await harness.scratch.readTextMergeSegments(
      harness.scratchPath,
      Buffer.from(`personal conflict\n${separation}tail base\n`),
      Buffer.from(`base conflict\n${separation}tail base\n`),
      Buffer.from(`accepted conflict\n${separation}tail accepted\n`),
    );

    expect(segments).toEqual([
      expect.objectContaining({
        accepted: 'accepted conflict\n',
        kind: 'conflict',
        personal: 'personal conflict\n',
      }),
      { kind: 'common', text: `${separation}tail accepted\n` },
    ]);
  });

  it('validates a resumable scratch index against immutable starting OIDs', async () => {
    const harness = await createHarness();
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );

    await expect(harness.scratch.inspect(
      harness.scratchPath,
      harness.descriptor,
    )).resolves.toMatchObject({
      acceptedMainOid: harness.descriptor.startingMainOid,
      personalOid: harness.descriptor.startingPersonalOid,
    });
    await expect(harness.scratch.isPrepared(
      harness.scratchPath,
      harness.descriptor,
    )).resolves.toBe(true);

    await rm(path.join(harness.scratchPath, '.git', 'index'));
    await expect(harness.scratch.isPrepared(
      harness.scratchPath,
      harness.descriptor,
    )).resolves.toBe(false);
  });

  it('honors cancellation before creating conflict state', async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
      controller.signal,
    )).rejects.toMatchObject({ code: 'cancelled' });
    await expect(readFile(path.join(harness.repositoryPath, 'note.md'), 'utf8'))
      .resolves.toBe('personal\n');
  });

  it('stages the committed working-tree version and creates a two-parent commit', async () => {
    const harness = await createHarness();
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );

    const inspection = await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['note.md'],
    );

    expect(inspection.stages).toEqual([]);
    await expect(readFile(path.join(harness.scratchPath, 'note.md'), 'utf8'))
      .resolves.toBe('personal\n');
    await expect(harness.git.readBlobAtPath(
      harness.scratchPath,
      resultOid,
      'note.md',
    )).resolves.toEqual(Buffer.from('personal\n'));
    await expect(showParents(harness.runner, harness.scratchPath, resultOid))
      .resolves.toBe(
        `${harness.descriptor.startingPersonalOid} ${harness.descriptor.startingMainOid}`,
      );
    await expect(showCommit(
      harness.runner,
      harness.scratchPath,
      resultOid,
      '%an%x00%ae',
    )).resolves.toBe('Claudian Collab\0collab@claudian.local');
  });

  it.each([
    ['keep-personal', Buffer.from([0x00, 0x01, 0x02])],
  ] as const)('resolves a binary conflict with whole-file choice %s', async (
    _choice,
    expected,
  ) => {
    const harness = await createHarness('binary');
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );

    await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['image.bin'],
    );

    await expect(harness.git.readBlobAtPath(
      harness.scratchPath,
      resultOid,
      'image.bin',
    )).resolves.toEqual(expected);
  });

  it.each([
    ['keep-personal', 'personal\n'],
  ] as const)('resolves delete/modify with explicit side %s', async (_choice, expected) => {
    const harness = await createHarness('delete-modify');
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );

    await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['note.md'],
    );
    const result = await harness.git.readBlobAtPath(
      harness.scratchPath,
      resultOid,
      'note.md',
    );

    expect(result).toEqual(expected === null ? null : Buffer.from(expected));
  });

  it.each([
    ['keep-personal', 'shared line\npersonal\n'],
  ] as const)('resolves rename/delete with explicit side %s', async (_choice, expected) => {
    const harness = await createHarness('rename-delete');
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );

    await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['renamed.md'],
    );
    const result = await harness.git.readBlobAtPath(
      harness.scratchPath,
      resultOid,
      'renamed.md',
    );

    expect(result).toEqual(expected === null ? null : Buffer.from(expected));
    await expect(harness.git.readBlobAtPath(
      harness.scratchPath,
      resultOid,
      'old.md',
    )).resolves.toBeNull();
  });

  it('fetches the exact result and fast-forwards only the visible personal branch', async () => {
    const harness = await createHarness();
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );
    await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['note.md'],
    );
    await expect(harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['note.md'],
    )).resolves.toBe(resultOid);
    const marker = path.join(root, 'hostile-post-merge');
    const hook = path.join(harness.repositoryPath, '.git', 'hooks', 'post-merge');
    const refMarker = path.join(root, 'hostile-reference-transaction');
    const refHook = path.join(
      harness.repositoryPath,
      '.git',
      'hooks',
      'reference-transaction',
    );
    await writeFile(hook, `#!/bin/sh\nprintf hostile > "${marker}"\n`);
    await writeFile(refHook, `#!/bin/sh\nprintf hostile > "${refMarker}"\n`);
    await Promise.all([chmod(hook, 0o755), chmod(refHook, 0o755)]);

    await harness.scratch.retainResultForPublication(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
      resultOid,
    );

    expect(await harness.git.resolveRef(
      harness.repositoryPath,
      harness.context.personalRef,
    )).toBe(harness.descriptor.startingPersonalOid);
    expect(await harness.git.resolveRef(harness.repositoryPath, 'refs/heads/main'))
      .toBe(harness.descriptor.startingMainOid);
    await expect(readFile(path.join(harness.repositoryPath, 'note.md'), 'utf8'))
      .resolves.toBe('personal\n');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(refMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await harness.git.getWorkingTreeStatus(harness.repositoryPath)).toEqual([]);
    expect(await harness.git.resolveRef(
      harness.repositoryPath,
      `refs/claudian/publications/${harness.descriptor.operationId}`,
    )).toBe(resultOid);

    await expect(harness.scratch.retainResultForPublication(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
      resultOid,
    )).resolves.toBeUndefined();
  });

  it('refuses stale real worktree state without resetting local content', async () => {
    const harness = await createHarness();
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );
    await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['note.md'],
    );
    await writeFile(path.join(harness.repositoryPath, 'local-draft.md'), 'keep\n');

    await expect(harness.scratch.retainResultForPublication(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
      resultOid,
    )).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'conflict-project-state-changed' },
    });
    await expect(readFile(path.join(harness.repositoryPath, 'local-draft.md'), 'utf8'))
      .resolves.toBe('keep\n');
    expect(await harness.git.resolveRef(
      harness.repositoryPath,
      harness.context.personalRef,
    )).toBe(harness.descriptor.startingPersonalOid);
  });

  it('refuses a clean but advanced real personal branch', async () => {
    const harness = await createHarness();
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );
    await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['note.md'],
    );
    await writeFile(path.join(harness.repositoryPath, 'later.md'), 'later\n');
    await harness.git.stageAll(harness.repositoryPath);
    const laterOid = await harness.git.createCommitFromIndex(harness.repositoryPath, {
      expectedRefOid: harness.descriptor.startingPersonalOid,
      message: 'Later local work',
      parents: [harness.descriptor.startingPersonalOid],
      ref: harness.context.personalRef,
    });

    await expect(harness.scratch.retainResultForPublication(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
      resultOid,
    )).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'conflict-project-state-changed' },
    });
    expect(await harness.git.resolveRef(
      harness.repositoryPath,
      harness.context.personalRef,
    )).toBe(laterOid);
    await expect(readFile(path.join(harness.repositoryPath, 'later.md'), 'utf8'))
      .resolves.toBe('later\n');
  });

  it('honors cancellation before transferring or mutating the real Project', async () => {
    const harness = await createHarness();
    await harness.scratch.prepare(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
    );
    await harness.scratch.resolveWithPersonalVersions(
      harness.scratchPath,
      harness.descriptor,
    );
    const resultOid = await harness.scratch.createResolutionCommit(
      harness.scratchPath,
      harness.descriptor,
      ['note.md'],
    );
    const controller = new AbortController();
    controller.abort();

    await expect(harness.scratch.retainResultForPublication(
      harness.context,
      harness.scratchPath,
      harness.descriptor,
      resultOid,
      controller.signal,
    )).rejects.toMatchObject({ code: 'cancelled' });
    expect(await harness.git.resolveRef(
      harness.repositoryPath,
      harness.context.personalRef,
    )).toBe(harness.descriptor.startingPersonalOid);
  });

  async function createHarness(
    scenario: 'binary' | 'delete-modify' | 'rename-delete' | 'text' = 'text',
  ) {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-conflict-git-'));
    const repositoryPath = path.join(root, 'project');
    const scratchPath = path.join(root, 'scratch');
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await Promise.all([
      mkdir(repositoryPath, { recursive: true }),
      mkdir(scratchPath, { recursive: true }),
      writeFile(emptyConfigPath, ''),
    ]);
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') throw new Error('Native Git is required');
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    });
    const git = new GitRepositoryService(runner);
    await git.initializeWorkingRepository(repositoryPath);
    await git.configureLocalRepository(repositoryPath, {
      memberId: 'member-a',
      personalRef: 'refs/heads/members/member-a',
      projectId: 'project-a',
      userDisplayName: 'Member A',
    });
    const basePath = scenario === 'binary'
      ? 'image.bin'
      : scenario === 'rename-delete'
        ? 'old.md'
        : 'note.md';
    const baseContents = scenario === 'binary'
      ? Buffer.from([0x00, 0x05, 0x06])
      : scenario === 'rename-delete'
        ? 'shared line\nbase\n'
        : 'base\n';
    await writeFile(path.join(repositoryPath, basePath), baseContents);
    await git.stageAll(repositoryPath);
    const baseOid = await git.createCommitFromIndex(repositoryPath, {
      expectedRefOid: null,
      message: 'Base',
      parents: [],
      ref: 'refs/heads/main',
    });
    const personalRef = 'refs/heads/members/member-a';
    await git.createRef(repositoryPath, personalRef, baseOid);
    if (scenario === 'delete-modify' || scenario === 'rename-delete') {
      await rm(path.join(repositoryPath, basePath));
    } else {
      await writeFile(
        path.join(repositoryPath, basePath),
        scenario === 'binary' ? Buffer.from([0x00, 0x03, 0x04]) : 'accepted\n',
      );
    }
    await git.stageAll(repositoryPath);
    const mainOid = await git.createCommitFromIndex(repositoryPath, {
      expectedRefOid: baseOid,
      message: 'Accepted',
      parents: [baseOid],
      ref: 'refs/heads/main',
    });
    await runner.run({
      args: ['switch', '--quiet', 'members/member-a'],
      cwd: repositoryPath,
    });
    if (scenario === 'rename-delete') {
      await rename(
        path.join(repositoryPath, 'old.md'),
        path.join(repositoryPath, 'renamed.md'),
      );
      await writeFile(path.join(repositoryPath, 'renamed.md'), 'shared line\npersonal\n');
    } else {
      await writeFile(
        path.join(repositoryPath, basePath),
        scenario === 'binary' ? Buffer.from([0x00, 0x01, 0x02]) : 'personal\n',
      );
    }
    await git.stageAll(repositoryPath);
    const personalOid = await git.createCommitFromIndex(repositoryPath, {
      expectedRefOid: baseOid,
      message: 'Personal',
      parents: [baseOid],
      ref: personalRef,
    });
    await git.createRef(repositoryPath, 'refs/remotes/origin/main', mainOid);
    const context: PublishProjectContext = {
      memberId: 'member-a',
      personalRef,
      projectId: 'project-a',
      remoteUrl: 'https://127.0.0.1/repository.git',
      repositoryPath,
    };
    const conflict = scenario === 'binary'
      ? { kind: 'binary' as const, path: 'image.bin' }
      : scenario === 'delete-modify'
        ? { kind: 'delete-modify' as const, path: 'note.md' }
        : scenario === 'rename-delete'
          ? {
            acceptedPath: 'old.md',
            kind: 'rename-delete' as const,
            path: 'renamed.md',
            personalPath: 'renamed.md',
          }
          : { kind: 'text' as const, path: 'note.md' };
    const descriptor: CollabConflictDescriptor = {
      conflicts: [conflict],
      mergeBaseOid: baseOid,
      operationId: 'operation-a',
      projectId: context.projectId,
      startingMainOid: mainOid,
      startingPersonalOid: personalOid,
    };
    return {
      context,
      descriptor,
      git,
      repositoryPath,
      runner,
      scratch: new ConflictScratchGitRepository(git, runner),
      scratchPath,
    };
  }
});

async function showParents(
  runner: GitCommandRunner,
  repositoryPath: string,
  oid: string,
): Promise<string> {
  return showCommit(runner, repositoryPath, oid, '%P');
}

async function showCommit(
  runner: GitCommandRunner,
  repositoryPath: string,
  oid: string,
  format: string,
): Promise<string> {
  const result = await runner.run({
    args: ['show', '-s', `--format=${format}`, oid],
    cwd: repositoryPath,
  });
  return result.stdout.toString('utf8').trim();
}
