/** @jest-environment jsdom */

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

    expect(port.createProject).toHaveBeenCalledWith({
      memberDisplayName: 'Alice',
      name: 'Alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-alpha' }));
    expect(modal.close).toHaveBeenCalledTimes(1);
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
      expect.anything(),
    );
  });

  it('aborts active creation when the modal closes', () => {
    let capturedSignal: AbortSignal | undefined;
    const port = createPort({
      createProject: jest.fn((_request, options) => {
        capturedSignal = options?.signal;
        return new Promise<never>(() => undefined);
      }),
    });
    const modal = new CreateProjectModal({} as never, port);
    modal.onOpen();
    fillRequiredFields(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create"]')?.click();

    modal.close();

    expect(capturedSignal?.aborted).toBe(true);
  });
});
