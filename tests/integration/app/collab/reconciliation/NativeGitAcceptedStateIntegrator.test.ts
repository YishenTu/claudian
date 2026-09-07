import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import type { PublishRepositorySnapshot } from '@/app/collab/publish/PublishCoordinator';
import {
  NativeGitAcceptedStateIntegrator,
} from '@/app/collab/reconciliation/NativeGitAcceptedStateIntegrator';

const MEMBER_ID = 'member-a';
const PERSONAL_REF = `refs/heads/members/${MEMBER_ID}`;
const REMOTE_PERSONAL_REF = `refs/remotes/origin/members/${MEMBER_ID}`;
const REMOTE_MAIN_REF = 'refs/remotes/origin/main';

jest.setTimeout(30_000);

describe('NativeGitAcceptedStateIntegrator', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
  });

  it('fast-forwards only the current personal branch and suppresses repository hooks', async () => {
    const harness = await createHarness('fast-forward');
    const marker = path.join(root, 'hostile-hook-ran');
    const hook = path.join(harness.repositoryPath, '.git', 'hooks', 'post-merge');
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\nprintf hostile > "${marker}"\n`);
    await chmod(hook, 0o755);

    await expect(harness.integrator.plan(
      harness.context,
      harness.snapshot,
      'reconcile-ff',
    )).resolves.toEqual({ kind: 'fast-forward' });
    const result = await harness.integrator.fastForward(
      harness.context,
      harness.snapshot,
    );

    expect(result).toMatchObject({
      kind: 'fast-forwarded',
      snapshot: {
        acceptedMainOid: harness.mainOid,
        headOid: harness.mainOid,
        personalBehindBy: 0,
        workingTreeClean: true,
      },
    });
    expect(await harness.git.resolveRef(harness.repositoryPath, PERSONAL_REF))
      .toBe(harness.mainOid);
    expect(await readFile(path.join(harness.repositoryPath, 'accepted.md'), 'utf8'))
      .toBe('accepted\n');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('classifies a clean divergence without integrating or touching refs', async () => {
    const harness = await createHarness('divergent-clean');
    const unrelatedRef = 'refs/heads/members/member-other';
    await harness.git.createRef(harness.repositoryPath, unrelatedRef, harness.baseOid);

    await expect(harness.integrator.plan(
      harness.context,
      harness.snapshot,
      'reconcile-clean',
    )).resolves.toEqual({ kind: 'diverged' });
    await expect(harness.integrator.fastForward(
      harness.context,
      harness.snapshot,
    )).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'reconciliation-contribution-present' },
    });

    expect(await harness.git.resolveRef(harness.repositoryPath, PERSONAL_REF))
      .toBe(harness.personalOid);
    await expect(readFile(path.join(harness.repositoryPath, 'accepted.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(harness.repositoryPath, 'personal.md'), 'utf8'))
      .toBe('personal\n');
    expect(await harness.git.resolveRef(harness.repositoryPath, unrelatedRef))
      .toBe(harness.baseOid);
  });

  it('returns conflict paths without writing markers or moving the personal ref', async () => {
    const harness = await createHarness('conflicting');

    const plan = await harness.integrator.plan(
      harness.context,
      harness.snapshot,
      'reconcile-conflict',
    );

    expect(plan).toMatchObject({
      conflict: {
        conflicts: [{ kind: 'text', path: 'note.md' }],
        mergeBaseOid: harness.baseOid,
        operationId: 'reconcile-conflict',
        startingMainOid: harness.mainOid,
        startingPersonalOid: harness.personalOid,
      },
      kind: 'conflicting',
    });
    expect(await harness.git.resolveRef(harness.repositoryPath, PERSONAL_REF))
      .toBe(harness.personalOid);
    expect(await readFile(path.join(harness.repositoryPath, 'note.md'), 'utf8'))
      .toBe('personal\n');
    expect(await harness.git.getWorkingTreeStatus(harness.repositoryPath)).toEqual([]);
  });

  it('classifies a delete-modify conflict whose path contains spaces', async () => {
    const harness = await createHarness('delete-modify-space');

    await expect(harness.integrator.plan(
      harness.context,
      harness.snapshot,
      'reconcile-delete-modify',
    )).resolves.toMatchObject({
      conflict: {
        conflicts: [{ kind: 'delete-modify', path: 'note with spaces.md' }],
      },
      kind: 'conflicting',
    });
    expect(await harness.git.resolveRef(harness.repositoryPath, PERSONAL_REF))
      .toBe(harness.personalOid);
    await expect(readFile(
      path.join(harness.repositoryPath, 'note with spaces.md'),
      'utf8',
    )).resolves.toBe('personal\n');
  });

  it('revalidates refs and repository locks immediately before mutation', async () => {
    const locked = await createHarness('fast-forward');
    await writeFile(path.join(locked.repositoryPath, '.git', 'index.lock'), 'busy');
    await expect(locked.integrator.fastForward(
      locked.context,
      locked.snapshot,
    )).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'reconciliation-repository-lock' },
    });
    await rm(path.join(locked.repositoryPath, '.git', 'index.lock'));

    const personalLock = path.join(
      locked.repositoryPath,
      '.git',
      'refs',
      'heads',
      'members',
      `${MEMBER_ID}.lock`,
    );
    await writeFile(personalLock, 'busy');
    await expect(locked.integrator.fastForward(
      locked.context,
      locked.snapshot,
    )).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'reconciliation-repository-lock' },
    });
    await rm(personalLock);

    await locked.git.compareAndSwapRef(
      locked.repositoryPath,
      REMOTE_PERSONAL_REF,
      locked.mainOid,
      locked.personalOid,
    );
    await expect(locked.integrator.fastForward(
      locked.context,
      locked.snapshot,
    )).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'reconciliation-repository-state-changed' },
    });
    expect(await locked.git.resolveRef(locked.repositoryPath, PERSONAL_REF))
      .toBe(locked.personalOid);
  });

  it('honors cancellation before merge analysis or mutation', async () => {
    const harness = await createHarness('divergent-clean');
    const controller = new AbortController();
    controller.abort();

    await expect(harness.integrator.plan(
      harness.context,
      harness.snapshot,
      'reconcile-cancelled',
      controller.signal,
    )).rejects.toMatchObject({ code: 'cancelled' });
    expect(await harness.git.resolveRef(harness.repositoryPath, PERSONAL_REF))
      .toBe(harness.personalOid);
  });

  it('never resets or overwrites uncommitted content discovered before mutation', async () => {
    const harness = await createHarness('fast-forward');
    const localPath = path.join(harness.repositoryPath, 'local-draft.md');
    await writeFile(localPath, 'keep me\n');

    await expect(harness.integrator.fastForward(
      harness.context,
      harness.snapshot,
    )).rejects.toMatchObject({
      code: 'working-tree-busy',
      safeContext: { reason: 'reconciliation-repository-state-changed' },
    });
    await expect(readFile(localPath, 'utf8')).resolves.toBe('keep me\n');
    expect(await harness.git.resolveRef(harness.repositoryPath, PERSONAL_REF))
      .toBe(harness.personalOid);
  });

  async function createHarness(
    scenario: 'conflicting' | 'delete-modify-space' | 'divergent-clean' | 'fast-forward',
  ) {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-reconciliation-'));
    const repositoryPath = path.join(root, 'project');
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available') throw new Error('Native Git is required');
    const runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    });
    const git = new GitRepositoryService(runner);
    await mkdir(repositoryPath, { recursive: true });
    await git.initializeWorkingRepository(repositoryPath);
    await git.configureLocalRepository(repositoryPath, {
      memberId: MEMBER_ID,
      personalRef: PERSONAL_REF,
      projectId: 'project-a',
      userDisplayName: 'Member A',
    });
    const conflictPath = scenario === 'delete-modify-space'
      ? 'note with spaces.md'
      : 'note.md';
    await writeFile(path.join(repositoryPath, conflictPath), 'base\n');
    await git.stageAll(repositoryPath);
    const baseOid = await git.createCommitFromIndex(repositoryPath, {
      expectedRefOid: null,
      message: 'Base',
      parents: [],
      ref: 'refs/heads/main',
    });
    await git.createRef(repositoryPath, PERSONAL_REF, baseOid);

    if (scenario === 'conflicting') {
      await writeFile(path.join(repositoryPath, conflictPath), 'accepted\n');
    } else if (scenario === 'delete-modify-space') {
      await rm(path.join(repositoryPath, conflictPath));
    } else {
      await writeFile(path.join(repositoryPath, 'accepted.md'), 'accepted\n');
    }
    await git.stageAll(repositoryPath);
    const mainOid = await git.createCommitFromIndex(repositoryPath, {
      expectedRefOid: baseOid,
      message: 'Accepted change',
      parents: [baseOid],
      ref: 'refs/heads/main',
    });
    await runner.run({
      args: ['switch', '--quiet', `members/${MEMBER_ID}`],
      cwd: repositoryPath,
    });

    let personalOid = baseOid;
    if (scenario !== 'fast-forward') {
      if (scenario === 'conflicting' || scenario === 'delete-modify-space') {
        await writeFile(path.join(repositoryPath, conflictPath), 'personal\n');
      } else {
        await writeFile(path.join(repositoryPath, 'personal.md'), 'personal\n');
      }
      await git.stageAll(repositoryPath);
      personalOid = await git.createCommitFromIndex(repositoryPath, {
        expectedRefOid: baseOid,
        message: 'Personal change',
        parents: [baseOid],
        ref: PERSONAL_REF,
      });
    }
    await git.createRef(repositoryPath, REMOTE_MAIN_REF, mainOid);
    await git.createRef(repositoryPath, REMOTE_PERSONAL_REF, personalOid);
    const snapshot: PublishRepositorySnapshot = {
      acceptedMainOid: mainOid,
      changedFiles: [],
      headOid: personalOid,
      includesAcceptedMain: false,
      personalAheadBy: 0,
      personalBehindBy: 0,
      personalRemoteOid: personalOid,
      workingTreeClean: true,
    };
    const context = {
      memberId: MEMBER_ID,
      personalRef: PERSONAL_REF,
      projectId: 'project-a',
      remoteUrl: 'https://127.0.0.1/repository.git',
      repositoryPath,
    };
    return {
      baseOid,
      context,
      git,
      integrator: new NativeGitAcceptedStateIntegrator(git, runner),
      mainOid,
      personalOid,
      repositoryPath,
      runner,
      snapshot,
    };
  }
});
