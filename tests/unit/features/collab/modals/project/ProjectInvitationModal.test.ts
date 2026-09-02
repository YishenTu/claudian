/** @jest-environment jsdom */

import { configureAxe } from 'jest-axe';

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

const axe = configureAxe({ rules: { region: { enabled: false } } });

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
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn().mockResolvedValue(success({
        encodedInvitation: 'claudian-collab:v2:invite-alpha',
        expiresAt: '2026-08-08T00:15:00.000Z',
      })),
      listInvitations: jest.fn(),
      readManagementOperation: jest.fn(),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn().mockResolvedValue(success(undefined)),
    };
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectInvitationModal({} as never, port, {
      copyText,
      authorityKind: 'lan',
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();

    expect(port.createInvitation).not.toHaveBeenCalled();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="create-invitation"]')
      ?.click();
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

  it('aborts a pending LAN invitation mutation when the modal closes', async () => {
    let signal: AbortSignal | undefined;
    const port = {
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn((_projectId, options) => {
        signal = options?.signal;
        return new Promise(() => undefined);
      }),
      listInvitations: jest.fn(),
      readManagementOperation: jest.fn(),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'lan',
      projectId: 'project-alpha',
    });
    modal.onOpen();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.click();

    modal.close();

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });

  it('opens Cloud invitations read-only, creates explicitly, and revokes the exact item', async () => {
    const port: jest.Mocked<ProjectInvitationModalPort> = {
      completeManagementOperation: jest.fn().mockResolvedValue(success(undefined)),
      createInvitation: jest.fn().mockResolvedValue(success({
        encodedInvitation: 'claudian-cloud:v1:secret',
        expiresAt: '2026-09-10T00:00:00.000Z',
      })),
      listInvitations: jest.fn().mockResolvedValue(success([{
        createdAt: '2026-09-02T00:00:00.000Z',
        expiresAt: '2026-09-10T00:00:00.000Z',
        invitationId: 'invitation-existing',
        state: 'active',
      }])),
      readManagementOperation: jest.fn().mockResolvedValue(success(null)),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn().mockResolvedValue(success(undefined)),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();
    expect(port.createInvitation).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('invitation-existing');
    expect(modal.contentEl.querySelector('[data-invitation-state="active"]')?.textContent)
      .toBe('Active');

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.click();
    await flush();
    expect(port.createInvitation).toHaveBeenCalledTimes(1);
    expect(port.createInvitation).toHaveBeenCalledWith('project-alpha');
    expect(modal.contentEl.textContent).toContain('claudian-cloud:v1:secret');

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-invitation-id="invitation-existing"]',
    )?.click();
    await flush();
    expect(port.revokeInvitation).toHaveBeenCalledWith({
      invitationId: 'invitation-existing',
      projectId: 'project-alpha',
    });
  });

  it('retains a Cloud invitation result across close and completes it only after copy', async () => {
    const retained = {
      action: 'create-invitation' as const,
      invitation: {
        encodedInvitation: 'claudian-cloud:v1:retained-secret',
        expiresAt: '2026-09-10T00:00:00.000Z',
      },
      status: 'result-retained' as const,
    };
    const port: jest.Mocked<ProjectInvitationModalPort> = {
      completeManagementOperation: jest.fn().mockResolvedValue(success(undefined)),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn().mockResolvedValue(success(retained)),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      copyText,
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();
    modal.close();
    expect(port.completeManagementOperation).not.toHaveBeenCalled();

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="copy-invitation"]',
    )?.click();
    await flush();
    expect(copyText).toHaveBeenCalledWith('claudian-cloud:v1:retained-secret');
    expect(port.completeManagementOperation).toHaveBeenCalledWith(
      { projectId: 'project-alpha' },
    );
  });

  it('does not replay or reveal a management operation owned by another surface', async () => {
    const port = {
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'remove-member',
        invitation: null,
        status: 'pending',
      })),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();

    expect(port.resumeManagementOperation).not.toHaveBeenCalled();
    expect(modal.contentEl.querySelector('[data-action="resume-invitation"]')).toBeNull();
    expect(modal.contentEl.querySelector('[aria-label="Project invitation"]')).toBeNull();
  });

  it('offers only a durable-slot read retry when Cloud recovery inspection fails', async () => {
    const port = {
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn()
        .mockResolvedValueOnce({
          error: new Error('offline'),
          status: 'failure',
        })
        .mockResolvedValueOnce(success(null)),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="create-invitation"]')).toBeNull();
    const retry = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="retry-invitations"]',
    );
    expect(retry).not.toBeNull();
    retry?.click();
    await flush();

    expect(port.readManagementOperation).toHaveBeenCalledTimes(2);
    expect(modal.contentEl.querySelector('[data-action="create-invitation"]')).not.toBeNull();
    expect(modal.contentEl.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers an explicit resume only for a pending invitation creation', async () => {
    const retained = {
      action: 'create-invitation' as const,
      invitation: {
        encodedInvitation: 'claudian-cloud:v1:resumed-secret',
        expiresAt: '2026-09-10T00:00:00.000Z',
      },
      status: 'result-retained' as const,
    };
    const port = {
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'create-invitation',
        invitation: null,
        status: 'pending',
      })),
      resumeManagementOperation: jest.fn().mockResolvedValue(success(retained)),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();
    expect(port.resumeManagementOperation).not.toHaveBeenCalled();
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.disabled).toBe(true);

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="resume-invitation"]',
    )?.click();
    await flush();

    expect(port.resumeManagementOperation).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.textContent).toContain('claudian-cloud:v1:resumed-secret');
  });

  it('has no detectable accessibility violations in the Cloud list state', async () => {
    const port = {
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn().mockResolvedValue(success(null)),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      projectId: 'project-alpha',
    });
    modal.onOpen();
    await flush();

    expect(await axe(modal.contentEl)).toHaveNoViolations();
  });
});
