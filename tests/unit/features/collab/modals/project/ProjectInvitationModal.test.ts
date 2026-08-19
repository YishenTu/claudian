/** @jest-environment jsdom */

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

import {
  ProjectInvitationModal,
  type ProjectInvitationModalPort,
} from '@/features/collab/modals/project/ProjectInvitationModal';

function success<T>(value: T) {
  return { status: 'success' as const, value };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProjectInvitationModal', () => {
  it('owns invitation creation, copy, and revoke without changing its parent layout', async () => {
    const port: jest.Mocked<ProjectInvitationModalPort> = {
      createInvitation: jest.fn().mockResolvedValue(success({
        encodedInvitation: 'claudian-collab:v2:invite-alpha',
        expiresAt: '2026-08-08T00:15:00.000Z',
      })),
      revokeInvitation: jest.fn().mockResolvedValue(success(undefined)),
    };
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectInvitationModal({} as never, port, {
      copyText,
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();

    expect(port.createInvitation).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(modal.contentEl.textContent).toContain('claudian-collab:v2:invite-alpha');

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="copy-invitation"]')
      ?.click();
    await flush();
    expect(copyText).toHaveBeenCalledWith('claudian-collab:v2:invite-alpha');

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="revoke-invitation"]')
      ?.click();
    await flush();
    expect(port.revokeInvitation).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(modal.close).toHaveBeenCalledTimes(1);
  });
});
