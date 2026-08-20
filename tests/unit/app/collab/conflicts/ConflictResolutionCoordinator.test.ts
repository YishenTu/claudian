import {
  type ConflictPublicationPort,
  ConflictResolutionCoordinator,
  type ConflictResolutionProjectPort,
  type ConflictResolutionSafetyPort,
  type ConflictScratchGitPort,
  type ConflictScratchStorePort,
} from '@/app/collab/conflicts/ConflictResolutionCoordinator';
import {
  COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
  type ConflictResolutionRecord,
} from '@/app/collab/conflicts/ConflictResolutionRecord';
import type { PublishProjectContext } from '@/app/collab/publish/PublishCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PERSONAL = '1'.repeat(40);
const MAIN = '2'.repeat(40);
const BASE = '3'.repeat(40);
const RESULT = '4'.repeat(40);
const CONTEXT: PublishProjectContext = {
  allowHostRemoteRepair: false,
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://127.0.0.1/repository.git',
  repositoryPath: '/vault/workspace/project-a',
};
const DESCRIPTOR = {
  conflicts: [
    { kind: 'text' as const, path: 'note.md' },
    { kind: 'binary' as const, path: 'image.bin' },
  ],
  mergeBaseOid: BASE,
  operationId: 'operation-a',
  projectId: CONTEXT.projectId,
  startingMainOid: MAIN,
  startingPersonalOid: PERSONAL,
};

describe('ConflictResolutionCoordinator', () => {
  it('creates one decision-free resumable scratch session', async () => {
    const { git, store, subject } = createSubject();

    await expect(subject.start(DESCRIPTOR)).resolves.toEqual({
      status: 'success',
      value: { descriptor: DESCRIPTOR },
    });
    expect(store.value).toMatchObject({ descriptor: DESCRIPTOR, phase: 'ready' });
    expect(store.value).not.toHaveProperty('decisions');
    expect(git.prepare).toHaveBeenCalledTimes(1);
  });

  it('recreates invalid derived scratch state without replaying local choices', async () => {
    const { git, store, subject } = createSubject();
    store.value = record();
    git.prepared = false;

    await expect(subject.read('operation-a')).resolves.toEqual({
      status: 'success',
      value: { descriptor: DESCRIPTOR },
    });
    expect(store.recreateRepository).toHaveBeenCalledTimes(1);
    expect(git.prepare).toHaveBeenCalledTimes(1);
    expect(git.resolveWithPersonalVersions).not.toHaveBeenCalled();
  });

  it('uses the committed working tree as the sole resolution input', async () => {
    const { git, publication, safety, store, subject } = createSubject();
    store.value = record();

    await expect(subject.prepareWorkingTreeResolution(DESCRIPTOR)).resolves.toMatchObject({
      status: 'success',
      value: {
        descriptor: DESCRIPTOR,
        publicationReview: expect.objectContaining({ candidateOid: RESULT }),
      },
    });
    expect(git.resolveWithPersonalVersions).toHaveBeenCalledWith(
      '/scratch/repository',
      DESCRIPTOR,
    );
    expect(git.createResolutionCommit).toHaveBeenCalledWith(
      '/scratch/repository',
      DESCRIPTOR,
      ['note.md', 'image.bin'],
    );
    expect(safety.assertSafe).toHaveBeenCalledWith(CONTEXT);
    expect(git.retainResultForPublication).toHaveBeenCalledWith(
      CONTEXT,
      '/scratch/repository',
      DESCRIPTOR,
      RESULT,
      undefined,
      expect.any(Function),
    );
    expect(publication.prepareResolvedReview).toHaveBeenCalledWith(CONTEXT, {
      candidateOid: RESULT,
      contributionHeadOid: PERSONAL,
      currentMainOid: MAIN,
      operationId: 'operation-a',
    }, undefined);
    expect(store.remove).toHaveBeenCalledWith('operation-a');
  });

  it('keeps blocking collisions readable until the working tree changes', async () => {
    const { git, store, subject } = createSubject();
    const descriptor = {
      ...DESCRIPTOR,
      conflicts: [
        { kind: 'text' as const, path: 'note.md' },
        { kind: 'directory-file' as const, path: 'docs' },
      ],
    };
    store.value = record();

    await expect(subject.prepareWorkingTreeResolution(descriptor)).resolves.toEqual({
      status: 'success',
      value: { descriptor },
    });
    expect(store.value).toMatchObject({ descriptor, phase: 'ready' });
    expect(git.resolveWithPersonalVersions).not.toHaveBeenCalled();
    expect(git.createResolutionCommit).not.toHaveBeenCalled();
  });

  it('resumes a committed result without rebuilding it', async () => {
    const { git, store, subject } = createSubject();
    store.value = record({ phase: 'committed', resultCommitOid: RESULT });

    await expect(subject.prepareWorkingTreeResolution(DESCRIPTOR))
      .resolves.toMatchObject({ status: 'success' });
    expect(git.prepare).not.toHaveBeenCalled();
    expect(git.resolveWithPersonalVersions).not.toHaveBeenCalled();
    expect(git.createResolutionCommit).not.toHaveBeenCalled();
    expect(git.retainResultForPublication).toHaveBeenCalled();
  });

  it('maps stale committed recovery and pre-progress cancellation safely', async () => {
    const { git, store, subject } = createSubject();
    store.value = record({ phase: 'committed', resultCommitOid: RESULT });
    git.retainResultForPublication.mockRejectedValueOnce(new CollabError({
      code: 'working-tree-busy',
      safeContext: { reason: 'conflict-project-state-changed' },
    }));

    const stale = await subject.prepareWorkingTreeResolution(DESCRIPTOR);
    expect(stale).toMatchObject({ staleKind: 'working-copy', status: 'stale' });
    expect(JSON.stringify(stale)).not.toContain('/vault/');

    const controller = new AbortController();
    controller.abort();
    await expect(subject.read('operation-a', { signal: controller.signal }))
      .resolves.toEqual({ durableProgress: false, status: 'cancelled' });
  });
});

function record(
  overrides: Partial<ConflictResolutionRecord> = {},
): ConflictResolutionRecord {
  return {
    createdAt: '2026-08-08T00:00:00.000Z',
    descriptor: DESCRIPTOR,
    operationId: DESCRIPTOR.operationId,
    phase: 'ready',
    projectId: DESCRIPTOR.projectId,
    resultCommitOid: null,
    schemaVersion: COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

function createSubject() {
  const projects = {
    load: jest.fn(async () => CONTEXT),
    revalidate: jest.fn(async () => undefined),
  } satisfies ConflictResolutionProjectPort;
  const storeState = { value: null as ConflictResolutionRecord | null };
  const store = {
    get value() { return storeState.value; },
    set value(value: ConflictResolutionRecord | null) { storeState.value = value; },
    list: jest.fn(async () => storeState.value ? [storeState.value] : []),
    load: jest.fn(async () => storeState.value),
    recreateRepository: jest.fn(async () => '/scratch/repository'),
    remove: jest.fn(async () => true),
    repositoryPath: jest.fn(async () => '/scratch/repository'),
    save: jest.fn(async (value: ConflictResolutionRecord) => {
      storeState.value = value;
    }),
  } satisfies ConflictScratchStorePort & { value: ConflictResolutionRecord | null };
  const gitState = { prepared: true };
  const git = {
    get prepared() { return gitState.prepared; },
    set prepared(value: boolean) { gitState.prepared = value; },
    createResolutionCommit: jest.fn(async () => RESULT),
    inspect: jest.fn(async () => ({
      acceptedMainOid: MAIN,
      personalOid: PERSONAL,
      stages: [],
    })),
    isPrepared: jest.fn(async () => gitState.prepared),
    prepare: jest.fn(async () => ({
      acceptedMainOid: MAIN,
      personalOid: PERSONAL,
      stages: [],
    })),
    readBlobAtPath: jest.fn(async (
      _scratchPath: string,
      oid: string,
      _repositoryPath: string,
    ): Promise<Buffer | null> => Buffer.from(
      oid === BASE ? 'base\n' : oid === PERSONAL ? 'personal\n' : 'accepted\n',
    )),
    readStage: jest.fn(),
    readTextMergeSegments: jest.fn(async () => []),
    resolveWithPersonalVersions: jest.fn(async () => ({
      acceptedMainOid: MAIN,
      personalOid: PERSONAL,
      stages: [],
    })),
    retainResultForPublication: jest.fn(async () => undefined),
  } satisfies ConflictScratchGitPort & { prepared: boolean };
  const safety = {
    assertSafe: jest.fn(async () => undefined),
  } satisfies ConflictResolutionSafetyPort;
  const publication = {
    prepareResolvedReview: jest.fn(async (_context, input) => ({
      baseMainOid: BASE,
      candidateOid: input.candidateOid,
      canConfirm: true,
      comparisonBaseOid: input.currentMainOid,
      comparisonTargetOid: input.candidateOid,
      contributionHeadOid: input.contributionHeadOid,
      currentMainOid: input.currentMainOid,
      files: [],
      kind: 'publication' as const,
      operationId: input.operationId,
      projectId: CONTEXT.projectId,
    })),
  } satisfies ConflictPublicationPort;
  const subject = new ConflictResolutionCoordinator(
    projects,
    store,
    git,
    safety,
    publication,
    { now: () => new Date('2026-08-08T00:00:00.000Z') },
  );
  return { git, publication, safety, store, subject };
}
