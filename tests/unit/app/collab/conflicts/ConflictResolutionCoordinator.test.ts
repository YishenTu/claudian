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
  it('creates a ready resumable scratch session from an immutable descriptor', async () => {
    const { git, store, subject } = createSubject();

    await expect(subject.start(DESCRIPTOR)).resolves.toMatchObject({
      status: 'success',
      value: {
        pending: DESCRIPTOR.conflicts,
        resolvedPaths: [],
      },
    });
    expect(store.value).toMatchObject({ phase: 'ready', descriptor: DESCRIPTOR });
    expect(store.value).not.toHaveProperty('scratchPath');
    expect(git.prepare).toHaveBeenCalledTimes(1);
  });

  it('recreates invalid scratch state and replays durable decisions on restart', async () => {
    const { git, store, subject } = createSubject();
    store.value = record({
      decisions: [{ choice: 'keep-personal', path: 'note.md' }],
      phase: 'ready',
    });
    git.prepared = false;

    await expect(subject.read('operation-a')).resolves.toMatchObject({
      status: 'success',
      value: { resolvedPaths: ['note.md'] },
    });
    expect(store.recreateRepository).toHaveBeenCalledTimes(1);
    expect(git.applyDecision).toHaveBeenCalledWith(
      '/scratch/repository',
      DESCRIPTOR,
      { choice: 'keep-personal', path: 'note.md' },
      [],
    );
  });

  it('discovers the one durable Project conflict after application restart', async () => {
    const { store, subject } = createSubject();
    store.value = record();

    await expect(subject.findProject(CONTEXT.projectId)).resolves.toMatchObject({
      status: 'success',
      value: { descriptor: DESCRIPTOR },
    });
    await expect(subject.findProject('project-b')).resolves.toEqual({
      status: 'success',
      value: null,
    });
  });

  it('persists reviewed decisions but does not finalize without explicit Apply', async () => {
    const { git, store, subject } = createSubject();
    store.value = record();

    await expect(subject.resolve({
      decisions: [{ choice: 'use-manual-draft', draft: 'resolved\n', path: 'note.md' }],
      finalize: false,
      operationId: 'operation-a',
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        pending: [{ kind: 'binary', path: 'image.bin' }],
        resolvedPaths: ['note.md'],
      },
    });
    expect(store.value?.decisions).toEqual([
      { choice: 'use-manual-draft', draft: 'resolved\n', path: 'note.md' },
    ]);
    expect(git.createResolutionCommit).not.toHaveBeenCalled();
    expect(git.retainResultForPublication).not.toHaveBeenCalled();
  });

  it('commits, retains, and prepares final review without applying the result', async () => {
    const { git, publication, safety, store, subject } = createSubject();
    store.value = record();

    await expect(subject.resolve({
      decisions: [
        { choice: 'use-agent-proposal', path: 'note.md', proposal: 'proposal\n' },
        { choice: 'use-accepted', path: 'image.bin' },
      ],
      finalize: true,
      operationId: 'operation-a',
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        pending: [],
        publicationReview: expect.objectContaining({ candidateOid: RESULT }),
        resolvedPaths: ['note.md', 'image.bin'],
      },
    });
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

  it('uses the committed working-tree version for every remaining selectable conflict', async () => {
    const { git, store, subject } = createSubject();
    store.value = record();

    await expect(subject.prepareWorkingTreeResolution(DESCRIPTOR)).resolves.toMatchObject({
      status: 'success',
      value: {
        publicationReview: expect.objectContaining({ candidateOid: RESULT }),
      },
    });

    expect(git.applyDecision).toHaveBeenNthCalledWith(1,
      '/scratch/repository',
      DESCRIPTOR,
      { choice: 'keep-personal', path: 'note.md' },
      [],
    );
    expect(git.applyDecision).toHaveBeenNthCalledWith(2,
      '/scratch/repository',
      DESCRIPTOR,
      { choice: 'keep-personal', path: 'image.bin' },
      ['note.md'],
    );
  });

  it('keeps blocking collisions readable until Project files change', async () => {
    const { git, store, subject } = createSubject();
    const descriptor = {
      ...DESCRIPTOR,
      conflicts: [
        { kind: 'text' as const, path: 'note.md' },
        { kind: 'directory-file' as const, path: 'docs' },
      ],
    };
    store.value = record();

    const result = await subject.prepareWorkingTreeResolution(descriptor);
    expect(result).toMatchObject({
      status: 'success',
      value: {
        descriptor,
      },
    });
    expect(result.status === 'success' && result.value.publicationReview).toBeUndefined();

    expect(store.value).toMatchObject({
      decisions: [{ choice: 'keep-personal', path: 'note.md' }],
      descriptor,
    });
    expect(git.createResolutionCommit).not.toHaveBeenCalled();
  });

  it('resumes a committed result without rebuilding or creating another commit', async () => {
    const { git, store, subject } = createSubject();
    store.value = record({
      decisions: [
        { choice: 'keep-personal', path: 'note.md' },
        { choice: 'use-accepted', path: 'image.bin' },
      ],
      phase: 'committed',
      resultCommitOid: RESULT,
    });

    await expect(subject.resolve({
      decisions: [],
      finalize: true,
      operationId: 'operation-a',
    })).resolves.toMatchObject({ status: 'success' });
    expect(git.prepare).not.toHaveBeenCalled();
    expect(git.createResolutionCommit).not.toHaveBeenCalled();
    expect(git.retainResultForPublication).toHaveBeenCalled();
  });

  it('reads immutable text versions after a saved decision for UI restart', async () => {
    const { git, store, subject } = createSubject();
    store.value = record({
      decisions: [{ choice: 'keep-personal', path: 'note.md' }],
    });

    await expect(subject.readFile({
      operationId: 'operation-a',
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
    expect(git.readBlobAtPath).toHaveBeenCalledWith(
      '/scratch/repository',
      PERSONAL,
      'note.md',
    );
  });

  it('returns product-safe binary side metadata without exposing blob bytes', async () => {
    const { git, store, subject } = createSubject();
    store.value = record();
    git.readBlobAtPath.mockImplementation(async (_path, _oid, filePath) => (
      filePath === 'image.bin' ? Buffer.from([1, 2, 3]) : null
    ));

    await expect(subject.readFile({
      operationId: 'operation-a',
      path: 'image.bin',
    })).resolves.toEqual({
      status: 'success',
      value: {
        accepted: { bytes: 3, exists: true, path: 'image.bin' },
        base: { bytes: 3, exists: true, path: 'image.bin' },
        kind: 'binary',
        path: 'image.bin',
        personal: { bytes: 3, exists: true, path: 'image.bin' },
      },
    });
    expect(JSON.stringify(await subject.readFile({
      operationId: 'operation-a',
      path: 'image.bin',
    }))).not.toContain('"data"');
  });

  it('maps stale finalization and cancellation without leaking local paths', async () => {
    const { git, store, subject } = createSubject();
    store.value = record({
      decisions: [
        { choice: 'keep-personal', path: 'note.md' },
        { choice: 'use-accepted', path: 'image.bin' },
      ],
      phase: 'committed',
      resultCommitOid: RESULT,
    });
    git.retainResultForPublication.mockRejectedValueOnce(new CollabError({
      code: 'working-tree-busy',
      safeContext: { reason: 'conflict-project-state-changed' },
    }));

    const stale = await subject.resolve({
      decisions: [],
      finalize: true,
      operationId: 'operation-a',
    });
    expect(stale).toMatchObject({ staleKind: 'working-copy', status: 'stale' });
    expect(JSON.stringify(stale)).not.toContain('/vault/');

    const controller = new AbortController();
    controller.abort();
    await expect(subject.read('operation-a', {
      signal: controller.signal,
    })).resolves.toEqual({ durableProgress: false, status: 'cancelled' });
  });
});

function record(
  overrides: Partial<ConflictResolutionRecord> = {},
): ConflictResolutionRecord {
  return {
    createdAt: '2026-08-08T00:00:00.000Z',
    decisions: [],
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
    applyDecision: jest.fn(async () => ({
      acceptedMainOid: MAIN,
      personalOid: PERSONAL,
      stages: [],
    })),
    retainResultForPublication: jest.fn(async () => undefined),
    createResolutionCommit: jest.fn(async () => RESULT),
    inspect: jest.fn(async () => ({
      acceptedMainOid: MAIN,
      personalOid: PERSONAL,
      stages: [
        { mode: '100644' as const, oid: BASE, path: 'note.md', stage: 1 as const },
        { mode: '100644' as const, oid: PERSONAL, path: 'note.md', stage: 2 as const },
        { mode: '100644' as const, oid: MAIN, path: 'note.md', stage: 3 as const },
      ],
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
    readStage: jest.fn(async (
      _scratchPath,
      _inspection,
      _path,
      stage,
    ) => Buffer.from(stage === 1 ? 'base\n' : stage === 2 ? 'personal\n' : 'accepted\n')),
    readTextMergeSegments: jest.fn(async () => [{
      accepted: 'accepted\n',
      base: 'base\n',
      id: 'hunk-1',
      kind: 'conflict' as const,
      personal: 'personal\n',
    }]),
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
  return { git, projects, publication, safety, store, subject };
}
