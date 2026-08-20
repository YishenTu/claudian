/** @jest-environment jsdom */

import type {
  CollabCoordinationSnapshot,
  CollabFeatureState,
  CollabLocalProjectSummary,
  CollabPublicationReview,
  CollabRequestReview,
  CollabResult,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  TeamChangesPanel,
  type TeamChangesPanelPort,
} from '@/features/collab/sidebar/changes/TeamChangesPanel';

const MAIN = '1'.repeat(40);

describe('TeamChangesPanel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('does not prepare unopened requests in the background', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const onReviewIntent = jest.fn();
    new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      onReviewIntent,
      port: test.port,
      project: project(),
    });

    await flush();

    expect(test.port.prepareReview).not.toHaveBeenCalled();
    expect(onReviewIntent).not.toHaveBeenCalled();
  });

  it('prewarms review rendering on request hover without opening the request', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const onReviewIntent = jest.fn();
    new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      onReviewIntent,
      port: test.port,
      project: project(),
    });
    await flush();
    const row = container.querySelector<HTMLButtonElement>(
      '[data-request-id="request-team"]',
    )!;

    row.dispatchEvent(new Event('pointerenter'));

    expect(onReviewIntent).toHaveBeenCalledTimes(1);
    expect(test.port.prepareReview).not.toHaveBeenCalled();
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('reads the initial snapshot once when subscription immediately publishes current state', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    test.port.subscribe.mockImplementation(listener => {
      listener(test.port.state);
      return test.subscription;
    });

    new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      port: test.port,
      project: project(),
    });
    await flush();

    expect(test.port.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('pauses snapshot reads while inactive and coalesces them on resume', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const panel = new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      port: test.port,
      project: project(),
    });
    await flush();
    const request = container.querySelector('[data-request-id="request-team"]');

    panel.setActive(false);
    test.emit();
    test.emit();
    await flush();
    expect(test.port.readSnapshot).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-request-id="request-team"]')).toBe(request);

    panel.setActive(true);
    await flush();
    expect(test.port.readSnapshot).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-request-id="request-team"]')).not.toBeNull();
  });

  it('restarts an expanded review that was aborted while inactive', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    let reviewCalls = 0;
    let firstSignal: AbortSignal | undefined;
    test.port.prepareReview.mockImplementation(async (_projectId, requestId, options) => {
      reviewCalls += 1;
      if (reviewCalls > 1) return success(review(requestId));
      firstSignal = options?.signal;
      return await new Promise(resolve => {
        options?.signal?.addEventListener('abort', () => {
          resolve({
            error: new CollabError({ code: 'cancelled' }),
            status: 'failure',
          });
        }, { once: true });
      });
    });
    const onOpenFile = jest.fn();
    const panel = new TeamChangesPanel(container, {
      onOpenFile,
      port: test.port,
      project: project(),
    });
    await flush();

    container.querySelector<HTMLButtonElement>(
      '[data-request-id="request-team"]',
    )?.click();
    await flush();
    expect(container.textContent).toContain('Loading review');

    panel.setActive(false);
    expect(firstSignal?.aborted).toBe(true);
    panel.setActive(true);
    await nextTurn();
    await nextTurn();

    expect(test.port.prepareReview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('notes/request-team.md');
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it('opens only the latest request intent across an unresolved A-B-A sequence', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const first = deferred<CollabResult<CollabRequestReview>>();
    test.port.prepareReview.mockImplementation(async (_projectId, requestId) => (
      requestId === 'request-mine' ? first.promise : success(review(requestId))
    ));
    const onOpenFile = jest.fn();
    new TeamChangesPanel(container, {
      onOpenFile,
      port: test.port,
      project: project(),
    });
    await flush();
    const clickRequest = (requestId: string) => {
      container.querySelector<HTMLButtonElement>(`[data-request-id="${requestId}"]`)?.click();
    };

    clickRequest('request-mine');
    clickRequest('request-team');
    clickRequest('request-mine');
    first.resolve(success(review('request-mine')));
    await flush();
    await nextTurn();

    expect(test.port.prepareReview.mock.calls.map(call => call[1]))
      .toEqual(['request-mine']);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          request: expect.objectContaining({ id: 'request-mine' }),
        }),
      }),
      expect.any(Object),
      'notes/request-mine.md',
    );
  });

  it('aborts active B before reopening cached A', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const activeB = deferred<CollabResult<CollabRequestReview>>();
    let activeBSignal: AbortSignal | undefined;
    test.port.prepareReview.mockImplementation(async (
      _projectId,
      requestId,
      options,
    ) => {
      if (requestId === 'request-team') {
        activeBSignal = options?.signal;
        return activeB.promise;
      }
      return success(review(requestId));
    });
    const onOpenFile = jest.fn();
    new TeamChangesPanel(container, {
      onOpenFile,
      port: test.port,
      project: project(),
    });
    await flush();
    const clickRequest = (requestId: string) => {
      container.querySelector<HTMLButtonElement>(`[data-request-id="${requestId}"]`)?.click();
    };

    clickRequest('request-mine');
    await nextTurn();
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    clickRequest('request-team');
    await flush();
    expect(activeBSignal?.aborted).toBe(false);

    clickRequest('request-mine');

    expect(activeBSignal?.aborted).toBe(true);
    expect(onOpenFile).toHaveBeenCalledTimes(2);
    expect(onOpenFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          request: expect.objectContaining({ id: 'request-mine' }),
        }),
      }),
      expect.any(Object),
      'notes/request-mine.md',
    );
    activeB.resolve(success(review('request-team')));
    await nextTurn();
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it('restarts an aborted request selected again before native cleanup finishes', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const firstB = deferred<CollabResult<CollabRequestReview>>();
    let bCalls = 0;
    test.port.prepareReview.mockImplementation(async (_projectId, requestId) => {
      if (requestId !== 'request-team') return success(review(requestId));
      bCalls += 1;
      return bCalls === 1 ? firstB.promise : success(review(requestId));
    });
    const onOpenFile = jest.fn();
    new TeamChangesPanel(container, {
      onOpenFile,
      port: test.port,
      project: project(),
    });
    await flush();
    const clickRequest = (requestId: string) => {
      container.querySelector<HTMLButtonElement>(`[data-request-id="${requestId}"]`)?.click();
    };

    clickRequest('request-mine');
    await nextTurn();
    clickRequest('request-team');
    await flush();
    clickRequest('request-mine');
    clickRequest('request-team');
    expect(bCalls).toBe(1);

    firstB.resolve(success(review('request-team')));
    await nextTurn();
    await nextTurn();

    expect(bCalls).toBe(2);
    expect(onOpenFile).toHaveBeenCalledTimes(3);
    expect(onOpenFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          request: expect.objectContaining({ id: 'request-team' }),
        }),
      }),
      expect.any(Object),
      'notes/request-team.md',
    );
    expect(container.querySelector('[data-request-id="request-team"]')
      ?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('notes/request-team.md');
  });

  it('shows every open request to Members and Managers, including mine', async () => {
    const memberContainer = document.body.createDiv();
    const managerContainer = document.body.createDiv();
    const member = fixture(snapshot());
    const manager = fixture(snapshot());
    const onOpenFile = jest.fn();
    new TeamChangesPanel(memberContainer, {
      onOpenFile,
      port: member.port,
      project: project('member'),
    });
    new TeamChangesPanel(managerContainer, {
      onOpenFile: jest.fn(),
      port: manager.port,
      project: project('manager'),
    });
    await flush();

    expect(memberContainer.textContent).toContain('Team changes');
    expect(memberContainer.textContent).toContain('Maya');
    expect(memberContainer.querySelector('.claudian-collab-team-comments')).toBeNull();
    expect(memberContainer.textContent).not.toContain('comments');
    expect(memberContainer.textContent).toContain('You');
    expect(memberContainer.textContent).not.toContain('Alice (You)');
    expect(memberContainer.querySelector('.claudian-collab-team-count')?.textContent).toBe('2');
    expect(memberContainer.querySelector('.claudian-collab-team-request-chevron')).toBeNull();
    expect(memberContainer.querySelector('[data-action="accept"]')).toBeNull();
    expect(managerContainer.innerHTML).toBe(memberContainer.innerHTML);

    memberContainer.querySelector<HTMLButtonElement>(
      '[data-request-id="request-mine"]',
    )?.click();
    await flush();
    expect(memberContainer.querySelector('[data-request-id="request-mine"]')
      ?.getAttribute('aria-expanded')).toBe('true');
    expect(memberContainer.querySelector('.claudian-collab-team-request-summary')).toBeNull();
    expect(memberContainer.textContent).not.toContain('Ready to accept');
    expect(memberContainer.textContent).toContain('notes/request-mine.md');
    expect(onOpenFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'project-a' }),
      expect.objectContaining({ snapshot: expect.any(Object) }),
      'notes/request-mine.md',
    );

    memberContainer.querySelector<HTMLButtonElement>(
      '[data-request-id="request-team"]',
    )?.click();
    await flush();
    expect(memberContainer.querySelector('[data-request-id="request-mine"]')
      ?.getAttribute('aria-expanded')).toBe('false');
    expect(memberContainer.querySelector('[data-request-id="request-team"]')
      ?.getAttribute('aria-expanded')).toBe('true');
    expect(memberContainer.textContent).not.toContain('notes/request-mine.md');
    expect(memberContainer.textContent).toContain('notes/request-team.md');
    const fileList = memberContainer.querySelector<HTMLElement>(
      '.claudian-collab-file-list',
    )!;
    expect(fileList.tagName).toBe('DIV');
    expect(fileList.getAttribute('role')).toBe('group');
    expect(fileList.getAttribute('aria-label')).toBe('1 changed files');
    expect(fileList.querySelector('li')).toBeNull();
    expect(fileList.querySelector(':scope > .claudian-collab-file-button'))
      .not.toBeNull();
    expect(fileList.querySelector('.claudian-collab-file-kind')?.textContent).toBe('M');
    expect(fileList.querySelector('.claudian-collab-file-kind')?.getAttribute('data-kind'))
      .toBe('modified');
    expect(onOpenFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          request: expect.objectContaining({ id: 'request-team' }),
        }),
      }),
      expect.objectContaining({ snapshot: expect.any(Object) }),
      'notes/request-team.md',
    );
    const openCount = onOpenFile.mock.calls.length;
    memberContainer.querySelector<HTMLButtonElement>(
      '[data-path="notes/request-team.md"]',
    )?.click();
    expect(onOpenFile).toHaveBeenCalledTimes(openCount + 1);
    expect(onOpenFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          request: expect.objectContaining({ id: 'request-team' }),
        }),
      }),
      expect.objectContaining({ snapshot: expect.any(Object) }),
      'notes/request-team.md',
    );
  });

  it('owns conflict resolution for the current Member open request', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const onOpenConflict = jest.fn();
    const panel = new TeamChangesPanel(container, {
      onOpenConflict,
      onOpenFile: jest.fn(),
      port: test.port,
      project: project(),
    });
    await flush();

    panel.adoptOwnRequestConflict({
      operationId: 'operation-a',
      requestId: 'request-mine',
    });

    const ownRequest = container.querySelector<HTMLButtonElement>(
      '[data-request-id="request-mine"]',
    );
    expect(ownRequest?.textContent).toContain('View conflicts');
    ownRequest?.click();

    expect(container.querySelector('[data-request-id="request-mine"]')
      ?.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenConflict).toHaveBeenCalledWith('operation-a', 'request-mine');
    expect(test.port.prepareReview).not.toHaveBeenCalled();
    expect(container.textContent).toContain('View conflicts');
  });

  it('keeps a resolved publication review on the current Member open request', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const onOpenPublicationReview = jest.fn();
    const panel = new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      onOpenPublicationReview,
      port: test.port,
      project: project(),
    });
    await flush();

    const prepared = publicationReview();
    panel.adoptOwnRequestConflict({
      operationId: 'operation-a',
      requestId: 'request-mine',
    });
    const ownRequest = () => container.querySelector<HTMLButtonElement>(
      '[data-request-id="request-mine"]',
    )!;
    ownRequest().click();
    panel.adoptOwnRequestPublicationReview({
      requestId: 'request-mine',
      review: prepared,
    });

    expect(container.querySelector('[data-request-id="request-mine"]')
      ?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('notes/resolved-a.md');
    expect(container.textContent).toContain('notes/resolved-b.md');
    expect(onOpenPublicationReview).not.toHaveBeenCalled();

    ownRequest().click();
    ownRequest().click();
    expect(onOpenPublicationReview).toHaveBeenCalledWith(
      prepared,
      'notes/resolved-a.md',
    );
    expect(test.port.prepareReview).not.toHaveBeenCalled();

    const firstFile = container.querySelector<HTMLButtonElement>(
      '[data-path="notes/resolved-a.md"]',
    )!;
    const selectedFile = container.querySelector<HTMLButtonElement>(
      '[data-path="notes/resolved-b.md"]',
    )!;
    expect([
      ...container.querySelectorAll<HTMLButtonElement>(
        '.claudian-collab-file-list > .claudian-collab-file-button',
      ),
    ].map(button => button.dataset.path)).toEqual([
      'notes/resolved-a.md',
      'notes/resolved-b.md',
    ]);
    expect(firstFile.closest('.claudian-collab-file-list')?.getAttribute('aria-label'))
      .toBe('2 changed files');
    const firstFileOpenCount = onOpenPublicationReview.mock.calls.length;
    firstFile.click();
    expect(onOpenPublicationReview).toHaveBeenCalledTimes(firstFileOpenCount + 1);
    expect(onOpenPublicationReview).toHaveBeenLastCalledWith(
      prepared,
      'notes/resolved-a.md',
    );
    firstFile.focus();
    selectedFile.click();
    expect(onOpenPublicationReview).toHaveBeenLastCalledWith(
      prepared,
      'notes/resolved-b.md',
    );
    expect(container.querySelector('[data-path="notes/resolved-a.md"]')).toBe(firstFile);
    expect(container.querySelector('[data-path="notes/resolved-b.md"]')).toBe(selectedFile);
    expect(firstFile.getAttribute('aria-pressed')).toBe('false');
    expect(selectedFile.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(firstFile);
  });

  it('reuses an exact prepared review when a request is collapsed and expanded again', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const onOpenFile = jest.fn();
    new TeamChangesPanel(container, {
      onOpenFile,
      port: test.port,
      project: project(),
    });
    await flush();

    const requestRow = () => container.querySelector<HTMLButtonElement>(
      '[data-request-id="request-team"]',
    )!;
    requestRow().click();
    await flush();
    expect(requestRow().getAttribute('aria-expanded')).toBe('true');
    expect(onOpenFile).toHaveBeenCalledTimes(1);

    requestRow().click();
    expect(requestRow().getAttribute('aria-expanded')).toBe('false');
    expect(onOpenFile).toHaveBeenCalledTimes(1);

    requestRow().click();
    await flush();
    expect(requestRow().getAttribute('aria-expanded')).toBe('true');

    expect(test.port.prepareReview.mock.calls.filter(
      call => call[1] === 'request-team',
    )).toHaveLength(1);
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it('labels cached data as stale and removes a terminal request after refresh', async () => {
    const container = document.body.createDiv();
    const first = snapshot({ stale: true });
    const second = snapshot({ requests: [] });
    const test = fixture(first);
    test.port.readSnapshot
      .mockResolvedValueOnce(success(first))
      .mockResolvedValueOnce(success(second));
    new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      port: test.port,
      project: project(),
    });
    await flush();

    expect(container.textContent).toContain('Showing saved change requests');
    expect(container.textContent).toContain('Maya');
    test.emit();
    await flush();
    expect(container.textContent).toContain('No open changes');
    expect(container.textContent).not.toContain('Maya');
  });

  it('preserves row focus and scroll across a list refresh', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    const panel = new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      port: test.port,
      project: project(),
    });
    await flush();
    const root = container.querySelector<HTMLElement>('.claudian-collab-team')!;
    const row = container.querySelector<HTMLButtonElement>('[data-request-id="request-team"]')!;
    root.scrollTop = 42;
    row.focus();

    await panel.refresh();

    expect(root.scrollTop).toBe(42);
    expect(document.activeElement).toBe(
      container.querySelector('[data-request-id="request-team"]'),
    );
  });

  it('offers a retry after a failed list read and releases work on destroy', async () => {
    const container = document.body.createDiv();
    const test = fixture(snapshot());
    test.port.readSnapshot
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'offline' }),
        status: 'failure',
      })
      .mockResolvedValueOnce(success(snapshot()));
    const panel = new TeamChangesPanel(container, {
      onOpenFile: jest.fn(),
      port: test.port,
      project: project(),
    });
    await flush();
    expect(container.textContent).toContain('Could not load change requests');

    container.querySelector<HTMLButtonElement>('[data-action="retry-team-changes"]')?.click();
    await flush();
    expect(container.textContent).toContain('Maya');
    panel.destroy();
    expect(test.subscription.dispose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.claudian-collab-team')).toBeNull();
  });
});

function project(role: 'manager' | 'member' = 'member'): CollabLocalProjectSummary {
  return {
    authorityKind: 'lan',
    connectionStatus: 'connected',
    health: 'healthy',
    hostStatus: 'not-host',
    id: 'project-a',
    name: 'Alpha',
    role,
    workspacePath: 'workspace/project-a',
  };
}

function snapshot(options: {
  requests?: CollabCoordinationSnapshot['snapshot']['openRequests'];
  stale?: boolean;
} = {}): CollabCoordinationSnapshot {
  return {
    snapshot: {
      currentMember: member('member-a', 'Alice'),
      eventSequence: options.stale ? 1 : 2,
      members: [member('member-a', 'Alice'), member('member-b', 'Maya')],
      openTicketCount: 0,
      openRequests: options.requests ?? [
        request('request-mine', 'member-a', 1),
        request('request-team', 'member-b', 2),
      ],
      project: {
        authorityKind: 'lan',
        createdAt: '2026-08-08T00:00:00.000Z',
        hostMemberId: 'member-a',
        id: 'project-a',
        mainOid: MAIN,
        mainRef: 'refs/heads/main',
        managerSetGeneration: 0,
        name: 'Alpha',
      },
      ticketHighlights: [],
    },
    source: options.stale ? 'cache' : 'online',
    stale: options.stale ?? false,
    syncState: options.stale
      ? {
        eventSequence: 1,
        generation: 1,
        projectId: 'project-a',
        status: 'offline',
      }
      : {
        eventSequence: 2,
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
    role: id === 'member-a' ? 'manager' as const : 'member' as const,
    status: 'active' as const,
  };
}

function request(id: string, memberId: string, commentCount: number) {
  return {
    commentCount,
    createdAt: '2026-08-08T00:00:00.000Z',
    description: 'Published change',
    firstBaseOid: MAIN,
    id,
    latestHeadOid: '2'.repeat(40),
    memberId,
    revision: 1,
    status: 'open' as const,
    ticketRelations: [],
    updatedAt: '2026-08-08T00:10:00.000Z',
  };
}

function success<T>(value: T): CollabResult<T> {
  return { status: 'success', value };
}

function fixture(value: CollabCoordinationSnapshot) {
  let state: CollabFeatureState = {
    lifecycle: 'ready',
    projects: [project()],
    selectedProjectId: 'project-a',
  };
  const listeners = new Set<(state: CollabFeatureState) => void>();
  const subscription = { dispose: jest.fn() };
  const port = {
    get state() { return state; },
    prepareReview: jest.fn(async (_projectId: string, requestId: string) => (
      success(review(requestId))
    )),
    readSnapshot: jest.fn().mockResolvedValue(success(value)),
    subscribe: jest.fn((listener: (next: CollabFeatureState) => void) => {
      listeners.add(listener);
      return subscription;
    }),
  } as unknown as jest.Mocked<TeamChangesPanelPort>;
  return {
    emit() {
      state = { ...state };
      for (const listener of listeners) listener(state);
    },
    port,
    subscription,
  };
}

function review(requestId: string): CollabRequestReview {
  const matchingRequest = request(
    requestId,
    requestId === 'request-mine' ? 'member-a' : 'member-b',
    0,
  );
  const path = `notes/${requestId}.md`;
  const file = {
    binary: false,
    kind: 'modified' as const,
    largeForReview: false,
    path,
  };
  return {
    canAccept: true,
    comparisonBaseOid: MAIN,
    comparisonKind: 'candidate',
    comparisonTargetOid: '3'.repeat(40),
    detail: {
      comments: { comments: [] },
      currentMainOid: MAIN,
      request: matchingRequest,
      reviewCondition: 'clean',
      reviewedHeadOid: matchingRequest.latestHeadOid,
    },
    files: [file],
    projectId: 'project-a',
  };
}

function publicationReview(): CollabPublicationReview {
  return {
    baseMainOid: MAIN,
    candidateOid: '4'.repeat(40),
    canConfirm: true,
    comparisonBaseOid: MAIN,
    comparisonTargetOid: '4'.repeat(40),
    contributionHeadOid: '2'.repeat(40),
    currentMainOid: MAIN,
    files: [{
      binary: false,
      kind: 'modified',
      largeForReview: false,
      path: 'notes/resolved-a.md',
    }, {
      binary: false,
      kind: 'modified',
      largeForReview: false,
      path: 'notes/resolved-b.md',
    }],
    kind: 'publication',
    operationId: 'operation-a',
    projectId: 'project-a',
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

function nextTurn(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
