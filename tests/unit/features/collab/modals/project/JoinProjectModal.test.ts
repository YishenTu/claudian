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

import { JoinProjectModal } from '@/features/collab/modals/project/JoinProjectModal';

const axe = configureAxe({ rules: { region: { enabled: false } } });

type JoinPort = Pick<CollabFeaturePort, 'joinProject' | 'resumeSetup'>;

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

function createPort(overrides: Partial<jest.Mocked<JoinPort>> = {}): jest.Mocked<JoinPort> {
  return {
    joinProject: jest.fn().mockResolvedValue({ status: 'success', value: project() }),
    resumeSetup: jest.fn().mockResolvedValue({ status: 'success', value: project() }),
    ...overrides,
  } as jest.Mocked<JoinPort>;
}

function fill(modal: JoinProjectModal): void {
  const invitation = modal.contentEl.querySelector<HTMLTextAreaElement>(
    '[data-field="invitation"]',
  )!;
  const member = modal.contentEl.querySelector<HTMLInputElement>('[data-field="member-name"]')!;
  invitation.value = 'claudian-collab:v2:payload';
  invitation.dispatchEvent(new Event('input'));
  member.value = 'Alice';
  member.dispatchEvent(new Event('input'));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('JoinProjectModal', () => {
  it('submits invitation and display name, then returns the joined Project', async () => {
    const port = createPort();
    const onJoined = jest.fn();
    const modal = new JoinProjectModal({} as never, port, { onJoined });
    modal.onOpen();
    fill(modal);

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="join"]')?.click();
    await flush();

    expect(port.joinProject).toHaveBeenCalledWith(
      {
        encodedInvitation: 'claudian-collab:v2:payload',
        memberDisplayName: 'Alice',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onJoined).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-alpha' }));
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['claudian-collab:v9:payload', 'LAN invitation'],
    ['claudian-cloud:v1:payload', 'Cloud invitation'],
    ['claudian-cloud-claim:v1:payload', 'Imported membership claim'],
  ])('identifies %s as %s without decoding authority data in the UI', (
    encoded,
    expected,
  ) => {
    const modal = new JoinProjectModal({} as never, createPort());
    modal.onOpen();
    const invitation = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="invitation"]',
    )!;

    invitation.value = encoded;
    invitation.dispatchEvent(new Event('input'));

    expect(modal.contentEl.querySelector('[data-material]')?.textContent).toBe(expected);
  });

  it('offers resume after durable membership progress', async () => {
    const port = createPort({
      joinProject: jest.fn().mockResolvedValue({
        durablePhase: 'committed',
        durableProgress: true,
        error: { code: 'durable-progress-recovery-required' },
        operationId: 'join-alpha',
        status: 'recovery-required',
      }),
    });
    const modal = new JoinProjectModal({} as never, port);
    modal.onOpen();
    fill(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="join"]')?.click();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="resume"]')?.click();
    await flush();

    expect(port.resumeSetup).toHaveBeenCalledWith(
      { operationId: 'join-alpha' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the durable Join resume action available after a failed attempt', async () => {
    const port = createPort({
      joinProject: jest.fn().mockResolvedValue({
        durablePhase: 'committed',
        durableProgress: true,
        error: { code: 'durable-progress-recovery-required' },
        operationId: 'join-alpha',
        status: 'recovery-required',
      }),
      resumeSetup: jest.fn()
        .mockResolvedValueOnce({
          error: { code: 'endpoint-unreachable' },
          status: 'failure',
        })
        .mockResolvedValueOnce({ status: 'success', value: project() }),
    } as never);
    const modal = new JoinProjectModal({} as never, port);
    modal.onOpen();
    fill(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="join"]')?.click();
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

  it('cannot be re-enabled by input while a Join request is unresolved', async () => {
    let resolveJoin!: (value: Awaited<ReturnType<JoinPort['joinProject']>>) => void;
    const port = createPort({
      joinProject: jest.fn((_request, _options) => new Promise(resolve => {
        resolveJoin = resolve;
      })),
    });
    const modal = new JoinProjectModal({} as never, port);
    modal.onOpen();
    fill(modal);
    const invitation = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="invitation"]',
    )!;
    const button = modal.contentEl.querySelector<HTMLButtonElement>('[data-action="join"]')!;
    button.click();
    invitation.value = 'claudian-collab:v2:changed';
    invitation.dispatchEvent(new Event('input'));
    button.click();

    expect(button.disabled).toBe(true);
    expect(invitation.disabled).toBe(true);
    expect(port.joinProject).toHaveBeenCalledTimes(1);
    resolveJoin({ status: 'success', value: project() });
    await flush();
  });

  it('aborts an active Join and ignores its stale completion after close', async () => {
    let resolveJoin!: (value: Awaited<ReturnType<JoinPort['joinProject']>>) => void;
    let signal: AbortSignal | undefined;
    const port = createPort({
      joinProject: jest.fn((_request, options) => {
        signal = options?.signal;
        return new Promise(resolve => {
          resolveJoin = resolve;
        });
      }),
    });
    const onJoined = jest.fn();
    const modal = new JoinProjectModal({} as never, port, { onJoined });
    modal.onOpen();
    fill(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="join"]')?.click();

    modal.close();
    resolveJoin({ status: 'success', value: project() });
    await flush();

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('announces Join failures and has no detectable accessibility violations', async () => {
    const port = createPort({
      joinProject: jest.fn().mockResolvedValue({
        error: { code: 'endpoint-unreachable' },
        status: 'failure',
      }),
    });
    const modal = new JoinProjectModal({} as never, port);
    modal.onOpen();
    fill(modal);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="join"]')?.click();
    await flush();

    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent)
      .toBe('Could not join the project.');
    expect(await axe(modal.contentEl)).toHaveNoViolations();
  });
});
