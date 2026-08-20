import { type CollabChangeRequest } from '@claudian/collab-protocol';

import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  type CollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';
import {
  type PublishAcceptedState,
  type PublishCandidatePort,
  type PublishComparisonPort,
  PublishCoordinator,
  type PublishProjectContext,
  type PublishPublicationStatePort,
  type PublishRepositoryPort,
  type PublishRepositorySnapshot,
  type PublishRequestEnsurePort,
} from '@/app/collab/publish/PublishCoordinator';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT: PublishProjectContext = {
  allowHostRemoteRepair: false,
  memberId: 'member-a',
  personalRef: 'refs/heads/members/member-a',
  projectId: 'project-a',
  remoteUrl: 'https://192.168.0.10/v1/git/project-a/repository.git',
  repositoryPath: '/vault/workspace/project-a',
};
const BASE = '0'.repeat(40);
const MAIN = '1'.repeat(40);
const LOCAL = '2'.repeat(40);
const COMMITTED = '3'.repeat(40);
const CANDIDATE = '4'.repeat(40);
const NEXT_MAIN = '5'.repeat(40);
const NEXT_CANDIDATE = '6'.repeat(40);
const NOW = '2026-08-09T00:00:00.000Z';
const DESCRIPTION = 'Published change';
const PUBLISH_REQUEST = { description: DESCRIPTION, projectId: PROJECT.projectId };

function conflict(operationId = 'operation-a', personalOid = LOCAL) {
  return {
    conflicts: [{ kind: 'text' as const, path: 'note.md' }],
    mergeBaseOid: BASE,
    operationId,
    projectId: PROJECT.projectId,
    startingMainOid: MAIN,
    startingPersonalOid: personalOid,
  };
}

function request(headOid: string): CollabChangeRequest {
  return {
    commentCount: 0,
    createdAt: NOW,
    description: DESCRIPTION,
    firstBaseOid: MAIN,
    id: 'request-a',
    memberId: PROJECT.memberId,
    latestHeadOid: headOid,
    revision: 1,
    status: 'open',
    ticketRelations: [],
    updatedAt: NOW,
  };
}

function snapshot(overrides: Partial<PublishRepositorySnapshot> = {}): PublishRepositorySnapshot {
  return {
    acceptedMainOid: MAIN,
    changedFiles: [],
    headOid: LOCAL,
    includesAcceptedMain: true,
    personalAheadBy: 0,
    personalBehindBy: 0,
    personalRemoteOid: LOCAL,
    workingTreeClean: true,
    ...overrides,
  };
}

class FakeProjectPort {
  selectedProjectId: string | null = PROJECT.projectId;

  async load(): Promise<PublishProjectContext> {
    return PROJECT;
  }

  async revalidate(): Promise<void> {
    if (this.selectedProjectId !== PROJECT.projectId) {
      throw new CollabError({ code: 'stale-project-selection' });
    }
  }
}

class FakeRepository implements PublishRepositoryPort {
  acceptedState: PublishAcceptedState = { kind: 'current' };
  calls: string[] = [];
  commitCount = 0;
  current = snapshot();
  fetchError: CollabError | null = null;
  onFetch: (() => void) | null = null;

  async inspect(): Promise<PublishRepositorySnapshot> {
    this.calls.push('inspect');
    return this.current;
  }

  async validateChangedFiles(): Promise<void> {
    this.calls.push('validate');
  }

  async stageAll(): Promise<void> {
    this.calls.push('stage');
    this.current = { ...this.current, workingTreeClean: false };
  }

  async commitStaged(): Promise<string> {
    this.calls.push('commit');
    this.commitCount += 1;
    this.current = snapshot({
      headOid: COMMITTED,
      personalAheadBy: 1,
      personalRemoteOid: LOCAL,
    });
    return COMMITTED;
  }

  async fetch(): Promise<void> {
    this.calls.push('fetch');
    if (this.fetchError) throw this.fetchError;
    this.onFetch?.();
    this.onFetch = null;
  }

  async classifyAcceptedState(): Promise<PublishAcceptedState> {
    this.calls.push('classify-main');
    return this.acceptedState;
  }

  async isAncestor(_context: PublishProjectContext, ancestor: string, descendant: string) {
    return ancestor === descendant || descendant === COMMITTED;
  }

  async pushPersonal(): Promise<void> {
    this.calls.push('push');
    this.current = {
      ...this.current,
      personalAheadBy: 0,
      personalBehindBy: 0,
      personalRemoteOid: this.current.headOid,
    };
  }
}

class FakeState implements PublishPublicationStatePort {
  current: CollabPublicationStateRecord;

  constructor(baseMainOid = MAIN) {
    this.current = {
      baseMainOid,
      operation: null,
      projectId: PROJECT.projectId,
      schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
      updatedAt: NOW,
    };
  }

  load = jest.fn(async () => this.current);
  save = jest.fn(async (record: CollabPublicationStateRecord) => {
    this.current = record;
  });
}

class FakeCandidates implements PublishCandidatePort {
  apply = jest.fn(async (
    _context: PublishProjectContext,
    _expected: PublishRepositorySnapshot,
    input: { candidateOid: string },
  ) => {
    this.repository.current = {
      ...this.repository.current,
      headOid: input.candidateOid,
      personalAheadBy: 1,
    };
  });
  assertRetained = jest.fn(async () => undefined);
  cleanup = jest.fn(async () => undefined);
  prepare = jest.fn(async (
    _context: PublishProjectContext,
    input: { currentMainOid: string },
  ) => input.currentMainOid === NEXT_MAIN ? NEXT_CANDIDATE : CANDIDATE);

  constructor(private readonly repository: FakeRepository) {}
}

class FakeRequests implements PublishRequestEnsurePort {
  calls: Array<{
    description: string;
    expectedMainOid: string;
    headOid: string;
    idempotencyKey: string;
  }> = [];
  error: CollabError | null = null;
  onEnsure: (() => void) | null = null;

  async ensure(input: {
    description: string;
    expectedMainOid: string;
    headOid: string;
    idempotencyKey: string;
  }): Promise<CollabChangeRequest> {
    this.calls.push(input);
    const error = this.error;
    this.onEnsure?.();
    this.onEnsure = null;
    if (error) throw error;
    return request(input.headOid);
  }
}

class FakeComparison implements PublishComparisonPort {
  compare = jest.fn(async () => [{
    binary: false,
    kind: 'modified' as const,
    largeForReview: false,
    path: 'note.md',
  }]);
}

interface Fixture {
  readonly candidates: FakeCandidates;
  readonly comparison: FakeComparison;
  readonly projects: FakeProjectPort;
  readonly repository: FakeRepository;
  readonly requests: FakeRequests;
  readonly state: FakeState;
  readonly subject: PublishCoordinator;
}

function createSubject(overrides: {
  readonly repository?: FakeRepository;
  readonly state?: FakeState;
} = {}): Fixture {
  const projects = new FakeProjectPort();
  const repository = overrides.repository ?? new FakeRepository();
  const state = overrides.state ?? new FakeState();
  const candidates = new FakeCandidates(repository);
  const comparison = new FakeComparison();
  const requests = new FakeRequests();
  const operationIds = ['operation-a', 'operation-b'];
  const subject = new PublishCoordinator(
    projects,
    repository,
    requests,
    { assertSafe: async () => undefined },
    state,
    candidates,
    comparison,
    {
      createOperationId: () => operationIds.shift() ?? 'operation-c',
      now: () => new Date(NOW),
    },
  );
  return { candidates, comparison, projects, repository, requests, state, subject };
}

describe('PublishCoordinator', () => {
  it('publishes directly when the contribution base is current', async () => {
    const fixture = createSubject();
    fixture.repository.current = snapshot({
      changedFiles: [{ path: 'note.md', status: 'modified' }],
      workingTreeClean: false,
    });

    await expect(fixture.subject.publish(PUBLISH_REQUEST)).resolves.toMatchObject({
      status: 'success',
      value: {
        localHeadOid: COMMITTED,
        remoteHeadOid: COMMITTED,
        state: 'request-synchronized',
      },
    });
    expect(fixture.repository.commitCount).toBe(1);
    expect(fixture.candidates.prepare).not.toHaveBeenCalled();
    expect(fixture.requests.calls).toEqual([
      expect.objectContaining({ expectedMainOid: MAIN, headOid: COMMITTED }),
    ]);
    expect(fixture.state.current).toMatchObject({ baseMainOid: MAIN, operation: null });
  });

  it('retains and reviews a stale-base candidate before any push or request mutation', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.repository.current = snapshot({
      includesAcceptedMain: false,
      personalAheadBy: 1,
      personalRemoteOid: LOCAL,
    });
    fixture.repository.acceptedState = { kind: 'advanced' };

    const prepared = await fixture.subject.publish(PUBLISH_REQUEST);

    expect(prepared).toMatchObject({
      status: 'success',
      value: {
        localHeadOid: LOCAL,
        review: {
          baseMainOid: BASE,
          candidateOid: CANDIDATE,
          currentMainOid: MAIN,
          operationId: 'operation-a',
        },
        state: 'review-required',
      },
    });
    expect(fixture.repository.calls).not.toContain('push');
    expect(fixture.requests.calls).toEqual([]);
    expect(fixture.state.current.operation).toMatchObject({
      candidateOid: CANDIDATE,
      phase: 'review-ready',
    });

    await expect(fixture.subject.confirm({
      description: DESCRIPTION,
      expectedCandidateOid: CANDIDATE,
      expectedMainOid: MAIN,
      operationId: 'operation-a',
      projectId: PROJECT.projectId,
    })).resolves.toMatchObject({
      status: 'success',
      value: { localHeadOid: CANDIDATE, state: 'request-synchronized' },
    });
    expect(fixture.candidates.apply).toHaveBeenCalledTimes(1);
    expect(fixture.repository.calls).toContain('push');
    expect(fixture.requests.calls).toEqual([
      expect.objectContaining({ expectedMainOid: MAIN, headOid: CANDIDATE }),
    ]);
    expect(fixture.state.current.operation).toBeNull();
  });

  it('rebuilds and requires a new review when main changes after confirmation', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.repository.current = snapshot({ includesAcceptedMain: false });
    fixture.repository.acceptedState = { kind: 'advanced' };
    await fixture.subject.publish(PUBLISH_REQUEST);
    fixture.repository.onFetch = () => {
      fixture.repository.current = {
        ...fixture.repository.current,
        acceptedMainOid: NEXT_MAIN,
      };
    };

    await expect(fixture.subject.confirm({
      description: DESCRIPTION,
      expectedCandidateOid: CANDIDATE,
      expectedMainOid: MAIN,
      operationId: 'operation-a',
      projectId: PROJECT.projectId,
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        review: {
          candidateOid: NEXT_CANDIDATE,
          currentMainOid: NEXT_MAIN,
          operationId: 'operation-b',
        },
        state: 'review-required',
      },
    });
    expect(fixture.candidates.apply).not.toHaveBeenCalled();
    expect(fixture.requests.calls).toEqual([]);
  });

  it('rebuilds in the same confirmation when request ensure observes a newer main', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.repository.current = snapshot({ includesAcceptedMain: false });
    fixture.repository.acceptedState = { kind: 'advanced' };
    await fixture.subject.publish(PUBLISH_REQUEST);
    fixture.requests.error = new CollabError({ code: 'stale-main' });
    fixture.requests.onEnsure = () => {
      fixture.requests.error = null;
      fixture.repository.onFetch = () => {
        fixture.repository.current = {
          ...fixture.repository.current,
          acceptedMainOid: NEXT_MAIN,
        };
      };
    };

    await expect(fixture.subject.confirm({
      description: DESCRIPTION,
      expectedCandidateOid: CANDIDATE,
      expectedMainOid: MAIN,
      operationId: 'operation-a',
      projectId: PROJECT.projectId,
    })).resolves.toMatchObject({
      status: 'success',
      value: {
        review: {
          candidateOid: NEXT_CANDIDATE,
          currentMainOid: NEXT_MAIN,
          operationId: 'operation-b',
        },
        state: 'review-required',
      },
    });
    expect(fixture.requests.calls).toHaveLength(1);
  });

  it('rejects a stale confirmation without applying or pushing', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.repository.acceptedState = { kind: 'advanced' };
    await fixture.subject.publish(PUBLISH_REQUEST);

    await expect(fixture.subject.confirm({
      description: DESCRIPTION,
      expectedCandidateOid: NEXT_CANDIDATE,
      expectedMainOid: MAIN,
      operationId: 'operation-a',
      projectId: PROJECT.projectId,
    })).resolves.toMatchObject({
      staleKind: 'operation',
      status: 'stale',
    });
    expect(fixture.candidates.apply).not.toHaveBeenCalled();
    expect(fixture.repository.calls).not.toContain('push');

  });

  it('does not persist confirmation when the working copy changed during review', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.repository.acceptedState = { kind: 'advanced' };
    await fixture.subject.publish(PUBLISH_REQUEST);
    fixture.repository.current = {
      ...fixture.repository.current,
      changedFiles: [{ path: 'later.md', status: 'modified' }],
      workingTreeClean: false,
    };

    await expect(fixture.subject.confirm({
      description: DESCRIPTION,
      expectedCandidateOid: CANDIDATE,
      expectedMainOid: MAIN,
      operationId: 'operation-a',
      projectId: PROJECT.projectId,
    })).resolves.toMatchObject({
      staleKind: 'working-copy',
      status: 'stale',
    });

    expect(fixture.state.current.operation).toMatchObject({
      phase: 'review-ready',
    });
    expect(fixture.candidates.apply).not.toHaveBeenCalled();
    expect(fixture.repository.calls).not.toContain('push');

    fixture.repository.acceptedState = { kind: 'advanced' };
    await expect(fixture.subject.publish(PUBLISH_REQUEST)).resolves.toMatchObject({
      status: 'success',
      value: {
        review: { operationId: 'operation-b' },
        state: 'review-required',
      },
    });
    expect(fixture.candidates.cleanup).toHaveBeenCalledWith(
      PROJECT,
      'operation-a',
      CANDIDATE,
    );
    expect(fixture.repository.commitCount).toBe(1);
  });

  it('persists capture while offline and resumes without duplicating the commit', async () => {
    const repository = new FakeRepository();
    const state = new FakeState();
    const first = createSubject({ repository, state });
    repository.current = snapshot({
      changedFiles: [{ path: 'note.md', status: 'modified' }],
      workingTreeClean: false,
    });
    repository.fetchError = new CollabError({ code: 'endpoint-unreachable' });

    await expect(first.subject.publish(PUBLISH_REQUEST)).resolves.toMatchObject({
      status: 'success',
      value: { state: 'committed-locally' },
    });
    expect(state.current.operation).toMatchObject({ phase: 'captured' });

    repository.fetchError = null;
    const resumed = createSubject({ repository, state });
    await expect(resumed.subject.publish(PUBLISH_REQUEST)).resolves.toMatchObject({
      status: 'success',
      value: { state: 'request-synchronized' },
    });
    expect(repository.commitCount).toBe(1);
  });

  it('surfaces a conflict during Publish without pushing a misleading head', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.repository.acceptedState = { conflict: conflict(), kind: 'conflicting' };

    await expect(fixture.subject.publish(PUBLISH_REQUEST)).resolves.toMatchObject({
      error: { code: 'content-conflict' },
      status: 'conflict',
    });
    expect(fixture.repository.calls).not.toContain('push');
    expect(fixture.requests.calls).toEqual([]);
  });

  it('captures an exact existing-request conflict without changing Git state', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.repository.current = snapshot({ includesAcceptedMain: false });
    fixture.repository.acceptedState = { conflict: conflict(), kind: 'conflicting' };

    await expect(fixture.subject.captureConflict(conflict())).resolves.toBeUndefined();

    expect(fixture.state.current.operation).toMatchObject({
      candidateOid: null,
      contributionHeadOid: LOCAL,
      currentMainOid: null,
      operationId: 'operation-a',
      phase: 'captured',
    });
    expect(fixture.repository.calls).not.toContain('push');
    expect(fixture.candidates.prepare).not.toHaveBeenCalled();
  });

  it('captures edited Project files as the next conflict-resolution contribution', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.state.current = {
      ...fixture.state.current,
      operation: {
        candidateOid: null,
        contributionHeadOid: LOCAL,
        createdAt: NOW,
        currentMainOid: null,
        operationId: 'operation-a',
        phase: 'captured',
        updatedAt: NOW,
      },
    };
    fixture.repository.current = snapshot({
      changedFiles: [{ path: 'note.md', status: 'modified' }],
      includesAcceptedMain: false,
      workingTreeClean: false,
    });
    fixture.repository.acceptedState = {
      conflict: conflict('operation-a', COMMITTED),
      kind: 'conflicting',
    };

    await expect(fixture.subject.publishConflictResolution(
      PUBLISH_REQUEST,
      conflict(),
    )).resolves.toMatchObject({
      conflict: { startingPersonalOid: COMMITTED },
      status: 'conflict',
    });

    expect(fixture.repository.calls).toEqual(expect.arrayContaining([
      'validate',
      'stage',
      'commit',
      'fetch',
      'classify-main',
    ]));
    expect(fixture.state.current.operation).toMatchObject({
      contributionHeadOid: COMMITTED,
      operationId: 'operation-a',
      phase: 'captured',
    });
  });

  it('keeps the conflict open when Publish has no local resolution edit', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.state.current = {
      ...fixture.state.current,
      operation: {
        candidateOid: null,
        contributionHeadOid: LOCAL,
        createdAt: NOW,
        currentMainOid: null,
        operationId: 'operation-a',
        phase: 'captured',
        updatedAt: NOW,
      },
    };
    fixture.repository.current = snapshot({
      includesAcceptedMain: false,
      workingTreeClean: true,
    });

    await expect(fixture.subject.publishConflictResolution(
      PUBLISH_REQUEST,
      conflict(),
    )).resolves.toMatchObject({ conflict: conflict(), status: 'conflict' });

    expect(fixture.repository.calls).not.toContain('classify-main');
    expect(fixture.state.current.operation).toMatchObject({
      contributionHeadOid: LOCAL,
      phase: 'captured',
    });
  });

  it('recovers an already committed local resolution before preparing its review', async () => {
    const fixture = createSubject({ state: new FakeState(BASE) });
    fixture.state.current = {
      ...fixture.state.current,
      operation: {
        candidateOid: null,
        contributionHeadOid: LOCAL,
        createdAt: NOW,
        currentMainOid: null,
        operationId: 'operation-a',
        phase: 'captured',
        updatedAt: NOW,
      },
    };
    fixture.repository.current = snapshot({
      headOid: COMMITTED,
      includesAcceptedMain: false,
      personalAheadBy: 1,
      workingTreeClean: true,
    });
    fixture.repository.acceptedState = { kind: 'advanced' };

    await expect(fixture.subject.publishConflictResolution(
      PUBLISH_REQUEST,
      conflict(),
    )).resolves.toMatchObject({
      status: 'success',
      value: {
        review: { contributionHeadOid: COMMITTED },
        state: 'review-required',
      },
    });

    expect(fixture.repository.commitCount).toBe(0);
    expect(fixture.state.current.operation).toMatchObject({
      contributionHeadOid: COMMITTED,
      phase: 'review-ready',
    });
  });
});
