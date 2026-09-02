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

import { ReconnectProjectModal } from '@/features/collab/modals/project/ReconnectProjectModal';

const axe = configureAxe({ rules: { region: { enabled: false } } });

type ReconnectPort = Pick<
  CollabFeaturePort,
  'readPendingReconnect' | 'reconnectProject' | 'resumeReconnect'
>;

function createPort(
  overrides: Partial<jest.Mocked<ReconnectPort>> = {},
): jest.Mocked<ReconnectPort> {
  return {
    readPendingReconnect: jest.fn().mockResolvedValue({ status: 'success', value: null }),
    reconnectProject: jest.fn(),
    resumeReconnect: jest.fn(),
    ...overrides,
  } as jest.Mocked<ReconnectPort>;
}

function project() {
  return {
    authorityKind: 'lan' as const,
    connectionStatus: 'connected' as const,
    health: 'healthy' as const,
    hostInstallationStatus: 'not-host' as const,
    hostStatus: 'not-host' as const,
    id: 'project-alpha',
    name: 'Alpha',
    role: 'member' as const,
    workspacePath: 'workspace/project-alpha',
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ReconnectProjectModal', () => {
  it('submits one invitation for the selected existing Project', async () => {
    const port = createPort({
      reconnectProject: jest.fn().mockResolvedValue({
        status: 'success',
        value: project(),
      }),
    });
    const onReconnected = jest.fn();
    const modal = new ReconnectProjectModal({} as never, port, {
      onReconnected,
      project: project(),
    });
    modal.onOpen();
    const invitation = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="invitation"]',
    )!;
    const reconnect = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="reconnect"]',
    )!;
    expect(modal.contentEl.querySelector('[data-field="member-name"]')).toBeNull();
    expect(reconnect.disabled).toBe(true);

    invitation.value = ' claudian-collab:v2:payload ';
    invitation.dispatchEvent(new Event('input'));
    reconnect.click();
    await flush();

    expect(port.reconnectProject).toHaveBeenCalledWith(
      {
        encodedInvitation: 'claudian-collab:v2:payload',
        projectId: 'project-alpha',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onReconnected).toHaveBeenCalledWith(project());
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('relocates an existing Cloud identity to the raw server URL without a login form', async () => {
    const cloudProject = { ...project(), authorityKind: 'cloud' as const };
    const port = createPort({
      reconnectProject: jest.fn().mockResolvedValue({
        status: 'success',
        value: cloudProject,
      }),
    });
    const modal = new ReconnectProjectModal({} as never, port, {
      project: cloudProject,
    });
    modal.onOpen();

    expect(modal.contentEl.textContent).toContain(
      'Cloud invitation, imported membership claim, or its new server URL',
    );

    const relocation = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="reconnect-relocation"]',
    )!;
    relocation.checked = true;
    relocation.dispatchEvent(new Event('change'));
    const serverUrl = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="server-url"]',
    )!;
    serverUrl.value = ' HTTP://203.0.113.8:8787/operator/cloud ';
    serverUrl.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="reconnect"]')?.click();
    await flush();

    expect(modal.contentEl.querySelector('[data-field="username"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-field="password"]')).toBeNull();
    expect(port.reconnectProject).toHaveBeenCalledWith(
      {
        authority: {
          kind: 'cloud',
          serverUrl: ' HTTP://203.0.113.8:8787/operator/cloud ',
        },
        projectId: 'project-alpha',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('describes a failed Cloud relocation as a server URL failure', async () => {
    const cloudProject = { ...project(), authorityKind: 'cloud' as const };
    const port = createPort({
      reconnectProject: jest.fn().mockResolvedValue({
        error: { code: 'endpoint-unreachable' },
        status: 'failure',
      }),
    });
    const modal = new ReconnectProjectModal({} as never, port, { project: cloudProject });
    modal.onOpen();
    const relocation = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="reconnect-relocation"]',
    )!;
    relocation.checked = true;
    relocation.dispatchEvent(new Event('change'));
    const serverUrl = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="server-url"]',
    )!;
    serverUrl.value = 'https://new.example.test/';
    serverUrl.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="reconnect"]')?.click();
    await flush();

    const alert = modal.contentEl.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('server URL');
    expect(alert?.textContent).not.toContain('invitation');
  });

  it('cannot be re-enabled by input while a reconnect request is unresolved', async () => {
    let resolveReconnect!: (
      value: Awaited<ReturnType<ReconnectPort['reconnectProject']>>,
    ) => void;
    const port = createPort({
      reconnectProject: jest.fn((_request, _options) => new Promise(resolve => {
        resolveReconnect = resolve;
      })),
    });
    const modal = new ReconnectProjectModal({} as never, port, { project: project() });
    modal.onOpen();
    const invitation = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="invitation"]',
    )!;
    const button = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="reconnect"]',
    )!;
    invitation.value = 'claudian-collab:v2:payload';
    invitation.dispatchEvent(new Event('input'));
    button.click();
    invitation.value = 'claudian-collab:v2:changed';
    invitation.dispatchEvent(new Event('input'));
    button.click();

    expect(button.disabled).toBe(true);
    expect(invitation.disabled).toBe(true);
    expect(port.reconnectProject).toHaveBeenCalledTimes(1);
    resolveReconnect({ status: 'success', value: project() });
    await flush();
  });

  it('has no detectable accessibility violations for Cloud reconnect modes', async () => {
    const port = createPort();
    const modal = new ReconnectProjectModal({} as never, port, {
      project: { ...project(), authorityKind: 'cloud' },
    });
    modal.onOpen();

    expect(await axe(modal.contentEl)).toHaveNoViolations();
  });

  it('keeps the invitation available for retry after a failure', async () => {
    const port = createPort({
      reconnectProject: jest.fn().mockResolvedValue({
        error: { code: 'endpoint-unreachable' },
        status: 'failure',
      }),
    });
    const modal = new ReconnectProjectModal({} as never, port, {
      project: project(),
    });
    modal.onOpen();
    const invitation = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="invitation"]',
    )!;
    invitation.value = 'claudian-collab:v2:payload';
    invitation.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="reconnect"]')?.click();
    await flush();

    expect(invitation.value).toBe('claudian-collab:v2:payload');
    expect(modal.contentEl.querySelector('[role="alert"]')).not.toBeNull();
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="reconnect"]',
    )?.disabled).toBe(false);
  });

  it('freezes a durable Cloud relocation and resumes it explicitly through the app owner', async () => {
    const cloudProject = { ...project(), authorityKind: 'cloud' as const };
    const pending = {
      operationId: 'relocate-project-alpha',
      projectId: 'project-alpha',
      serverUrl: 'HTTP://203.0.113.8:8787/operator/cloud',
    };
    const port = createPort({
      readPendingReconnect: jest.fn()
        .mockResolvedValueOnce({ status: 'success', value: null })
        .mockResolvedValue({ status: 'success', value: pending }),
      reconnectProject: jest.fn().mockResolvedValue({
        durablePhase: 'committed',
        durableProgress: true,
        error: { code: 'durable-progress-recovery-required' },
        operationId: pending.operationId,
        status: 'recovery-required',
      }),
      resumeReconnect: jest.fn().mockResolvedValue({
        status: 'success',
        value: cloudProject,
      }),
    } as never);
    const onReconnected = jest.fn();
    const modal = new ReconnectProjectModal({} as never, port, {
      onReconnected,
      project: cloudProject,
    });
    modal.onOpen();
    await flush();

    const relocation = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="reconnect-relocation"]',
    )!;
    relocation.checked = true;
    relocation.dispatchEvent(new Event('change'));
    const serverUrl = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="server-url"]',
    )!;
    serverUrl.value = pending.serverUrl;
    serverUrl.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="reconnect"]')?.click();
    await flush();
    await flush();

    expect(serverUrl.value).toBe(pending.serverUrl);
    expect(serverUrl.disabled).toBe(true);
    expect(modal.contentEl.querySelector('[data-action="resume"]')).not.toBeNull();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="resume"]')?.click();
    await flush();

    expect(port.resumeReconnect).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onReconnected).toHaveBeenCalledWith(cloudProject);
  });

  it('restores a pending Cloud relocation on reopen without asking for the URL again', async () => {
    const cloudProject = { ...project(), authorityKind: 'cloud' as const };
    const port = createPort({
      readPendingReconnect: jest.fn().mockResolvedValue({
        status: 'success',
        value: {
          operationId: 'relocate-project-alpha',
          projectId: 'project-alpha',
          serverUrl: 'https://new.example.test/operator',
        },
      }),
    });
    const modal = new ReconnectProjectModal({} as never, port, { project: cloudProject });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="server-url"]',
    )?.value).toBe('https://new.example.test/operator');
    expect(modal.contentEl.querySelector('[data-action="resume"]')).not.toBeNull();
    expect(port.reconnectProject).not.toHaveBeenCalled();
  });

  it('aborts an active reconnect and ignores its late completion', async () => {
    let resolveReconnect!: (
      value: Awaited<ReturnType<ReconnectPort['reconnectProject']>>,
    ) => void;
    let signal: AbortSignal | undefined;
    const port = createPort({
      reconnectProject: jest.fn((_request, options) => {
        signal = options?.signal;
        return new Promise(resolve => {
          resolveReconnect = resolve;
        });
      }),
    });
    const onReconnected = jest.fn();
    const modal = new ReconnectProjectModal({} as never, port, {
      onReconnected,
      project: project(),
    });
    modal.onOpen();
    const invitation = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="invitation"]',
    )!;
    invitation.value = 'claudian-collab:v2:payload';
    invitation.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="reconnect"]')?.click();

    modal.close();
    resolveReconnect({ status: 'success', value: project() });
    await flush();

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it('re-enables recovery input when the durable reconnect cannot be read', async () => {
    const cloudProject = { ...project(), authorityKind: 'cloud' as const };
    const port = createPort({
      readPendingReconnect: jest.fn()
        .mockResolvedValueOnce({ status: 'success', value: null })
        .mockResolvedValueOnce({
          error: { code: 'endpoint-unreachable' },
          status: 'failure',
        }),
      reconnectProject: jest.fn().mockResolvedValue({
        durablePhase: 'prepared',
        durableProgress: true,
        error: { code: 'durable-progress-recovery-required' },
        operationId: 'relocate-project-alpha',
        status: 'recovery-required',
      }),
    } as never);
    const modal = new ReconnectProjectModal({} as never, port, { project: cloudProject });
    modal.onOpen();
    await flush();
    const relocation = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="reconnect-relocation"]',
    )!;
    relocation.checked = true;
    relocation.dispatchEvent(new Event('change'));
    const serverUrl = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="server-url"]',
    )!;
    serverUrl.value = 'https://new.example.test/operator';
    serverUrl.dispatchEvent(new Event('input'));

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="reconnect"]')?.click();
    await flush();
    await flush();

    expect(serverUrl.disabled).toBe(false);
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="reconnect"]',
    )?.disabled).toBe(false);
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent)
      .toContain('Could not reconnect');
  });
});
