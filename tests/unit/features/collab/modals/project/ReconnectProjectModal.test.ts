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

import { ReconnectProjectModal } from '@/features/collab/modals/project/ReconnectProjectModal';

type ReconnectPort = Pick<CollabFeaturePort, 'reconnectProject'>;

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
    const port: jest.Mocked<ReconnectPort> = {
      reconnectProject: jest.fn().mockResolvedValue({
        status: 'success',
        value: project(),
      }),
    };
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

    expect(port.reconnectProject).toHaveBeenCalledWith({
      encodedInvitation: 'claudian-collab:v2:payload',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(onReconnected).toHaveBeenCalledWith(project());
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the invitation available for retry after a failure', async () => {
    const port: jest.Mocked<ReconnectPort> = {
      reconnectProject: jest.fn().mockResolvedValue({
        error: { code: 'endpoint-unreachable' },
        status: 'failure',
      }),
    } as unknown as jest.Mocked<ReconnectPort>;
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

  it('aborts an active reconnect and ignores its late completion', async () => {
    let resolveReconnect!: (
      value: Awaited<ReturnType<ReconnectPort['reconnectProject']>>,
    ) => void;
    let signal: AbortSignal | undefined;
    const port: jest.Mocked<ReconnectPort> = {
      reconnectProject: jest.fn((_request, options) => {
        signal = options?.signal;
        return new Promise(resolve => {
          resolveReconnect = resolve;
        });
      }),
    };
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

    expect(signal?.aborted).toBe(true);
    expect(onReconnected).not.toHaveBeenCalled();
  });
});
