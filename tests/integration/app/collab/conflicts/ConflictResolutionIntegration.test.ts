import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
import { NativeGitPublicationCandidateRepository } from '@/app/collab/publish/NativeGitPublicationCandidateRepository';
import type { PublishProjectContext, PublishRepositorySnapshot } from '@/app/collab/publish/PublishCoordinator';
import { NativeGitAcceptedStateIntegrator } from '@/app/collab/reconciliation/NativeGitAcceptedStateIntegrator';
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

  it.each(['personal-file', 'personal-directory'] as const)(
    'keeps a %s collision readable while the user renames their path and continues',
    async scenario => {
      const harness = await createHarness(scenario);
      const { context, descriptor, git, runner } = harness;
      expect(descriptor.conflicts).toEqual([{ kind: 'directory-file', path: 'notes' }]);
      await expect(harness.coordinator.start(descriptor)).resolves.toMatchObject({ status: 'success' });
      await expect(harness.coordinator.readFile({ operationId: descriptor.operationId, path: 'notes' }))
        .resolves.toEqual({ status: 'success', value: { kind: 'directory-file', path: 'notes' } });
      await rename(path.join(context.repositoryPath, 'notes'), path.join(context.repositoryPath, 'personal-notes'));
      await expect(harness.createCoordinator().findProject(context.projectId))
        .resolves.toMatchObject({ status: 'success', value: { descriptor } });

      await git.stageAll(context.repositoryPath);
      const personalOid = await git.createCommitFromIndex(context.repositoryPath, {
        expectedRefOid: descriptor.startingPersonalOid,
        message: 'Rename conflicting personal path',
        parents: [descriptor.startingPersonalOid],
        ref: context.personalRef,
      });
      const snapshot = { ...harness.snapshot, headOid: personalOid, personalAheadBy: 1 };
      await expect(harness.integrator.plan(context, snapshot, descriptor.operationId))
        .resolves.toEqual({ kind: 'diverged' });
      const candidates = new NativeGitPublicationCandidateRepository(git, runner);
      const input = {
        contributionHeadOid: personalOid,
        currentMainOid: descriptor.startingMainOid,
        operationId: descriptor.operationId,
      };
      const candidateOid = await candidates.prepare(context, input);
      await candidates.apply(context, snapshot, { ...input, candidateOid });
      const personalPath = scenario === 'personal-file' ? 'personal-notes' : 'personal-notes/personal.md';
      const acceptedPath = scenario === 'personal-file' ? 'notes/accepted.md' : 'notes';
      await expect(readFile(path.join(context.repositoryPath, personalPath), 'utf8')).resolves.toBe('personal\n');
      await expect(readFile(path.join(context.repositoryPath, acceptedPath), 'utf8')).resolves.toBe('accepted\n');
    },
  );

  async function createHarness(scenario: 'text' | 'personal-file' | 'personal-directory' = 'text') {
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
    if (scenario === 'personal-file') {
      await mkdir(path.join(repositoryPath, 'notes'));
      await writeFile(path.join(repositoryPath, 'notes', 'accepted.md'), 'accepted\n');
    } else {
      await writeFile(path.join(repositoryPath, scenario === 'text' ? 'note.md' : 'notes'), 'accepted\n');
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
    if (scenario === 'personal-directory') {
      await mkdir(path.join(repositoryPath, 'notes'));
      await writeFile(path.join(repositoryPath, 'notes', 'personal.md'), 'personal\n');
    } else {
      await writeFile(path.join(repositoryPath, scenario === 'text' ? 'note.md' : 'notes'), 'personal\n');
    }
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
    const integrator = new NativeGitAcceptedStateIntegrator(git, runner);
    const plan = await integrator.plan(context, snapshot, 'operation-a');
    if (plan.kind !== 'conflicting') throw new Error('Expected a conflict');
    const descriptor: CollabConflictDescriptor = plan.conflict;
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
      isResolutionRetained: jest.fn(async () => false),
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
      integrator,
      runner,
      scratch,
      snapshot,
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
