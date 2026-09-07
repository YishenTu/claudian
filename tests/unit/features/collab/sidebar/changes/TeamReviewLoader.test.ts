import type {
  CollabCoordinationSnapshot,
  CollabOperationOptions,
  CollabRequestReview,
  CollabResult,
} from '@/core/collab';
import { CollabPreparedReviewCache } from '@/features/collab/handoff/CollabPreparedReviewCache';
import {
  TeamReviewLoader,
  type TeamReviewLoaderPort,
} from '@/features/collab/sidebar/changes/TeamReviewLoader';

const MAIN = '1'.repeat(40);
const HEAD_A = '2'.repeat(40);
const HEAD_B = '3'.repeat(40);
const NEXT_MAIN = '4'.repeat(40);

describe('TeamReviewLoader', () => {
  it('serializes rapid request changes without restarting Git work', async () => {
    const first = deferred<CollabResult<CollabRequestReview>>();
    let active = 0;
    let maxActive = 0;
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn(async (_projectId, requestId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return requestId === 'request-a'
            ? await first.promise
            : success(review('request-b', 'member-b', HEAD_B));
        } finally {
          active -= 1;
        }
      }),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());

    const focusedA = loader.load('request-a');
    const focusedB = loader.load('request-b');

    expect(port.prepareReview).toHaveBeenCalledTimes(1);
    expect(port.prepareReview).toHaveBeenLastCalledWith(
      'project-a',
      'request-a',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    first.resolve(success(review('request-a', 'member-a', HEAD_A)));
    await expect(focusedA).resolves.toMatchObject({ kind: 'ready' });
    await expect(focusedB).resolves.toMatchObject({ kind: 'ready' });

    expect(port.prepareReview.mock.calls.map(call => call[1])).toEqual([
      'request-a',
      'request-b',
    ]);
    expect(maxActive).toBe(1);
    expect(loader.peek('request-a')).toMatchObject({ kind: 'ready' });
    expect(loader.peek('request-b')).toMatchObject({ kind: 'ready' });
  });

  it('drops a superseded pending request when the active request is selected again', async () => {
    const first = deferred<CollabResult<CollabRequestReview>>();
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn(async (_projectId, requestId) => (
        requestId === 'request-a'
          ? first.promise
          : success(review('request-b', 'member-b', HEAD_B))
      )),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());

    const firstA = loader.load('request-a');
    const pendingB = loader.load('request-b');
    const finalA = loader.load('request-a');

    expect(finalA).toBe(firstA);
    await expect(pendingB).resolves.toEqual({ kind: 'stale' });
    expect(port.prepareReview.mock.calls.map(call => call[1])).toEqual(['request-a']);

    first.resolve(success(review('request-a', 'member-a', HEAD_A)));
    await expect(finalA).resolves.toMatchObject({ kind: 'ready' });
    expect(port.prepareReview.mock.calls.map(call => call[1])).toEqual(['request-a']);
  });

  it('aborts nonmatching active work and reports when its native cleanup settles', async () => {
    const activeB = deferred<CollabResult<CollabRequestReview>>();
    let activeBSignal: AbortSignal | undefined;
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn(async (_projectId, requestId, options) => {
        if (requestId === 'request-b') {
          activeBSignal = options?.signal;
          return activeB.promise;
        }
        return success(review('request-a', 'member-a', HEAD_A));
      }),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());
    await loader.load('request-a');
    const pendingB = loader.load('request-b');
    await flush();
    let cleanupSettled = false;

    const cleanup = loader.select('request-a').then(() => {
      cleanupSettled = true;
    });

    expect(activeBSignal?.aborted).toBe(true);
    await expect(pendingB).resolves.toEqual({ kind: 'stale' });
    expect(cleanupSettled).toBe(false);
    activeB.resolve(success(review('request-b', 'member-b', HEAD_B)));
    await cleanup;
    expect(cleanupSettled).toBe(true);
  });

  it('queues a replacement when an aborted request is selected during native cleanup', async () => {
    const firstB = deferred<CollabResult<CollabRequestReview>>();
    let bCalls = 0;
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn(async (_projectId, requestId) => {
        if (requestId !== 'request-b') {
          return success(review('request-a', 'member-a', HEAD_A));
        }
        bCalls += 1;
        return bCalls === 1
          ? firstB.promise
          : success(review('request-b', 'member-b', HEAD_B));
      }),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());
    await loader.load('request-a');
    const abortedB = loader.load('request-b');
    await flush();
    const cleanup = loader.select('request-a');

    const replacementB = loader.load('request-b');

    expect(replacementB).not.toBe(abortedB);
    await expect(abortedB).resolves.toEqual({ kind: 'stale' });
    expect(bCalls).toBe(1);
    firstB.resolve(success(review('request-b', 'member-b', HEAD_B)));
    await cleanup;
    await expect(replacementB).resolves.toMatchObject({ kind: 'ready' });
    expect(bCalls).toBe(2);
  });

  it('drops exact cached work when the request head or main changes', async () => {
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn().mockResolvedValue(
        success(review('request-a', 'member-a', HEAD_A)),
      ),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());
    await loader.load('request-a');
    expect(loader.peek('request-a')).toMatchObject({ kind: 'ready' });

    loader.update('project-a', coordination({ mainOid: NEXT_MAIN }));

    expect(loader.peek('request-a')).toBeNull();
    loader.destroy();
  });

  it('drops cached review details when comments change without a Git OID change', async () => {
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn().mockResolvedValue(
        success(review('request-a', 'member-a', HEAD_A)),
      ),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());
    await loader.load('request-a');
    expect(loader.peek('request-a')).toMatchObject({ kind: 'ready' });

    loader.update('project-a', coordination({
      commentCount: 1,
      updatedAt: '2026-08-08T00:11:00.000Z',
    }));

    expect(loader.peek('request-a')).toBeNull();
    loader.destroy();
  });

  it('drops cached review details when only the request revision changes', async () => {
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn().mockResolvedValue(
        success(review('request-a', 'member-a', HEAD_A)),
      ),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());
    await loader.load('request-a');
    expect(loader.peek('request-a')).toMatchObject({ kind: 'ready' });

    loader.update('project-a', coordination({ revision: 2 }));

    expect(loader.peek('request-a')).toBeNull();
    await expect(loader.load('request-a')).resolves.toMatchObject({ kind: 'ready' });
    expect(port.prepareReview).toHaveBeenCalledTimes(2);
    loader.destroy();
  });

  it('hydrates an exact review from the plugin-lifetime prepared cache', async () => {
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn(),
    };
    const snapshot = coordination();
    const prepared = new CollabPreparedReviewCache();
    prepared.store({
      coordination: snapshot,
      review: review('request-a', 'member-a', HEAD_A),
    });
    const loader = new TeamReviewLoader(port, prepared);

    loader.update('project-a', snapshot);

    await expect(loader.load('request-a')).resolves.toMatchObject({ kind: 'ready' });
    expect(port.prepareReview).not.toHaveBeenCalled();
  });

  it('reloads a cached review when the current Member role changes', async () => {
    const managerReview = review('request-a', 'member-a', HEAD_A);
    const memberReview = { ...managerReview, canAccept: false };
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn()
        .mockResolvedValueOnce(success(managerReview))
        .mockResolvedValueOnce(success(memberReview)),
    };
    const loader = new TeamReviewLoader(port, new CollabPreparedReviewCache());
    loader.update('project-a', coordination({ currentMemberRole: 'manager' }));
    await expect(loader.load('request-a')).resolves.toMatchObject({
      kind: 'ready',
      review: { canAccept: true },
    });

    loader.update('project-a', coordination({ currentMemberRole: 'member' }));

    expect(loader.peek('request-a')).toBeNull();
    await expect(loader.load('request-a')).resolves.toMatchObject({
      kind: 'ready',
      review: { canAccept: false },
    });
    expect(port.prepareReview).toHaveBeenCalledTimes(2);
  });

  it('waits for invalid native work to finish before starting its replacement', async () => {
    const first = deferred<CollabResult<CollabRequestReview>>();
    let active = 0;
    let maxActive = 0;
    const port: jest.Mocked<TeamReviewLoaderPort> = {
      prepareReview: jest.fn(async (
        _projectId: string,
        _requestId: string,
        _options?: CollabOperationOptions,
      ) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return port.prepareReview.mock.calls.length === 1
            ? await first.promise
            : success(review('request-a', 'member-a', HEAD_A, NEXT_MAIN));
        } finally {
          active -= 1;
        }
      }),
    };
    const loader = new TeamReviewLoader(port);
    loader.update('project-a', coordination());
    const staleLoad = loader.load('request-a');
    await flush();

    loader.update('project-a', coordination({ mainOid: NEXT_MAIN }));
    await expect(staleLoad).resolves.toEqual({ kind: 'stale' });
    const currentLoad = loader.load('request-a');
    await flush();

    expect(port.prepareReview).toHaveBeenCalledTimes(1);
    first.resolve(success(review('request-a', 'member-a', HEAD_A)));
    await expect(currentLoad).resolves.toMatchObject({ kind: 'ready' });
    expect(port.prepareReview).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});

function coordination(options: {
  readonly commentCount?: number;
  readonly currentMemberRole?: 'manager' | 'member';
  readonly mainOid?: string;
  readonly revision?: number;
  readonly updatedAt?: string;
} = {}): CollabCoordinationSnapshot {
  const mainOid = options.mainOid ?? MAIN;
  const currentMember = {
    ...member('member-manager', 'Manager'),
    role: options.currentMemberRole ?? 'manager',
  };
  return {
    snapshot: {
      currentMember,
      eventSequence: 1,
      members: [
        currentMember,
        member('member-a', 'Member A'),
        member('member-b', 'Member B'),
      ],
      openTicketCount: 0,
      openRequests: [
        {
          ...request('request-a', 'member-a', HEAD_A, mainOid),
          commentCount: options.commentCount ?? 0,
          revision: options.revision ?? 1,
          updatedAt: options.updatedAt ?? '2026-08-08T00:10:00.000Z',
        },
        request('request-b', 'member-b', HEAD_B, mainOid),
      ],
      project: {
        authorityKind: 'lan',
        createdAt: '2026-08-08T00:00:00.000Z',
        hostMemberId: 'member-manager',
        id: 'project-a',
        mainOid,
        mainRef: 'refs/heads/main',
        managerSetGeneration: 0,
        name: 'Alpha',
      },
      ticketHighlights: [],
    },
    source: 'online',
    stale: false,
    syncState: {
      eventSequence: 1,
      generation: 1,
      projectId: 'project-a',
      status: 'synchronized',
    },
  };
}

function member(id: string, displayName: string) {
  return {
    activatedAt: '2026-08-08T00:00:00.000Z',
    createdAt: '2026-08-08T00:00:00.000Z',
    displayName,
    id,
    personalRef: `refs/heads/members/${id}`,
    role: id === 'member-manager' ? 'manager' as const : 'member' as const,
    status: 'active' as const,
  };
}

function request(id: string, memberId: string, headOid: string, mainOid = MAIN) {
  return {
    commentCount: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
    description: 'Published change',
    firstBaseOid: mainOid,
    id,
    latestHeadOid: headOid,
    memberId,
    revision: 1,
    status: 'open' as const,
    ticketRelations: [],
    updatedAt: '2026-08-08T00:10:00.000Z',
  };
}

function review(
  requestId: string,
  memberId: string,
  headOid: string,
  mainOid = MAIN,
): CollabRequestReview {
  const changeRequest = request(requestId, memberId, headOid, mainOid);
  const file = {
    binary: false,
    kind: 'modified' as const,
    largeForReview: false,
    path: `${requestId}.md`,
  };
  return {
    canAccept: true,
    comparisonBaseOid: mainOid,
    comparisonKind: 'candidate',
    comparisonTargetOid: '5'.repeat(40),
    detail: {
      comments: { comments: [] },
      currentMainOid: mainOid,
      request: changeRequest,
      reviewCondition: 'clean',
      reviewedHeadOid: headOid,
    },
    files: [file],
    projectId: 'project-a',
  };
}

function success<T>(value: T): CollabResult<T> {
  return { status: 'success', value };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
