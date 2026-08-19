/** @jest-environment jsdom */

import { type CollabLocalProjectSummary } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  LanHostSection,
  type LanHostSectionPort,
} from '@/features/collab/modals/project/LanHostSection';

function project(
  overrides: Partial<CollabLocalProjectSummary> = {},
): CollabLocalProjectSummary {
  return {
    authorityKind: 'lan',
    connectionStatus: 'host-stopped',
    health: 'healthy',
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('LanHostSection', () => {
  it('lets a non-Manager Host start and stop without exposing Manager controls', async () => {
    const container = document.body.createDiv();
    const port = createPort();
    const section = new LanHostSection(container, {
      port,
      project: project(),
    });

    const sectionEl = container.querySelector<HTMLElement>('.claudian-collab-host-section')!;
    expect(sectionEl.tagName).toBe('DIV');
    expect(sectionEl.textContent).toContain('LAN Host');
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
    const section = new LanHostSection(container, {
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
    new LanHostSection(container, {
      port: createPort(),
      project: project({ hostStatus: 'not-host', role: 'manager' }),
    });

    expect(container.childElementCount).toBe(0);
  });

  it('renders transitional Host states without exposing a second action', () => {
    const container = document.body.createDiv();
    const section = new LanHostSection(container, {
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
    const section = new LanHostSection(container, {
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

  it('fences an active operation when a newer external Host state arrives', async () => {
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
    const section = new LanHostSection(container, {
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

    expect(signal?.aborted).toBe(true);
    expect(container.textContent).toContain('Running');
    expect(container.textContent).not.toContain('Host could not be started');
  });
});
