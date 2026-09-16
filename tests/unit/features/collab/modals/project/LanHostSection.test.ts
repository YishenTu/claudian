/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';

import type { CollabFeatureState } from '@/core/collab';
import { type CollabLocalProjectSummary } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  LanHostSection,
} from '@/features/collab/modals/project/LanHostSection';
import { ProjectManagementSession, type ProjectManagementSessionPort } from '@/features/collab/modals/project/ProjectManagementSession';

type LanHostSectionPort = Pick<ProjectManagementSessionPort, 'claimLegacyHostInstallation' | 'startHost' | 'stopHost'>;

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
    role: 'member',
    workspacePath: 'workspace/alpha',
    ...overrides,
  };
}

function createPort(
  overrides: Partial<jest.Mocked<LanHostSectionPort>> = {},
): jest.Mocked<LanHostSectionPort> {
  return {
    claimLegacyHostInstallation: jest.fn().mockResolvedValue({
      status: 'success',
      value: project({ hostInstallationStatus: 'hosted-here' }),
    }),
    startHost: jest.fn().mockResolvedValue({
      status: 'success',
      value: { projectId: 'project-alpha', status: 'running' },
    }),
    stopHost: jest.fn().mockResolvedValue({
      status: 'success',
      value: { projectId: 'project-alpha', status: 'stopped' },
    }),
    ...overrides,
  } as jest.Mocked<LanHostSectionPort>;
}

function mountHost(container: HTMLElement, options: {
  project: CollabLocalProjectSummary;
  port: LanHostSectionPort;
  confirmLegacyClaim?: () => Promise<boolean>;
  onOpenDiagnostics?: ConstructorParameters<typeof LanHostSection>[1]['onOpenDiagnostics'];
}) {
  const unavailable = { status: 'failure' as const, error: new CollabError({ code: 'endpoint-unreachable' }) };
  let publish!: (state: CollabFeatureState) => void;
  const session = new ProjectManagementSession({
    project: options.project,
    port: {
      ...options.port,
      observeProject: () => ({ dispose() {} }),
      subscribe: listener => { publish = listener; return { dispose() {} }; },
      readSnapshot: async () => unavailable,
      readProjectCapabilities: async () => unavailable,
      readLanToCloudTransfer: async () => ({ status: 'success', value: null }),
      readCloudToLanTransfer: async () => ({ status: 'success', value: null }),
      readManagementOperation: async () => ({ status: 'success', value: null }),
      listMembers: async () => unavailable,
      listManagerResponsibilityOffers: async () => unavailable,
    },
    confirmLegacyClaim: options.confirmLegacyClaim ?? (async () => false),
    onChange: () => section.setState(session.host),
    onResetInteraction() {},
    onClose() {},
  });
  const section = new LanHostSection(container, {
    state: session.host,
    onAction: action => { void session.runHostAction(action); },
    onOpenDiagnostics: options.onOpenDiagnostics,
  });
  session.open();
  return {
    destroy() { session.close(); section.destroy(); },
    setProject(project: CollabLocalProjectSummary) {
      publish({ lifecycle: 'ready', projects: [project], selectedProjectId: project.id });
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('LanHostSection', () => {
  it('continues a confirmed legacy claim into Host startup after its own ownership publication', async () => {
    const claimed = project({ hostInstallationStatus: 'hosted-here', hostStatus: 'stopped' });
    const port = createPort({ claimLegacyHostInstallation: jest.fn().mockImplementation(async () => {
      section.setProject(claimed);
      return { status: 'success', value: claimed };
    }) });
    const container = document.body.createDiv();
    const section = mountHost(container, {
      confirmLegacyClaim: async () => true,
      port,
      project: project({ hostInstallationStatus: 'legacy-unbound', hostStatus: 'stopped' }),
    });
    try {
      fireEvent.click(within(container).getByRole('button', { name: 'Start Host' }));
      await flush(); await flush();
      expect(within(container).getByRole('button', { name: 'Stop Host' })).not.toBeNull();
      expect(within(container).getByText('Running')).not.toBeNull();
    } finally { section.destroy(); container.remove(); }
  });


  it('lets a non-Manager Host start and stop without exposing Manager controls', async () => {
    const container = document.body.createDiv();
    const port = createPort();
    const section = mountHost(container, {
      port,
      project: project(),
    });

    const sectionEl = container.querySelector<HTMLElement>('.claudian-collab-host-section')!;
    expect(sectionEl.tagName).toBe('DIV');
    const header = sectionEl.querySelector<HTMLElement>(
      '.claudian-collab-host-section-header',
    )!;
    expect(header.firstElementChild?.textContent).toBe('LAN Host (on this device)');
    expect(header.querySelector('span.claudian-collab-host-badge')).toBeNull();
    expect(header.querySelector<HTMLButtonElement>('[data-action="start-host"]')
      ?.classList.contains('mod-cta')).toBe(true);
    expect(sectionEl.textContent).toContain('Stopped');
    expect(sectionEl.querySelectorAll('button')).toHaveLength(1);
    expect(sectionEl.querySelector('[data-action="create-invitation"]')).toBeNull();

    sectionEl.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();
    await flush();
    expect(port.startHost).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sectionEl.textContent).toContain('Running');
    expect(sectionEl.querySelectorAll('button')).toHaveLength(1);

    sectionEl.querySelector<HTMLButtonElement>('[data-action="stop-host"]')?.click();
    await flush();
    expect(port.stopHost).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(sectionEl.textContent).toContain('Stopped');

    section.destroy();
  });

  it('expands actionable warnings and supports diagnostics plus retry', async () => {
    const container = document.body.createDiv();
    const onOpenDiagnostics = jest.fn();
    const failure = new CollabError({
      code: 'database-corrupt',
      recoveryActions: ['open-diagnostics'],
      safeContext: { reason: 'authority-open-failed' },
    });
    const port = createPort({
      startHost: jest.fn()
        .mockResolvedValueOnce({ status: 'failure', error: failure })
        .mockResolvedValueOnce({
          status: 'success',
          value: { projectId: 'project-alpha', status: 'running' },
        }),
    });
    const section = mountHost(container, {
      onOpenDiagnostics,
      port,
      project: project({ hostStatus: 'needs-attention' }),
    });

    const sectionEl = container.querySelector<HTMLElement>('.claudian-collab-host-section')!;
    expect(sectionEl.textContent).toContain('Needs attention');
    expect(sectionEl.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.textContent)
      .toContain('Needs attention');
    sectionEl.querySelector<HTMLButtonElement>('[data-action="host-diagnostics"]')?.click();
    expect(onOpenDiagnostics).toHaveBeenLastCalledWith({
      projectId: 'project-alpha',
      status: 'needs-attention',
    });

    sectionEl.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();
    await flush();
    expect(sectionEl.querySelector('[role="alert"]')?.textContent)
      .toContain('Host could not be started');
    expect(sectionEl.querySelector<HTMLButtonElement>('[data-action="retry-host"]')?.textContent)
      .toContain('Needs attention');
    sectionEl.querySelector<HTMLButtonElement>('[data-action="host-diagnostics"]')?.click();
    expect(onOpenDiagnostics).toHaveBeenLastCalledWith({
      error: failure.toJSON(),
      projectId: 'project-alpha',
      status: 'needs-attention',
    });

    sectionEl.querySelector<HTMLButtonElement>('[data-action="retry-host"]')?.click();
    await flush();
    expect(port.startHost).toHaveBeenCalledTimes(2);
    expect(sectionEl.textContent).toContain('Running');
    expect(sectionEl.querySelector('.claudian-collab-host-body')).toBeNull();
    section.destroy();
  });

  it('renders nothing for a Manager who does not own Host capability', () => {
    const container = document.body.createDiv();
    mountHost(container, {
      port: createPort(),
      project: project({ hostStatus: 'not-host', role: 'manager' }),
    });

    expect(container.childElementCount).toBe(0);
  });

  it('shows a foreign Host installation as status-only with no Host action', () => {
    const container = document.body.createDiv();
    const port = createPort();
    mountHost(container, {
      port,
      project: project({
        connectionStatus: 'offline',
        hostInstallationStatus: 'hosted-elsewhere',
        hostStatus: 'not-host',
      }),
    });

    expect(container.textContent).toContain('LAN Host (on another device)');
    expect(container.querySelector('.claudian-collab-host-badge')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(port.startHost).not.toHaveBeenCalled();
  });

  it('claims a legacy Host only after the accepted explicit confirmation', async () => {
    const cancelledContainer = document.body.createDiv();
    const cancelledPort = createPort();
    const cancelConfirmation = jest.fn().mockResolvedValue(false);
    mountHost(cancelledContainer, {
      confirmLegacyClaim: cancelConfirmation,
      port: cancelledPort,
      project: project({ hostInstallationStatus: 'legacy-unbound' }),
    });

    cancelledContainer.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();
    await flush();
    expect(cancelConfirmation).toHaveBeenCalledTimes(1);
    expect(cancelledPort.claimLegacyHostInstallation).not.toHaveBeenCalled();
    expect(cancelledPort.startHost).not.toHaveBeenCalled();
    expect(cancelledContainer.textContent).toContain('Stopped');

    const confirmedContainer = document.body.createDiv();
    const confirmedPort = createPort();
    mountHost(confirmedContainer, {
      confirmLegacyClaim: jest.fn().mockResolvedValue(true),
      port: confirmedPort,
      project: project({ hostInstallationStatus: 'legacy-unbound' }),
    });

    confirmedContainer.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();
    await flush();
    await flush();
    expect(confirmedPort.claimLegacyHostInstallation).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(confirmedPort.startHost).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(confirmedContainer.textContent).toContain('Running');
  });

  it('suppresses a late legacy confirmation after the Host section is destroyed', async () => {
    let confirm!: (accepted: boolean) => void;
    const port = createPort();
    const container = document.body.createDiv();
    const section = mountHost(container, {
      confirmLegacyClaim: jest.fn(() => new Promise(resolve => { confirm = resolve; })),
      port,
      project: project({ hostInstallationStatus: 'legacy-unbound' }),
    });
    container.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();

    section.destroy();
    confirm(true);
    await flush();

    expect(port.claimLegacyHostInstallation).not.toHaveBeenCalled();
    expect(port.startHost).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
  });

  it('renders transitional Host states without exposing a second action', () => {
    const container = document.body.createDiv();
    const section = mountHost(container, {
      port: createPort(),
      project: project({ hostStatus: 'starting' }),
    });

    expect(container.textContent).toContain('Starting');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);

    section.setProject(project({ hostStatus: 'stopping' }));
    expect(container.textContent).toContain('Stopping');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    section.destroy();
  });

  it('aborts an active Host operation on destroy and suppresses late rendering', async () => {
    let finish!: (value: {
      status: 'success';
      value: { projectId: string; status: 'running' };
    }) => void;
    let signal: AbortSignal | undefined;
    const port = createPort({
      startHost: jest.fn((_projectId, options) => {
        signal = options?.signal;
        return new Promise(resolve => { finish = resolve; });
      }),
    });
    const container = document.body.createDiv();
    const section = mountHost(container, {
      port,
      project: project(),
    });
    container.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();

    section.destroy();
    finish({
      status: 'success',
      value: { projectId: 'project-alpha', status: 'running' },
    });
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(container.childElementCount).toBe(0);
  });

  it('retains an admitted Host action through unrelated Project refreshes', async () => {
    let finish!: (value: Awaited<ReturnType<LanHostSectionPort['startHost']>>) => void;
    let signal: AbortSignal | undefined;
    const port = createPort({ startHost: jest.fn((_projectId, options) => {
      signal = options?.signal;
      return new Promise(resolve => { finish = resolve; });
    }) });
    const container = document.body.createDiv();
    const section = mountHost(container, { port, project: project() });
    container.querySelector<HTMLButtonElement>('[data-action="start-host"]')!.click();
    section.setProject(project({ name: 'Renamed Project' }));
    expect(signal?.aborted).toBe(false);
    expect(container.textContent).toContain('Starting');
    finish({ status: 'failure', error: new CollabError({ code: 'operation-failed' }) });
    await flush();
    expect(container.textContent).toContain('Host could not be started');
    section.setProject(project({ name: 'Renamed again' }));
    expect(container.textContent).toContain('Host could not be started');
    expect(container.querySelector<HTMLButtonElement>('[data-action="retry-host"]')?.disabled).toBe(false);
    section.destroy(); container.remove();
  });

  it('does not restore Running from a late start result after a published stop', async () => {
    let finish!: (result: Awaited<ReturnType<LanHostSectionPort['startHost']>>) => void;
    const port = createPort({ startHost: jest.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
    const container = document.body.createDiv();
    const section = mountHost(container, { port, project: project() });
    fireEvent.click(within(container).getByRole('button', { name: 'Start Host' }));
    section.setProject(project({ hostStatus: 'running' }));
    section.setProject(project({ hostStatus: 'stopped' }));
    finish({ status: 'success', value: { projectId: 'project-alpha', status: 'running' } });
    await flush();
    expect(within(container).getByRole('button', { name: 'Start Host' }).textContent).toContain('Stopped');
    section.destroy(); container.remove();
  });

  it('keeps newer published Host state while consuming a late operation result', async () => {
    let finish!: (
      value: Awaited<ReturnType<LanHostSectionPort['startHost']>>,
    ) => void;
    let signal: AbortSignal | undefined;
    const port = createPort({
      startHost: jest.fn((_projectId, options) => {
        signal = options?.signal;
        return new Promise(resolve => { finish = resolve; });
      }),
    });
    const container = document.body.createDiv();
    const section = mountHost(container, {
      port,
      project: project(),
    });
    container.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();

    section.setProject(project({
      connectionStatus: 'connected',
      hostStatus: 'running',
    }));
    finish({
      status: 'failure',
      error: { code: 'operation-failed' } as never,
    });
    await flush();

    expect(signal?.aborted).toBe(false);
    expect(container.textContent).toContain('Running');
    expect(container.textContent).not.toContain('Host could not be started');
  });
});
