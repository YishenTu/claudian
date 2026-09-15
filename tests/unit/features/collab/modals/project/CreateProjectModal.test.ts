/** @jest-environment jsdom */

import { configureAxe } from 'jest-axe';

import type { CollabFeaturePort } from '@/core/collab';

jest.mock('obsidian', () => ({
  Modal: class MockModal {
    readonly contentEl = document.createElement('div');
    readonly modalEl = document.createElement('div');
    close = jest.fn(() => this.onClose());
    open = jest.fn(() => this.onOpen());
    setTitle = jest.fn();
    onClose(): void {}
    onOpen(): void {}
  },
}));

import { CreateProjectModal } from '@/features/collab/modals/project/CreateProjectModal';

const axe = configureAxe({ rules: { region: { enabled: false } } });

type ProjectPort = Pick<CollabFeaturePort, 'createProject' | 'resumeSetup'>;

function createPort(overrides: Partial<jest.Mocked<ProjectPort>> = {}): jest.Mocked<ProjectPort> {
  return {
    createProject: jest.fn().mockResolvedValue({
      status: 'success',
      value: {
        authorityKind: 'lan',
        connectionStatus: 'host-stopped',
        health: 'healthy',
        hostStatus: 'stopped',
        id: 'project-alpha',
        name: 'Alpha',
        role: 'manager',
        workspacePath: 'Shared/Collab Projects/alpha',
      },
    }),
    resumeSetup: jest.fn(),
    ...overrides,
  } as jest.Mocked<ProjectPort>;
}

function fillRequiredFields(modal: CreateProjectModal): void {
  const name = modal.contentEl.querySelector<HTMLInputElement>('[data-field="project-name"]')!;
  const member = modal.contentEl.querySelector<HTMLInputElement>('[data-field="member-name"]')!;
  name.value = 'Alpha';
  name.dispatchEvent(new Event('input'));
  member.value = 'Alice';
  member.dispatchEvent(new Event('input'));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CreateProjectModal', () => {
  it('creates an empty Project directly from the two required fields', async () => {
    const port = createPort();
    const onCreated = jest.fn();
    const modal = new CreateProjectModal({} as never, port, { onCreated });
    modal.onOpen();

    expect(modal.contentEl.querySelector('[data-field="source"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-action="preview"]')).toBeNull();
    const create = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')!;
    expect(create.disabled).toBe(true);
    fillRequiredFields(modal);
    expect(create.disabled).toBe(false);
    create.click();
    await flush();

    expect(port.createProject).toHaveBeenCalledWith(
      {
        authority: { kind: 'lan' },
        memberDisplayName: 'Alice',
        name: 'Alpha',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-alpha' }));
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('reveals one raw Cloud server URL field and submits it without canonicalizing', async () => {
    const port = createPort();
    const modal = new CreateProjectModal({} as never, port);
    modal.onOpen();
    fillRequiredFields(modal);

    const cloud = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="authority-cloud"]',
    )!;
    cloud.checked = true;
    cloud.dispatchEvent(new Event('change'));
    const serverUrl = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="server-url"]',
    )!;
    const create = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')!;
    expect(serverUrl.hidden).toBe(false);
    expect(create.disabled).toBe(true);
    serverUrl.value = 'HTTP://198.51.100.12:8787/operator/cloud';
    serverUrl.dispatchEvent(new Event('input'));
    create.click();
    await flush();

    expect(port.createProject).toHaveBeenCalledWith(
      {
        authority: {
          kind: 'cloud',
          serverUrl: 'HTTP://198.51.100.12:8787/operator/cloud',
        },
        memberDisplayName: 'Alice',
        name: 'Alpha',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('has no detectable accessibility violations in either authority mode', async () => {
    const modal = new CreateProjectModal({} as never, createPort());
    modal.onOpen();

    expect(await axe(modal.contentEl)).toHaveNoViolations();
    const cloud = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="authority-cloud"]',
    )!;
    cloud.checked = true;
    cloud.dispatchEvent(new Event('change'));
    expect(await axe(modal.contentEl)).toHaveNoViolations();
  });

  it('prevents duplicate submission while creation is pending', () => {
    const port = createPort({
      createProject: jest.fn((_request, _options) => (
        new Promise<never>(() => undefined)
      )),
    });
    const modal = new CreateProjectModal({} as never, port);
    modal.onOpen();
    fillRequiredFields(modal);
    const create = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')!;

    create.click();
    create.click();

    expect(port.createProject).toHaveBeenCalledTimes(1);
    expect(create.disabled).toBe(true);
    expect(modal.contentEl.querySelector<HTMLInputElement>('[data-field="project-name"]')?.disabled)
      .toBe(true);
  });

  it('passes the entered Cloud server URL unchanged to the owning validator', async () => {
    const port = createPort();
    const modal = new CreateProjectModal({} as never, port);
    modal.onOpen();
    fillRequiredFields(modal);
    const cloud = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="authority-cloud"]',
    )!;
    cloud.checked = true;
    cloud.dispatchEvent(new Event('change'));
    const serverUrl = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="server-url"]',
    )!;
    serverUrl.value = ' https://cloud.example.test/operator ';
    serverUrl.dispatchEvent(new Event('input'));

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')?.click();
    await flush();

    expect(port.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: {
          kind: 'cloud',
          serverUrl: ' https://cloud.example.test/operator ',
        },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('offers Resume setup after durable creation progress', async () => {
    const port = createPort({
      createProject: jest.fn().mockResolvedValue({
        durablePhase: 'committed',
        durableProgress: true,
        error: { code: 'durable-progress-recovery-required' },
        operationId: 'create-project-alpha',
        status: 'recovery-required',
      }),
      resumeSetup: jest.fn().mockResolvedValue({
        status: 'success',
        value: {
          authorityKind: 'lan',
          connectionStatus: 'host-stopped',
          health: 'healthy',
          hostStatus: 'stopped',
          id: 'project-alpha',
          name: 'Alpha',
          role: 'manager',
          workspacePath: 'workspace/alpha',
        },
      }),
    });
    const modal = new CreateProjectModal({} as never, port);
    modal.onOpen();
    fillRequiredFields(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')?.click();
    await flush();

    const resume = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="resume"]')!;
    resume.click();
    await flush();

    expect(port.resumeSetup).toHaveBeenCalledWith(
      { operationId: 'create-project-alpha' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('keeps the durable creation resume action available after a failed attempt', async () => {
    const port = createPort({
      createProject: jest.fn().mockResolvedValue({
        durablePhase: 'committed',
        durableProgress: true,
        error: { code: 'durable-progress-recovery-required' },
        operationId: 'create-project-alpha',
        status: 'recovery-required',
      }),
      resumeSetup: jest.fn()
        .mockResolvedValueOnce({
          error: { code: 'endpoint-unreachable' },
          status: 'failure',
        })
        .mockResolvedValueOnce({
          status: 'success',
          value: {
            authorityKind: 'lan',
            connectionStatus: 'host-stopped',
            health: 'healthy',
            hostStatus: 'stopped',
            id: 'project-alpha',
            name: 'Alpha',
            role: 'manager',
            workspacePath: 'workspace/alpha',
          },
        }),
    } as never);
    const modal = new CreateProjectModal({} as never, port);
    modal.onOpen();
    fillRequiredFields(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')?.click();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="resume"]')?.click();
    await flush();
    const retry = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="resume"]');
    expect(retry).not.toBeNull();
    retry?.click();
    await flush();

    expect(port.resumeSetup).toHaveBeenCalledTimes(2);
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('aborts active creation while ignoring completion after close', async () => {
    let capturedSignal: AbortSignal | undefined;
    let finish!: (value: Awaited<ReturnType<ProjectPort['createProject']>>) => void;
    const port = createPort({
      createProject: jest.fn((_request, options) => {
        capturedSignal = options?.signal;
        return new Promise(resolve => { finish = resolve; });
      }),
    });
    const onCreated = jest.fn();
    const modal = new CreateProjectModal({} as never, port, { onCreated });
    modal.onOpen();
    fillRequiredFields(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')?.click();

    modal.close();
    finish({
      status: 'success',
      value: {
        authorityKind: 'lan',
        connectionStatus: 'host-stopped',
        health: 'healthy',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'stopped',
        id: 'project-alpha',
        name: 'Alpha',
        role: 'manager',
        workspacePath: 'Shared/Collab Projects/alpha',
      },
    });
    await flush();

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
    expect(onCreated).not.toHaveBeenCalled();
  });
});
