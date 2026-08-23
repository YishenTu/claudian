/** @jest-environment jsdom */

import { type CollabMember } from '@claudian-collab/protocol';

import { type CollabCoordinationSnapshot, type CollabFeatureState, type CollabLocalProjectSummary } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

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
  ProjectManagementModal,
  type ProjectManagementModalPort,
} from '@/features/collab/modals/project/ProjectManagementModal';

const CREATED_AT = '2026-08-08T00:00:00.000Z';

function member(
  id: string,
  displayName: string,
  overrides: Partial<CollabMember> = {},
): CollabMember {
  return {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName,
    id,
    personalRef: `refs/heads/members/${id}`,
    role: 'member',
    status: 'active',
    ...overrides,
  };
}

function project(
  overrides: Partial<CollabLocalProjectSummary> = {},
): CollabLocalProjectSummary {
  return {
    authorityKind: 'lan',
    connectionStatus: 'offline',
    health: 'healthy',
    hostStatus: 'not-host',
    id: 'project-alpha',
    name: 'Alpha',
    role: 'manager',
    workspacePath: 'workspace/alpha',
    ...overrides,
  };
}

function success<T>(value: T) {
  return { status: 'success' as const, value };
}

function createPort(
  members: readonly CollabMember[],
  overrides: Partial<jest.Mocked<ProjectManagementModalPort>> = {},
  identity: { readonly currentMemberId: string; readonly hostMemberId: string } = {
    currentMemberId: 'member-manager',
    hostMemberId: 'member-host',
  },
): jest.Mocked<ProjectManagementModalPort> {
  const currentMember = members.find(member => member.id === identity.currentMemberId)
    ?? members[0]!;
  return {
    createInvitation: jest.fn().mockResolvedValue(success({
      encodedInvitation: 'claudian-collab:v2:invite-alpha',
      expiresAt: '2026-08-08T00:15:00.000Z',
    })),
    acceptHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    cancelHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    cancelManagerResponsibilityOffer: jest.fn().mockResolvedValue(success({} as never)),
    createHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    createManagerResponsibilityOffer: jest.fn().mockResolvedValue(success({} as never)),
    declineHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    demoteManager: jest.fn().mockResolvedValue(success(undefined)),
    leaveProject: jest.fn().mockResolvedValue(success(undefined)),
    promoteManager: jest.fn().mockResolvedValue(success(undefined)),
    readSnapshot: jest.fn().mockResolvedValue(success({
      snapshot: {
        currentMember,
        members,
        project: { authorityKind: 'lan', hostMemberId: identity.hostMemberId },
      },
      source: 'online',
      stale: false,
      syncState: { status: 'synchronized' },
    } as never)),
    removeMember: jest.fn().mockResolvedValue(success(undefined)),
    revokeInvitation: jest.fn().mockResolvedValue(success(undefined)),
    retireProject: jest.fn().mockResolvedValue(success(undefined)),
    startHost: jest.fn().mockResolvedValue(success({
      projectId: 'project-alpha',
      status: 'running',
    })),
    stopHost: jest.fn().mockResolvedValue(success({
      projectId: 'project-alpha',
      status: 'stopped',
    })),
    subscribe: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    ...overrides,
  } as jest.Mocked<ProjectManagementModalPort>;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProjectManagementModal', () => {
  it('renders Cloud membership without exposing LAN lifecycle actions', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0],
          eventSequence: 7,
          members,
          openRequests: [],
          openTicketCount: 0,
          project: {
            authorityKind: 'cloud',
            createdAt: CREATED_AT,
            id: 'project-alpha',
            mainOid: 'a'.repeat(40),
            mainRef: 'refs/heads/main',
            name: 'Alpha',
          },
          ticketHighlights: [],
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    }, { currentMemberId: 'member-manager', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.textContent).toContain('Alice');
    expect(modal.contentEl.textContent).toContain('Maya');
    for (const action of [
      'create-invitation',
      'leave-project',
      'retire-project',
      'start-host',
      'stop-host',
      'host-diagnostics',
      'create-host-transfer',
      'promote-manager',
      'demote-manager',
      'remove-member',
    ]) {
      expect(modal.contentEl.querySelector(`[data-action="${action}"]`)).toBeNull();
    }
  });

  it('cancels a superseded snapshot read when a newer read starts', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const signals: AbortSignal[] = [];
    let invalidate: () => void = () => undefined;
    const port = createPort(members, {
      readSnapshot: jest.fn().mockImplementation((
        _projectId: string,
        options?: { signal?: AbortSignal },
      ) => {
        signals.push(options!.signal!);
        return Promise.resolve(success({
          snapshot: {
            currentMember: members[0],
            members,
            project: { authorityKind: 'lan', hostMemberId: 'member-host' },
          },
          source: 'online',
          stale: false,
          syncState: { status: 'synchronized' },
        } as never));
      }),
      subscribe: jest.fn().mockImplementation((listener: (state: unknown) => void) => {
        invalidate = () => listener({ projects: [] });
        return { dispose: jest.fn() };
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    expect(signals).toHaveLength(1);

    invalidate();
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);

    modal.onClose();
    expect(signals[1].aborted).toBe(true);
  });

  it('omits left Members from the visible list and Member count', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-pending', 'Pending member', {
        status: 'pending',
      }),
      member('member-left', 'Former member', { status: 'left' }),
    ];
    const modal = new ProjectManagementModal({} as never, createPort(members), {
      project: project({ connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.textContent).toContain('2 members');
    expect(modal.contentEl.querySelector('[data-member-id="member-manager"]')).not.toBeNull();
    expect(modal.contentEl.querySelector('[data-member-id="member-pending"]')).not.toBeNull();
    expect(modal.contentEl.querySelector('[data-member-id="member-left"]')).toBeNull();
    expect(modal.contentEl.textContent).not.toContain('Former member');
  });

  it('shows every Manager and starts additive promotion on a non-Host device', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members);
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectManagementModal({} as never, port, {
      copyText,
      project: project({ connectionStatus: 'connected' }),
    });
    document.body.appendChild(modal.contentEl);

    modal.onOpen();
    await flush();

    expect(modal.setTitle).toHaveBeenCalledWith('Project management');
    expect(modal.contentEl.textContent).toContain('Alice');
    expect(modal.contentEl.textContent).toContain('Manager');
    expect(modal.contentEl.textContent).toContain('Host');
    expect(modal.contentEl.textContent).toContain('You');
    expect(modal.contentEl.textContent).toContain('Managers: 2');
    expect(modal.contentEl.querySelectorAll(
      '.claudian-collab-access-badge[data-role="manager"]',
    )).toHaveLength(2);
    expect(modal.contentEl.querySelector('[data-action="start-host"]')).toBeNull();
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="leave-project"]',
    )?.disabled).toBe(false);
    expect(modal.contentEl.querySelector('[data-action="select-manager-successor"]'))
      .toBeNull();
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="remove-member"][data-member-id="member-host"]',
    )?.disabled).toBe(true);

    const projectActions = modal.contentEl.querySelector(
      '.claudian-collab-project-actions',
    );
    expect(projectActions).not.toBeNull();
    expect(Array.from(projectActions?.children ?? []).map(child => (
      child.className
    ))).toEqual([
      'claudian-collab-project-actions-primary',
      'claudian-collab-project-actions-lifecycle',
    ]);
    expect(Array.from(projectActions?.querySelectorAll('button') ?? []).map(button => (
      button.getAttribute('data-action')
    ))).toEqual(['create-invitation', 'leave-project', 'retire-project']);
    expect(modal.contentEl.querySelector(
      '[data-member-id="member-manager"] [data-action="leave-project"]',
    )).toBeNull();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.click();
    await flush();
    expect(port.createInvitation).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(modal.contentEl.textContent).not.toContain('claudian-collab:v2:invite-alpha');
    expect(modal.contentEl.querySelector('[data-action="create-invitation"]'))
      .not.toBeNull();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="make-manager"][data-member-id="member-maya"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    expect(port.createManagerResponsibilityOffer).toHaveBeenCalledWith({
      intentId: expect.any(String),
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-maya',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shows pending promotion acknowledgement and lets only the source cancel it', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0],
          managerResponsibilityOffer: {
            offerId: 'promotion-one',
            offeredAt: CREATED_AT,
            purpose: 'manager-promotion',
            sourceManagerMemberId: 'member-manager',
            status: 'offered',
            targetMemberId: 'member-maya',
          },
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-manager' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    }, { currentMemberId: 'member-manager', hostMemberId: 'member-manager' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ hostStatus: 'stopped' }),
    });

    modal.onOpen();
    await flush();

    const targetRow = modal.contentEl.querySelector('[data-member-id="member-maya"]')!;
    expect(targetRow.querySelector('[data-action="make-manager"]')).toBeNull();
    expect(targetRow.querySelector<HTMLButtonElement>(
      '[data-action="promotion-pending"]',
    )?.disabled).toBe(true);
    expect(targetRow.textContent).toContain('Waiting for acknowledgement');

    const sourceRow = modal.contentEl.querySelector('[data-member-id="member-manager"]')!;
    const cancel = sourceRow.querySelector<HTMLButtonElement>(
      '[data-action="cancel-manager-responsibility"]',
    );
    expect(cancel?.textContent).toBe('Cancel promotion');
    cancel?.click();
    await flush();
    expect(port.cancelManagerResponsibilityOffer).toHaveBeenCalledWith({
      offerId: 'promotion-one',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('completes an acknowledged promotion without changing the source Manager', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0],
          managerResponsibilityOffer: {
            acknowledgedAt: CREATED_AT,
            offerId: 'promotion-one',
            offeredAt: CREATED_AT,
            purpose: 'manager-promotion',
            sourceManagerMemberId: 'member-manager',
            status: 'acknowledged',
            targetMemberId: 'member-maya',
          },
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-manager' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    }, { currentMemberId: 'member-manager', hostMemberId: 'member-manager' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ hostStatus: 'stopped' }),
    });

    modal.onOpen();
    await flush();

    const complete = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="complete-promotion"][data-member-id="member-maya"]',
    );
    expect(complete?.textContent).toBe('Complete promotion');
    complete?.click();
    expect(modal.contentEl.textContent).toContain('You will both remain Managers');
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.promoteManager).toHaveBeenCalledWith({
      intentId: expect.any(String),
      managerResponsibilityOfferId: 'promotion-one',
      projectId: 'project-alpha',
      targetMemberId: 'member-maya',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(port.createManagerResponsibilityOffer).not.toHaveBeenCalled();
  });

  it('retries offer creation with its frozen intent after acknowledgement appears', async () => {
    const manager = member('member-manager', 'Alice', { role: 'manager' });
    const target = member('member-maya', 'Maya');
    let acknowledged = false;
    let listener: ((state: CollabFeatureState) => void) | undefined;
    let attempt = 0;
    const port = createPort([manager, target], {
      createManagerResponsibilityOffer: jest.fn().mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) {
          acknowledged = true;
          return {
            error: new CollabError({ code: 'operation-timeout' }),
            status: 'failure',
          };
        }
        return success({} as never);
      }),
      readSnapshot: jest.fn().mockImplementation(async () => success({
        snapshot: {
          currentMember: manager,
          ...(acknowledged ? {
            managerResponsibilityOffer: {
              acknowledgedAt: CREATED_AT,
              offerId: 'promotion-one',
              offeredAt: CREATED_AT,
              purpose: 'manager-promotion',
              sourceManagerMemberId: manager.id,
              status: 'acknowledged',
              targetMemberId: target.id,
            },
          } : {}),
          members: [manager, target],
          project: { authorityKind: 'lan', hostMemberId: 'member-host' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
      subscribe: jest.fn().mockImplementation(callback => {
        listener = callback;
        return { dispose: jest.fn() };
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project(),
    });

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="make-manager"][data-member-id="member-maya"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    const firstIntentId = port.createManagerResponsibilityOffer.mock.calls[0]?.[0].intentId;

    listener?.({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.createManagerResponsibilityOffer).toHaveBeenCalledTimes(2);
    expect(port.createManagerResponsibilityOffer.mock.calls[1]?.[0]).toEqual({
      intentId: firstIntentId,
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-maya',
    });
    expect(port.promoteManager).not.toHaveBeenCalled();
  });

  it('retries promotion completion with its frozen offer after snapshot consumption', async () => {
    const manager = member('member-manager', 'Alice', { role: 'manager' });
    const target = member('member-maya', 'Maya');
    let promoted = false;
    let listener: ((state: CollabFeatureState) => void) | undefined;
    let attempt = 0;
    const port = createPort([manager, target], {
      createManagerResponsibilityOffer: jest.fn().mockResolvedValue(success({} as never)),
      promoteManager: jest.fn().mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) {
          promoted = true;
          return {
            error: new CollabError({ code: 'operation-timeout' }),
            status: 'failure',
          };
        }
        return success(undefined);
      }),
      readSnapshot: jest.fn().mockImplementation(async () => {
        const projectedTarget = promoted ? { ...target, role: 'manager' as const } : target;
        return success({
          snapshot: {
            currentMember: manager,
            ...(!promoted ? {
              managerResponsibilityOffer: {
                acknowledgedAt: CREATED_AT,
                offerId: 'promotion-one',
                offeredAt: CREATED_AT,
                purpose: 'manager-promotion',
                sourceManagerMemberId: manager.id,
                status: 'acknowledged',
                targetMemberId: target.id,
              },
            } : {}),
            members: [manager, projectedTarget],
            project: { authorityKind: 'lan', hostMemberId: 'member-host' },
          },
          source: 'online',
          stale: false,
          syncState: { status: 'synchronized' },
        } as never);
      }),
      subscribe: jest.fn().mockImplementation(callback => {
        listener = callback;
        return { dispose: jest.fn() };
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project(),
    });

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="complete-promotion"][data-member-id="member-maya"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    const firstIntentId = port.promoteManager.mock.calls[0]?.[0].intentId;

    listener?.({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.promoteManager).toHaveBeenCalledTimes(2);
    expect(port.promoteManager.mock.calls[1]?.[0]).toEqual({
      intentId: firstIntentId,
      managerResponsibilityOfferId: 'promotion-one',
      projectId: 'project-alpha',
      targetMemberId: 'member-maya',
    });
    expect(port.createManagerResponsibilityOffer).not.toHaveBeenCalled();
  });

  it('demotes another Manager without moving Host responsibility', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator', { role: 'manager' }),
    ];
    const port = createPort(members);
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.querySelector(
      '[data-member-id="member-manager"] [data-action="make-member"]',
    )).toBeNull();
    const hostRow = modal.contentEl.querySelector('[data-member-id="member-host"]')!;
    expect(hostRow.textContent).toContain('Host');
    expect(hostRow.querySelector<HTMLButtonElement>(
      '[data-action="remove-member"]',
    )?.disabled).toBe(true);
    hostRow.querySelector<HTMLButtonElement>('[data-action="make-member"]')?.click();
    expect(modal.contentEl.textContent).toContain('Host responsibility stays with them');
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.demoteManager).toHaveBeenCalledWith({
      intentId: expect.any(String),
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('discards a failed mutation intent when another confirmation replaces it', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-bob', 'Bob', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      demoteManager: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'operation-timeout' }),
        status: 'failure',
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="make-member"][data-member-id="member-bob"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    const firstIntentId = port.demoteManager.mock.calls[0]?.[0].intentId;

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="make-manager"][data-member-id="member-maya"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-access-action"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="make-member"][data-member-id="member-bob"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.demoteManager).toHaveBeenCalledTimes(2);
    expect(port.demoteManager.mock.calls[1]?.[0].intentId).not.toBe(firstIntentId);
  });

  it('submits Manager removal and surfaces last-Manager authority protection', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-bob', 'Bob', { role: 'manager' }),
      member('member-host', 'Host operator'),
    ];
    const port = createPort(members, {
      removeMember: jest.fn().mockResolvedValue({
        error: new CollabError({
          code: 'authorization-denied',
          safeContext: { reason: 'last-manager-required' },
        }),
        status: 'failure',
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    const remove = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="remove-member"][data-member-id="member-bob"]',
    );
    expect(remove?.disabled).toBe(false);
    remove?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.removeMember).toHaveBeenCalledWith({
      intentId: expect.any(String),
      memberId: 'member-bob',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent)
      .toContain('At least one Manager must remain');
  });

  it('places the LAN Host switch inside Project management on the Host device', async () => {
    const port = createPort([
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
    ], {}, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ hostStatus: 'stopped', role: 'member' }),
    });

    modal.onOpen();
    await flush();
    expect(modal.contentEl.querySelector(
      '.claudian-collab-project-actions [data-action="start-host"]',
    )).not.toBeNull();
    expect(Array.from(modal.contentEl.querySelectorAll(
      '.claudian-collab-project-actions button',
    )).map(button => button.getAttribute('data-action'))).toEqual([
      'start-host',
      'leave-project',
    ]);
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();
    await flush();

    expect(port.startHost).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(modal.contentEl.textContent).toContain('Running');
    expect(modal.contentEl.querySelectorAll('[data-action="start-host"]')).toHaveLength(0);
    expect(modal.contentEl.querySelectorAll('[data-action="stop-host"]')).toHaveLength(1);
  });

  it('lets the sole Manager Host retire after starting Host in the open modal', async () => {
    const soleManagerHost = member('member-host', 'Host operator', { role: 'manager' });
    const port = createPort([
      soleManagerHost,
    ], {
      readSnapshot: jest.fn()
        .mockResolvedValueOnce(success({
          snapshot: {
            currentMember: soleManagerHost,
            members: [soleManagerHost],
            project: { authorityKind: 'lan', hostMemberId: 'member-host' },
          },
          source: 'offline',
          stale: true,
          syncState: { status: 'offline' },
        } as never))
        .mockResolvedValue(success({
          snapshot: {
            currentMember: soleManagerHost,
            members: [soleManagerHost],
            project: { authorityKind: 'lan', hostMemberId: 'member-host' },
          },
          source: 'online',
          stale: false,
          syncState: { status: 'synchronized' },
        } as never)),
    }, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({
        connectionStatus: 'host-stopped',
        hostStatus: 'stopped',
        role: 'manager',
      }),
    });

    modal.onOpen();
    await flush();
    expect(modal.contentEl.querySelector('[data-action="retire-project"]')).toBeNull();

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="retire-project"]')).not.toBeNull();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="retire-project"]')?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    expect(port.retireProject).toHaveBeenCalledWith({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-host',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shows and copies redacted Host diagnostics after a failed start', async () => {
    const error = new CollabError({
      code: 'database-corrupt',
      recoveryActions: ['open-diagnostics'],
      safeContext: {
        credential: 'must-not-leak',
        reason: 'authority-open-failed',
      },
    });
    const port = createPort([
      member('member-host', 'Host operator', { role: 'manager' }),
    ], {
      startHost: jest.fn().mockResolvedValue({ error, status: 'failure' }),
    }, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectManagementModal({} as never, port, {
      copyText,
      project: project({ hostStatus: 'stopped' }),
    });
    modal.onOpen();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="start-host"]')?.click();
    await flush();
    expect(modal.contentEl.querySelector(
      '.claudian-collab-project-actions [data-action="host-diagnostics"]',
    )).not.toBeNull();
    expect(modal.contentEl.querySelector('[data-state="host-diagnostics"]')).toBeNull();
  });

  it('confirms removal without claiming to delete the former Member local Project', async () => {
    const port = createPort([
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ]);
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, {
      onChanged,
      project: project(),
    });
    document.body.appendChild(modal.contentEl);
    modal.onOpen();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="remove-member"][data-member-id="member-maya"]',
    )?.click();

    const confirm = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )!;
    expect(confirm).toBe(document.activeElement);
    expect(modal.contentEl.textContent).toContain(
      'Their local Project files and history stay on their device.',
    );
    expect(modal.contentEl.textContent?.toLocaleLowerCase('en-US'))
      .not.toContain('delete their local');

    confirm.click();
    await flush();

    expect(port.removeMember).toHaveBeenCalledWith({
      intentId: expect.any(String),
      memberId: 'member-maya',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('lets an ordinary non-Host Member leave with explicit retained-file copy', async () => {
    const port = createPort([
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ], {}, { currentMemberId: 'member-maya', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ role: 'member' }),
    });
    document.body.appendChild(modal.contentEl);
    modal.onOpen();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="create-invitation"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-action="remove-member"]')).toBeNull();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="leave-project"]',
    )?.click();
    expect(modal.contentEl.textContent).toContain('Choose what happens to this local copy.');

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.leaveProject).toHaveBeenCalledWith({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('lets authority require Host transfer and supports retry after unrelated failure', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-bob', 'Bob', { role: 'manager' }),
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ];
    const hostPort = createPort(members, {
      leaveProject: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'host-transfer-pending' }),
        status: 'failure',
      }),
    },
      { currentMemberId: 'member-host', hostMemberId: 'member-host' },
    );
    const port = createPort(members, {
      removeMember: jest.fn()
        .mockResolvedValueOnce({ status: 'failure', error: { code: 'operation-failed' } })
        .mockResolvedValueOnce(success(undefined)),
    });
    const hostModal = new ProjectManagementModal({} as never, hostPort, {
      project: project({ hostStatus: 'stopped', role: 'member' }),
    });
    hostModal.onOpen();
    await flush();
    expect(hostModal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="leave-project"]',
    )?.disabled).toBe(false);
    hostModal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="leave-project"]',
    )?.click();
    hostModal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    expect(hostModal.contentEl.textContent).toContain('Transfer Host before leaving');
    expect(hostModal.contentEl.querySelector('[data-action="offer-host-transfer"]'))
      .not.toBeNull();

    const managerModal = new ProjectManagementModal({} as never, port, {
      project: project(),
    });
    managerModal.onOpen();
    await flush();
    managerModal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="remove-member"][data-member-id="member-maya"]',
    )?.click();
    managerModal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(managerModal.contentEl.querySelector('[role="alert"]')?.textContent)
      .toContain('could not be completed');
    const firstIntentId = port.removeMember.mock.calls[0]?.[0].intentId;
    expect(firstIntentId).toEqual(expect.any(String));
    managerModal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    expect(port.removeMember).toHaveBeenCalledTimes(2);
    expect(port.removeMember.mock.calls[1]?.[0].intentId).toBe(firstIntentId);
  });

  it('aborts loading and ignores its late result after close', async () => {
    let finish!: (
      value: ReturnType<typeof success<CollabCoordinationSnapshot>>,
    ) => void;
    let signal: AbortSignal | undefined;
    const port = createPort([], {
      readSnapshot: jest.fn((_projectId, options) => {
        signal = options?.signal;
        return new Promise(resolve => { finish = resolve; });
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project(),
    });
    modal.onOpen();

    modal.onClose();
    finish(success({} as CollabCoordinationSnapshot));
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('offers every role explicit Keep or Delete when leaving and defaults to Keep', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ];
    for (const currentMemberId of ['member-manager', 'member-host', 'member-maya']) {
      const port = createPort(
        members,
        {},
        { currentMemberId, hostMemberId: 'member-host' },
      );
      const modal = new ProjectManagementModal({} as never, port, {
        project: project({
          hostStatus: currentMemberId === 'member-host' ? 'stopped' : 'not-host',
          role: currentMemberId === 'member-manager' ? 'manager' : 'member',
        }),
      });
      document.body.appendChild(modal.contentEl);
      modal.onOpen();
      await flush();

      modal.contentEl.querySelector<HTMLButtonElement>('[data-action="leave-project"]')
        ?.click();
      expect(modal.contentEl.querySelector('[data-action="select-manager-successor"]'))
        .toBeNull();
      const keep = modal.contentEl.querySelector<HTMLInputElement>(
        '[name="leave-cleanup-choice"][value="keep-files"]',
      );
      const remove = modal.contentEl.querySelector<HTMLInputElement>(
        '[name="leave-cleanup-choice"][value="delete-files"]',
      );
      expect(keep?.checked).toBe(true);
      expect(remove?.checked).toBe(false);
      expect(modal.contentEl.textContent)
        .toContain('unpublished Git-only work cannot be recovered');
      remove?.click();
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="confirm-access-action"]',
      )?.click();
      await flush();
      expect(port.leaveProject).toHaveBeenCalledWith({
        cleanupChoice: 'delete-files',
        projectId: 'project-alpha',
      }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      modal.onClose();
    }
  });

  it('asks for a Manager successor only after authority requires one', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ];
    let offerStatus: 'acknowledged' | 'offered' | null = null;
    let listener: ((state: CollabFeatureState) => void) | undefined;
    const port = createPort(members, {
      createManagerResponsibilityOffer: jest.fn().mockImplementation(async () => {
        offerStatus = 'offered';
        return success({} as never);
      }),
      leaveProject: jest.fn()
        .mockResolvedValueOnce({
          error: new CollabError({ code: 'manager-responsibility-pending' }),
          status: 'failure',
        })
        .mockResolvedValueOnce(success(undefined)),
      readSnapshot: jest.fn().mockImplementation(async () => success({
        snapshot: {
          currentMember: members[0],
          ...(offerStatus ? {
            managerResponsibilityOffer: {
              offerId: 'manager-offer-one',
              offeredAt: CREATED_AT,
              purpose: 'manager-leave',
              sourceManagerMemberId: 'member-manager',
              status: offerStatus,
              targetMemberId: 'member-maya',
            },
          } : {}),
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-host' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
      subscribe: jest.fn().mockImplementation(next => {
        listener = next;
        return { dispose: jest.fn() };
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="select-manager-successor"]'))
      .toBeNull();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="leave-project"]')?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(modal.contentEl.textContent).toContain('Choose a successor');
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.disabled).toBe(true);
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="select-manager-successor"][data-member-id="member-maya"]',
    )?.click();
    await flush();
    expect(port.createManagerResponsibilityOffer).toHaveBeenCalledWith({
      intentId: expect.any(String),
      projectId: 'project-alpha',
      purpose: 'manager-leave',
      targetMemberId: 'member-maya',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(modal.contentEl.textContent).toContain('Waiting for Maya');

    offerStatus = 'acknowledged';
    listener?.({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    await flush();
    const confirm = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    );
    expect(confirm?.disabled).toBe(false);
    confirm?.click();
    await flush();
    expect(port.leaveProject).toHaveBeenLastCalledWith({
      cleanupChoice: 'keep-files',
      managerResponsibilityOfferId: 'manager-offer-one',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('retains a Leave offer intent for Retry but discards it with the workflow', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      createManagerResponsibilityOffer: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'operation-timeout' }),
        status: 'failure',
      }),
      leaveProject: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'manager-responsibility-pending' }),
        status: 'failure',
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();

    const enterSuccessorFlow = async () => {
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="leave-project"]',
      )?.click();
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="confirm-access-action"]',
      )?.click();
      await flush();
    };
    const selectSuccessor = async () => {
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="select-manager-successor"][data-member-id="member-maya"]',
      )?.click();
      await flush();
    };

    await enterSuccessorFlow();
    await selectSuccessor();
    const firstIntent = port.createManagerResponsibilityOffer.mock.calls[0]?.[0].intentId;
    await selectSuccessor();
    expect(port.createManagerResponsibilityOffer.mock.calls[1]?.[0].intentId)
      .toBe(firstIntent);

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-access-action"]',
    )?.click();
    await enterSuccessorFlow();
    await selectSuccessor();
    expect(port.createManagerResponsibilityOffer.mock.calls[2]?.[0].intentId)
      .not.toBe(firstIntent);
  });

  it('discards actor-scoped Leave intents when the current Member changes', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-second-manager', 'Bob', { role: 'manager' }),
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ];
    let currentMember = members[0]!;
    let listener: ((state: CollabFeatureState) => void) | undefined;
    const port = createPort(members, {
      createManagerResponsibilityOffer: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'operation-timeout' }),
        status: 'failure',
      }),
      leaveProject: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'manager-responsibility-pending' }),
        status: 'failure',
      }),
      readSnapshot: jest.fn().mockImplementation(async () => success({
        snapshot: {
          currentMember,
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-host' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
      subscribe: jest.fn().mockImplementation(next => {
        listener = next;
        return { dispose: jest.fn() };
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();

    const createOffer = async () => {
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="leave-project"]',
      )?.click();
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="confirm-access-action"]',
      )?.click();
      await flush();
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="select-manager-successor"][data-member-id="member-maya"]',
      )?.click();
      await flush();
    };

    await createOffer();
    const firstIntent = port.createManagerResponsibilityOffer.mock.calls[0]?.[0].intentId;

    currentMember = members[1]!;
    listener?.({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    await flush();
    await createOffer();

    expect(port.createManagerResponsibilityOffer.mock.calls[1]?.[0].intentId)
      .not.toBe(firstIntent);
  });

  it('does not ask the target to manually confirm Manager responsibility', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      readSnapshot: jest.fn().mockImplementation(async () => success({
        snapshot: {
          currentMember: members[1],
          managerResponsibilityOffer: {
            offerId: 'manager-offer-one',
            offeredAt: CREATED_AT,
            purpose: 'manager-promotion',
            sourceManagerMemberId: 'member-manager',
            status: 'offered',
            targetMemberId: 'member-maya',
          },
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-manager' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    }, { currentMemberId: 'member-maya', hostMemberId: 'member-manager' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ role: 'member' }),
    });
    modal.onOpen();
    await flush();

    const ownRow = modal.contentEl.querySelector('[data-member-id="member-maya"]')!;
    expect(ownRow.querySelector('[data-action="accept-manager-responsibility"]'))
      .toBeNull();
    expect(ownRow.querySelector('[data-action="decline-manager-responsibility"]')).toBeNull();
  });

  it('shows Host Accept and Decline only on the offered target own row', async () => {
    const members = [
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
      member('member-lee', 'Lee'),
    ];
    const port = createPort(members, {
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[1],
          hostTransfer: {
            canAccept: true,
            canCancel: false,
            canDecline: true,
            expiresAt: '2026-08-13T01:00:00.000Z',
            offeredAt: CREATED_AT,
            phase: 'offered',
            targetMemberId: 'member-maya',
            transferId: 'host-transfer-one',
          },
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-host' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    }, { currentMemberId: 'member-maya', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ role: 'member' }),
    });
    modal.onOpen();
    await flush();

    const ownRow = modal.contentEl.querySelector('[data-member-id="member-maya"]')!;
    const otherRow = modal.contentEl.querySelector('[data-member-id="member-lee"]')!;
    expect(ownRow.querySelector('[data-action="accept-host-transfer"]')).not.toBeNull();
    expect(ownRow.querySelector('[data-action="decline-host-transfer"]')).not.toBeNull();
    expect(otherRow.querySelector('[data-action="accept-host-transfer"]')).toBeNull();
    ownRow.querySelector<HTMLButtonElement>('[data-action="decline-host-transfer"]')?.click();
    await flush();
    expect(port.declineHostTransfer).toHaveBeenCalledWith({
      projectId: 'project-alpha',
      transferId: 'host-transfer-one',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('disables duplicate responsibility mutations while one is pending', async () => {
    const members = [
      member('member-host', 'Host operator'),
      member('member-maya', 'Maya'),
    ];
    let finish!: (result: ReturnType<typeof success<void>>) => void;
    const port = createPort(members, {
      declineHostTransfer: jest.fn().mockReturnValue(new Promise(resolve => {
        finish = resolve;
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[1],
          hostTransfer: {
            canAccept: true,
            canCancel: false,
            canDecline: true,
            expiresAt: '2026-08-13T01:00:00.000Z',
            offeredAt: CREATED_AT,
            phase: 'offered',
            targetMemberId: 'member-maya',
            transferId: 'host-transfer-one',
          },
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-host' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    }, { currentMemberId: 'member-maya', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ role: 'member' }),
    });
    modal.onOpen();
    await flush();

    const decline = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="decline-host-transfer"]',
    )!;
    decline.click();
    decline.click();
    expect(port.declineHostTransfer).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="decline-host-transfer"]',
    )?.disabled).toBe(true);
    finish(success(undefined));
    await flush();
  });

  it('confirms Retire only for a connected synchronized Manager', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
    ];
    const port = createPort(members);
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="retire-project"]')?.click();
    expect(modal.contentEl.textContent).toContain('collaboration for every Member');
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    expect(port.retireProject).toHaveBeenCalledWith({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      projectId: 'project-alpha',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('ignores a completed Leave after the modal closes', async () => {
    const members = [member('member-maya', 'Maya')];
    let finish!: (result: ReturnType<typeof success<void>>) => void;
    const port = createPort(members, {
      leaveProject: jest.fn().mockReturnValue(new Promise(resolve => {
        finish = resolve;
      })),
    }, { currentMemberId: 'member-maya', hostMemberId: 'member-host' });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, {
      onChanged,
      project: project({ role: 'member' }),
    });
    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="leave-project"]')?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    modal.onClose();
    finish(success(undefined));
    await flush();

    expect(onChanged).not.toHaveBeenCalled();
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('ignores a completed promotion after the modal closes', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    let finish!: (result: ReturnType<typeof success<void>>) => void;
    const port = createPort(members, {
      promoteManager: jest.fn().mockReturnValue(new Promise(resolve => {
        finish = resolve;
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0],
          managerResponsibilityOffer: {
            acknowledgedAt: CREATED_AT,
            offerId: 'promotion-one',
            offeredAt: CREATED_AT,
            purpose: 'manager-promotion',
            sourceManagerMemberId: 'member-manager',
            status: 'acknowledged',
            targetMemberId: 'member-maya',
          },
          members,
          project: { authorityKind: 'lan', hostMemberId: 'member-manager' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    }, { currentMemberId: 'member-manager', hostMemberId: 'member-manager' });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, {
      onChanged,
      project: project({ hostStatus: 'stopped' }),
    });
    modal.onOpen();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="complete-promotion"]',
    )?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    modal.onClose();
    finish(success(undefined));
    await flush();

    expect(onChanged).not.toHaveBeenCalled();
    expect(modal.contentEl.childElementCount).toBe(0);
  });

});
