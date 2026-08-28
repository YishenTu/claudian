/** @jest-environment jsdom */

import { type App, Menu } from 'obsidian';

import { type CollabFeatureState, type CollabLocalProjectSummary } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const mockOpenCreate = jest.fn();
const mockOpenJoin = jest.fn();
const mockOpenManagement = jest.fn();
const mockOpenReconnect = jest.fn();
const mockCreateManagement = jest.fn();

jest.mock('@/features/collab/modals/project/CreateProjectModal', () => ({
  CreateProjectModal: class MockCreateProjectModal {
    constructor(..._args: unknown[]) {}
    open(): void { mockOpenCreate(); }
  },
}));

jest.mock('@/features/collab/modals/project/JoinProjectModal', () => ({
  JoinProjectModal: class MockJoinProjectModal {
    constructor(..._args: unknown[]) {}
    open(): void { mockOpenJoin(); }
  },
}));

jest.mock('@/features/collab/modals/project/ReconnectProjectModal', () => ({
  ReconnectProjectModal: class MockReconnectProjectModal {
    constructor(..._args: unknown[]) {}
    open(): void { mockOpenReconnect(); }
  },
}));

jest.mock('@/features/collab/modals/project/ProjectManagementModal', () => ({
  ProjectManagementModal: class MockProjectManagementModal {
    constructor(...args: unknown[]) { mockCreateManagement(...args); }
    open(): void { mockOpenManagement(); }
  },
}));

import {
  CollabPanel,
  type CollabPanelPort,
} from '@/features/collab/sidebar/CollabPanel';

type TestMenu = Menu & {
  items: Array<{
    checked: boolean | null;
    clickHandler: (() => void) | null;
    title: string;
  }>;
  showAtPosition: jest.Mock;
  useNativeMenu: boolean | null;
};

const MockMenu = Menu as typeof Menu & { instances: TestMenu[] };

const AVAILABLE = { status: 'available' as const, version: '2.45.1' };

function project(
  overrides: Partial<CollabLocalProjectSummary> = {},
): CollabLocalProjectSummary {
  return {
    authorityKind: 'lan',
    connectionStatus: 'host-stopped',
    health: 'healthy',
    hostInstallationStatus: 'hosted-here',
    hostStatus: 'stopped',
    id: 'project-alpha',
    name: 'Alpha',
    role: 'manager',
    workspacePath: 'workspace/alpha',
    ...overrides,
  };
}

function createPort(initialState: CollabFeatureState) {
  let state = initialState;
  const listeners = new Set<(next: CollabFeatureState) => void>();
  const port = {
    get state() { return state; },
    initialize: jest.fn(async () => {
      state = { ...state, lifecycle: 'ready' };
      for (const listener of listeners) listener(state);
      return { status: 'success' as const, value: state };
    }),
    inspectProject: jest.fn(async (projectId: string) => ({
      status: 'success' as const,
      value: {
        gitStatus: {
          acceptedMainOid: 'a'.repeat(40),
          aheadBy: 0,
          behindBy: 0,
          changedFiles: [{
            binary: false,
            kind: 'modified' as const,
            largeForReview: false,
            path: 'note.md',
          }],
          headOid: 'a'.repeat(40),
          includesAcceptedMain: true,
          personalRemoteOid: 'a'.repeat(40),
          workingTreeClean: false,
        },
        personalChanges: {
          action: 'publish' as const,
          hasContribution: true,
          unpublishedReview: {
            baseOid: 'a'.repeat(40),
            files: [{
              binary: false,
              kind: 'modified' as const,
              largeForReview: false,
              path: 'note.md',
            }],
            headOid: 'a'.repeat(40),
            kind: 'working-tree' as const,
            projectId,
            snapshotId: 'd'.repeat(64),
          },
          updateAvailable: false,
        },
        project: state.projects.find(item => item.id === projectId)!,
      },
    })),
    publish: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        localHeadOid: 'b'.repeat(40),
        projectId: 'project-alpha',
        remoteHeadOid: 'b'.repeat(40),
        request: {
          commentCount: 0,
          createdAt: '2026-08-08T00:00:00.000Z',
          firstBaseOid: 'a'.repeat(40),
          id: 'request-alpha',
          latestHeadOid: 'b'.repeat(40),
          memberId: 'member-host',
          status: 'open',
          updatedAt: '2026-08-08T00:00:00.000Z',
        },
        state: 'request-synchronized',
      },
    }),
    listTickets: jest.fn().mockResolvedValue({
      status: 'success',
      value: { page: { tickets: [] }, source: 'online', stale: false },
    }),
    prepareReview: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        canAccept: true,
        comparisonBaseOid: 'a'.repeat(40),
        comparisonKind: 'candidate',
        comparisonTargetOid: 'c'.repeat(40),
        detail: {
          changedFiles: [{
            binary: false,
            kind: 'modified' as const,
            largeForReview: false,
            path: 'notes/alpha.md',
          }, {
            binary: false,
            kind: 'added' as const,
            largeForReview: false,
            path: 'notes/beta.md',
          }],
          comments: [],
          currentMainOid: 'a'.repeat(40),
          request: {
            commentCount: 2,
            createdAt: '2026-08-08T00:00:00.000Z',
            firstBaseOid: 'a'.repeat(40),
            id: 'request-maya',
            latestHeadOid: 'b'.repeat(40),
            memberId: 'member-maya',
            status: 'open' as const,
            updatedAt: '2026-08-08T00:00:00.000Z',
          },
          reviewCondition: 'clean' as const,
          reviewedHeadOid: 'b'.repeat(40),
        },
        files: [{
          binary: false,
          kind: 'modified' as const,
          largeForReview: false,
          path: 'notes/alpha.md',
        }, {
          binary: false,
          kind: 'added' as const,
          largeForReview: false,
          path: 'notes/beta.md',
        }],
        projectId: 'project-alpha',
      },
    }),
    readSnapshot: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        snapshot: {
          currentMember: {
            activatedAt: '2026-08-08T00:00:00.000Z',
            createdAt: '2026-08-08T00:00:00.000Z',
            displayName: 'Alice',
            id: 'member-host',
            personalRef: 'refs/heads/members/member-host',
            role: 'manager',
            status: 'active',
          },
          eventSequence: 1,
          members: [{
            activatedAt: '2026-08-08T00:00:00.000Z',
            createdAt: '2026-08-08T00:00:00.000Z',
            displayName: 'Alice',
            id: 'member-host',
            personalRef: 'refs/heads/members/member-host',
            role: 'manager',
            status: 'active',
          }, {
            activatedAt: '2026-08-08T00:00:00.000Z',
            createdAt: '2026-08-08T00:00:00.000Z',
            displayName: 'Maya',
            id: 'member-maya',
            personalRef: 'refs/heads/members/member-maya',
            role: 'member',
            status: 'active',
          }],
          openRequests: [{
            commentCount: 2,
            createdAt: '2026-08-08T00:00:00.000Z',
            firstBaseOid: 'a'.repeat(40),
            id: 'request-maya',
            latestHeadOid: 'b'.repeat(40),
            memberId: 'member-maya',
            status: 'open',
            updatedAt: '2026-08-08T00:00:00.000Z',
          }],
          project: {
            authorityKind: 'lan',
            createdAt: '2026-08-08T00:00:00.000Z',
            hostMemberId: 'member-host',
            id: 'project-alpha',
            mainOid: 'a'.repeat(40),
            mainRef: 'refs/heads/main',
            managerSetGeneration: 0,
            name: 'Alpha',
          },
        },
        source: 'online',
        stale: false,
      },
    }),
    selectProject: jest.fn(async (projectId: string) => {
      state = { ...state, selectedProjectId: projectId };
      for (const listener of listeners) listener(state);
      return {
        status: 'success' as const,
        value: { project: state.projects.find(item => item.id === projectId)! },
      };
    }),
    resumeSetup: jest.fn().mockResolvedValue({
      status: 'success',
      value: project(),
    }),
    createInvitation: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        encodedInvitation: 'claudian-collab:v2:test',
        expiresAt: '2026-08-08T01:00:00.000Z',
      },
    }),
    startHost: jest.fn(async (projectId: string) => {
      state = {
        ...state,
        projects: state.projects.map(item => item.id === projectId
          ? { ...item, connectionStatus: 'connected', hostStatus: 'running' }
          : item),
      };
      for (const listener of listeners) listener(state);
      return { status: 'success', value: { projectId, status: 'running' } };
    }),
    finalizeRetiredProject: jest.fn(async ({ projectId }: { projectId: string }) => {
      state = {
        ...state,
        projects: state.projects.filter(project => project.id !== projectId),
        selectedProjectId: null,
      };
      for (const listener of listeners) listener(state);
      return { status: 'success', value: undefined };
    }),
    retryProjectCleanup: jest.fn().mockResolvedValue({
      status: 'success',
      value: undefined,
    }),
    stopHost: jest.fn(async (projectId: string) => {
      state = {
        ...state,
        projects: state.projects.map(item => item.id === projectId
          ? { ...item, connectionStatus: 'host-stopped', hostStatus: 'stopped' }
          : item),
      };
      for (const listener of listeners) listener(state);
      return { status: 'success', value: { projectId, status: 'stopped' } };
    }),
    subscribe: jest.fn((listener: (next: CollabFeatureState) => void) => {
      listeners.add(listener);
      listener(state);
      return { dispose: jest.fn(() => listeners.delete(listener)) };
    }),
  } as unknown as CollabPanelPort & {
    initialize: jest.Mock;
    resumeSetup: jest.Mock;
    selectProject: jest.Mock;
    subscribe: jest.Mock;
  };
  return port;
}

function createApp(activePath = 'notes/brief.md') {
  type VaultListener = (...args: Array<{ path: string } | string>) => void;
  const listeners = new Map<string, Set<VaultListener>>();
  const vault = {
    offref: jest.fn((ref: { event: string; listener: VaultListener }) => {
      listeners.get(ref.event)?.delete(ref.listener);
    }),
    on: jest.fn((event: string, listener: VaultListener) => {
      let eventListeners = listeners.get(event);
      if (!eventListeners) {
        eventListeners = new Set();
        listeners.set(event, eventListeners);
      }
      eventListeners.add(listener);
      return { event, listener };
    }),
  };
  return {
    emitVault(event: string, ...args: Array<{ path: string } | string>): void {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    vault,
    workspace: {
      getActiveFile: () => ({
        parent: { path: 'notes' },
        path: activePath,
      }),
    },
  } as unknown as App & {
    emitVault(event: string, ...args: Array<{ path: string } | string>): void;
    vault: typeof vault;
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('CollabPanel', () => {
  beforeEach(() => {
    MockMenu.instances = [];
    mockCreateManagement.mockClear();
    mockOpenManagement.mockClear();
    mockOpenCreate.mockClear();
    mockOpenJoin.mockClear();
    mockOpenReconnect.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reuses Git resolution started while the Collab chunk is loading', async () => {
    const container = document.body.createDiv();
    const port = createPort({ lifecycle: 'uninitialized', projects: [], selectedProjectId: null });
    const resolveGit = jest.fn().mockResolvedValue(AVAILABLE);
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      initialGitResolution: Promise.resolve(AVAILABLE),
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit,
    });

    panel.setActive(true);
    await flush();

    expect(resolveGit).not.toHaveBeenCalled();
    expect(port.initialize).toHaveBeenCalledTimes(1);
  });

  it('preloads initialization without activating the panel', async () => {
    const container = document.body.createDiv();
    const port = createPort({ lifecycle: 'uninitialized', projects: [], selectedProjectId: null });
    const resolveGit = jest.fn().mockResolvedValue(AVAILABLE);
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit,
    });

    panel.preload();
    await flush();

    expect(resolveGit).toHaveBeenCalledWith(false);
    expect(port.initialize).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.claudian-collab-panel-header')).toBeNull();

    panel.setActive(true);
    expect(container.querySelector('.claudian-collab-panel-header')).not.toBeNull();
  });

  it('keeps preloaded initialization alive across visibility changes', async () => {
    const container = document.body.createDiv();
    const port = createPort({ lifecycle: 'uninitialized', projects: [], selectedProjectId: null });
    let finishResolution!: (value: typeof AVAILABLE) => void;
    const resolveGit = jest.fn(() => new Promise<typeof AVAILABLE>(resolve => {
      finishResolution = resolve;
    }));
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit,
    });

    panel.preload();
    panel.setActive(true);
    panel.setActive(false);
    finishResolution(AVAILABLE);
    await flush();

    expect(resolveGit).toHaveBeenCalledTimes(1);
    expect(port.initialize).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.claudian-collab-panel-header')).toBeNull();

    panel.setActive(true);
    await flush();
    expect(resolveGit).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.claudian-collab-panel-header')).not.toBeNull();
  });

  it('initializes lazily and renders Create and Join in the empty state', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'uninitialized',
      projects: [],
      selectedProjectId: null,
    });
    const resolveGit = jest.fn().mockResolvedValue(AVAILABLE);
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit,
    });

    expect(resolveGit).not.toHaveBeenCalled();
    panel.setActive(true);
    await flush();

    expect(resolveGit).toHaveBeenCalledWith(false);
    expect(port.initialize).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.claudian-collab-panel-header')).not.toBeNull();
    expect(container.querySelector('[data-action="add-project"]')).toBeNull();
    expect(container.querySelector('[data-action="create-project"]')).toBeNull();
    expect(container.textContent).toContain('Create');
    expect(container.textContent).toContain('Join');
    const emptyActions = container.querySelector('.claudian-collab-empty-actions')!;
    expect([...emptyActions.querySelectorAll('button')].map(button => (
      button.getAttribute('data-action')
    ))).toEqual(['empty-create', 'join-project']);
    expect(container.querySelector('[data-action="join-project"]')?.classList.contains(
      'claudian-collab-empty-join',
    )).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-action="join-project"]')?.disabled)
      .toBe(false);
    container.querySelector<HTMLButtonElement>('[data-action="join-project"]')?.click();
    expect(mockOpenJoin).toHaveBeenCalledTimes(1);
    container.querySelector<HTMLButtonElement>('[data-action="empty-create"]')?.click();
    expect(mockOpenCreate).toHaveBeenCalledTimes(1);
  });

  it('commits the effective fallback Project before mounting Project reads', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: null,
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();
    await flush();

    expect(port.selectProject).toHaveBeenCalledTimes(1);
    expect(port.selectProject).toHaveBeenCalledWith('project-alpha');
    expect(port.inspectProject).toHaveBeenCalled();
    expect(port.selectProject.mock.invocationCallOrder[0])
      .toBeLessThan((port.inspectProject as jest.Mock).mock.invocationCallOrder[0]!);
    expect(container.textContent).not.toContain('Checking');
    expect(container.textContent).not.toContain('Loading changes');
  });

  it('opens Project management without mounting Host controls in the sidebar', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    const copyText = jest.fn().mockResolvedValue(undefined);
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      copyText,
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();
    expect(container.querySelector('[data-action="start-host"]')).toBeNull();
    expect(container.querySelector('.claudian-collab-host-section')).toBeNull();
    expect(container.querySelector('[data-action="create-invitation"]')).toBeNull();
    const manage = container.querySelector<HTMLButtonElement>(
      '[data-action="manage-project"]',
    )!;
    expect(manage).not.toBeNull();
    const snapshotCount = (port.readSnapshot as jest.Mock).mock.calls.length;
    manage.click();
    await flush();
    expect(mockOpenManagement).toHaveBeenCalledTimes(1);
    expect(mockCreateManagement).toHaveBeenCalledWith(
      expect.anything(),
      port,
      expect.objectContaining({
        copyText,
        project: expect.objectContaining({ id: 'project-alpha' }),
      }),
    );
    expect(port.readSnapshot).toHaveBeenCalledTimes(snapshotCount);
  });

  it('shows Project management beside the Project picker without a Member badge', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({ role: 'member' })],
      selectedProjectId: 'project-alpha',
    });
    const original = await port.readSnapshot('project-alpha');
    if (original.status !== 'success') throw new Error('Expected snapshot');
    (port.readSnapshot as jest.Mock).mockResolvedValue({
      ...original,
      value: {
        ...original.value,
        snapshot: {
          ...original.value.snapshot,
          currentMember: {
            ...original.value.snapshot.currentMember,
            role: 'member',
          },
        },
      },
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();

    expect(container.querySelector('.claudian-collab-host-section')).toBeNull();
    const management = container.querySelector<HTMLButtonElement>(
      '.claudian-collab-project-management',
    );
    expect(management?.parentElement).toBe(
      container.querySelector('.claudian-collab-project-header-actions'),
    );
    expect(management?.getAttribute('aria-label')).toBe('Project management');
    expect(management?.querySelector('.claudian-collab-project-management-icon')).not.toBeNull();
    expect(management?.textContent).toBe('');
    management?.click();
    await flush();
    expect(mockOpenManagement).toHaveBeenCalledTimes(1);
  });

  it('renders blocking Git setup after loading the local Project projection', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'uninitialized',
      projects: [],
      selectedProjectId: null,
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue({ status: 'missing' }),
    });

    panel.setActive(true);
    await flush();

    expect(container.textContent).toContain('Native Git required');
    expect(port.initialize).toHaveBeenCalledTimes(1);
  });

  it('announces loading and failed lifecycle states to assistive technology', async () => {
    const loadingContainer = document.body.createDiv();
    const loadingPanel = new CollabPanel(loadingContainer, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port: createPort({
        lifecycle: 'uninitialized',
        projects: [],
        selectedProjectId: null,
      }),
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn(() => new Promise(() => undefined)),
    });

    loadingPanel.setActive(true);
    expect(loadingContainer.querySelector('[role="status"]')?.getAttribute('aria-live'))
      .toBe('polite');
    loadingPanel.destroy();

    const failedContainer = document.body.createDiv();
    const failedPort = createPort({
      error: new CollabError({ code: 'operation-failed' }),
      lifecycle: 'failed',
      projects: [],
      selectedProjectId: null,
    });
    failedPort.initialize.mockResolvedValue({
      error: new CollabError({ code: 'operation-failed' }),
      status: 'failure',
    });
    const failedPanel = new CollabPanel(failedContainer, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port: failedPort,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    failedPanel.setActive(true);
    await flush();
    expect(failedContainer.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('renders the local Project home, collapsed management, footer, and Resume setup', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({ health: 'needs-attention' })],
      selectedProjectId: 'project-alpha',
    });
    const getPendingSetupOperationId = jest.fn().mockResolvedValue('create-project-alpha');
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();

    expect(container.textContent).toContain('Alpha');
    expect(container.querySelector('.claudian-collab-panel-header')).toBeNull();
    const headerActions = container.querySelector('.claudian-collab-project-header-actions')!;
    expect([...headerActions.querySelectorAll('button')].map(button => (
      button.getAttribute('data-action')
    ))).toEqual(['add-project', 'manage-project']);
    container.querySelector<HTMLButtonElement>('[data-action="add-project"]')?.click();
    const addMenu = MockMenu.instances.at(-1)!;
    expect(addMenu.useNativeMenu).toBe(false);
    expect(addMenu.items.map(item => item.title)).toEqual([
      'Create',
      'Join',
    ]);
    addMenu.items[0]?.clickHandler?.();
    addMenu.items[1]?.clickHandler?.();
    expect(mockOpenCreate).toHaveBeenCalledTimes(1);
    expect(mockOpenJoin).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.claudian-collab-project-toolbar')?.getAttribute('title'))
      .toBe('workspace/alpha');
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('[data-action="open-project"]')).toBeNull();
    expect(container.textContent).not.toContain('LAN Host');
    expect(container.textContent).not.toContain('Host stopped · Manager');
    expect(container.querySelector('.claudian-collab-project-bottom')).toBeNull();
    const resume = container.querySelector<HTMLButtonElement>('[data-action="resume-setup"]')!;
    expect(resume).not.toBeNull();
    resume.click();
    await flush();
    expect(port.resumeSetup).toHaveBeenCalledWith({ operationId: 'create-project-alpha' });
  });

  it('opens the Project picker with an Obsidian DOM menu', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [
        project({ hostStatus: 'not-host', role: 'member' }),
        project({
          hostStatus: 'not-host',
          id: 'project-beta',
          name: 'Beta',
          role: 'member',
          workspacePath: 'workspace/beta',
        }),
      ],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();

    const picker = container.querySelector<HTMLButtonElement>('[data-field="project-picker"]')!;
    expect(picker.tagName).toBe('BUTTON');
    expect(picker.getAttribute('aria-haspopup')).toBe('menu');
    expect(picker.textContent).toContain('Alpha');
    expect(picker.querySelector('.claudian-collab-project-picker-icon')).toBeNull();
    expect(container.querySelector('select')).toBeNull();

    picker.click();
    const menu = MockMenu.instances.at(-1)!;
    expect(menu.useNativeMenu).toBe(false);
    expect(menu.items.map(item => item.title)).toEqual([
      'Alpha',
      'Beta',
      'Reconnect project...',
    ]);
    expect(menu.items.map(item => item.checked)).toEqual([true, false, null]);
    expect(menu.showAtPosition).toHaveBeenCalledTimes(1);

    menu.items[1]?.clickHandler?.();
    await flush();
    expect(port.selectProject).toHaveBeenCalledWith('project-beta');
    menu.items[2]?.clickHandler?.();
    expect(mockOpenReconnect).toHaveBeenCalledTimes(1);
  });

  it('mounts the shared personal Publish surface for a healthy Project', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({ connectionStatus: 'connected', hostStatus: 'running' })],
      selectedProjectId: 'project-alpha',
    });
    const onOpenRequest = jest.fn();
    const onOpenWorkingTreeReview = jest.fn();
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onOpenRequest,
      onOpenWorkingTreeReview,
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();

    expect(container.querySelector('.claudian-collab-publish')).not.toBeNull();
    expect(container.querySelector('.claudian-collab-team')).not.toBeNull();
    expect(container.textContent).toContain('My changes');
    expect(container.textContent).toContain('Team changes');
    expect(container.textContent).toContain('Maya');
    expect(container.textContent).toContain('note.md');
    expect(container.textContent).not.toContain('Changes are ready to publish.');
    container.querySelector<HTMLButtonElement>('[data-path="note.md"]')?.click();
    expect(onOpenWorkingTreeReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-alpha' }),
      expect.objectContaining({
        baseOid: 'a'.repeat(40),
        kind: 'working-tree',
      }),
      'note.md',
    );
    expect(port.publish).not.toHaveBeenCalled();
    expect(container.querySelector('[data-action="publish"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[data-request-id="request-maya"]')?.click();
    await flush();

    expect(container.querySelector('.claudian-collab-review-sidebar')).toBeNull();
    expect(container.querySelector('.claudian-collab-project-home')).not.toBeNull();
    expect(container.querySelector('[data-request-id="request-maya"]')
      ?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Maya');
    expect(container.textContent).toContain('notes/alpha.md');
    expect(container.textContent).toContain('notes/beta.md');
    expect(onOpenRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'project-alpha' }),
      expect.objectContaining({ projectId: 'project-alpha' }),
      expect.objectContaining({ snapshot: expect.any(Object) }),
      'notes/alpha.md',
    );

    container.querySelector<HTMLButtonElement>('[data-path="notes/beta.md"]')?.click();
    expect(onOpenRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'project-alpha' }),
      expect.objectContaining({ projectId: 'project-alpha' }),
      expect.objectContaining({ snapshot: expect.any(Object) }),
      'notes/beta.md',
    );

    container.querySelector<HTMLButtonElement>('[data-request-id="request-maya"]')?.click();
    expect(container.querySelector('[data-request-id="request-maya"]')
      ?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('notes/alpha.md');
  });

  it('keeps a resolved review-ready operation on the current Member request', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({ connectionStatus: 'connected', hostStatus: 'running' })],
      selectedProjectId: 'project-alpha',
    });
    const snapshotResult = await port.readSnapshot('project-alpha');
    if (snapshotResult.status !== 'success') throw new Error('Expected coordination snapshot');
    const ownRequest = {
      commentCount: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
      firstBaseOid: 'a'.repeat(40),
      id: 'request-alpha',
      latestHeadOid: 'b'.repeat(40),
      memberId: 'member-host',
      status: 'open' as const,
      updatedAt: '2026-08-08T00:10:00.000Z',
    };
    const coordination = {
      ...snapshotResult.value,
      snapshot: {
        ...snapshotResult.value.snapshot,
        openRequests: [ownRequest, ...snapshotResult.value.snapshot.openRequests],
      },
    };
    const review = {
      baseMainOid: 'a'.repeat(40),
      candidateOid: 'c'.repeat(40),
      canConfirm: true,
      comparisonBaseOid: 'a'.repeat(40),
      comparisonTargetOid: 'c'.repeat(40),
      contributionHeadOid: 'b'.repeat(40),
      currentMainOid: 'a'.repeat(40),
      files: [{
        binary: false,
        kind: 'modified' as const,
        largeForReview: false,
        path: 'notes/resolved.md',
      }],
      kind: 'publication' as const,
      operationId: 'operation-review',
      projectId: 'project-alpha',
    };
    (port.readSnapshot as jest.Mock).mockClear().mockResolvedValue({
      status: 'success',
      value: coordination,
    });
    (port.inspectProject as jest.Mock).mockResolvedValue({
      status: 'success',
      value: {
        coordination,
        gitStatus: {
          acceptedMainOid: 'a'.repeat(40),
          aheadBy: 0,
          behindBy: 0,
          changedFiles: [],
          headOid: 'b'.repeat(40),
          includesAcceptedMain: false,
          personalRemoteOid: 'b'.repeat(40),
          workingTreeClean: true,
        },
        personalChanges: {
          action: 'review-and-publish',
          hasContribution: true,
          review,
          unpublishedReview: {
            baseOid: 'b'.repeat(40),
            files: [],
            headOid: 'b'.repeat(40),
            kind: 'working-tree',
            projectId: 'project-alpha',
            snapshotId: 'd'.repeat(64),
          },
          updateAvailable: true,
        },
        project: project({ connectionStatus: 'connected', hostStatus: 'running' }),
      },
    });
    const onOpenPublicationReview = jest.fn();
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onOpenPublicationReview,
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();

    expect(container.querySelector('[data-action="publish"]')).toBeNull();
    expect(container.textContent).not.toContain('notes/resolved.md');
    container.querySelector<HTMLButtonElement>(
      '[data-request-id="request-alpha"]',
    )?.click();

    expect(container.textContent).toContain('notes/resolved.md');
    expect(onOpenPublicationReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-alpha' }),
      review,
      'notes/resolved.md',
    );
    expect(port.prepareReview).not.toHaveBeenCalledWith(
      'project-alpha',
      'request-alpha',
      expect.anything(),
    );
  });

  it('refreshes My changes for coalesced Vault events inside the selected Project only', async () => {
    jest.useFakeTimers();
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({ connectionStatus: 'connected', hostStatus: 'running' })],
      selectedProjectId: 'project-alpha',
    });
    const app = createApp();
    const panel = new CollabPanel(container, {} as never, {
      app,
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();
    (port.inspectProject as jest.Mock).mockClear();

    app.emitVault('modify', { path: 'notes/outside.md' });
    app.emitVault('modify', { path: 'workspace/alpha/note.md' });
    app.emitVault('create', { path: 'workspace/alpha/new.md' });
    jest.runOnlyPendingTimers();
    await flush();

    expect(port.inspectProject).toHaveBeenCalledTimes(1);

    (port.inspectProject as jest.Mock).mockClear();
    app.emitVault(
      'rename',
      { path: 'archive/note.md' },
      'workspace/alpha/note.md',
    );
    jest.runOnlyPendingTimers();
    await flush();
    expect(port.inspectProject).toHaveBeenCalledTimes(1);

    panel.destroy();
    expect(app.vault.offref).toHaveBeenCalledTimes(4);
  });

  it('shows a terminal Retired Project without mounting active collaboration panels', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({
        cleanupStatus: 'complete',
        lifecycle: 'retired',
        retiredAt: '2026-08-13T00:00:00.000Z',
      })],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();

    expect(container.textContent).toContain('Retired');
    expect(container.textContent).toContain('Collaboration ended');
    expect(container.querySelector('.claudian-collab-personal-home')).toBeNull();
    expect(container.querySelector('.claudian-collab-team-home')).toBeNull();
    expect(container.querySelector('.claudian-collab-ticket-home')).toBeNull();
    expect(container.querySelector('[data-action="manage-project"]')).toBeNull();
    expect(container.querySelector('[data-action="keep-retired-files"]')).not.toBeNull();
    expect(container.querySelector('[data-action="delete-retired-files"]')).not.toBeNull();
    expect(mockOpenManagement).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>('[data-action="keep-retired-files"]')?.click();
    await flush();
    expect(port.finalizeRetiredProject).toHaveBeenCalledWith({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    });
  });

  it('keeps a terminal Retired Project actionable when native Git is missing', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({
        cleanupStatus: 'complete',
        lifecycle: 'retired',
        retiredAt: '2026-08-13T00:00:00.000Z',
      })],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue({ status: 'missing' }),
    });

    panel.setActive(true);
    await flush();

    expect(container.textContent).toContain('Retired');
    expect(container.textContent).not.toContain('Native Git required');
    expect(container.querySelector('[data-action="keep-retired-files"]')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-action="keep-retired-files"]')?.click();
    await flush();
    expect(port.finalizeRetiredProject).toHaveBeenCalledWith({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    });
  });

  it('keeps a failed Retired cleanup visible with an inline retry', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({
        cleanupStatus: 'failed',
        lifecycle: 'retired',
        retiredAt: '2026-08-13T00:00:00.000Z',
      })],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();
    expect(container.textContent).toContain('cleanup needs attention');
    expect(container.querySelector('[data-action="keep-retired-files"]')).toBeNull();
    container.querySelector<HTMLButtonElement>(
      '[data-action="retry-retired-cleanup"]',
    )?.click();
    await flush();
    expect(port.retryProjectCleanup).toHaveBeenCalledWith('project-alpha');
  });

  it('preserves scroll position and focused control across state refreshes', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });

    panel.setActive(true);
    await flush();
    const root = container.querySelector<HTMLElement>('.claudian-collab-panel')!;
    const projectPicker = root.querySelector<HTMLButtonElement>('[data-field="project-picker"]')!;
    root.scrollTop = 123;
    projectPicker.focus();

    await port.startHost('project-alpha');
    await flush();

    expect(root.scrollTop).toBe(123);
    expect(document.activeElement).toBe(
      root.querySelector('[data-field="project-picker"]'),
    );
  });

  it('pauses and preserves the rendered surface across unchanged sidebar visibility', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });
    panel.setActive(true);
    await flush();
    const personalFile = container.querySelector('[data-path="note.md"]');
    const request = container.querySelector('[data-request-id="request-maya"]');
    const inspectionCount = (port.inspectProject as jest.Mock).mock.calls.length;
    const snapshotCount = (port.readSnapshot as jest.Mock).mock.calls.length;

    panel.setActive(false);
    expect(container.querySelector('[data-path="note.md"]')).toBe(personalFile);
    expect(container.querySelector('[data-request-id="request-maya"]')).toBe(request);

    panel.setActive(true);
    await flush();
    expect(container.querySelector('[data-path="note.md"]')).toBe(personalFile);
    expect(container.querySelector('[data-request-id="request-maya"]')).toBe(request);
    expect(port.inspectProject).toHaveBeenCalledTimes(inspectionCount);
    expect(port.readSnapshot).toHaveBeenCalledTimes(snapshotCount);
    expect(port.subscribe).toHaveBeenCalledTimes(4);
  });

  it('restores a pending setup action that resolves while Collab is hidden', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project({ health: 'needs-attention' })],
      selectedProjectId: 'project-alpha',
    });
    let finishLookup!: (operationId: string) => void;
    const getPendingSetupOperationId = jest.fn(() => new Promise<string>(resolve => {
      finishLookup = resolve;
    }));
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });
    panel.setActive(true);
    await flush();

    panel.setActive(false);
    finishLookup('create-project-alpha');
    await flush();
    expect(container.querySelector('[data-action="resume-setup"]')).toBeNull();

    panel.setActive(true);
    await flush();

    expect(getPendingSetupOperationId).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-action="resume-setup"]')).not.toBeNull();
  });

  it('replays an aborted Team-only refresh when Collab resumes', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    const initialSnapshot = await port.readSnapshot('project-alpha');
    let retrySignal: AbortSignal | undefined;
    (port.readSnapshot as jest.Mock)
      .mockClear()
      .mockResolvedValueOnce({
        error: new CollabError({ code: 'offline' }),
        status: 'failure',
      })
      .mockImplementationOnce((_projectId, options) => {
        retrySignal = options?.signal;
        return new Promise(resolve => {
          options?.signal?.addEventListener('abort', () => {
            resolve({ status: 'cancelled' });
          }, { once: true });
        });
      })
      .mockResolvedValueOnce(initialSnapshot);
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });
    panel.setActive(true);
    await flush();
    expect(container.querySelector('[data-action="retry-team-changes"]')).not.toBeNull();

    container.querySelector<HTMLButtonElement>('[data-action="retry-team-changes"]')?.click();
    await flush();
    expect(retrySignal?.aborted).toBe(false);

    panel.setActive(false);
    expect(retrySignal?.aborted).toBe(true);
    panel.setActive(true);
    await flush();

    expect(port.readSnapshot).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('Maya');
  });

  it('opens Project management immediately without requiring an online snapshot', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });
    panel.setActive(true);
    await flush();
    (port.readSnapshot as jest.Mock).mockResolvedValueOnce({ status: 'failure' });

    const snapshotCount = (port.readSnapshot as jest.Mock).mock.calls.length;
    container.querySelector<HTMLButtonElement>('[data-action="manage-project"]')?.click();
    expect(mockOpenManagement).toHaveBeenCalledTimes(1);
    expect(port.readSnapshot).toHaveBeenCalledTimes(snapshotCount);
  });

  it('coalesces hidden invalidation into one refresh when Collab resumes', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit: jest.fn().mockResolvedValue(AVAILABLE),
    });
    panel.setActive(true);
    await flush();
    const inspectionCount = (port.inspectProject as jest.Mock).mock.calls.length;
    const snapshotCount = (port.readSnapshot as jest.Mock).mock.calls.length;

    panel.setActive(false);
    await port.initialize();
    await port.initialize();
    await flush();
    expect(port.inspectProject).toHaveBeenCalledTimes(inspectionCount);
    expect(port.readSnapshot).toHaveBeenCalledTimes(snapshotCount);

    panel.setActive(true);
    await flush();
    expect(port.inspectProject).toHaveBeenCalledTimes(inspectionCount + 1);
    expect(port.readSnapshot).toHaveBeenCalledTimes(snapshotCount + 1);
  });

  it('ignores late initialization and releases its subscription after destroy', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'uninitialized',
      projects: [],
      selectedProjectId: null,
    });
    let finishResolution!: (value: typeof AVAILABLE) => void;
    const resolveGit = jest.fn(() => new Promise<typeof AVAILABLE>(resolve => {
      finishResolution = resolve;
    }));
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit,
    });
    panel.setActive(true);

    panel.destroy();
    finishResolution(AVAILABLE);
    await flush();

    expect(port.initialize).not.toHaveBeenCalled();
    expect(container.querySelector('.claudian-collab-panel')).toBeNull();
    const subscription = port.subscribe.mock.results[0]?.value as { dispose: jest.Mock };
    expect(subscription.dispose).toHaveBeenCalledTimes(1);
    expect(port.subscribe.mock.results).toHaveLength(1);
  });

  it('reuses in-flight initialization when the surface becomes active again', async () => {
    const container = document.body.createDiv();
    const port = createPort({
      lifecycle: 'uninitialized',
      projects: [],
      selectedProjectId: null,
    });
    let finishFirst!: (value: typeof AVAILABLE) => void;
    const resolveGit = jest.fn()
      .mockImplementationOnce(() => new Promise<typeof AVAILABLE>(resolve => {
        finishFirst = resolve;
      }))
      .mockResolvedValue(AVAILABLE);
    const panel = new CollabPanel(container, {} as never, {
      app: createApp(),
      configuredGitPath: () => '',
      onSaveConfiguredGitPath: jest.fn(),
      port,
      projectSetup: { getPendingSetupOperationId: jest.fn() },
      resolveGit,
    });
    panel.setActive(true);
    panel.setActive(false);
    panel.setActive(true);

    finishFirst(AVAILABLE);
    await flush();
    await flush();

    expect(resolveGit).toHaveBeenCalledTimes(1);
    expect(port.initialize).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Create');
  });
});
