/** @jest-environment jsdom */

import { type CollabMember } from '@claudian-collab/protocol';
import { configureAxe } from 'jest-axe';

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

const axe = configureAxe({ rules: { region: { enabled: false } } });

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
    hostInstallationStatus: 'not-host',
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
    acceptCloudToLanTransfer: jest.fn().mockResolvedValue(success({} as never)),
    createInvitation: jest.fn().mockResolvedValue(success({
      encodedInvitation: 'claudian-collab:v2:invite-alpha',
      expiresAt: '2026-08-08T00:15:00.000Z',
    })),
    acceptHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    acceptLanToCloudTransfer: jest.fn().mockResolvedValue(success({} as never)),
    beginCloudToLanTransfer: jest.fn().mockResolvedValue(success({} as never)),
    cancelCloudToLanTransfer: jest.fn().mockResolvedValue(success({} as never)),
    cancelHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    cancelLanToCloudTransfer: jest.fn().mockResolvedValue(success({} as never)),
    cancelManagerResponsibilityOffer: jest.fn().mockResolvedValue(success({} as never)),
    claimLegacyHostInstallation: jest.fn().mockResolvedValue(success(project({
      hostInstallationStatus: 'hosted-here',
      hostStatus: 'stopped',
    }))),
    completeManagementOperation: jest.fn().mockResolvedValue(success(undefined)),
    createHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    createManagerResponsibilityOffer: jest.fn().mockResolvedValue(success({} as never)),
    declineHostTransfer: jest.fn().mockResolvedValue(success(undefined)),
    demoteManager: jest.fn().mockResolvedValue(success(undefined)),
    leaveProject: jest.fn().mockResolvedValue(success(undefined)),
    listInvitations: jest.fn().mockResolvedValue(success([])),
    listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
    listMembers: jest.fn().mockResolvedValue(success(members.map(item => ({
      displayName: item.displayName,
      importedClaim: null,
      memberId: item.id,
      role: item.role,
    })))),
    observeCloudToLanTransfer: jest.fn().mockResolvedValue(success({} as never)),
    prepareCloudToLanTarget: jest.fn().mockResolvedValue(success({} as never)),
    proposeLanToCloudTransfer: jest.fn().mockResolvedValue(success({} as never)),
    promoteManager: jest.fn().mockResolvedValue(success(undefined)),
    readLanToCloudTransfer: jest.fn().mockResolvedValue(success(null)),
    readCloudToLanTransfer: jest.fn().mockResolvedValue(success(null)),
    readManagementOperation: jest.fn().mockResolvedValue(success(null)),
    readProjectCapabilities: jest.fn().mockResolvedValue(success({
      authorityKind: 'lan',
      authorityTransfer: true,
      importedMemberClaims: false,
      invitations: true,
      leave: true,
      managerResponsibility: true,
      membershipManagement: true,
      retirement: true,
    })),
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
    reissueMemberClaim: jest.fn().mockResolvedValue(success({} as never)),
    resumeManagementOperation: jest.fn().mockResolvedValue(success({} as never)),
    revokeInvitation: jest.fn().mockResolvedValue(success(undefined)),
    revokeMemberClaim: jest.fn().mockResolvedValue(success(undefined)),
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
    withdrawCloudToLanTarget: jest.fn().mockResolvedValue(success(undefined)),
    ...overrides,
  } as jest.Mocked<ProjectManagementModalPort>;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProjectManagementModal', () => {
  it('keeps ordinary-member Cloud Leave reachable while the authority is offline', async () => {
    const port = createPort([], {
      readProjectCapabilities: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
      readSnapshot: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({
        authorityKind: 'cloud',
        connectionStatus: 'offline',
        role: 'member',
      }),
    });

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>('[data-action="leave-project"]')?.click();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();

    expect(port.leaveProject).toHaveBeenCalledWith({
      cleanupChoice: 'keep-files',
      projectId: 'project-alpha',
    });
  });

  it('renders Cloud membership without exposing LAN lifecycle actions', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud',
        authorityTransfer: false,
        importedMemberClaims: false,
        invitations: false,
        leave: false,
        managerResponsibility: false,
        membershipManagement: false,
        retirement: false,
      })),
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

  it('renders negotiated Cloud lifecycle, membership, and imported-claim actions', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
      listMembers: jest.fn().mockResolvedValue(success([
        { displayName: 'Alice', importedClaim: null, memberId: 'member-manager', role: 'manager' },
        {
          displayName: 'Maya',
          importedClaim: { bindingState: 'unbound', state: 'expired' },
          memberId: 'member-maya',
          role: 'member',
        },
      ])),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud',
        authorityTransfer: true,
        importedMemberClaims: true,
        invitations: true,
        leave: true,
        managerResponsibility: true,
        membershipManagement: true,
        retirement: true,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0],
          members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
      reissueMemberClaim: jest.fn().mockResolvedValue(success({
        encodedInvitation: 'claudian-cloud-claim:v1:replacement',
        expiresAt: '2026-09-10T00:00:00.000Z',
      })),
      readManagementOperation: jest.fn()
        .mockResolvedValueOnce(success(null))
        .mockResolvedValue(success({
          action: 'reissue-member-claim',
          completionId: 'completion-reissued-claim',
          invitation: {
            encodedInvitation: 'claudian-cloud-claim:v1:replacement',
            expiresAt: '2026-09-10T00:00:00.000Z',
          },
          secretAvailableUntil: '2026-09-10T00:00:00.000Z',
          status: 'result-retained',
        })),
    });
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectManagementModal({} as never, port, {
      copyText,
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();

    for (const action of [
      'create-invitation',
      'leave-project',
      'retire-project',
      'make-manager',
      'remove-member',
      'reissue-member-claim',
      'revoke-member-claim',
    ]) {
      expect(modal.contentEl.querySelector(`[data-action="${action}"]`)).not.toBeNull();
    }
    expect(modal.contentEl.querySelector('[data-action="make-manager"]')?.getAttribute(
      'aria-label',
    )).toBe('Make Manager: Maya');
    expect(modal.contentEl.querySelector('[data-action="remove-member"]')?.getAttribute(
      'aria-label',
    )).toBe('Remove: Maya');
    expect(modal.contentEl.querySelector('[data-action="start-host"]')).toBeNull();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="reissue-member-claim"]',
    )?.click();
    await flush();
    expect(port.reissueMemberClaim).toHaveBeenCalledWith({
      memberId: 'member-maya',
      projectId: 'project-alpha',
    });
    expect(modal.contentEl.textContent).toContain('claudian-cloud-claim:v1:replacement');

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="copy-member-claim"]',
    )?.click();
    await flush();
    expect(copyText).toHaveBeenCalledWith('claudian-cloud-claim:v1:replacement');
    expect(port.completeManagementOperation).toHaveBeenCalledWith({
      completionId: 'completion-reissued-claim',
      projectId: 'project-alpha',
    });
  });

  it('redacts a retained member claim when its secret availability expires', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
      const members = [member('member-manager', 'Alice', { role: 'manager' })];
      const port = createPort(members, {
        readManagementOperation: jest.fn().mockResolvedValue(success({
          action: 'reissue-member-claim',
          completionId: 'completion-expiring-claim',
          invitation: {
            encodedInvitation: 'claudian-cloud-claim:v1:expiring-secret',
            expiresAt: '2026-09-10T00:00:00.000Z',
          },
          secretAvailableUntil: '2026-09-02T00:00:01.000Z',
          status: 'result-retained',
        })),
        readProjectCapabilities: jest.fn().mockResolvedValue(success({
          authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: true,
          invitations: true, leave: true, managerResponsibility: true,
          membershipManagement: true, retirement: true,
        })),
        readSnapshot: jest.fn().mockResolvedValue(success({
          snapshot: {
            currentMember: members[0], members,
            project: { authorityGeneration: 4, authorityKind: 'cloud' },
          },
          source: 'online', stale: false, syncState: { status: 'synchronized' },
        } as never)),
      } as never);
      const modal = new ProjectManagementModal({} as never, port, {
        project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
      });

      modal.onOpen();
      await flush();
      await flush();
      expect(modal.contentEl.textContent)
        .toContain('claudian-cloud-claim:v1:expiring-secret');

      jest.advanceTimersByTime(1_000);

      expect(modal.contentEl.textContent)
        .not.toContain('claudian-cloud-claim:v1:expiring-secret');
      expect(modal.contentEl.querySelector('[data-action="copy-member-claim"]')).toBeNull();
      expect(modal.contentEl.querySelector(
        '[data-action="complete-management-operation"]',
      )).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('revalidates a retained member claim immediately before copying it', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
      const members = [member('member-manager', 'Alice', { role: 'manager' })];
      const retained = {
        action: 'reissue-member-claim' as const,
        completionId: 'completion-claim-revalidation',
        invitation: {
          encodedInvitation: 'claudian-cloud-claim:v1:stale-secret',
          expiresAt: '2026-09-10T00:00:00.000Z',
        },
        secretAvailableUntil: '2026-09-02T00:00:01.000Z',
        status: 'result-retained' as const,
      };
      const port = createPort(members, {
        readManagementOperation: jest.fn()
          .mockResolvedValueOnce(success(retained))
          .mockResolvedValueOnce(success({ ...retained, invitation: null })),
        readProjectCapabilities: jest.fn().mockResolvedValue(success({
          authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: true,
          invitations: true, leave: true, managerResponsibility: true,
          membershipManagement: true, retirement: true,
        })),
        readSnapshot: jest.fn().mockResolvedValue(success({
          snapshot: {
            currentMember: members[0], members,
            project: { authorityGeneration: 4, authorityKind: 'cloud' },
          },
          source: 'online', stale: false, syncState: { status: 'synchronized' },
        } as never)),
      } as never);
      const copyText = jest.fn().mockResolvedValue(undefined);
      const modal = new ProjectManagementModal({} as never, port, {
        copyText,
        project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
      });

      modal.onOpen();
      await flush();
      await flush();
      jest.setSystemTime(new Date('2026-09-02T00:00:01.000Z'));
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="copy-member-claim"]',
      )?.click();
      await flush();

      expect(port.readManagementOperation).toHaveBeenCalledTimes(2);
      expect(copyText).not.toHaveBeenCalled();
      expect(modal.contentEl.textContent)
        .not.toContain('claudian-cloud-claim:v1:stale-secret');
      expect(modal.contentEl.querySelector(
        '[data-action="complete-management-operation"]',
      )).not.toBeNull();
      expect(port.completeManagementOperation).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('hides imported-claim actions for an already bound Member', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
      listMembers: jest.fn().mockResolvedValue(success([
        { displayName: 'Alice', importedClaim: null, memberId: 'member-manager', role: 'manager' },
        {
          displayName: 'Maya',
          importedClaim: { bindingState: 'bound', state: 'hidden' },
          memberId: 'member-maya',
          role: 'member',
        },
      ])),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: true,
        invitations: false, leave: false, managerResponsibility: true,
        membershipManagement: true, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();

    const maya = modal.contentEl.querySelector('[data-member-id="member-maya"]')!;
    expect(maya.querySelector('[data-action="reissue-member-claim"]')).toBeNull();
    expect(maya.querySelector('[data-action="revoke-member-claim"]')).toBeNull();
  });

  it('lets any LAN Member propose a raw Cloud target without exposing Host acceptance', async () => {
    const members = [
      member('member-host', 'Host', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {}, {
      currentMemberId: 'member-maya',
      hostMemberId: 'member-host',
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected', role: 'member' }),
    });
    modal.onOpen();
    await flush();

    const serverUrl = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="lan-to-cloud-server-url"]',
    )!;
    serverUrl.value = ' HTTP://203.0.113.20:8787/operator/cloud ';
    serverUrl.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="propose-lan-to-cloud"]',
    )?.click();
    await flush();

    expect(port.proposeLanToCloudTransfer).toHaveBeenCalledWith({
      projectId: 'project-alpha',
      serverUrl: ' HTTP://203.0.113.20:8787/operator/cloud ',
    });
    expect(modal.contentEl.querySelector('[data-action="accept-lan-to-cloud"]')).toBeNull();
  });

  it('does not expose Host acceptance on an installation hosted elsewhere', async () => {
    const proposal = {
      proposedByMemberId: 'member-maya',
      serverUrl: 'https://cloud.example.test/',
      status: {
        phase: 'collecting-readiness',
        state: 'active',
      },
    } as never;
    const members = [member('member-host', 'Host', { role: 'manager' })];
    const port = createPort(members, {
      readLanToCloudTransfer: jest.fn().mockResolvedValue(success(proposal)),
    }, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ hostInstallationStatus: 'hosted-elsewhere' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="accept-lan-to-cloud"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-action="cancel-lan-to-cloud"]')).toBeNull();
  });

  it('keeps Cloud management open read-only until the user explicitly resumes it', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      listMembers: jest.fn().mockResolvedValue(success(members.map(item => ({
        displayName: item.displayName,
        importedClaim: null,
        memberId: item.id,
        role: item.role,
      })))),
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'remove-member',
        completionId: 'completion-pending',
        invitation: null,
        secretAvailableUntil: null,
        status: 'pending',
      })),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: false,
        membershipManagement: true, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
      resumeManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'remove-member',
        completionId: 'completion-retained',
        invitation: null,
        secretAvailableUntil: null,
        status: 'result-retained',
      })),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();
    expect(port.resumeManagementOperation).not.toHaveBeenCalled();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="resume-management-operation"]',
    )?.click();
    await flush();
    expect(port.resumeManagementOperation).toHaveBeenCalledTimes(1);
  });

  it('restores durable Cloud management controls when authority reads are offline', async () => {
    const port = createPort([], {
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'remove-member',
        completionId: 'completion-offline',
        invitation: null,
        secretAvailableUntil: null,
        status: 'result-retained',
      })),
      readProjectCapabilities: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
      readSnapshot: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'offline' }),
    });

    modal.onOpen();
    await flush();

    expect(port.readManagementOperation).toHaveBeenCalledWith(
      'project-alpha',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(modal.contentEl.querySelector('[data-action="complete-management-operation"]'))
      .not.toBeNull();
  });

  it('restores a pending LAN-to-Cloud requester intent while the LAN Host is offline', async () => {
    const proposal = {
      proposedByMemberId: 'member-maya',
      serverUrl: 'http://203.0.113.20:8787/operator/cloud',
      sourceOwned: false,
      status: null,
    } as const;
    const port = createPort([], {
      readLanToCloudTransfer: jest.fn().mockResolvedValue(success(proposal)),
      readProjectCapabilities: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
      readSnapshot: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'lan', connectionStatus: 'offline', role: 'member' }),
    });

    modal.onOpen();
    await flush();

    const input = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="lan-to-cloud-server-url"]',
    );
    expect(input?.value).toBe(proposal.serverUrl);
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="propose-lan-to-cloud"]',
    )?.click();
    await flush();
    expect(port.proposeLanToCloudTransfer).toHaveBeenCalledWith({
      projectId: 'project-alpha',
      serverUrl: proposal.serverUrl,
    });
  });

  it('refreshes LAN durable transfer state after a recovery-required proposal result', async () => {
    const proposal = {
      proposedByMemberId: 'member-maya',
      serverUrl: 'https://cloud.example.test/',
      sourceOwned: false,
      status: { phase: 'collecting-readiness', state: 'active' } as never,
    };
    const members = [member('member-maya', 'Maya')];
    const port = createPort(members, {
      proposeLanToCloudTransfer: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'durable-progress-recovery-required' }),
        operationId: 'intent-lan-to-cloud',
        status: 'recovery-required',
      }),
      readLanToCloudTransfer: jest.fn()
        .mockResolvedValueOnce(success(null))
        .mockResolvedValueOnce(success(proposal)),
    }, { currentMemberId: 'member-maya', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected', role: 'member' }),
    });
    modal.onOpen();
    await flush();
    const input = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="lan-to-cloud-server-url"]',
    )!;
    input.value = proposal.serverUrl;
    input.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="propose-lan-to-cloud"]',
    )?.click();
    await flush();

    expect(port.readLanToCloudTransfer).toHaveBeenCalledTimes(2);
    expect(modal.contentEl.textContent).toContain(proposal.serverUrl);
  });

  it('binds LAN-to-Cloud accept and cancel actions to the displayed transfer', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const proposal = {
      proposedByMemberId: 'member-manager',
      serverUrl: 'https://cloud.example.test/',
      sourceOwned: true,
      status: {
        phase: 'collecting-readiness',
        state: 'active',
        transferId: 'transfer-visible',
      } as never,
    };
    const port = createPort(members, {
      readLanToCloudTransfer: jest.fn().mockResolvedValue(success(proposal)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({
        connectionStatus: 'connected',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'running',
      }),
    });

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="accept-lan-to-cloud"]',
    )?.click();
    await flush();
    expect(port.acceptLanToCloudTransfer).toHaveBeenCalledWith({
      projectId: 'project-alpha',
      transferId: 'transfer-visible',
    });

    modal.onOpen();
    await flush();
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-lan-to-cloud"]',
    )?.click();
    await flush();
    expect(port.cancelLanToCloudTransfer).toHaveBeenCalledWith({
      projectId: 'project-alpha',
      transferId: 'transfer-visible',
    });
  });

  it('clears stale privileged footer actions while a refresh fails', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    let listener: ((state: CollabFeatureState) => void) | undefined;
    const port = createPort(members, {
      readProjectCapabilities: jest.fn()
        .mockResolvedValueOnce(success({
          authorityKind: 'lan', authorityTransfer: false, importedMemberClaims: false,
          invitations: true, leave: true, managerResponsibility: true,
          membershipManagement: true, retirement: true,
        }))
        .mockResolvedValueOnce({
          error: new CollabError({ code: 'endpoint-unreachable' }),
          status: 'failure',
        }),
      readSnapshot: jest.fn()
        .mockResolvedValueOnce(success({
          snapshot: {
            currentMember: members[0], members,
            project: { authorityKind: 'lan', hostMemberId: 'member-host' },
          },
          source: 'online', stale: false, syncState: { status: 'synchronized' },
        } as never))
        .mockResolvedValueOnce({
          error: new CollabError({ code: 'endpoint-unreachable' }),
          status: 'failure',
        }),
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
    expect(modal.contentEl.querySelector('[data-action="create-invitation"]')).not.toBeNull();

    listener?.({ lifecycle: 'ready', projects: [project()], selectedProjectId: 'project-alpha' });
    await flush();

    expect(modal.contentEl.querySelector('[data-action="create-invitation"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-action="retire-project"]')).toBeNull();
  });

  it('closes when the selected Project changes and fences the old Project surface', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    let listener: ((state: CollabFeatureState) => void) | undefined;
    const port = createPort(members, {
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

    listener?.({
      lifecycle: 'ready',
      projects: [project(), project({ id: 'project-beta', name: 'Beta' })],
      selectedProjectId: 'project-beta',
    });

    expect(modal.close).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('disposes a synchronously delivered foreign-Project subscription before reading', () => {
    const dispose = jest.fn();
    const port = createPort([], {
      subscribe: jest.fn().mockImplementation(next => {
        next({
          lifecycle: 'ready',
          projects: [project({ id: 'project-beta', name: 'Beta' })],
          selectedProjectId: 'project-beta',
        });
        return { dispose };
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected' }),
    });

    modal.onOpen();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(port.readSnapshot).not.toHaveBeenCalled();
  });

  it('locks competing Cloud management controls while a durable operation is pending', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'remove-member',
        completionId: 'completion-lock',
        invitation: null,
        secretAvailableUntil: null,
        status: 'pending',
      })),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: true, importedMemberClaims: false,
        invitations: true, leave: true, managerResponsibility: true,
        membershipManagement: true, retirement: true,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();

    expect(modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="resume-management-operation"]',
    )?.disabled).toBe(false);
    for (const action of [
      'create-invitation',
      'make-manager',
      'remove-member',
      'leave-project',
      'retire-project',
    ]) {
      expect(modal.contentEl.querySelector<HTMLButtonElement>(
        `[data-action="${action}"]`,
      )?.disabled).toBe(true);
    }
  });

  it('shows persisted authority-transfer recovery when negotiation disables new actions', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const descriptor = {
      preparationId: 'preparation-recovery',
      projectId: 'project-alpha',
      selectedTargetMemberId: 'member-manager',
      sourceAuthorityGeneration: 4,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.30:54545',
    } as never;
    const port = createPort(members, {
      readCloudToLanTransfer: jest.fn().mockResolvedValue(success({
        manager: {
          descriptor,
          handle: { operationIntentId: 'intent-recovery', transferId: 'transfer-recovery' },
          status: { phase: 'source-quiesced', state: 'active' },
        },
        target: null,
      } as never)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: false,
        membershipManagement: false, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.textContent).toContain('In progress');
    expect(modal.contentEl.querySelector('[data-action="begin-cloud-to-lan"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-action="observe-cloud-to-lan"]')).toBeNull();
  });

  it('explains a saved pre-publication transfer when capability negotiation is unavailable', async () => {
    const members = [member('member-maya', 'Maya')];
    const port = createPort(members, {
      readCloudToLanTransfer: jest.fn().mockResolvedValue(success({
        manager: null,
        target: {
          canWithdraw: false,
          descriptor: null,
          handle: null,
          status: null,
        },
      })),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: true, managerResponsibility: false,
        membershipManagement: false, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected', role: 'member' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.textContent).toContain('Pending');
    expect(modal.contentEl.textContent).toContain('compatible server connection');
  });

  it('shows a saved Manager preparation when capability negotiation is unavailable', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const descriptor = {
      preparationId: 'preparation-manager-recovery',
      projectId: 'project-alpha',
      selectedTargetMemberId: 'member-maya',
      sourceAuthorityGeneration: 4,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.30:54545',
    } as never;
    const port = createPort(members, {
      readCloudToLanTransfer: jest.fn().mockResolvedValue(success({
        manager: { descriptor, handle: null, status: null },
        target: null,
      })),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: false,
        membershipManagement: false, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.textContent).toContain('preparation-manager-recovery');
    expect(modal.contentEl.textContent).toContain('Pending');
  });

  it('keeps pending invitation recovery reachable when the current capability is disabled', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const port = createPort(members, {
      readManagementOperation: jest.fn().mockResolvedValue(success({
        action: 'create-invitation',
        completionId: 'completion-invitation',
        invitation: null,
        secretAvailableUntil: null,
        status: 'pending',
      })),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: false,
        membershipManagement: false, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    const invitation = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    );
    expect(invitation).not.toBeNull();
    expect(invitation?.disabled).toBe(false);
    expect(invitation?.textContent).toBe('Resume invitation');
  });

  it('fails closed when the durable management read fails with capabilities disabled', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const port = createPort(members, {
      readManagementOperation: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: false,
        membershipManagement: false, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.textContent).toContain('Members could not be loaded');
    expect(modal.contentEl.querySelector('[data-action="retry-members"]')).not.toBeNull();
  });

  it('keeps LAN-to-Cloud Host actions reachable after proposing in the same modal', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const port = createPort(members, {
      proposeLanToCloudTransfer: jest.fn().mockResolvedValue(success({
        phase: 'collecting-readiness',
        state: 'active',
        transferId: 'transfer-proposed',
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({
        connectionStatus: 'connected',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'running',
      }),
    });

    modal.onOpen();
    await flush();
    const input = modal.contentEl.querySelector<HTMLInputElement>(
      '[data-field="lan-to-cloud-server-url"]',
    )!;
    input.value = 'https://cloud.example.test/';
    input.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="propose-lan-to-cloud"]',
    )?.click();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="accept-lan-to-cloud"]')).not.toBeNull();
    expect(modal.contentEl.querySelector('[data-action="cancel-lan-to-cloud"]')).not.toBeNull();
  });

  it('shows persisted Cloud-to-LAN progress to the selected non-Manager target', async () => {
    const members = [member('member-maya', 'Maya')];
    const descriptor = {
      preparationId: 'preparation-target',
      projectId: 'project-alpha',
      selectedTargetMemberId: 'member-maya',
      sourceAuthorityGeneration: 4,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.30:54545',
    } as never;
    const port = createPort(members, {
      acceptCloudToLanTransfer: jest.fn().mockResolvedValue(success({
        phase: 'source-quiesced', state: 'active',
      } as never)),
      readCloudToLanTransfer: jest.fn().mockResolvedValue(success({
        manager: null,
        target: {
          canWithdraw: false,
          descriptor,
          handle: { operationIntentId: 'intent-target', transferId: 'transfer-target' },
          status: null,
        },
      } as never)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: true, importedMemberClaims: false,
        invitations: false, leave: true, managerResponsibility: false,
        membershipManagement: false, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected', role: 'member' }),
    });

    modal.onOpen();
    await flush();

    expect(modal.contentEl.textContent).not.toContain('In progress');
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="accept-cloud-to-lan"]',
    )?.click();
    await flush();
    expect(modal.contentEl.textContent).toContain('In progress');
    expect(modal.contentEl.querySelector('[data-action="begin-cloud-to-lan"]')).toBeNull();
  });

  it('renders the explicit Cloud-to-LAN prepare, begin, accept, observe, and cancel flow', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const descriptor = {
      expiresAt: '2026-09-10T00:00:00.000Z',
      preparationId: 'preparation-one',
      projectId: 'project-alpha',
      schemaVersion: 1,
      selectedTargetMemberId: 'member-manager',
      sourceAuthorityGeneration: 4,
      sourceCloudUrl: 'http://cloud.example:8787',
      targetUrl: 'https://192.168.1.30:54545',
      transferId: 'transfer-one',
    } as never;
    const handle = {
      operationIntentId: 'intent-one',
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    } as never;
    const activeStatus = {
      phase: 'source-quiesced',
      state: 'active',
    } as never;
    const completedStatus = {
      phase: 'completed',
      state: 'completed',
    } as never;
    const port = createPort(members, {
      acceptCloudToLanTransfer: jest.fn().mockResolvedValue(success(completedStatus)),
      beginCloudToLanTransfer: jest.fn().mockResolvedValue(success(handle)),
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
      listMembers: jest.fn().mockResolvedValue(success([{
        displayName: 'Alice', importedClaim: null, memberId: 'member-manager', role: 'manager',
      }])),
      prepareCloudToLanTarget: jest.fn().mockResolvedValue(success(descriptor)),
      observeCloudToLanTransfer: jest.fn().mockResolvedValue(success(activeStatus)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud',
        authorityTransfer: true,
        importedMemberClaims: false,
        invitations: false,
        leave: false,
        managerResponsibility: true,
        membershipManagement: true,
        retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0],
          members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      } as never)),
    });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, {
      copyText: jest.fn().mockResolvedValue(undefined),
      onChanged,
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();
    await flush();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="prepare-cloud-to-lan"]',
    )?.click();
    await flush();
    expect(port.prepareCloudToLanTarget).toHaveBeenCalledWith({
      projectId: 'project-alpha',
    });
    expect(modal.contentEl.textContent).toContain('preparation-one');

    const descriptorInput = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="cloud-to-lan-descriptor"]',
    )!;
    descriptorInput.value = JSON.stringify(descriptor);
    descriptorInput.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="begin-cloud-to-lan"]',
    )?.click();
    await flush();
    expect(port.beginCloudToLanTransfer).toHaveBeenCalledWith({ descriptor });
    expect(modal.contentEl.textContent).toContain('intent-one');
    expect(modal.contentEl.querySelector(
      '[data-action="copy-cloud-to-lan-descriptor"]',
    )?.getAttribute('aria-label')).toBe('Copy transfer data: LAN target descriptor');
    expect(modal.contentEl.querySelector(
      '[data-action="copy-cloud-to-lan-handle"]',
    )?.getAttribute('aria-label')).toBe('Copy transfer data: Transfer handle');

    for (const action of [
      'accept-cloud-to-lan',
      'observe-cloud-to-lan',
      'withdraw-cloud-to-lan-target',
    ]) {
      expect(modal.contentEl.querySelector(`[data-action="${action}"]`)).not.toBeNull();
    }
    expect(modal.contentEl.querySelector('[data-action="cancel-cloud-to-lan"]')).toBeNull();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="observe-cloud-to-lan"]',
    )?.click();
    await flush();
    expect(modal.contentEl.textContent).toContain('In progress');
    expect(modal.contentEl.textContent).not.toContain('source-quiesced');
    expect(modal.contentEl.querySelector('[data-action="cancel-cloud-to-lan"]')).not.toBeNull();

    const handleInput = modal.contentEl.querySelector<HTMLTextAreaElement>(
      '[data-field="cloud-to-lan-handle"]',
    )!;
    handleInput.value = JSON.stringify(handle);
    handleInput.dispatchEvent(new Event('input'));
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="accept-cloud-to-lan"]',
    )?.click();
    await flush();

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('hides target-device controls when a Manager selected another Member installation', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const descriptor = {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      preparationId: 'preparation-maya',
      projectId: 'project-alpha',
      publishedAt: CREATED_AT,
      schemaVersion: 1,
      selectedTargetMemberId: 'member-maya',
      sourceAuthorityGeneration: 4,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.30:54545',
    } as const;
    const port = createPort(members, {
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
      listMembers: jest.fn().mockResolvedValue(success(members.map(item => ({
        displayName: item.displayName,
        importedClaim: null,
        memberId: item.id,
        role: item.role,
      })))),
      readCloudToLanTransfer: jest.fn().mockResolvedValue(success({
        manager: { descriptor, handle: null, status: null },
        target: null,
      })),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: true, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: true,
        membershipManagement: true, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="prepare-cloud-to-lan"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-action="accept-cloud-to-lan"]')).toBeNull();
    expect(modal.contentEl.querySelector('[data-action="withdraw-cloud-to-lan-target"]'))
      .toBeNull();
    expect(modal.contentEl.querySelector('[data-action="begin-cloud-to-lan"]')).not.toBeNull();
  });

  it('restores durable Cloud-to-LAN Manager and target controls after close and offline reopen', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const descriptor = {
      caCertificatePem: '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----',
      caFingerprint: 'c'.repeat(64),
      preparationId: 'preparation-one',
      projectId: 'project-alpha',
      publishedAt: CREATED_AT,
      schemaVersion: 1,
      selectedTargetMemberId: 'member-manager',
      sourceAuthorityGeneration: 4,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.30:54545',
    } as const;
    const handle = {
      operationIntentId: 'intent-manager',
      preparationId: 'preparation-one',
      projectId: 'project-alpha',
      schemaVersion: 1,
      selectedTargetMemberId: 'member-manager',
      sourceAuthorityGeneration: 4,
      sourceCloudUrl: 'https://cloud.example.test/',
      targetUrl: 'https://192.168.1.30:54545',
      transferId: 'transfer-one',
    } as const;
    const view = {
      manager: {
        descriptor,
        handle,
        status: { phase: 'source-quiesced', state: 'active' } as never,
      },
      target: {
        canWithdraw: false,
        descriptor,
        handle,
        status: { phase: 'source-quiesced', state: 'active' } as never,
      },
    } as const;
    const port = createPort(members, {
      readCloudToLanTransfer: jest.fn().mockResolvedValue(success(view)),
      readProjectCapabilities: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
      readSnapshot: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }),
        status: 'failure',
      }),
    } as never);
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'offline' }),
    });

    modal.onOpen();
    await flush();
    expect(modal.contentEl.querySelector('[data-action="observe-cloud-to-lan"]'))
      .not.toBeNull();
    expect(modal.contentEl.querySelector('[data-action="accept-cloud-to-lan"]'))
      .not.toBeNull();
    expect(modal.contentEl.querySelector('[data-action="withdraw-cloud-to-lan-target"]'))
      .toBeNull();

    modal.onClose();
    modal.onOpen();
    await flush();
    expect(port.readCloudToLanTransfer).toHaveBeenCalledTimes(2);
    expect(modal.contentEl.querySelector('[data-action="observe-cloud-to-lan"]'))
      .not.toBeNull();
  });

  it.each([
    'revoke-invitation',
    'demote-manager',
    'remove-member',
    'create-manager-offer',
    'cancel-manager-offer',
    'promote-manager',
    'reissue-member-claim',
    'revoke-member-claim',
  ] as const)('finishes a retained %s result explicitly', async action => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    let retained = true;
    const port = createPort(members, {
      completeManagementOperation: jest.fn().mockImplementation(async () => {
        retained = false;
        return success(undefined);
      }),
      readManagementOperation: jest.fn().mockImplementation(async () => success(retained
        ? {
          action,
          completionId: `completion-${action}`,
          invitation: null,
          secretAvailableUntil: null,
          status: 'result-retained' as const,
        }
        : null)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: true,
        invitations: true, leave: true, managerResponsibility: true,
        membershipManagement: true, retirement: true,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    } as never);
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();
    const finish = modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="complete-management-operation"]',
    );
    expect(finish).not.toBeNull();
    finish!.click();
    await flush();

    expect(port.completeManagementOperation).toHaveBeenCalledWith({
      completionId: `completion-${action}`,
      projectId: 'project-alpha',
    });
  });

  it('does not settle Cloud retained state when a LAN-open modal observes authority convergence', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    let listener: ((state: CollabFeatureState) => void) | undefined;
    const port = createPort(members, {
      subscribe: jest.fn().mockImplementation(next => {
        listener = next;
        return { dispose: jest.fn() };
      }),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'lan' }),
    });
    modal.onOpen();
    await flush();

    listener?.({
      lifecycle: 'ready',
      projects: [project({ authorityKind: 'cloud', connectionStatus: 'connected' })],
      selectedProjectId: 'project-alpha',
    });
    modal.onClose();

    expect(port.completeManagementOperation).not.toHaveBeenCalled();
  });

  it('has no detectable accessibility violations in negotiated Cloud management', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const port = createPort(members, {
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
      listMembers: jest.fn().mockResolvedValue(success([{
        displayName: 'Alice', importedClaim: null, memberId: 'member-manager', role: 'manager',
      }])),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: true, importedMemberClaims: true,
        invitations: true, leave: true, managerResponsibility: true,
        membershipManagement: true, retirement: true,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();
    await flush();

    expect(await axe(modal.contentEl)).toHaveNoViolations();
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
        invalidate = () => listener({
          lifecycle: 'ready',
          projects: [project()],
          selectedProjectId: 'project-alpha',
        });
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
    expect(port.createInvitation).not.toHaveBeenCalled();
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
      projectId: 'project-alpha',
      purpose: 'manager-promotion',
      targetMemberId: 'member-maya',
    }, { signal: expect.any(AbortSignal) });
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
    }, { signal: expect.any(AbortSignal) });
  });

  it('matches the current Manager to the relevant offer when disjoint offers coexist', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-other-manager', 'Omar', { role: 'manager' }),
      member('member-maya', 'Maya'),
      member('member-noah', 'Noah'),
    ];
    const offers = [
      {
        expiresAt: '2026-09-10T00:00:00.000Z',
        offerId: 'offer-unrelated',
        offeredAt: CREATED_AT,
        purpose: 'manager-promotion' as const,
        sourceManagerMemberId: 'member-other-manager',
        status: 'offered' as const,
        targetMemberId: 'member-noah',
      },
      {
        expiresAt: '2026-09-10T00:00:00.000Z',
        offerId: 'offer-current',
        offeredAt: CREATED_AT,
        purpose: 'manager-promotion' as const,
        sourceManagerMemberId: 'member-manager',
        status: 'acknowledged' as const,
        targetMemberId: 'member-maya',
      },
    ];
    const port = createPort(members, {
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success(offers)),
      listMembers: jest.fn().mockResolvedValue(success(members.map(item => ({
        displayName: item.displayName,
        importedClaim: null,
        memberId: item.id,
        role: item.role,
      })))),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: true,
        membershipManagement: true, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();

    expect(modal.contentEl.querySelector(
      '[data-action="complete-promotion"][data-member-id="member-maya"]',
    )).not.toBeNull();
    const current = modal.contentEl.querySelector('[data-member-id="member-manager"]')!;
    current.querySelector<HTMLButtonElement>(
      '[data-action="cancel-manager-responsibility"]',
    )?.click();
    await flush();
    expect(port.cancelManagerResponsibilityOffer).toHaveBeenCalledWith({
      offerId: 'offer-current',
      projectId: 'project-alpha',
    });
  });

  it('does not offer Manager promotion without membership-management capability', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: true,
        membershipManagement: false, retirement: false,
      })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: {
          currentMember: members[0], members,
          project: { authorityGeneration: 4, authorityKind: 'cloud' },
        },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });

    modal.onOpen();
    await flush();
    await flush();

    expect(modal.contentEl.querySelector('[data-action="make-manager"]')).toBeNull();
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
      managerResponsibilityOfferId: 'promotion-one',
      projectId: 'project-alpha',
      targetMemberId: 'member-maya',
    }, { signal: expect.any(AbortSignal) });
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
      projectId: 'project-alpha',
      targetMemberId: 'member-host',
    }, { signal: expect.any(AbortSignal) });
  });

  it('requests project-scoped LAN intent abandonment when another confirmation replaces it', async () => {
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
    expect(port.demoteManager.mock.calls[1]?.[0]).toEqual({
      projectId: 'project-alpha', targetMemberId: 'member-bob',
    });
    expect(port.completeManagementOperation).toHaveBeenCalledWith({
      projectId: 'project-alpha',
    });
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
      memberId: 'member-bob',
      projectId: 'project-alpha',
    }, { signal: expect.any(AbortSignal) });
    expect(modal.contentEl.querySelector('[role="alert"]')?.textContent)
      .toContain('At least one Manager must remain');
  });

  it('places the LAN Host switch inside Project management on the Host device', async () => {
    const port = createPort([
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-host', 'Host operator'),
    ], {}, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'stopped',
        role: 'member',
      }),
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

  it('shows a synchronized foreign Host as status-only in Project management', async () => {
    const port = createPort([
      member('member-host', 'Host operator'),
    ], {}, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({
        hostInstallationStatus: 'hosted-elsewhere',
        hostStatus: 'not-host',
        role: 'member',
      }),
    });

    modal.onOpen();
    await flush();

    const host = modal.contentEl.querySelector('.claudian-collab-project-host-action');
    expect(host?.textContent).toContain('Hosted on another device');
    expect(host?.querySelectorAll('button')).toHaveLength(0);
    expect(port.startHost).not.toHaveBeenCalled();
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
        hostInstallationStatus: 'hosted-here',
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
      projectId: 'project-alpha',
    }, { signal: expect.any(AbortSignal) });
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
      project: project({
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'stopped',
      }),
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
      memberId: 'member-maya',
      projectId: 'project-alpha',
    }, { signal: expect.any(AbortSignal) });
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
    }, { signal: expect.any(AbortSignal) });
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
    expect(port.removeMember.mock.calls[0]?.[0]).toEqual({
      memberId: 'member-maya', projectId: 'project-alpha',
    });
    managerModal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-access-action"]',
    )?.click();
    await flush();
    expect(port.removeMember).toHaveBeenCalledTimes(2);
    expect(port.removeMember.mock.calls[1]?.[0]).toEqual(port.removeMember.mock.calls[0]?.[0]);
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
      }, { signal: expect.any(AbortSignal) });
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
      projectId: 'project-alpha',
      purpose: 'manager-leave',
      targetMemberId: 'member-maya',
    }, { signal: expect.any(AbortSignal) });
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
    }, { signal: expect.any(AbortSignal) });
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
    await selectSuccessor();
    expect(port.createManagerResponsibilityOffer.mock.calls[1]?.[0])
      .toEqual(port.createManagerResponsibilityOffer.mock.calls[0]?.[0]);

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="cancel-access-action"]',
    )?.click();
    await enterSuccessorFlow();
    await selectSuccessor();
    expect(port.completeManagementOperation).toHaveBeenCalledWith({ projectId: 'project-alpha' });
    expect(port.createManagerResponsibilityOffer.mock.calls[2]?.[0])
      .toEqual(port.createManagerResponsibilityOffer.mock.calls[0]?.[0]);
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
    currentMember = members[1]!;
    listener?.({
      lifecycle: 'ready',
      projects: [project()],
      selectedProjectId: 'project-alpha',
    });
    await flush();
    await createOffer();

    expect(port.completeManagementOperation).toHaveBeenCalledWith({ projectId: 'project-alpha' });
    expect(port.createManagerResponsibilityOffer.mock.calls[1]?.[0])
      .toEqual(port.createManagerResponsibilityOffer.mock.calls[0]?.[0]);
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
    }, { signal: expect.any(AbortSignal) });
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
      projectId: 'project-alpha',
    }, { signal: expect.any(AbortSignal) });
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('ignores a completed Leave after the modal closes', async () => {
    const members = [member('member-maya', 'Maya')];
    let finish!: (result: ReturnType<typeof success<void>>) => void;
    let signal: AbortSignal | undefined;
    const port = createPort(members, {
      leaveProject: jest.fn((_request, options) => {
        signal = options?.signal;
        return new Promise(resolve => { finish = resolve; });
      }),
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
    expect(port.leaveProject).toHaveBeenCalledWith(
      {
        cleanupChoice: 'keep-files',
        projectId: 'project-alpha',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    modal.onClose();
    finish(success(undefined));
    await flush();

    expect(onChanged).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('ignores a completed promotion after the modal closes', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    let finish!: (result: ReturnType<typeof success<void>>) => void;
    let signal: AbortSignal | undefined;
    const port = createPort(members, {
      promoteManager: jest.fn((_request, options) => {
        signal = options?.signal;
        return new Promise(resolve => { finish = resolve; });
      }),
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
    expect(signal?.aborted).toBe(true);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

});
