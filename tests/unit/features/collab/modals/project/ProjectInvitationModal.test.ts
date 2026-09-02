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
      readManagementOperation: jest.fn()
        .mockResolvedValueOnce(success(null))
        .mockResolvedValueOnce(success({
          action: 'create-invitation',
          completionId: 'completion-created',
          invitation: {
            encodedInvitation: 'claudian-cloud:v1:secret',
            expiresAt: '2026-09-10T00:00:00.000Z',
          },
          secretAvailableUntil: '2026-09-10T00:00:00.000Z',
          status: 'result-retained',
        }))
        .mockResolvedValue(success(null)),
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
      completionId: 'completion-retained',
      invitation: {
        encodedInvitation: 'claudian-cloud:v1:retained-secret',
        expiresAt: '2026-09-10T00:00:00.000Z',
      },
      secretAvailableUntil: '2026-09-10T00:00:00.000Z',
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
      { completionId: 'completion-retained', projectId: 'project-alpha' },
    );
  });

  it('finishes an expired retained Cloud invitation without exposing its secret', async () => {
    const port = {
      completeManagementOperation: jest.fn().mockResolvedValue(success(undefined)),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn()
        .mockResolvedValueOnce(success({
          action: 'create-invitation',
          completionId: 'completion-expired',
          invitation: null,
          secretAvailableUntil: '2026-09-01T00:00:00.000Z',
          status: 'result-retained',
        }))
        .mockResolvedValue(success(null)),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.querySelector('[aria-label="Project invitation"]')).toBeNull();
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.disabled).toBe(true);
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="complete-invitation"]',
    )?.click();
    await flush();

    expect(port.completeManagementOperation).toHaveBeenCalledWith({
      completionId: 'completion-expired',
      projectId: 'project-alpha',
    });
  });

  it('redacts a retained Cloud invitation when its secret availability expires', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.parse('2026-09-02T00:00:00.000Z'));
      const port = {
        completeManagementOperation: jest.fn().mockResolvedValue(success(undefined)),
        createInvitation: jest.fn(),
        listInvitations: jest.fn().mockResolvedValue(success([])),
        readManagementOperation: jest.fn().mockResolvedValue(success({
          action: 'create-invitation',
          completionId: 'completion-expiring',
          invitation: {
            encodedInvitation: 'claudian-cloud:v1:expiring-secret',
            expiresAt: '2026-09-10T00:00:00.000Z',
          },
          secretAvailableUntil: '2026-09-02T00:00:01.000Z',
          status: 'result-retained',
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
      expect(modal.contentEl.textContent).toContain('claudian-cloud:v1:expiring-secret');

      jest.advanceTimersByTime(1_000);

      expect(modal.contentEl.textContent).not.toContain('claudian-cloud:v1:expiring-secret');
      expect(modal.contentEl.querySelector('[data-action="copy-invitation"]')).toBeNull();
      expect(modal.contentEl.querySelector('[data-action="complete-invitation"]')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('revalidates a retained Cloud invitation immediately before copying it', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.parse('2026-09-02T00:00:00.000Z'));
      const retained = {
        action: 'create-invitation' as const,
        completionId: 'completion-copy-revalidation',
        invitation: {
          encodedInvitation: 'claudian-cloud:v1:stale-secret',
          expiresAt: '2026-09-10T00:00:00.000Z',
        },
        secretAvailableUntil: '2026-09-02T00:00:01.000Z',
        status: 'result-retained' as const,
      };
      const port = {
        completeManagementOperation: jest.fn(),
        createInvitation: jest.fn(),
        listInvitations: jest.fn().mockResolvedValue(success([])),
        readManagementOperation: jest.fn()
          .mockResolvedValueOnce(success(retained))
          .mockResolvedValueOnce(success({
            ...retained,
            invitation: null,
          })),
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
      jest.setSystemTime(Date.parse('2026-09-02T00:00:01.000Z'));
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="copy-invitation"]',
      )?.click();
      await flush();

      expect(port.readManagementOperation).toHaveBeenCalledTimes(2);
      expect(copyText).not.toHaveBeenCalled();
      expect(modal.contentEl.textContent).not.toContain('claudian-cloud:v1:stale-secret');
      expect(modal.contentEl.querySelector('[data-action="complete-invitation"]')).not.toBeNull();
      expect(port.completeManagementOperation).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cannot complete a newer retained result from a stale invitation modal', async () => {
    let releaseCopy!: () => void;
    const copying = new Promise<void>(resolve => { releaseCopy = resolve; });
    let retainedCompletionId = 'completion-old';
    const port = {
      completeManagementOperation: jest.fn().mockImplementation(async request => (
        request.completionId === retainedCompletionId
          ? success(undefined)
          : { status: 'error' as const }
      )),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'create-invitation',
        completionId: 'completion-old',
        invitation: {
          encodedInvitation: 'claudian-cloud:v1:old-secret',
          expiresAt: '2026-09-10T00:00:00.000Z',
        },
        secretAvailableUntil: '2026-09-10T00:00:00.000Z',
        status: 'result-retained',
      })),
      resumeManagementOperation: jest.fn(),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      copyText: () => copying,
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="copy-invitation"]',
    )?.click();
    retainedCompletionId = 'completion-new';
    releaseCopy();
    await flush();

    expect(port.completeManagementOperation).toHaveBeenCalledWith({
      completionId: 'completion-old',
      projectId: 'project-alpha',
    });
    expect(retainedCompletionId).toBe('completion-new');
    expect(modal.contentEl.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('does not replay or reveal a management operation owned by another surface', async () => {
    const port = {
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([{
        createdAt: '2026-09-02T00:00:00.000Z',
        expiresAt: '2026-09-10T00:00:00.000Z',
        invitationId: 'invitation-existing',
        state: 'active',
      }])),
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'remove-member',
        completionId: 'completion-other',
        invitation: null,
        secretAvailableUntil: null,
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
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.disabled).toBe(true);
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="revoke-invitation"]',
    )?.disabled).toBe(true);
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
      completionId: 'completion-resumed',
      invitation: {
        encodedInvitation: 'claudian-cloud:v1:resumed-secret',
        expiresAt: '2026-09-10T00:00:00.000Z',
      },
      secretAvailableUntil: '2026-09-10T00:00:00.000Z',
      status: 'result-retained' as const,
    };
    const port = {
      completeManagementOperation: jest.fn(),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'create-invitation',
        completionId: 'completion-pending',
        invitation: null,
        secretAvailableUntil: null,
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

  it('keeps exact completion reachable when resumed invitation creation is already expired', async () => {
    const port = {
      completeManagementOperation: jest.fn().mockResolvedValue(success(undefined)),
      createInvitation: jest.fn(),
      listInvitations: jest.fn().mockResolvedValue(success([])),
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'create-invitation',
        completionId: 'completion-pending-expired',
        invitation: null,
        secretAvailableUntil: null,
        status: 'pending',
      })),
      resumeManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'create-invitation',
        completionId: 'completion-resumed-expired',
        invitation: null,
        secretAvailableUntil: '2026-09-01T00:00:00.000Z',
        status: 'result-retained',
      })),
      revokeInvitation: jest.fn(),
    } as unknown as jest.Mocked<ProjectInvitationModalPort>;
    const modal = new ProjectInvitationModal({} as never, port, {
      authorityKind: 'cloud',
      projectId: 'project-alpha',
    });

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="resume-invitation"]',
    )?.click();
    await flush();

    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.disabled).toBe(true);
    const finish = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="complete-invitation"]',
    );
    expect(finish).not.toBeNull();
    finish?.click();
    await flush();
    expect(port.completeManagementOperation).toHaveBeenCalledWith({
      completionId: 'completion-resumed-expired',
      projectId: 'project-alpha',
    });
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
