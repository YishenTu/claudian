import { type CollabChangeRequest } from '@claudian-collab/protocol';

import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  type CollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import type {
  PublishProjectContext,
  PublishRepositorySnapshot,
} from '@/app/collab/publish/PublishCoordinator';
import {
  type ReconciliationControlPort,
  ReconciliationCoordinator,
  type ReconciliationProjectPort,
  type ReconciliationPublicationStatePort,
  type ReconciliationRepositoryPort,
  type ReconciliationSafetyPort,
} from '@/app/collab/reconciliation/ReconciliationCoordinator';
import type { CollabProjectSnapshot } from '@/core/collab';
import { type CollabConflictDescriptor } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const MAIN = '1'.repeat(40);
const PERSONAL = '2'.repeat(40);
const CONTEXT: PublishProjectContext = {
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://192.168.0.2/repository.git',
  repositoryPath: '/vault/workspace/project-a',
};

function repositorySnapshot(
  overrides: Partial<PublishRepositorySnapshot> = {},
): PublishRepositorySnapshot {
  return {
    acceptedMainOid: MAIN,
    changedFiles: [],
    headOid: PERSONAL,
    includesAcceptedMain: true,
    personalAheadBy: 0,
    personalBehindBy: 0,
    personalRemoteOid: PERSONAL,
    workingTreeClean: true,
    ...overrides,
  };
}

function request(headOid = PERSONAL): CollabChangeRequest {
  return {
    commentCount: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
    description: 'Published change',
    firstBaseOid: MAIN,
    id: 'request-a',
    latestHeadOid: headOid,
    memberId: CONTEXT.memberId,
    revision: 1,
    status: 'open',
    ticketRelations: [],
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
}

function coordination(openRequest?: CollabChangeRequest): CollabProjectSnapshot {
  const member = {
    activatedAt: '2026-08-08T00:00:00.000Z',
    createdAt: '2026-08-08T00:00:00.000Z',
    displayName: 'Member A',
    id: CONTEXT.memberId,
    personalRef: CONTEXT.personalRef,
    role: 'member' as const,
    status: 'active' as const,
  };
  return {
    currentMember: member,
    eventSequence: 1,
    members: [member],
    openTicketCount: 0,
    openRequests: openRequest ? [openRequest] : [],
    project: {
      authorityKind: 'lan',
      createdAt: '2026-08-08T00:00:00.000Z',
      hostMemberId: 'member-host',
      id: CONTEXT.projectId,
      mainOid: MAIN,
      mainRef: 'refs/heads/main',
      managerSetGeneration: 0,
      name: 'Alpha',
    },
    ticketHighlights: [],
  };
}

class FakeProjectPort implements ReconciliationProjectPort {
  revalidate = jest.fn(async () => undefined);

  async load(): Promise<PublishProjectContext> {
    return CONTEXT;
  }
}

class FakeRepository implements ReconciliationRepositoryPort {
  current = repositorySnapshot();
  planValue: Awaited<ReturnType<ReconciliationRepositoryPort['plan']>> = {
    kind: 'fast-forward',
  };
  fetch = jest.fn(async () => undefined);
  inspect = jest.fn(async () => this.current);
  fastForward = jest.fn(async () => {
    this.current = repositorySnapshot({
      headOid: this.current.acceptedMainOid,
      personalAheadBy: 1,
    });
    return { kind: 'fast-forwarded' as const, snapshot: this.current };
  });
  pushPersonal = jest.fn(async () => {
    this.current = { ...this.current, personalAheadBy: 0, personalRemoteOid: this.current.headOid };
  });

  plan = jest.fn((
    ..._args: Parameters<ReconciliationRepositoryPort['plan']>
  ): ReturnType<ReconciliationRepositoryPort['plan']> => Promise.resolve(this.planValue));
}

class FakeControl implements ReconciliationControlPort {
  snapshot = coordination();
  readSnapshot = jest.fn(async () => this.snapshot);
}

class FakeSafety implements ReconciliationSafetyPort {
  safe = true;
  assertSafe = jest.fn(async () => {
    if (!this.safe) throw new CollabError({ code: 'working-tree-busy' });
  });
  inspect = jest.fn(async () => this.safe
    ? { safe: true as const }
    : { reason: 'repository-lock' as const, safe: false as const });
}

class FakePublicationState implements ReconciliationPublicationStatePort {
  current: CollabPublicationStateRecord = {
    baseMainOid: MAIN,
    operation: null,
    projectId: CONTEXT.projectId,
    schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
  load = jest.fn(async () => this.current);
  save = jest.fn(async (record: CollabPublicationStateRecord) => {
    this.current = record;
  });
}

function createSubject() {
  const projects = new FakeProjectPort();
  const repository = new FakeRepository();
  const control = new FakeControl();
  const safety = new FakeSafety();
  const publicationState = new FakePublicationState();
  const subject = new ReconciliationCoordinator(
    projects,
    repository,
    control,
    safety,
    publicationState,
    { createOperationId: () => 'reconcile-a' },
  );
  return { control, projects, publicationState, repository, safety, subject };
}

describe('ReconciliationCoordinator', () => {
  it('fast-forwards and pushes accepted history without creating a request', async () => {
    const { control, repository, subject } = createSubject();
    repository.current = repositorySnapshot({ includesAcceptedMain: false });

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: MAIN,
        projectId: CONTEXT.projectId,
        state: 'fast-forwarded',
      },
    });
    expect(repository.fetch).toHaveBeenCalledTimes(1);
    expect(repository.fastForward).toHaveBeenCalledTimes(1);
    expect(repository.pushPersonal).toHaveBeenCalledTimes(1);
    expect(control.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('defers accepted synchronization when an open request exists', async () => {
    const { control, repository, subject } = createSubject();
    control.snapshot = coordination(request());

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: PERSONAL,
        projectId: CONTEXT.projectId,
        state: 'deferred',
      },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
    expect(repository.pushPersonal).not.toHaveBeenCalled();
    expect(repository.plan).not.toHaveBeenCalled();
  });

  it('defers a clean divergence until Publish instead of integrating it', async () => {
    const { control, repository, subject } = createSubject();
    repository.current = repositorySnapshot({ includesAcceptedMain: false });
    repository.planValue = { kind: 'diverged' };

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: PERSONAL,
        projectId: CONTEXT.projectId,
        state: 'deferred',
      },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
    expect(repository.pushPersonal).not.toHaveBeenCalled();
    expect(control.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('defers unpublished local commits even when the remote personal ref remains an ancestor', async () => {
    const { repository, subject } = createSubject();
    repository.current = repositorySnapshot({
      personalAheadBy: 1,
      personalRemoteOid: '4'.repeat(40),
    });
    repository.planValue = { kind: 'current' };

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: PERSONAL,
        projectId: CONTEXT.projectId,
        state: 'deferred',
      },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
  });

  it('defers while a publication recovery operation is durable', async () => {
    const { publicationState, repository, subject } = createSubject();
    publicationState.current = {
      ...publicationState.current,
      operation: {
        candidateOid: '5'.repeat(40),
        contributionHeadOid: PERSONAL,
        createdAt: '2026-08-08T00:00:00.000Z',
        currentMainOid: MAIN,
        operationId: 'publish-a',
        phase: 'review-ready',
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
    };

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toMatchObject({
      status: 'success',
      value: { state: 'deferred' },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
  });

  it('fails closed when publication state changes at the mutation boundary', async () => {
    const { publicationState, repository, subject } = createSubject();
    repository.current = repositorySnapshot({ includesAcceptedMain: false });
    publicationState.load.mockImplementationOnce(async () => publicationState.current)
      .mockImplementationOnce(async () => ({
        ...publicationState.current,
        baseMainOid: '6'.repeat(40),
      }));

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toMatchObject({
      error: {
        code: 'repository-invalid',
        safeContext: { reason: 'reconciliation-publication-state-changed' },
      },
      status: 'failure',
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
  });

  it('defers visible mutation while the repository mutation lock is held', async () => {
    const { repository, safety, subject } = createSubject();
    repository.current = repositorySnapshot({ includesAcceptedMain: false });
    safety.safe = false;

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: PERSONAL,
        projectId: CONTEXT.projectId,
        state: 'deferred',
      },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
    expect(repository.pushPersonal).not.toHaveBeenCalled();
  });

  it('fetches accepted refs while deferring a dirty working tree', async () => {
    const { control, repository, subject } = createSubject();
    repository.current = repositorySnapshot({
      changedFiles: [{ path: 'note.md', status: 'modified' }],
      workingTreeClean: false,
    });

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: PERSONAL,
        projectId: CONTEXT.projectId,
        state: 'deferred',
      },
    });

    expect(repository.fetch).toHaveBeenCalledTimes(1);
    expect(repository.inspect).toHaveBeenCalledTimes(2);
    expect(repository.fastForward).not.toHaveBeenCalled();
    expect(repository.pushPersonal).not.toHaveBeenCalled();
    expect(control.readSnapshot).not.toHaveBeenCalled();
  });

  it('defers a conflicting divergence until Publish without exposing a conflict', async () => {
    const { repository, subject } = createSubject();
    repository.current = repositorySnapshot({ includesAcceptedMain: false });
    const conflict: CollabConflictDescriptor = {
      conflicts: [{ kind: 'text', path: 'note.md' }],
      mergeBaseOid: '4'.repeat(40),
      operationId: 'reconcile-a',
      projectId: CONTEXT.projectId,
      startingMainOid: MAIN,
      startingPersonalOid: PERSONAL,
    };
    repository.planValue = { conflict, kind: 'conflicting' };

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: PERSONAL,
        projectId: CONTEXT.projectId,
        state: 'deferred',
      },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
  });

  it('surfaces a conflicting open request without mutating the personal Project', async () => {
    const { control, repository, subject } = createSubject();
    repository.current = repositorySnapshot({ includesAcceptedMain: false });
    const conflict: CollabConflictDescriptor = {
      conflicts: [{ kind: 'text', path: 'note.md' }],
      mergeBaseOid: '4'.repeat(40),
      operationId: 'reconcile-open-request',
      projectId: CONTEXT.projectId,
      startingMainOid: MAIN,
      startingPersonalOid: PERSONAL,
    };
    control.snapshot = coordination(request());
    repository.planValue = { conflict, kind: 'conflicting' };

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      conflict,
      error: expect.objectContaining({ code: 'content-conflict' }),
      status: 'conflict',
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
    expect(repository.pushPersonal).not.toHaveBeenCalled();
  });

  it('defers a pushed personal head that is not the accepted main', async () => {
    const { repository, subject } = createSubject();
    repository.planValue = { kind: 'current' };

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: PERSONAL,
        projectId: CONTEXT.projectId,
        state: 'deferred',
      },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
  });

  it('resumes an accepted-main push without treating it as a local contribution', async () => {
    const { repository, subject } = createSubject();
    repository.current = repositorySnapshot({
      headOid: MAIN,
      personalAheadBy: 1,
      personalRemoteOid: '4'.repeat(40),
    });
    repository.planValue = { kind: 'current' };

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toEqual({
      status: 'success',
      value: {
        headOid: MAIN,
        projectId: CONTEXT.projectId,
        state: 'fast-forwarded',
      },
    });
    expect(repository.fastForward).not.toHaveBeenCalled();
    expect(repository.pushPersonal).toHaveBeenCalledTimes(1);
  });

  it('fails closed for personal-ref divergence, stale revalidation, and cancellation', async () => {
    const first = createSubject();
    first.repository.current = repositorySnapshot({ personalBehindBy: 1 });
    await expect(first.subject.reconcile(CONTEXT.projectId)).resolves.toMatchObject({
      error: { code: 'personal-ref-diverged' },
      status: 'failure',
    });
    expect(first.repository.fastForward).not.toHaveBeenCalled();

    const second = createSubject();
    second.projects.revalidate.mockRejectedValueOnce(new CollabError({
      code: 'stale-project-selection',
    }));
    await expect(second.subject.reconcile(CONTEXT.projectId)).resolves.toMatchObject({
      staleKind: 'project-selection',
      status: 'stale',
    });

    const third = createSubject();
    const controller = new AbortController();
    controller.abort();
    await expect(third.subject.reconcile(CONTEXT.projectId, {
      signal: controller.signal,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(third.repository.fetch).not.toHaveBeenCalled();
  });

  it('preserves retryability across an offline attempt and reconnect', async () => {
    const { repository, subject } = createSubject();
    repository.current = repositorySnapshot({ includesAcceptedMain: false });
    repository.fetch.mockRejectedValueOnce(new CollabError({
      code: 'offline',
      recoveryActions: ['retry'],
    }));

    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toMatchObject({
      error: { code: 'offline' },
      status: 'failure',
    });
    await expect(subject.reconcile(CONTEXT.projectId)).resolves.toMatchObject({
      status: 'success',
      value: { state: 'fast-forwarded' },
    });
    expect(repository.fetch).toHaveBeenCalledTimes(2);
  });
});
