/** @jest-environment jsdom */

import type {
  CollabFeatureState,
  CollabLocalProjectSummary,
  CollabProjectInspection,
  CollabPublicationReview,
  CollabResult,
  CollabWorkingTreeReview,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  PersonalChangesPanel,
  type PersonalChangesPanelPort,
} from '@/features/collab/sidebar/changes/PersonalChangesPanel';

const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);

function project(
  id = 'project-a',
  overrides: Partial<CollabLocalProjectSummary> = {},
): CollabLocalProjectSummary {
  return {
    authorityKind: 'lan',
    connectionStatus: 'connected',
    health: 'healthy',
    hostInstallationStatus: 'not-host',
    hostStatus: 'not-host',
    id,
    name: id === 'project-a' ? 'Alpha' : 'Beta',
    role: 'member',
    workspacePath: `workspace/${id}`,
    ...overrides,
  };
}

function inspection(options: {
  changed?: boolean;
  comments?: number;
  headOid?: string;
  includesAcceptedMain?: boolean;
  openRequest?: boolean;
} = {}): CollabProjectInspection {
  const headOid = options.headOid ?? MAIN;
  return {
    coordination: {
      snapshot: {
        currentMember: {
          activatedAt: '2026-08-08T00:00:00.000Z',
          createdAt: '2026-08-08T00:00:00.000Z',
          displayName: 'Alice',
          id: 'member-a',
          personalRef: 'refs/heads/members/member-a',
          role: 'member',
          status: 'active',
        },
        eventSequence: 1,
        members: [],
        openTicketCount: 0,
        openRequests: options.openRequest ? [{
          commentCount: options.comments ?? 0,
          createdAt: '2026-08-08T00:00:00.000Z',
          description: 'Published change',
          firstBaseOid: MAIN,
          id: 'request-a',
          latestHeadOid: headOid,
          memberId: 'member-a',
          revision: 1,
          status: 'open',
          ticketRelations: [],
          updatedAt: '2026-08-08T00:00:00.000Z',
        }] : [],
        project: {
          authorityKind: 'lan',
          createdAt: '2026-08-08T00:00:00.000Z',
          hostMemberId: 'member-host',
          id: 'project-a',
          mainOid: MAIN,
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
    },
    gitStatus: {
      acceptedMainOid: MAIN,
      aheadBy: 0,
      behindBy: 0,
      changedFiles: options.changed ? [
        { binary: false, kind: 'modified', largeForReview: false, path: 'note.md' },
        { binary: true, kind: 'added', largeForReview: false, path: 'assets/image.png' },
      ] : [],
      headOid,
      includesAcceptedMain: options.includesAcceptedMain ?? true,
      personalRemoteOid: headOid,
      workingTreeClean: !options.changed,
    },
    personalChanges: {
      action: options.changed
        ? 'publish'
        : options.openRequest
          ? 'none'
          : headOid !== MAIN
            ? 'retry'
            : 'none',
      hasContribution: options.changed === true || options.openRequest === true || headOid !== MAIN,
      unpublishedReview: workingTreeReview(options.changed === true, headOid),
      updateAvailable: options.includesAcceptedMain === false,
    },
    project: project(),
  };
}

function success<T>(value: T): CollabResult<T> {
  return { status: 'success', value };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function createPort(
  inspectResult: CollabResult<CollabProjectInspection> = success(inspection()),
) {
  let state: CollabFeatureState = {
    lifecycle: 'ready',
    projects: [project()],
    selectedProjectId: 'project-a',
  };
  const listeners = new Set<(next: CollabFeatureState) => void>();
  const port = {
    get state() { return state; },
    inspectProject: jest.fn().mockResolvedValue(inspectResult),
    publish: jest.fn(),
    subscribe: jest.fn((listener: (next: CollabFeatureState) => void) => {
      listeners.add(listener);
      return { dispose: jest.fn(() => listeners.delete(listener)) };
    }),
  } as unknown as PersonalChangesPanelPort & {
    inspectProject: jest.Mock;
    publish: jest.Mock;
    subscribe: jest.Mock;
  };
  return {
    port,
    update(next: CollabFeatureState) {
      state = next;
      for (const listener of listeners) listener(state);
    },
    select(projectId: string) {
      state = { ...state, selectedProjectId: projectId };
      for (const listener of listeners) listener(state);
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PersonalChangesPanel', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens a selected personal file as a read-only working-tree review', async () => {
    const cleanContainer = document.body.createDiv();
    const clean = createPort();
    new PersonalChangesPanel(cleanContainer, { port: clean.port, project: project() });
    await flush();

    expect(cleanContainer.textContent).toContain('Up to date');
    expect(cleanContainer.querySelector('[data-action="publish"]')).toBeNull();

    const dirtyContainer = document.body.createDiv();
    const dirty = createPort(success(inspection({ changed: true })));
    const onOpenWorkingTreeReview = jest.fn();
    new PersonalChangesPanel(dirtyContainer, {
      onOpenWorkingTreeReview,
      port: dirty.port,
      project: project(),
    });
    await flush();

    expect(dirtyContainer.textContent).not.toContain('2 changed files');
    expect(dirtyContainer.textContent).toContain('note.md');
    expect(dirtyContainer.querySelector('[data-action="publish"]')).toBeNull();
    expect(dirtyContainer.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(dirtyContainer.textContent).not.toContain('Review changes');
    expect(dirtyContainer.textContent).not.toContain('My request');
    const fileList = dirtyContainer.querySelector<HTMLElement>(
      '.claudian-collab-file-list',
    )!;
    expect(fileList.tagName).toBe('UL');
    expect(fileList.getAttribute('aria-label')).toBe('2 changed files');
    expect(fileList.querySelectorAll(':scope > li')).toHaveLength(2);
    expect([
      ...fileList.querySelectorAll<HTMLButtonElement>(
        ':scope > li > .claudian-collab-file-button',
      ),
    ].map(button => button.dataset.path)).toEqual([
      'note.md',
      'assets/image.png',
    ]);
    expect(fileList.querySelector('[data-path="note.md"] .claudian-collab-file-kind'))
      .toMatchObject({ textContent: 'M' });
    expect(fileList.querySelector('[data-path="note.md"] [data-kind="modified"]'))
      .not.toBeNull();
    expect(fileList.querySelector('[data-path="assets/image.png"] .claudian-collab-file-kind'))
      .toMatchObject({ textContent: 'A' });
    dirtyContainer.querySelector<HTMLButtonElement>('[data-action="review-personal"]')?.click();
    expect(onOpenWorkingTreeReview).toHaveBeenCalledWith(
      workingTreeReview(true, MAIN),
      'note.md',
    );
    onOpenWorkingTreeReview.mockClear();
    const personalFile = dirtyContainer.querySelector<HTMLButtonElement>(
      '[data-path="note.md"]',
    )!;
    personalFile.click();
    await flush();
    expect(dirty.port.publish).not.toHaveBeenCalled();
    expect(dirtyContainer.querySelector('[data-path="note.md"]')).toBe(personalFile);
    expect(personalFile.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(personalFile);
    expect(onOpenWorkingTreeReview).toHaveBeenCalledWith(
      workingTreeReview(true, MAIN),
      'note.md',
    );
  });

  it('renders the same personal area for a Manager and a Member', async () => {
    const memberContainer = document.body.createDiv();
    const managerContainer = document.body.createDiv();
    const member = createPort(success(inspection({ changed: true })));
    const manager = createPort(success(inspection({ changed: true })));
    new PersonalChangesPanel(memberContainer, { port: member.port, project: project() });
    new PersonalChangesPanel(managerContainer, {
      port: manager.port,
      project: project('project-a', { role: 'manager' }),
    });
    await flush();

    expect(managerContainer.innerHTML).toBe(memberContainer.innerHTML);
  });

  it('keeps fetched-main state implicit without hiding local changes or offering manual sync', async () => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({
      changed: true,
      includesAcceptedMain: false,
    })));
    new PersonalChangesPanel(container, { port: fixture.port, project: project() });
    await flush();

    expect(container.textContent).not.toContain('2 changed files');
    expect(container.textContent).not.toContain('Update available');
    expect(container.textContent).toContain('note.md');

    expect(container.querySelector('[data-action="get-latest"]')).toBeNull();
  });

  it('opens the review panel when durable progress needs resuming', async () => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({ headOid: HEAD })));
    const onOpenWorkingTreeReview = jest.fn();
    new PersonalChangesPanel(container, {
      onOpenWorkingTreeReview,
      port: fixture.port,
      project: project(),
    });
    await flush();

    container.querySelector<HTMLButtonElement>('[data-action="review-personal"]')?.click();

    expect(onOpenWorkingTreeReview).toHaveBeenCalledWith(
      workingTreeReview(false, HEAD),
      undefined,
    );
    expect(container.querySelector('[data-action="publish"]')).toBeNull();
  });

  it('opens exact publication review and resumes it from semantic inspection', async () => {
    const review = publicationReview();
    const onOpenPublicationReview = jest.fn();
    const resumedContainer = document.body.createDiv();
    const resumed = inspection();
    resumed.personalChanges = {
      action: 'review-and-publish',
      hasContribution: true,
      review,
      unpublishedReview: workingTreeReview(false),
      updateAvailable: true,
    };
    const resumedFixture = createPort(success(resumed));
    new PersonalChangesPanel(resumedContainer, {
      onOpenPublicationReview,
      port: resumedFixture.port,
      project: project(),
    });
    await flush();
    resumedContainer.querySelector<HTMLButtonElement>(
      '[data-action="open-publication-review"]',
    )?.click();

    expect(onOpenPublicationReview).toHaveBeenCalledWith(review);
    expect(resumedFixture.port.publish).not.toHaveBeenCalled();

    expect(resumedContainer.querySelector('[data-path="note.md"]')).toBeNull();
    expect(resumedContainer.querySelector('[data-action="publish"]')).toBeNull();
  });

  it('keeps cumulative publication files out of the My changes projection', async () => {
    const review = {
      ...publicationReview(),
      files: [{
        binary: false,
        kind: 'modified' as const,
        largeForReview: false,
        path: 'already-published.md',
      }],
    };
    const inspected = inspection({ changed: true, openRequest: true });
    inspected.personalChanges = {
      action: 'review-and-publish',
      hasContribution: true,
      review,
      unpublishedReview: workingTreeReview(true),
      updateAvailable: true,
    };
    const container = document.body.createDiv();
    const fixture = createPort(success(inspected));
    const onOpenPublicationReview = jest.fn();
    const onOpenWorkingTreeReview = jest.fn();
    new PersonalChangesPanel(container, {
      onOpenPublicationReview,
      onOpenWorkingTreeReview,
      port: fixture.port,
      project: project(),
    });
    await flush();

    expect(container.textContent).toContain('note.md');
    expect(container.textContent).not.toContain('already-published.md');
    container.querySelector<HTMLButtonElement>('[data-path="note.md"]')?.click();
    expect(onOpenWorkingTreeReview).toHaveBeenCalledWith(
      workingTreeReview(true),
      'note.md',
    );
    expect(onOpenPublicationReview).not.toHaveBeenCalled();
    expect(container.querySelector('[data-action="publish"]')).toBeNull();
  });

  it('keeps dirty and update state out of the compact personal-change summary', async () => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({
      changed: true,
      includesAcceptedMain: false,
    })));
    new PersonalChangesPanel(container, { port: fixture.port, project: project() });
    await flush();

    expect(container.textContent).not.toContain('2 changed files');
    expect(container.textContent).not.toContain('Update available');
    expect(container.textContent).toContain('note.md');
    expect(container.textContent).not.toContain('Publish');
  });

  it('opens a persisted conflict from the primary action without publishing again', async () => {
    const container = document.body.createDiv();
    const conflicted = {
      ...inspection(),
      conflict: {
        descriptor: {
          conflicts: [{ kind: 'text' as const, path: 'note.md' }],
          mergeBaseOid: MAIN,
          operationId: 'operation-a',
          projectId: 'project-a',
          startingMainOid: MAIN,
          startingPersonalOid: HEAD,
        },
      },
      personalChanges: {
        action: 'resolve-changes' as const,
        conflictOperationId: 'operation-a',
        hasContribution: true,
        unpublishedReview: workingTreeReview(false),
        updateAvailable: false,
      },
    };
    const fixture = createPort(success(conflicted));
    const onOpenConflict = jest.fn();
    new PersonalChangesPanel(container, {
      onOpenConflict,
      port: fixture.port,
      project: project(),
    });
    await flush();

    const action = container.querySelector<HTMLButtonElement>('[data-action="open-conflict"]');
    expect(action?.textContent).toBe('View conflicts');
    expect(action?.disabled).toBe(false);
    expect(container.textContent).not.toContain('Conflict needs review');
    expect(container.textContent).not.toContain('note.md');
    action?.click();

    expect(onOpenConflict).toHaveBeenCalledWith('operation-a');
    expect(fixture.port.publish).not.toHaveBeenCalled();
  });

  it('leaves an existing request conflict out of the My changes action', async () => {
    const container = document.body.createDiv();
    const conflicted = inspection({ openRequest: true });
    conflicted.personalChanges = {
      action: 'resolve-changes',
      conflictOperationId: 'operation-a',
      hasContribution: true,
      unpublishedReview: workingTreeReview(false, HEAD),
      updateAvailable: true,
    };
    const fixture = createPort(success(conflicted));
    const onOpenConflict = jest.fn();
    new PersonalChangesPanel(container, {
      onOpenConflict,
      port: fixture.port,
      project: project(),
    });
    await flush();

    const action = container.querySelector<HTMLButtonElement>('[data-action="open-conflict"]');
    expect(action).toBeNull();
    expect(onOpenConflict).not.toHaveBeenCalled();
  });

  it('refreshes after a Publish started outside the personal panel finishes', async () => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({ changed: true })));
    fixture.port.inspectProject
      .mockResolvedValueOnce(success(inspection({ changed: true })))
      .mockResolvedValueOnce(success(inspection({ headOid: HEAD, openRequest: true })));
    new PersonalChangesPanel(container, { port: fixture.port, project: project() });
    await flush();

    fixture.update({
      ...fixture.port.state,
      activeOperation: {
        cancellable: true,
        id: 'publish-external',
        kind: 'publish',
        phase: 'validating',
        startedAt: '2026-08-08T00:00:00.000Z',
      },
    });
    expect(container.textContent).toContain('Publishing…');

    fixture.update({ ...fixture.port.state, activeOperation: undefined });
    await flush();

    expect(fixture.port.inspectProject).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Up to date');
  });

  it('coalesces a burst of state invalidations into one follow-up inspection', async () => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({ changed: true })));
    new PersonalChangesPanel(container, { port: fixture.port, project: project() });
    await flush();

    fixture.update({ ...fixture.port.state });
    fixture.update({ ...fixture.port.state });
    fixture.update({ ...fixture.port.state });
    await flush();

    expect(fixture.port.inspectProject).toHaveBeenCalledTimes(2);
  });

  it('pauses inspections while inactive and coalesces them on resume', async () => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({ changed: true })));
    const panel = new PersonalChangesPanel(container, {
      port: fixture.port,
      project: project(),
    });
    await flush();
    const file = container.querySelector('[data-path="note.md"]');

    panel.setActive(false);
    fixture.update({ ...fixture.port.state });
    fixture.update({ ...fixture.port.state });
    await flush();
    expect(fixture.port.inspectProject).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-path="note.md"]')).toBe(file);

    panel.setActive(true);
    await flush();
    expect(fixture.port.inspectProject).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-path="note.md"]')).not.toBeNull();
  });

  it('coalesces working-tree invalidations and refreshes before opening a stale file', async () => {
    jest.useFakeTimers();
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({ changed: true })));
    const onOpenWorkingTreeReview = jest.fn();
    const panel = new PersonalChangesPanel(container, {
      onOpenWorkingTreeReview,
      port: fixture.port,
      project: project(),
    });
    await flush();
    fixture.port.inspectProject.mockClear();

    const refreshed = inspection({ changed: true });
    refreshed.personalChanges = {
      ...refreshed.personalChanges!,
      unpublishedReview: {
        ...refreshed.personalChanges!.unpublishedReview,
        snapshotId: '5'.repeat(64),
      },
    };
    fixture.port.inspectProject.mockResolvedValue(success(refreshed));

    panel.invalidateWorkingTree();
    panel.invalidateWorkingTree();
    container.querySelector<HTMLButtonElement>('[data-path="note.md"]')?.click();
    await flush();

    expect(fixture.port.inspectProject).toHaveBeenCalledTimes(1);
    expect(onOpenWorkingTreeReview).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: '5'.repeat(64) }),
      'note.md',
    );

    jest.runOnlyPendingTimers();
    await flush();
    expect(fixture.port.inspectProject).toHaveBeenCalledTimes(1);
  });

  it('coalesces hidden working-tree invalidations into one resume inspection', async () => {
    jest.useFakeTimers();
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({ changed: true })));
    const panel = new PersonalChangesPanel(container, {
      port: fixture.port,
      project: project(),
    });
    await flush();
    fixture.port.inspectProject.mockClear();

    panel.setActive(false);
    panel.invalidateWorkingTree();
    panel.invalidateWorkingTree();
    jest.runOnlyPendingTimers();
    await flush();
    expect(fixture.port.inspectProject).not.toHaveBeenCalled();

    panel.setActive(true);
    await flush();
    expect(fixture.port.inspectProject).toHaveBeenCalledTimes(1);
  });

  it('reports an unexpected inspection rejection through the coordination callback', async () => {
    const container = document.body.createDiv();
    const fixture = createPort();
    fixture.port.inspectProject.mockRejectedValueOnce(new Error('unexpected'));
    const onInspection = jest.fn();

    new PersonalChangesPanel(container, {
      onInspection,
      port: fixture.port,
      project: project(),
    });
    await flush();

    expect(onInspection).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'operation-failed' }),
      status: 'failure',
    });
    expect(container.textContent).toContain('Publish needs attention');
  });

  it.each([
    {
      expected: 'Request sync pending',
      inspected: inspection({ headOid: HEAD }),
    },
    {
      expected: 'Up to date',
      inspected: inspection({ comments: 2, headOid: HEAD, openRequest: true }),
    },
  ])('projects "$expected" from durable inspection state', async ({ expected, inspected }) => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspected));
    new PersonalChangesPanel(container, { port: fixture.port, project: project() });
    await flush();

    expect(container.textContent).toContain(expected);
  });

  it('keeps a published request out of My changes while offline', async () => {
    const container = document.body.createDiv();
    const inspected = inspection({ headOid: HEAD, openRequest: true });
    const fixture = createPort(success({
      ...inspected,
      project: project('project-a', {
        connectionStatus: 'host-stopped',
        hostStatus: 'stopped',
      }),
    }));
    new PersonalChangesPanel(container, { port: fixture.port, project: project() });
    await flush();

    expect(container.textContent).toContain('Up to date');
    expect(container.textContent).not.toContain('changes saved locally');
  });

  it('suppresses stale inspection completion after a Project switch', async () => {
    const container = document.body.createDiv();
    const fixture = createPort();
    const alphaInspect = deferred<CollabResult<CollabProjectInspection>>();
    const betaInspect = deferred<CollabResult<CollabProjectInspection>>();
    fixture.port.inspectProject
      .mockReturnValueOnce(alphaInspect.promise)
      .mockReturnValueOnce(betaInspect.promise);
    const panel = new PersonalChangesPanel(container, {
      port: fixture.port,
      project: project('project-a'),
    });
    fixture.select('project-b');
    panel.setProject(project('project-b'));
    betaInspect.resolve(success({
      ...inspection({ changed: true }),
      project: project('project-b'),
    }));
    await flush();
    alphaInspect.resolve({
      error: new CollabError({ code: 'operation-failed' }),
      status: 'failure',
    });
    await flush();

    expect(container.textContent).toContain('note.md');
    expect(container.textContent).not.toContain('Publish needs attention');
  });

  it('preserves selected-file focus and scroll across refresh', async () => {
    const container = document.body.createDiv();
    const fixture = createPort(success(inspection({ changed: true })));
    const panel = new PersonalChangesPanel(container, {
      port: fixture.port,
      project: project(),
    });
    await flush();
    const file = container.querySelector<HTMLButtonElement>('[data-path="note.md"]')!;
    file.click();
    file.focus();
    const root = container.querySelector<HTMLElement>('.claudian-collab-publish')!;
    root.scrollTop = 37;
    container.querySelector<HTMLButtonElement>('[data-path="note.md"]')?.focus();

    await panel.refresh();

    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('[data-path="note.md"]'),
    );
    expect(root.scrollTop).toBe(37);
  });

  it('aborts work, releases its subscription, and ignores late completion on destroy', async () => {
    const container = document.body.createDiv();
    const fixture = createPort();
    const pending = deferred<CollabResult<CollabProjectInspection>>();
    fixture.port.inspectProject.mockReturnValue(pending.promise);
    const panel = new PersonalChangesPanel(container, {
      port: fixture.port,
      project: project(),
    });
    const signal = fixture.port.inspectProject.mock.calls[0]?.[1]?.signal as AbortSignal;

    panel.destroy();
    pending.resolve(success(inspection({ changed: true })));
    await flush();

    expect(signal.aborted).toBe(true);
    expect(container.querySelector('.claudian-collab-publish')).toBeNull();
    const subscription = fixture.port.subscribe.mock.results[0]?.value as { dispose: jest.Mock };
    expect(subscription.dispose).toHaveBeenCalledTimes(1);
  });
});

function publicationReview(): CollabPublicationReview {
  return {
    baseMainOid: MAIN,
    candidateOid: '3'.repeat(40),
    canConfirm: true,
    comparisonBaseOid: MAIN,
    comparisonTargetOid: '3'.repeat(40),
    contributionHeadOid: HEAD,
    currentMainOid: MAIN,
    files: [{
      binary: false,
      kind: 'modified',
      largeForReview: false,
      path: 'note.md',
    }],
    kind: 'publication',
    operationId: 'operation-review',
    projectId: 'project-a',
  };
}

function workingTreeReview(
  changed: boolean,
  headOid = MAIN,
): CollabWorkingTreeReview {
  return {
    baseOid: MAIN,
    files: changed ? [
      { binary: false, kind: 'modified', largeForReview: false, path: 'note.md' },
      { binary: true, kind: 'added', largeForReview: false, path: 'assets/image.png' },
    ] : [],
    headOid,
    kind: 'working-tree',
    projectId: 'project-a',
    snapshotId: '4'.repeat(64),
  };
}
