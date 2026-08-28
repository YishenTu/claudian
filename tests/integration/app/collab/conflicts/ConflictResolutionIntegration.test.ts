import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import {
  type ConflictPublicationPort,
  ConflictResolutionCoordinator,
  type ConflictResolutionProjectPort,
} from '@/app/collab/conflicts/ConflictResolutionCoordinator';
import { decodeConflictResolutionRecord } from '@/app/collab/conflicts/ConflictResolutionRecord';
import { ConflictScratchGitRepository } from '@/app/collab/conflicts/ConflictScratchGitRepository';
import { ConflictScratchStore } from '@/app/collab/conflicts/ConflictScratchStore';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';
import type { CollabConflictDescriptor } from '@/core/collab';

jest.setTimeout(30_000);

describe('ConflictResolution integration', () => {
  let vaultRoot = '';

  afterEach(async () => {
    if (vaultRoot) await rm(vaultRoot, { force: true, recursive: true });
  });

  it('recreates derived scratch state and retains the working-tree result for review', async () => {
    const harness = await createHarness();

    await expect(harness.coordinator.start(harness.descriptor)).resolves.toMatchObject({
      status: 'success',
      value: { descriptor: harness.descriptor },
    });
    await expect(harness.coordinator.readFile({
      operationId: harness.descriptor.operationId,
      path: 'note.md',
    })).resolves.toEqual({
      status: 'success',
      value: {
        accepted: { path: 'note.md', text: 'accepted\n' },
        base: { path: 'note.md', text: 'base\n' },
        kind: 'text',
        path: 'note.md',
        personal: { path: 'note.md', text: 'personal\n' },
        segments: [{
          accepted: 'accepted\n',
          base: 'base\n',
          id: 'hunk-1',
          kind: 'conflict',
          personal: 'personal\n',
        }],
      },
    });
    await expect(readFile(path.join(harness.context.repositoryPath, 'note.md'), 'utf8'))
      .resolves.toBe('personal\n');
    expect(await harness.git.getWorkingTreeStatus(harness.context.repositoryPath)).toEqual([]);

    const interruptedScratch = await harness.store.repositoryPath(
      harness.descriptor.operationId,
    );
    await rm(interruptedScratch, { recursive: true });
    const resumed = harness.createCoordinator();
    await expect(resumed.read(harness.descriptor.operationId)).resolves.toMatchObject({
      status: 'success',
      value: { descriptor: harness.descriptor },
    });
    await expect(readFile(path.join(harness.context.repositoryPath, 'note.md'), 'utf8'))
      .resolves.toBe('personal\n');

    await expect(resumed.prepareWorkingTreeResolution(harness.descriptor))
      .resolves.toMatchObject({
      status: 'success',
      value: {
        publicationReview: expect.objectContaining({ kind: 'publication' }),
      },
    });
    const resultOid = await harness.git.resolveRef(
      harness.context.repositoryPath,
      `refs/claudian/publications/${harness.descriptor.operationId}`,
    );
    expect(resultOid).not.toBeNull();
    expect(await harness.git.resolveRef(
      harness.context.repositoryPath,
      harness.context.personalRef,
    )).toBe(harness.descriptor.startingPersonalOid);
    await expect(readFile(path.join(harness.context.repositoryPath, 'note.md'), 'utf8'))
      .resolves.toBe('personal\n');
    expect(await harness.git.getWorkingTreeStatus(harness.context.repositoryPath)).toEqual([]);
    await expect(showParents(
      harness.runner,
      harness.context.repositoryPath,
      resultOid!,
    )).resolves.toBe(
      `${harness.descriptor.startingPersonalOid} ${harness.descriptor.startingMainOid}`,
    );
    await expect(harness.store.load(harness.descriptor.operationId)).resolves.toBeNull();
  });

  it('recovers when result retention completed before state finalization', async () => {
    const harness = await createHarness();
    await harness.coordinator.start(harness.descriptor);
    const record = (await harness.store.load(harness.descriptor.operationId))!;
    const scratchPath = await harness.store.repositoryPath(harness.descriptor.operationId);
    await harness.scratch.resolveWithPersonalVersions(scratchPath, harness.descriptor);
    const resultOid = await harness.scratch.createResolutionCommit(
      scratchPath,
      harness.descriptor,
      ['note.md'],
    );
    await harness.store.save(decodeConflictResolutionRecord({
      ...record,
      phase: 'committed',
      resultCommitOid: resultOid,
    }));
    await harness.scratch.retainResultForPublication(
      harness.context,
      scratchPath,
      harness.descriptor,
      resultOid,
    );

    await expect(harness.createCoordinator().prepareWorkingTreeResolution(harness.descriptor))
      .resolves.toMatchObject({ status: 'success' });
    expect(await harness.git.resolveRef(
      harness.context.repositoryPath,
      harness.context.personalRef,
    )).toBe(harness.descriptor.startingPersonalOid);
    expect(await harness.git.resolveRef(
      harness.context.repositoryPath,
      `refs/claudian/publications/${harness.descriptor.operationId}`,
    )).toBe(resultOid);
    await expect(harness.store.load(harness.descriptor.operationId)).resolves.toBeNull();
  });

  async function createHarness() {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-conflict-flow-'));
    const repositoryPath = path.join(vaultRoot, 'workspace', 'project-a');
    const emptyConfigPath = path.join(vaultRoot, 'empty.gitconfig');
    await mkdir(repositoryPath, { recursive: true });
    await writeFile(emptyConfigPath, '');
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
    await writeFile(path.join(repositoryPath, 'note.md'), 'base\n');
    await git.stageAll(repositoryPath);
    const baseOid = await git.createCommitFromIndex(repositoryPath, {
      expectedRefOid: null,
      message: 'Base',
      parents: [],
      ref: 'refs/heads/main',
    });
    const personalRef = 'refs/heads/members/member-a';
    await git.createRef(repositoryPath, personalRef, baseOid);
    await writeFile(path.join(repositoryPath, 'note.md'), 'accepted\n');
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
    await writeFile(path.join(repositoryPath, 'note.md'), 'personal\n');
    await git.stageAll(repositoryPath);
    const personalOid = await git.createCommitFromIndex(repositoryPath, {
      expectedRefOid: baseOid,
      message: 'Personal',
      parents: [baseOid],
      ref: personalRef,
    });
    await git.createRef(repositoryPath, 'refs/remotes/origin/main', mainOid);
    await git.createRef(
      repositoryPath,
      'refs/remotes/origin/members/member-a',
      personalOid,
    );
    const context: PublishProjectContext = {
      memberId: 'member-a',
      personalRef,
      projectId: 'project-a',
      remoteUrl: 'https://127.0.0.1/repository.git',
      repositoryPath,
    };
    const descriptor: CollabConflictDescriptor = {
      conflicts: [{ kind: 'text', path: 'note.md' }],
      mergeBaseOid: baseOid,
      operationId: 'operation-a',
      projectId: context.projectId,
      startingMainOid: mainOid,
      startingPersonalOid: personalOid,
    };
    const projects = {
      load: jest.fn(async () => context),
      revalidate: jest.fn(async () => undefined),
    } satisfies ConflictResolutionProjectPort;
    const store = new ConflictScratchStore(
      vaultRoot,
      new CollabLocalProjectRepository(vaultRoot),
    );
    const scratch = new ConflictScratchGitRepository(git, runner);
    const safety = { assertSafe: jest.fn(async () => undefined) };
    const publication = {
      prepareResolvedReview: jest.fn(async (_context, input) => ({
        baseMainOid: descriptor.mergeBaseOid,
        candidateOid: input.candidateOid,
        canConfirm: true,
        comparisonBaseOid: input.currentMainOid,
        comparisonTargetOid: input.candidateOid,
        contributionHeadOid: input.contributionHeadOid,
        currentMainOid: input.currentMainOid,
        files: [],
        kind: 'publication' as const,
        operationId: input.operationId,
        projectId: context.projectId,
      })),
    } satisfies ConflictPublicationPort;
    const createCoordinator = () => new ConflictResolutionCoordinator(
      projects,
      store,
      scratch,
      safety,
      publication,
    );
    return {
      context,
      coordinator: createCoordinator(),
      createCoordinator,
      descriptor,
      git,
      runner,
      scratch,
      store,
    };
  }
});

async function showParents(
  runner: GitCommandRunner,
  repositoryPath: string,
  oid: string,
): Promise<string> {
  const result = await runner.run({
    args: ['show', '-s', '--format=%P', oid],
    cwd: repositoryPath,
  });
  return result.stdout.toString('utf8').trim();
}
