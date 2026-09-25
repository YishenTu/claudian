/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type CollabMember } from '@claudian-collab/protocol';
import { testTime } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import { type CollabCoordinationSnapshot, type CollabFeatureState, type CollabLocalProjectSummary } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const mockModals: { contentEl: HTMLElement; close: () => void }[] = [];

jest.mock('obsidian', () => ({
  Modal: class MockModal {
    readonly contentEl = document.createElement('div');
    readonly modalEl = document.createElement('div');
    close = jest.fn(() => this.onClose());
    open = jest.fn(() => this.onOpen());
    setTitle = jest.fn();
    constructor() { mockModals.push(this); }
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
    moveCloudToLan: jest.fn().mockResolvedValue(success({} as never)),
    moveLanToCloud: jest.fn().mockResolvedValue(success({} as never)),
    acceptCloudToLanTransfer: jest.fn().mockResolvedValue(success({} as never)),
    openInvitation: jest.fn().mockReturnValue({
      run: jest.fn().mockResolvedValue(success({
        status: 'ready', invitation: { encodedInvitation: 'claudian-collab:v2:invite-alpha', expiresAt: testTime({ days: 1442, minutes: 15 }) },
        availableUntil: '2030-08-08T00:15:00.000Z',
      })),
      read: jest.fn(), acknowledge: jest.fn(), dispose: jest.fn(),
    }),
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
    projectRecovery: true,
      invitations: true,
      leave: true,
      managerResponsibility: true, managerPromotion: true,
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
    observeProject: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    withdrawCloudToLanTarget: jest.fn().mockResolvedValue(success(undefined)),
    ...overrides,
  } as jest.Mocked<ProjectManagementModalPort>;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('ProjectManagementModal', () => {
  it('completes an acknowledged promotion without changing the source Manager', async () => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-maya', 'Maya'),
    ];
    const port = createPort(members, {
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'lan', authorityTransfer: true, importedMemberClaims: false,
        invitations: true, leave: true, managerResponsibility: true, managerPromotion: false,
        membershipManagement: true, retirement: true,
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


  it('confirms promotion inside Members and applies it with one Manager action', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' }), member('member-maya', 'Maya')];
    const port = createPort(members);
    const modal = new ProjectManagementModal({} as never, port, { project: project() });
    modal.open();
    await flush();
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Make Manager: Maya' }));
    const section = within(modal.contentEl).getByRole('region', { name: 'Members' });
    fireEvent.click(within(section).getByRole('button', { name: 'Confirm' }));
    await flush();
    expect(port.promoteManager).toHaveBeenCalledWith({ projectId: 'project-alpha', targetMemberId: 'member-maya' }, { signal: expect.any(AbortSignal) });
    modal.close();
  });

  it('offers eligible Host destinations from Hosting and submits the selected member', async () => {
    const members = [member('member-host', 'Host operator'), member('member-maya', 'Maya'),
      member('member-lee', 'Lee'), member('member-left', 'Former member', { status: 'left' })];
    const port = createPort(members, {}, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ hostInstallationStatus: 'hosted-here', hostStatus: 'running', role: 'member' }),
    });
    modal.open();
    await flush();
    const hosting = within(modal.contentEl).getByRole('region', { name: 'Hosting' });
    const transfer = within(hosting).getByRole('button', { name: 'Transfer Host' });
    expect(transfer.parentElement).toBe(within(hosting).getByRole('button', { name: 'Stop Host' }).parentElement);
    fireEvent.click(transfer);
    const picker = mockModals[mockModals.length - 1];
    expect(within(picker.contentEl).getAllByRole('button').map(button => button.textContent)).toEqual(['Maya', 'Lee']);
    expect((await axe(picker.contentEl)).violations).toEqual([]);
    fireEvent.click(within(picker.contentEl).getByRole('button', { name: 'Maya' }));
    await flush();
    expect(port.createHostTransfer).toHaveBeenCalledWith({ projectId: 'project-alpha', targetMemberId: 'member-maya' }, { signal: expect.any(AbortSignal) });
    expect(picker.close).toHaveBeenCalled();
    modal.close();
  });

  it('keeps keyboard focus in Host destinations during background refresh', async () => {
    const members = [member('member-host', 'Host operator'), member('member-maya', 'Maya')];
    const summary = project({ hostInstallationStatus: 'hosted-here', hostStatus: 'running', role: 'member' });
    const port = createPort(members, {}, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    modal.open();
    await flush();
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Transfer Host' }));
    const picker = mockModals[mockModals.length - 1];
    document.body.appendChild(picker.contentEl);
    const destination = within(picker.contentEl).getByRole('button', { name: 'Maya' });
    destination.focus();
    port.subscribe.mock.calls[0][0]({ lifecycle: 'ready', projects: [summary], selectedProjectId: summary.id });
    await flush();
    expect(document.activeElement).toBe(within(picker.contentEl).getByRole('button', { name: 'Maya' }));
    modal.close();
    picker.contentEl.remove();
  });

  it('closes Host destination selection with its management surface', async () => {
    const members = [member('member-host', 'Host operator'), member('member-maya', 'Maya')];
    const port = createPort(members, {}, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ hostInstallationStatus: 'hosted-here', hostStatus: 'running', role: 'member' }),
    });
    modal.open();
    await flush();
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Transfer Host' }));
    const picker = mockModals[mockModals.length - 1];
    const destination = within(picker.contentEl).getByRole('button', { name: 'Maya' });
    modal.close();
    expect(picker.close).toHaveBeenCalled();
    fireEvent.click(destination);
    expect(port.createHostTransfer).not.toHaveBeenCalled();
  });

  it('copies a fresh general recovery link next to Invite without displaying the string', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    let count = 0;
    const port = createPort(members, { openInvitation: jest.fn().mockImplementation(() => {
      const state = success({ status: 'ready', invitation: { encodedInvitation: `recovery-${++count}`, expiresAt: testTime({ days: 1442, minutes: 15 }) }, availableUntil: testTime({ days: 1442, minutes: 15 }) });
      return { run: async () => state, read: async () => state, acknowledge: async () => success(undefined), dispose: () => {} };
    }) });
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectManagementModal({} as never, port, { project: project(), copyText });
    modal.open();
    await flush();
    const invite = within(modal.contentEl).getByRole('button', { name: 'Create invitation' });
    const copy = within(modal.contentEl).getByRole('button', { name: 'Recovery link' });
    expect(copy.parentElement).toBe(invite.parentElement);
    fireEvent.click(copy);
    await flush();
    expect(copyText).toHaveBeenLastCalledWith('recovery-1');
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Recovery link' }));
    await flush();
    expect(copyText).toHaveBeenLastCalledWith('recovery-2');
    expect(modal.contentEl.textContent).not.toContain('recovery-2');
    expect(port.openInvitation).toHaveBeenLastCalledWith({ projectId: 'project-alpha', intent: 'create', purpose: 'recovery' });
    modal.close();
  });
it.each([false, true])('automatically restores management after Host startup with publication before response=%s', async publishBeforeResponse => {
  const host = member('member-host', 'Host operator', { role: 'manager' });
  const summary = project({ role: 'manager', hostInstallationStatus: 'hosted-here', hostStatus: 'stopped' });
  let publish!: (state: CollabFeatureState) => void;
  const port = createPort([host], {
    subscribe: jest.fn().mockImplementation(listener => { publish = listener; return { dispose() {} }; }),
  }, { currentMemberId: host.id, hostMemberId: host.id });
  port.readSnapshot.mockResolvedValueOnce({ status: 'failure', error: new CollabError({ code: 'endpoint-unreachable' }) });
  port.startHost.mockImplementation(async () => {
    if (publishBeforeResponse) publish({ lifecycle: 'ready', projects: [{ ...summary, hostStatus: 'running' }], selectedProjectId: summary.id });
    return success({ projectId: summary.id, status: 'running' });
  });
  const modal = new ProjectManagementModal({} as never, port, { project: summary });
  document.body.appendChild(modal.contentEl);
  try {
    modal.onOpen(); await flush(); await flush();
    const ui = within(modal.contentEl);
    expect(ui.queryByRole('button', { name: 'Create invitation' })).toBeNull();
    expect(ui.getByRole('button', { name: 'Retry' })).not.toBeNull();
    fireEvent.click(ui.getByRole('button', { name: 'Start Host' }));
    await flush(); await flush(); await flush();
    expect(ui.getByRole('button', { name: 'Stop Host' })).not.toBeNull();
    expect(ui.getByRole('button', { name: 'Create invitation' })).not.toBeNull();
  } finally { modal.onClose(); modal.contentEl.remove(); }
});

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(testTime({ days: 6 })));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves an unsubmitted Cloud URL and focus across ordinary Project invalidation', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    let publish!: (state: CollabFeatureState) => void;
    const summary = project({ connectionStatus: 'connected' });
    const port = createPort(members, { subscribe: jest.fn().mockImplementation(listener => { publish = listener; return { dispose() {} }; }) });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    document.body.appendChild(modal.contentEl); modal.onOpen(); await flush();
    const ui = within(modal.contentEl);
    fireEvent.click(ui.getByRole('button', { name: 'Move to Cloud' }));
    const input = ui.getByRole('textbox', { name: 'Cloud server URL' }) as HTMLInputElement;
    input.focus(); fireEvent.input(input, { target: { value: 'https://cloud.example.test/' } });
    input.setSelectionRange(8, 15);
    publish({ lifecycle: 'ready', projects: [summary], selectedProjectId: summary.id } as CollabFeatureState);
    await flush();
    expect((ui.getByRole('textbox', { name: 'Cloud server URL' }) as HTMLInputElement).value).toBe('https://cloud.example.test/');
    expect(document.activeElement).toBe(ui.getByRole('textbox', { name: 'Cloud server URL' }));
    expect((document.activeElement as HTMLInputElement).selectionStart).toBe(8);
    expect((document.activeElement as HTMLInputElement).selectionEnd).toBe(15);
    modal.onClose();
    modal.onOpen(); await flush();
    fireEvent.click(ui.getByRole('button', { name: 'Move to Cloud' }));
    expect((ui.getByRole('textbox', { name: 'Cloud server URL' }) as HTMLInputElement).value).toBe('');
    modal.onClose(); modal.contentEl.remove();
  });

  it('recovers pending management reads when the local Host starts', async () => {
    const host = member('member-host', 'Host', { role: 'manager' });
    const summary = project({ hostInstallationStatus: 'hosted-here', hostStatus: 'stopped' });
    let publish!: (state: CollabFeatureState) => void;
    let finish!: (value: ReturnType<typeof success<CollabCoordinationSnapshot>>) => void;
    const port = createPort([host], {
      subscribe: jest.fn().mockImplementation(listener => { publish = listener; return { dispose() {} }; }),
    }, { currentMemberId: host.id, hostMemberId: host.id });
    port.readSnapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    port.startHost.mockImplementation(async () => {
      publish({ lifecycle: 'ready', projects: [{ ...summary, hostStatus: 'running' }], selectedProjectId: summary.id });
      return success({ projectId: summary.id, status: 'running' });
    });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    modal.onOpen(); await flush();
    try {
      fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Start Host' }));
      await flush();
      expect(within(modal.contentEl).getByRole('button', { name: 'Create invitation' })).not.toBeNull();
    } finally { modal.onClose(); finish(success({} as never)); await flush(); }
  });

  it('updates the Host control when subscribed application state changes', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    let publish!: (state: CollabFeatureState) => void;
    const summary = project({ connectionStatus: 'connected', hostInstallationStatus: 'hosted-here', hostStatus: 'running' });
    const port = createPort(members, { subscribe: jest.fn().mockImplementation(listener => { publish = listener; return { dispose() {} }; }) }, { currentMemberId: 'member-manager', hostMemberId: 'member-manager' });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    document.body.appendChild(modal.contentEl); modal.onOpen(); await flush();
    const ui = within(modal.contentEl);
    expect(ui.getByRole('button', { name: 'Stop Host' })).not.toBeNull();
    publish({ lifecycle: 'ready', projects: [{ ...summary, hostStatus: 'stopped' }], selectedProjectId: summary.id } as CollabFeatureState);
    await flush();
    expect(ui.getByRole('button', { name: 'Start Host' })).not.toBeNull();
    modal.onClose(); modal.contentEl.remove();
  });
  it.each(['online', 'offline', 'pending', 'refresh-pending'] as const)('mounts Host controls when local ownership arrives with %s management reads', async readState => {
    let publish!: (state: CollabFeatureState) => void;
    const summary = project({ connectionStatus: 'connected', role: 'member' });
    const port = createPort([member('member-manager', 'Alice')], { subscribe: jest.fn().mockImplementation(listener => { publish = listener; return { dispose() {} }; }) });
    let release: (() => void) | undefined;
    if (readState === 'offline' || readState === 'pending') {
      const offline = { status: 'failure' as const, error: new CollabError({ code: 'endpoint-unreachable' }) };
      port.readSnapshot.mockImplementation(() => readState === 'offline'
        ? Promise.resolve(offline)
        : new Promise(resolve => { release = () => resolve(offline); }));
    }
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    document.body.appendChild(modal.contentEl);
    try {
      modal.onOpen(); await flush();
      expect(within(modal.contentEl).queryByRole('button', { name: 'Start Host' })).toBeNull();
      if (readState === 'refresh-pending') {
        port.readSnapshot.mockImplementation(() => new Promise(resolve => {
          release = () => resolve({ status: 'failure', error: new CollabError({ code: 'endpoint-unreachable' }) });
        }));
      }
      publish({ lifecycle: 'ready', projects: [{ ...summary, hostInstallationStatus: 'hosted-here', hostStatus: 'stopped' }], selectedProjectId: summary.id });
      await flush();
      expect(within(modal.contentEl).getByRole('button', { name: 'Start Host' })).not.toBeNull();
      publish({ lifecycle: 'ready', projects: [summary], selectedProjectId: summary.id });
      await flush();
      expect(within(modal.contentEl).queryByRole('button', { name: 'Start Host' })).toBeNull();
    } finally { release?.(); modal.onClose(); modal.contentEl.remove(); await flush(); }
  });

  it.each(['destination', 'actor-change'] as const)('preserves identity-bound transfer form state for %s', async scenario => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const summary = project({ authorityKind: 'cloud', connectionStatus: 'connected' });
    const port = createPort(members, {
      readProjectCapabilities: jest.fn().mockResolvedValue(success({ authorityKind: 'cloud', authorityTransfer: true })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: { currentMember: members[0], members, project: { authorityKind: 'cloud' } },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      })),
    });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    document.body.appendChild(modal.contentEl);
    try {
      modal.onOpen(); await flush();
      const ui = within(modal.contentEl);
      fireEvent.click(ui.getByRole('button', { name: 'Move to LAN' }));
      fireEvent.change(ui.getByRole('combobox', { name: 'LAN host' }), { target: { value: 'another-device' } });
      const destination = ui.getByRole('combobox', { name: 'LAN host' });
      if (scenario === 'destination') destination.focus();
      if (scenario === 'actor-change') {
        const replacementMember = member('member-replacement', 'Replacement', { role: 'manager' });
        port.readSnapshot.mockResolvedValue(success({
          snapshot: { currentMember: replacementMember, members: [replacementMember], project: { authorityKind: 'cloud' } },
          source: 'online', stale: false, syncState: { status: 'synchronized' },
        } as never));
      }
      port.observeProject.mock.calls[0]?.[1]();
      await flush();
      if (scenario === 'actor-change') {
        const toggle = ui.getByRole('button', { name: 'Move to LAN' });
        if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
      }
      expect((ui.getByRole('combobox', { name: 'LAN host' }) as HTMLSelectElement).value)
        .toBe(scenario === 'actor-change' ? 'this-device' : 'another-device');
      const focusedField = document.activeElement?.getAttribute('data-field') ?? null;
      expect(focusedField).toBe(scenario === 'actor-change' ? null
        : 'lan-destination');
      expect(port.beginCloudToLanTransfer).not.toHaveBeenCalled();
    } finally { modal.onClose(); modal.contentEl.remove(); }
  });

  it('keeps a retained remote transfer actionable after the current member changes', async () => {
    const original = member('member-manager', 'Alice', { role: 'manager' });
    const replacement = member('member-replacement', 'Replacement', { role: 'manager' });
    const summary = project({ authorityKind: 'cloud', connectionStatus: 'connected' });
    const handle = { operationIntentId: 'intent-one', projectId: summary.id, transferId: 'transfer-one' };
    const port = createPort([original], {
      readProjectCapabilities: jest.fn().mockResolvedValue(success({ authorityKind: 'cloud', authorityTransfer: true })),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: { currentMember: original, members: [original], project: { authorityKind: 'cloud' } },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      })),
    });
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectManagementModal({} as never, port, { copyText, project: summary });
    document.body.appendChild(modal.contentEl);
    try {
      modal.onOpen(); await flush();
      port.readSnapshot.mockResolvedValue(success({
        snapshot: { currentMember: replacement, members: [replacement], project: { authorityKind: 'cloud' } },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never));
      port.readCloudToLanTransfer.mockResolvedValue(success({
        manager: {
          descriptor: { preparationId: 'preparation-one', projectId: summary.id, transferId: 'transfer-one' },
          handle, status: { phase: 'source-quiesced', state: 'active' },
        }, target: null,
      } as never));
      port.observeProject.mock.calls[0]?.[1]();
      await flush();
      fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Refresh transfer status' }));
      await flush();
      expect(port.observeCloudToLanTransfer).toHaveBeenCalledWith(summary.id);
      expect(port.moveCloudToLan).not.toHaveBeenCalled();
    } finally { modal.onClose(); modal.contentEl.remove(); }
  });

  it.each(['initial', 'retry'] as const)('keeps offline Leave available during pending %s reads', async phase => {
    const offline = { status: 'failure' as const, error: new CollabError({ code: 'endpoint-unreachable' }) };
    let release!: (value: typeof offline) => void;
    const delayed = new Promise<typeof offline>(resolve => { release = resolve; });
    const readSnapshot = jest.fn();
    if (phase === 'retry') readSnapshot.mockResolvedValueOnce(offline);
    readSnapshot.mockReturnValue(delayed);
    const port = createPort([], { readSnapshot, readProjectCapabilities: jest.fn().mockResolvedValue(offline) });
    const modal = new ProjectManagementModal({} as never, port, { project: project({ role: 'member' }) });
    document.body.appendChild(modal.contentEl);
    try {
      modal.onOpen(); await flush();
      const ui = within(modal.contentEl);
      if (phase === 'retry') fireEvent.click(ui.getByRole('button', { name: 'Retry' }));
      fireEvent.click(ui.getByRole('button', { name: 'Leave project' }));
      expect((ui.getByRole('radio', { name: 'Keep files' }) as HTMLInputElement).checked).toBe(true);
      fireEvent.click(ui.getByRole('button', { name: 'Confirm' })); await flush();
      expect(port.leaveProject.mock.calls[0]?.[0]).toEqual({ projectId: 'project-alpha', cleanupChoice: 'keep-files' });
    } finally { release(offline); modal.onClose(); modal.contentEl.remove(); await flush(); }
  });

  it('identifies the Project and groups management into named sections', async () => {
    const port = createPort([member('member-manager', 'Alice', { role: 'manager' })]);
    const modal = new ProjectManagementModal({} as never, port, { project: project() });
    document.body.appendChild(modal.contentEl);
    modal.onOpen();
    await flush();
    const ui = within(modal.contentEl);
    expect(ui.getByRole('heading', { level: 2, name: 'Alpha' })).not.toBeNull();
    expect(ui.getByText('workspace/alpha')).not.toBeNull();
    expect(ui.getByText('1 member')).not.toBeNull();
    expect(within(ui.getByRole('region', { name: 'Members' }))
      .getByRole('button', { name: 'Create invitation' })).not.toBeNull();
    expect(within(ui.getByRole('region', { name: 'Hosting' }))
      .getByRole('button', { name: 'Move to Cloud' })).not.toBeNull();
    expect(within(ui.getByRole('region', { name: 'Project actions' }))
      .getByRole('button', { name: 'Leave project' })).not.toBeNull();
    expect(await axe(modal.contentEl)).toHaveNoViolations();
    modal.onClose();
    modal.contentEl.remove();
  });

  it.each(['Leave project', 'Retire project'])(
    'shows the %s confirmation below the Project actions controls', async action => {
      const port = createPort([member('member-manager', 'Alice', { role: 'manager' })]);
      const modal = new ProjectManagementModal({} as never, port, { project: project() });
      document.body.appendChild(modal.contentEl);
      modal.onOpen();
      await flush();
      const ui = within(modal.contentEl);
      fireEvent.click(ui.getByRole('button', { name: action }));
      const actions = within(ui.getByRole('region', { name: 'Project actions' }));
      const confirm = actions.getByRole('button', { name: 'Confirm' });
      const retire = actions.getByRole('button', { name: 'Retire project' });
      expect(retire.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(await axe(modal.contentEl)).toHaveNoViolations();
      fireEvent.click(actions.getByRole('button', { name: 'Cancel' }));
      expect(ui.queryByRole('button', { name: 'Confirm' })).toBeNull();
      expect(port.leaveProject).not.toHaveBeenCalled();
      expect(port.retireProject).not.toHaveBeenCalled();
      modal.onClose();
      modal.contentEl.remove();
    },
  );

  it('expands the Cloud move form on request and preserves its draft when collapsed', async () => {
    const port = createPort([member('member-manager', 'Alice', { role: 'manager' })]);
    const modal = new ProjectManagementModal({} as never, port, { project: project() });
    modal.onOpen();
    await flush();
    document.body.appendChild(modal.contentEl);
    const ui = within(modal.contentEl);
    const toggle = ui.getByRole('button', { name: 'Move to Cloud' });
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(ui.queryByRole('textbox', { name: 'Cloud server URL' })).toBeNull();
    fireEvent.click(toggle);
    const input = ui.getByRole('textbox', { name: 'Cloud server URL' });
    fireEvent.input(input, { target: { value: 'https://cloud.example.test/' } });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(ui.queryByRole('textbox', { name: 'Cloud server URL' })).toBeNull();
    fireEvent.click(toggle);
    expect((ui.getByRole('textbox', { name: 'Cloud server URL' }) as HTMLInputElement).value)
      .toBe('https://cloud.example.test/');
    expect(await axe(modal.contentEl)).toHaveNoViolations();
    modal.onClose();
    modal.contentEl.remove();
  });

  it.each(['lan', 'cloud'] as const)('explains immediate local Leave and deferred remote settlement while %s is offline', async authorityKind => {
    const offline = { status: 'failure' as const, error: new CollabError({ code: 'endpoint-unreachable' }) };
    const port = createPort([], {
      readSnapshot: jest.fn().mockResolvedValue(offline),
      readProjectCapabilities: jest.fn().mockResolvedValue(offline),
    });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ authorityKind, connectionStatus: 'offline', role: 'member' }),
    });
    document.body.appendChild(modal.contentEl);
    try {
      modal.onOpen(); await flush();
      const ui = within(modal.contentEl);
      fireEvent.click(ui.getByRole('button', { name: 'Leave project' }));
      expect(ui.getByText(authorityKind === 'lan'
        ? 'You are offline. You will leave this Project locally now. Your departure will be synced when this device reconnects to the Host.'
        : 'You are offline. You will leave this Project locally now. Your departure will be synced when this device reconnects to the server.')).not.toBeNull();
      expect((ui.getByRole('radio', { name: 'Keep files' }) as HTMLInputElement).checked).toBe(true);
      const deleteChoice = ui.getByRole('radio', { name: 'Delete files' });
      fireEvent.click(deleteChoice);
      fireEvent.change(deleteChoice, { target: { checked: true } });
      expect(ui.getByText('Local files will be deleted immediately.')).not.toBeNull();
      expect(await axe(modal.contentEl)).toHaveNoViolations();
      fireEvent.click(ui.getByRole('button', { name: 'Confirm' })); await flush();
      expect(port.leaveProject.mock.calls[0]?.[0]).toEqual({ projectId: 'project-alpha', cleanupChoice: 'delete-files' });
    } finally { modal.onClose(); modal.contentEl.remove(); }
  });

  it.each([
    { role: 'manager' as const },
    { role: 'member' as const, hostInstallationStatus: 'hosted-here' as const, hostStatus: 'stopped' as const },
    { role: 'member' as const, hostInstallationStatus: 'hosted-elsewhere' as const },
  ])('keeps offline responsibility holders out of local Leave: %j', async overrides => {
    const offline = { status: 'failure' as const, error: new CollabError({ code: 'endpoint-unreachable' }) };
    const port = createPort([], { readSnapshot: jest.fn().mockResolvedValue(offline), readProjectCapabilities: jest.fn().mockResolvedValue(offline) });
    const modal = new ProjectManagementModal({} as never, port, { project: project(overrides) });
    document.body.appendChild(modal.contentEl);
    try { modal.onOpen(); await flush(); expect(within(modal.contentEl).queryByRole('button', { name: 'Leave project' })).toBeNull(); }
    finally { modal.onClose(); modal.contentEl.remove(); }
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

  it('renders negotiated Cloud lifecycle and membership actions', async () => {
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
        managerResponsibility: true, managerPromotion: true,
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

    modal.close();
  });

  it('redacts a retained member claim when its secret availability expires', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.parse('2026-09-02T00:00:00.000Z'));
      const members = [member('member-manager', 'Alice', { role: 'manager' })];
      const port = createPort(members, {
        readManagementOperation: jest.fn().mockResolvedValue(success({
          action: 'reissue-member-claim',
          completionId: 'completion-expiring-claim',
          invitation: {
            encodedInvitation: 'claudian-cloud-claim:v1:expiring-secret',
            expiresAt: testTime({ days: 14 }),
          },
          secretAvailableUntil: '2026-09-02T00:00:01.000Z',
          status: 'result-retained',
        })),
        readProjectCapabilities: jest.fn().mockResolvedValue(success({
          authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: true,
          invitations: true, leave: true, managerResponsibility: true, managerPromotion: true,
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
      expect(within(modal.contentEl).getByRole('button', { name: 'Copy membership claim' })).not.toBeNull();

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

  it.each([500, 1_000])('revalidates a retained member claim before copying at %s ms', async elapsed => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.parse('2026-09-02T00:00:00.000Z'));
      const members = [member('member-manager', 'Alice', { role: 'manager' })];
      const retained = {
        action: 'reissue-member-claim' as const,
        completionId: 'completion-claim-revalidation',
        invitation: {
          encodedInvitation: 'claudian-cloud-claim:v1:stale-secret',
          expiresAt: testTime({ days: 14 }),
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
          invitations: true, leave: true, managerResponsibility: true, managerPromotion: true,
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
      jest.setSystemTime(Date.parse('2026-09-02T00:00:00.000Z') + elapsed);
      modal.contentEl.querySelector<HTMLButtonElement>(
        '[data-action="copy-member-claim"]',
      )?.click();
      await flush();

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
        invitations: false, leave: false, managerResponsibility: true, managerPromotion: true,
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
    const port = createPort(members, {
      proposeLanToCloudTransfer: jest.fn().mockResolvedValue(success({
        phase: 'collecting-readiness', state: 'active', transferId: 'transfer-member-request',
      } as never)),
    }, {
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
    expect(port.acceptLanToCloudTransfer).not.toHaveBeenCalled();
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

  it.each(['lan', 'cloud'] as const)('follows %s connection changes when displaying link recovery', async authorityKind => {
    const summary = project({ authorityKind, role: 'member', connectionStatus: 'offline' });
    const failure = { status: 'failure' as const, error: new CollabError({ code: 'endpoint-unreachable' }) };
    const port = createPort([], {
      readSnapshot: jest.fn().mockResolvedValue(failure),
      readProjectCapabilities: jest.fn().mockResolvedValue(failure),
    });
    const onReconnect = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, { project: summary, onReconnect });
    const style = document.createElement('style');
    style.textContent = 'button { display: flex; }\n' + readFileSync(
      resolve(process.cwd(), 'src/style/features/collab-access.css'), 'utf8',
    );
    document.head.appendChild(style);
    document.body.appendChild(modal.contentEl);
    try {
      modal.onOpen();
      await flush();
      const view = within(modal.contentEl);
      const name = 'Use a link to restore connection';
      const recovery = view.getByRole('button', { name });
      expect(getComputedStyle(recovery).display).toBe('flex');

      const publishConnection = (connectionStatus: CollabLocalProjectSummary['connectionStatus']) => {
        port.subscribe.mock.calls[0][0]({
          lifecycle: 'ready', selectedProjectId: summary.id,
          projects: [{ ...summary, connectionStatus }],
        } as CollabFeatureState);
      };
      publishConnection('connected');
      await flush();
      expect(view.queryByRole('button', { name })).toBeNull();
      expect(getComputedStyle(recovery).display).toBe('none');

      publishConnection('offline');
      await flush();
      expect(getComputedStyle(recovery).display).toBe('flex');
      fireEvent.click(view.getByRole('button', { name }));
      expect(onReconnect).toHaveBeenCalledWith(expect.objectContaining({
        id: summary.id, authorityKind, connectionStatus: 'offline',
      }));
    } finally {
      modal.onClose();
      modal.contentEl.remove();
      style.remove();
    }
  });

  it('keeps recovery navigation available when a migrated Project no longer loads members', async () => {
    const failure = { status: 'failure' as const, error: new CollabError({ code: 'project-not-found' }) };
    const summary = project({ role: 'member', connectionStatus: 'needs-attention' });
    const port = createPort([], {
      readSnapshot: jest.fn().mockResolvedValue(failure),
      readProjectCapabilities: jest.fn().mockResolvedValue(failure),
      readLanToCloudTransfer: jest.fn().mockResolvedValue(success({
        proposedByMemberId: 'member-maya', serverUrl: 'https://cloud.example', sourceOwned: false,
        status: { phase: 'collecting-readiness', state: 'active' } as never,
      })),
    });
    let openedProject: CollabLocalProjectSummary | undefined;
    let wasClosed = false;
    const options = {
      project: summary,
      onClosed: () => { wasClosed = true; },
      onReconnect: (selected: CollabLocalProjectSummary) => {
        expect(wasClosed).toBe(true);
        openedProject = selected;
      },
    };
    const modal = new ProjectManagementModal({} as never, port, options);
    modal.onOpen();
    await flush();
    within(modal.contentEl).getByText('Members could not be loaded.');
    const recovery = within(modal.contentEl).getByRole('button', { name: 'Use a link to restore connection' });
    expect(recovery.hasAttribute('disabled')).toBe(false);
    fireEvent.click(recovery);
    expect(openedProject?.id).toBe(summary.id);
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
    within(modal.contentEl).getByRole('button', { name: 'Retry move to Cloud' }).click();
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

  it.each([
    ['member-manager', 'Retry move to Cloud'],
    ['member-other', 'Accept move to Cloud'],
  ])('binds %s LAN-to-Cloud actions to the saved transfer on reopen', async (proposedByMemberId, label) => {
    const members = [
      member('member-manager', 'Alice', { role: 'manager' }),
      member('member-other', 'Maya'),
    ];
    const proposal = {
      proposedByMemberId,
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
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: label }));
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
          invitations: true, leave: true, managerResponsibility: true, managerPromotion: true,
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
        invitations: true, leave: true, managerResponsibility: true, managerPromotion: true,
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

    expect(within(modal.contentEl).getByText('Pending')).not.toBeNull();
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

    port.readManagementOperation.mockResolvedValue(success({
      action: 'create-invitation', completionId: 'completion-invitation',
      invitation: {
        encodedInvitation: 'claudian-cloud:v1:recovered',
        expiresAt: testTime({ days: 1467, minutes: 15 }),
      },
      secretAvailableUntil: '2030-09-02T00:15:00.000Z', status: 'result-retained',
    }));
    port.openInvitation.mockReturnValue({
      run: jest.fn().mockResolvedValue(success({
        status: 'ready', invitation: { encodedInvitation: 'claudian-cloud:v1:recovered', expiresAt: testTime({ days: 1467, minutes: 15 }) },
        availableUntil: '2030-09-02T00:15:00.000Z',
      })),
      read: jest.fn(), acknowledge: jest.fn(), dispose: jest.fn(),
    });
    invitation?.click();
    await flush();
    const child = mockModals[mockModals.length - 1];
    expect(within(child.contentEl).getByRole('button', { name: 'Copy invitation' }).textContent)
      .toBe('claudian-cloud:v1:recovered');
    expect(port.completeManagementOperation).not.toHaveBeenCalled();
    expect(port.openInvitation).toHaveBeenCalledWith({ projectId: 'project-alpha', intent: 'resume' });
    child.close();
    await flush();
    expect(within(modal.contentEl).getByRole('button', { name: 'Create invitation' }))
      .toHaveProperty('disabled', false);
    modal.close();
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

  it('moves directly to Cloud when the local Host requests the move', async () => {
    const members = [member('member-host', 'Host')];
    const port = createPort(members, {
      moveLanToCloud: jest.fn().mockResolvedValue(success({
        phase: 'completed', state: 'completed', transferId: 'transfer-proposed',
      } as never)),
    }, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, {
      onChanged,
      project: project({
        connectionStatus: 'connected',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'running',
        role: 'member',
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

    expect(port.moveLanToCloud).toHaveBeenCalledWith({
      projectId: 'project-alpha', serverUrl: 'https://cloud.example.test/',
    });
    expect(modal.close).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps the exact Host move available for retry after automatic acceptance fails', async () => {
    const port = createPort([member('member-host', 'Host')], {
      moveLanToCloud: jest.fn().mockResolvedValue({
        error: new CollabError({ code: 'endpoint-unreachable' }), status: 'failure',
      }),
      readLanToCloudTransfer: jest.fn().mockResolvedValueOnce(success(null)).mockResolvedValue(success({
        proposedByMemberId: 'member-host', serverUrl: 'https://cloud.example.test/', sourceOwned: true,
        status: { phase: 'collecting-readiness', state: 'active', transferId: 'transfer-host-retry' },
      } as never)),
      acceptLanToCloudTransfer: jest.fn().mockResolvedValue(success({
          phase: 'completed', state: 'completed', transferId: 'transfer-host-retry',
        } as never)),
    }, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected', hostInstallationStatus: 'hosted-here', hostStatus: 'running' }),
    });
    document.body.appendChild(modal.contentEl);
    modal.onOpen();
    await flush();
    const ui = within(modal.contentEl);
    fireEvent.click(ui.getByRole('button', { name: 'Move to Cloud' }));
    fireEvent.input(ui.getByRole('textbox', { name: 'Cloud server URL' }), {
      target: { value: 'https://cloud.example.test/' },
    });
    fireEvent.click(within(modal.contentEl.querySelector('#claudian-collab-transfer-form')!).getByRole('button', { name: 'Move to Cloud' }));
    await flush();
    expect(port.moveLanToCloud).toHaveBeenCalledWith({
      projectId: 'project-alpha', serverUrl: 'https://cloud.example.test/',
    });
    expect(ui.getByRole('alert').textContent).toContain('You can retry safely.');
    expect(ui.getByRole('button', { name: 'Retry move to Cloud' })).toHaveProperty('disabled', false);
    expect(modal.close).not.toHaveBeenCalled();
    fireEvent.click(ui.getByRole('button', { name: 'Retry move to Cloud' }));
    await flush();
    expect(port.acceptLanToCloudTransfer).toHaveBeenLastCalledWith({
      projectId: 'project-alpha', transferId: 'transfer-host-retry',
    });
    expect(modal.close).toHaveBeenCalled();
    modal.onClose();
    modal.contentEl.remove();
  });

  it('does not reopen the initiating modal when its application-owned Host move settles after close', async () => {
    let finishMove!: (value: ReturnType<typeof success<never>>) => void;
    const port = createPort([member('member-host', 'Host')], {
      moveLanToCloud: jest.fn().mockImplementation(() => new Promise(resolve => {
        finishMove = resolve;
      })),
    }, { currentMemberId: 'member-host', hostMemberId: 'member-host' });
    const modal = new ProjectManagementModal({} as never, port, {
      project: project({ connectionStatus: 'connected', hostInstallationStatus: 'hosted-here', hostStatus: 'running' }),
    });
    document.body.appendChild(modal.contentEl);
    modal.onOpen();
    await flush();
    const ui = within(modal.contentEl);
    fireEvent.click(ui.getByRole('button', { name: 'Move to Cloud' }));
    fireEvent.input(ui.getByRole('textbox', { name: 'Cloud server URL' }), {
      target: { value: 'https://cloud.example.test/' },
    });
    fireEvent.click(within(modal.contentEl.querySelector('#claudian-collab-transfer-form')!).getByRole('button', { name: 'Move to Cloud' }));
    modal.close();
    finishMove(success({
      phase: 'completed', state: 'completed', transferId: 'transfer-after-close',
    } as never));
    await flush();
    expect(port.moveLanToCloud).toHaveBeenCalledWith({ projectId: 'project-alpha', serverUrl: 'https://cloud.example.test/' });
    expect(modal.contentEl.textContent).toBe('');
    modal.contentEl.remove();
  });

  it.each(['lan', 'cloud'] as const)('consumes terminal transfer results after %s authority publication', async authorityKind => {
    const manager = member('member-manager', 'Alice', { role: 'manager' });
    const summary = project({ authorityKind, connectionStatus: 'connected',
      hostInstallationStatus: authorityKind === 'lan' ? 'hosted-here' : 'not-host',
      hostStatus: authorityKind === 'lan' ? 'running' : 'not-host',
    });
    let publish!: (state: CollabFeatureState) => void;
    const complete = async () => {
      const target = authorityKind === 'lan' ? 'cloud' : 'lan';
      publish({ lifecycle: 'ready', selectedProjectId: summary.id, projects: [{
        ...summary, authorityKind: target,
        hostInstallationStatus: target === 'lan' ? 'hosted-here' : 'not-host',
        hostStatus: target === 'lan' ? 'running' : 'not-host',
      }] });
      return success({ phase: 'completed', state: 'completed', transferId: 'transfer-one' } as never);
    };
    const port = createPort([manager], {
      subscribe: jest.fn().mockImplementation(listener => { publish = listener; return { dispose() {} }; }),
      moveLanToCloud: jest.fn().mockImplementation(complete),
      moveCloudToLan: jest.fn().mockImplementation(complete),
      readSnapshot: jest.fn().mockResolvedValue(success({
        snapshot: { currentMember: manager, members: [manager], project: { authorityKind, hostMemberId: manager.id } },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      } as never)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({ authorityKind, authorityTransfer: true })),
    });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, { project: summary, onChanged });
    document.body.appendChild(modal.contentEl);
    modal.onOpen(); await flush();
    const title = authorityKind === 'lan' ? 'Move to Cloud' : 'Move to LAN';
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: title }));
    const input = within(modal.contentEl).queryByRole('textbox', { name: 'Cloud server URL' });
    if (input) fireEvent.input(input, { target: { value: 'https://cloud.example.test/' } });
    fireEvent.click(within(modal.contentEl.querySelector<HTMLElement>('#claudian-collab-transfer-form')!).getByRole('button', { name: title }));
    await flush();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(modal.close).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.childElementCount).toBe(0);
    modal.onClose(); modal.contentEl.remove();
  });

  it('treats a persisted cancelled Cloud move as no current move', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const port = createPort(members, {
      readLanToCloudTransfer: jest.fn().mockResolvedValue(success({
        proposedByMemberId: 'member-manager',
        serverUrl: 'http://100.89.0.41:8787',
        sourceOwned: true,
        status: {
          phase: 'cancelled',
          state: 'cancelled',
          transferId: 'transfer-cancelled',
        },
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

    document.body.appendChild(modal.contentEl);
    const hosting = modal.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-hosting',
    )!;
    expect(within(hosting).getByRole('button', { name: 'Move to Cloud' }))
      .not.toBeNull();
    expect(hosting.textContent).not.toContain('Cloud target:');
    expect(hosting.textContent).not.toContain('Cancelled');
    expect(hosting.querySelector('[data-field="lan-to-cloud-server-url"]')).not.toBeNull();
    fireEvent.click(within(hosting).getByRole('button', { name: 'Move to Cloud' }));
    const requestMove = within(hosting.querySelector('#claudian-collab-transfer-form')!).getByRole('button', {
      name: 'Move to Cloud',
    });
    expect(requestMove.classList.contains('mod-cta')).toBe(true);
    expect(requestMove.classList.contains(
      'claudian-collab-authority-transfer-submit',
    )).toBe(true);
    expect(requestMove).toHaveProperty('disabled', true);
    modal.onClose();
    modal.contentEl.remove();
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
    let observedStatus: { phase: string; state: string } | null = null;
    const port = createPort(members, {
      acceptCloudToLanTransfer: jest.fn().mockImplementation(async () => {
        observedStatus = { phase: 'source-quiesced', state: 'active' };
        return success(observedStatus as never);
      }),
      readCloudToLanTransfer: jest.fn().mockImplementation(async () => success({
        manager: null,
        target: {
          canWithdraw: false,
          descriptor,
          handle: { operationIntentId: 'intent-target', transferId: 'transfer-target' },
          status: observedStatus,
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
    await waitFor(() => expect(modal.contentEl.textContent).toContain('In progress'));
    expect(modal.contentEl.querySelector('[data-action="begin-cloud-to-lan"]')).toBeNull();
  });

  it.each([false, true])('moves to this LAN device with one action and retains a failed move for retry (%s)', async retry => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const descriptor = {
      expiresAt: testTime({ days: 14 }),
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
      moveCloudToLan: jest.fn().mockResolvedValueOnce(retry
        ? { status: 'failure', error: new CollabError({ code: 'endpoint-unreachable' }) }
        : success(completedStatus)).mockResolvedValue(success(completedStatus)),
      readCloudToLanTransfer: jest.fn().mockResolvedValueOnce(success(null)).mockResolvedValue(success({
        manager: null,
        target: { canWithdraw: false, descriptor, handle, status: activeStatus },
      })),
      listManagerResponsibilityOffers: jest.fn().mockResolvedValue(success([])),
      listMembers: jest.fn().mockResolvedValue(success([{
        displayName: 'Alice', importedClaim: null, memberId: 'member-manager', role: 'manager',
      }])),
      observeCloudToLanTransfer: jest.fn().mockResolvedValue(success(activeStatus)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud',
        authorityTransfer: true,
        importedMemberClaims: false,
        invitations: false,
        leave: false,
        managerResponsibility: true, managerPromotion: true,
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

    document.body.appendChild(modal.contentEl);
    const ui = within(modal.contentEl);
    const toggle = ui.getByRole('button', { name: 'Move to LAN' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(ui.queryByRole('button', { name: 'Prepare LAN target' })).toBeNull();
    fireEvent.click(toggle);
    expect(ui.getByRole('combobox', { name: 'LAN host' })).not.toBeNull();
    expect(ui.queryByRole('textbox')).toBeNull();
    expect(ui.queryByRole('button', { name: 'Begin move to LAN' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Accept transfer on this device' })).toBeNull();
    expect(await axe(modal.contentEl)).toHaveNoViolations();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="prepare-cloud-to-lan"]',
    )?.click();
    await flush();
    expect(port.moveCloudToLan).toHaveBeenCalledWith('project-alpha');
    await waitFor(() => expect(ui.queryByRole('button', { name: 'Resume' }) !== null).toBe(retry));
    if (retry) {
      fireEvent.click(ui.getByRole('button', { name: 'Resume' }));
      await flush();
    }
    expect(port.moveCloudToLan).toHaveBeenLastCalledWith('project-alpha');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    modal.contentEl.remove();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  it('approves the Cloud-held receiving-device request by identity', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const descriptor = {
      expiresAt: testTime({ days: 14 }),
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
      readCloudToLanTransfer: jest.fn().mockResolvedValueOnce(success({ manager: null, target: null, preparations: [{ preparationId: 'preparation-one', targetMemberId: 'member-manager' }] })).mockResolvedValue(success({
        manager: { descriptor, handle, status: null }, target: null,
      })),
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
        managerResponsibility: true, managerPromotion: true,
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
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new ProjectManagementModal({} as never, port, {
      copyText,
      onChanged,
      project: project({ authorityKind: 'cloud', connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();
    await flush();

    document.body.appendChild(modal.contentEl);
    const ui = within(modal.contentEl);
    fireEvent.click(ui.getByRole('button', { name: 'Begin move to LAN' }));
    await flush();
    expect(port.beginCloudToLanTransfer).toHaveBeenCalledWith({ projectId: 'project-alpha', preparationId: 'preparation-one' });
    expect(ui.getByText('Approved. The receiving device will continue automatically, or its user can select Resume.')).not.toBeNull();
    expect(await axe(modal.contentEl)).toHaveNoViolations();
    modal.onClose();
    modal.contentEl.remove();
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
        invitations: false, leave: false, managerResponsibility: true, managerPromotion: true,
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

  it('keeps pending recovery available while a background management read is pending', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const summary = project({ authorityKind: 'cloud', connectionStatus: 'offline' });
    const offline = { status: 'failure' as const, error: new CollabError({ code: 'endpoint-unreachable' }) };
    let finish!: (result: Awaited<ReturnType<ProjectManagementModalPort['readSnapshot']>>) => void;
    const port = createPort(members, {
      readSnapshot: jest.fn().mockResolvedValue(offline),
      readProjectCapabilities: jest.fn().mockResolvedValue(offline),
      readCloudToLanTransfer: jest.fn().mockResolvedValue(success({
        manager: null,
        target: { canWithdraw: true, descriptor: { preparationId: 'preparation-one' }, handle: null, status: null },
      } as never)),
    });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    document.body.appendChild(modal.contentEl);
    try {
      modal.onOpen(); await flush();
      const ui = within(modal.contentEl);
      expect(ui.getByRole('button', { name: 'Resume' })).toBeDefined();
      port.readSnapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      port.observeProject.mock.calls[0]?.[1]();
      await flush();
      expect(ui.getByRole('button', { name: 'Resume' })).toBeDefined();
      finish(offline); await flush();
      fireEvent.click(ui.getByRole('button', { name: 'Resume' })); await flush();
      expect(port.prepareCloudToLanTarget).toHaveBeenCalledWith({ projectId: summary.id });
    } finally { modal.onClose(); modal.contentEl.remove(); }
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
        invitations: true, leave: true, managerResponsibility: true, managerPromotion: true,
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
        invitations: true, leave: true, managerResponsibility: true, managerPromotion: true,
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

  it('publishes refreshed Cloud management as a complete bundle', async () => {
    const original = member('member-manager', 'Original manager', { role: 'manager' });
    const replacement = member('member-manager', 'Replacement manager', { role: 'manager' });
    const summary = project({ authorityKind: 'cloud', connectionStatus: 'connected' });
    let finish!: (result: Awaited<ReturnType<ProjectManagementModalPort['listMembers']>>) => void;
    const snapshot = (current: CollabMember) => success({
      snapshot: { currentMember: current, members: [current], project: { authorityKind: 'cloud' } },
      source: 'online', stale: false, syncState: { status: 'synchronized' },
    } as never);
    const port = createPort([original], {
      readSnapshot: jest.fn().mockResolvedValue(snapshot(original)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', authorityTransfer: true, membershipManagement: true,
      })),
    });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    modal.onOpen(); await flush();
    port.readSnapshot.mockResolvedValue(snapshot(replacement));
    port.listMembers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    port.observeProject.mock.calls[0]?.[1]();
    await flush();
    // Another publication can render the current view while the richer member read is pending.
    port.observeProject.mock.calls[0]?.[1]();
    expect(within(modal.contentEl).getByText('Original manager')).not.toBeNull();
    expect(within(modal.contentEl).queryByText('Replacement manager')).toBeNull();
    finish(success([])); await flush();
    expect(within(modal.contentEl).getByText('Replacement manager')).not.toBeNull();
    modal.onClose();
  });

  it.each(['success', 'failure'] as const)('discards old actor confirmation before pending Cloud member read ends with %s', async outcome => {
    const original = member('member-manager', 'Original manager', { role: 'manager' });
    const replacement = member('member-replacement', 'Replacement manager', { role: 'manager' });
    const other = member('member-other', 'Other');
    const summary = project({ authorityKind: 'cloud', connectionStatus: 'connected' });
    let finish!: (result: Awaited<ReturnType<ProjectManagementModalPort['listMembers']>>) => void;
    const snapshot = (current: CollabMember) => success({
      snapshot: { currentMember: current, members: [current, other], project: { authorityKind: 'cloud' } },
      source: 'online', stale: false, syncState: { status: 'synchronized' },
    } as never);
    const port = createPort([original, other], {
      readSnapshot: jest.fn().mockResolvedValue(snapshot(original)),
      readProjectCapabilities: jest.fn().mockResolvedValue(success({
        authorityKind: 'cloud', membershipManagement: true,
      })),
    });
    const modal = new ProjectManagementModal({} as never, port, { project: summary });
    modal.onOpen(); await flush();
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Remove: Other' }));
    expect(within(modal.contentEl).getByRole('button', { name: 'Confirm' })).not.toBeNull();
    port.readSnapshot.mockResolvedValue(snapshot(replacement));
    port.listMembers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    port.observeProject.mock.calls[0]?.[1]();
    await flush();
    expect(within(modal.contentEl).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(within(modal.contentEl).queryByRole('button', { name: 'Remove: Other' })).toBeNull();
    finish(outcome === 'success' ? success([]) : {
      status: 'failure', error: new CollabError({ code: 'operation-failed' }),
    });
    await flush();
    expect(within(modal.contentEl).queryByRole('button', { name: 'Confirm' })).toBeNull();
    if (outcome === 'success') {
      fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Remove: Other' }));
      fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Confirm' }));
      await flush();
    }
    expect(port.removeMember).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    modal.onClose();
  });

  it('replays invalidation deferred during a failed management command', async () => {
    const manager = member('member-manager', 'Alice', { role: 'manager' });
    const other = member('member-other', 'Other');
    let finish!: (result: Awaited<ReturnType<ProjectManagementModalPort['removeMember']>>) => void;
    const port = createPort([manager, other], {
      removeMember: jest.fn<ReturnType<ProjectManagementModalPort['removeMember']>, Parameters<ProjectManagementModalPort['removeMember']>>(() => new Promise(resolve => { finish = resolve; })),
    });
    const modal = new ProjectManagementModal({} as never, port, { project: project() });
    modal.onOpen(); await flush();
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Remove: Other' }));
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Confirm' }));
    await flush();
    const updated = { ...manager, displayName: 'Updated manager' };
    port.readSnapshot.mockResolvedValue(success({
      snapshot: { currentMember: updated, members: [updated, other], project: { authorityKind: 'lan', hostMemberId: 'member-host' } },
      source: 'online', stale: false, syncState: { status: 'synchronized' },
    } as never));
    port.observeProject.mock.calls[0]?.[1]();
    finish({ status: 'failure', error: new CollabError({ code: 'operation-failed' }) });
    await flush();
    expect(within(modal.contentEl).getByText('Updated manager')).not.toBeNull();
    modal.onClose();
  });

  it('refreshes members on project invalidation without changing the local summary', async () => {
    const original = member('member-manager', 'Alice', { role: 'manager' });
    const port = createPort([original], {
    });
    const modal = new ProjectManagementModal({} as never, port, { project: project() });
    modal.onOpen(); await flush();
    const updated = { ...original, displayName: 'Updated member' };
    port.readSnapshot.mockResolvedValue(success({
      snapshot: { currentMember: updated, members: [updated], project: { authorityKind: 'lan', hostMemberId: 'member-host' } },
      source: 'online', stale: false, syncState: { status: 'synchronized' },
    } as never));
    port.observeProject.mock.calls[0]?.[1]();
    await flush();
    expect(within(modal.contentEl).getByText('Updated member')).not.toBeNull();
    modal.onClose();
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
      `${child.tagName}:${child.className}`
    ))).toEqual([
      'H3:',
      'DIV:claudian-collab-project-actions-lifecycle',
    ]);
    expect(Array.from(projectActions?.querySelectorAll('button') ?? []).map(button => (
      button.getAttribute('data-action')
    ))).toEqual(['leave-project', 'retire-project']);
    expect(modal.contentEl.querySelector(
      '.claudian-collab-access-members [data-action="create-invitation"]',
    )).not.toBeNull();
    expect(modal.contentEl.querySelector(
      '[data-member-id="member-manager"] [data-action="leave-project"]',
    )).toBeNull();

    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="create-invitation"]',
    )?.click();
    await flush();
    expect(port.openInvitation).toHaveBeenCalledWith({ projectId: 'project-alpha', intent: 'create' });
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
    expect(port.promoteManager).toHaveBeenCalledWith({
      projectId: 'project-alpha',
      targetMemberId: 'member-maya',
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
        expiresAt: testTime({ days: 14 }),
        offerId: 'offer-unrelated',
        offeredAt: CREATED_AT,
        purpose: 'manager-promotion' as const,
        sourceManagerMemberId: 'member-other-manager',
        status: 'offered' as const,
        targetMemberId: 'member-noah',
      },
      {
        expiresAt: testTime({ days: 14 }),
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
        invitations: false, leave: false, managerResponsibility: true, managerPromotion: true,
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
      '[data-action="make-manager"][data-member-id="member-maya"]',
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
        invitations: false, leave: false, managerResponsibility: true, managerPromotion: true,
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



  it('retries direct promotion after its updated role appears in the snapshot', async () => {
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

    expect(port.promoteManager).toHaveBeenCalledTimes(2);
    expect(port.promoteManager.mock.calls[1]?.[0]).toEqual({
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
      '.claudian-collab-hosting [data-action="start-host"]',
    )).not.toBeNull();
    expect(Array.from(modal.contentEl.querySelectorAll(
      '.claudian-collab-project-actions button',
    )).map(button => button.getAttribute('data-action'))).toEqual([
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

  it('groups invitation, Hosting, and Project actions by their user intent', async () => {
    const host = member('member-host', 'Host operator', { role: 'manager' });
    const modal = new ProjectManagementModal({} as never, createPort(
      [host],
      {},
      { currentMemberId: host.id, hostMemberId: host.id },
    ), {
      project: project({
        connectionStatus: 'connected',
        hostInstallationStatus: 'hosted-here',
        hostStatus: 'running',
      }),
    });

    modal.onOpen();
    await flush();

    const members = modal.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-access-members',
    )!;
    expect(within(members).getByRole('heading', { level: 3, name: 'Members' }))
      .not.toBeNull();
    expect(within(members).getByRole('button', { name: 'Create invitation' }))
      .toHaveProperty('className', 'mod-cta');

    const hosting = modal.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-hosting',
    )!;
    expect(within(hosting).getByRole('heading', { level: 3, name: 'Hosting' }))
      .not.toBeNull();
    expect(within(hosting).getByText('LAN Host (on this device)')).not.toBeNull();
    expect(within(hosting).getByRole('button', { name: 'Move to Cloud' }))
      .not.toBeNull();
    expect(hosting.textContent).not.toContain('authority');

    const projectActions = modal.contentEl.querySelector<HTMLElement>(
      '.claudian-collab-project-actions',
    )!;
    expect(within(projectActions).getByRole('heading', {
      level: 3,
      name: 'Project actions',
    })).not.toBeNull();
    expect(within(projectActions).getByRole('button', { name: 'Leave project' }))
      .toHaveProperty('className', 'mod-cta');
    expect(within(projectActions).getByRole('button', { name: 'Retire project' }))
      .toHaveProperty('className', 'mod-warning');
    expect(projectActions.querySelector('[data-action="create-invitation"]')).toBeNull();
    expect(projectActions.querySelector('[data-action="stop-host"]')).toBeNull();
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
    expect(host?.textContent).toContain('LAN Host (on another device)');
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
      '.claudian-collab-hosting [data-action="host-diagnostics"]',
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
      project: project({ hostInstallationStatus: 'hosted-here', hostStatus: 'stopped', role: 'member' }),
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
    expect(hostModal.contentEl.querySelector('[data-action="select-host-destination"]'))
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
    await flush();

    modal.onClose();
    finish(success({} as CollabCoordinationSnapshot));
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('ignores a completed mutation from a closed management session after reopening', async () => {
    let finish!: (result: ReturnType<typeof success<void>>) => void;
    const manager = member('member-manager', 'Alice', { role: 'manager' });
    const other = member('member-other', 'Other');
    const port = createPort([manager, other], {
      removeMember: jest.fn<ReturnType<ProjectManagementModalPort['removeMember']>, Parameters<ProjectManagementModalPort['removeMember']>>(() => new Promise(resolve => { finish = resolve; })),
    });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, { project: project(), onChanged });
    modal.onOpen(); await flush();
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Remove: Other' }));
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Confirm' }));
    await flush();
    modal.onClose(); modal.onOpen(); await flush();
    finish(success(undefined)); await flush();
    expect(onChanged).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).not.toContain('Action complete');
    modal.onClose();
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

  it('shows the offered target Host Accept and Decline in Hosting', async () => {
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
            expiresAt: testTime({ days: -14, hours: 1 }),
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

    const hosting = within(modal.contentEl).getByRole('region', { name: 'Hosting' });
    expect(within(hosting).getByRole('button', { name: 'Accept Host' })).not.toBeNull();
    fireEvent.click(within(hosting).getByRole('button', { name: 'Decline' }));
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
            expiresAt: testTime({ days: -14, hours: 1 }),
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

  it('restores Retire controls after a rejected invocation and permits an explicit retry', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    const port = createPort(members, {
      retireProject: jest.fn()
        .mockRejectedValueOnce(new CollabError({ code: 'project-retired' }))
        .mockResolvedValue(success(undefined)),
    });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, {
      onChanged,
      project: project({ connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();

    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Retire project' }));
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Confirm' }));
    await flush();

    expect(within(modal.contentEl).getByRole('alert')).toBeTruthy();
    const retry = within(modal.contentEl).getByRole<HTMLButtonElement>('button', { name: 'Retry' });
    expect(retry.disabled).toBe(false);
    expect(within(modal.contentEl).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled)
      .toBe(false);
    expect(await axe(modal.contentEl)).toHaveNoViolations();
    fireEvent.click(retry);
    await flush();

    expect(modal.close).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('ignores a rejected Retire after the modal closes', async () => {
    const members = [member('member-manager', 'Alice', { role: 'manager' })];
    let reject!: (error: Error) => void;
    const port = createPort(members, {
      retireProject: jest.fn((_request, _options) => new Promise((_resolve, fail) => { reject = fail; })),
    });
    const onChanged = jest.fn();
    const modal = new ProjectManagementModal({} as never, port, {
      onChanged,
      project: project({ connectionStatus: 'connected' }),
    });
    modal.onOpen();
    await flush();
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Retire project' }));
    fireEvent.click(within(modal.contentEl).getByRole('button', { name: 'Confirm' }));
    modal.onClose();
    reject(new CollabError({ code: 'project-retired' }));
    await flush();

    expect(modal.contentEl.childElementCount).toBe(0);
    expect(onChanged).not.toHaveBeenCalled();
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
      '[data-action="make-manager"]',
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

 it('updates members from project events without a local project summary change', async () => {
  const members = [member('member-manager', 'Alice', { role: 'manager' }), member('member-host', 'Bob')];
  let publish: Parameters<ProjectManagementModalPort['subscribe']>[0] | undefined;
  let changed: Parameters<ProjectManagementModalPort['observeProject']>[1] | undefined;
  const port = createPort(members, {
    subscribe: jest.fn().mockImplementation(listener => { publish = listener; return { dispose() {} }; }),
    observeProject: jest.fn().mockImplementation((_id, listener) => {
      changed = listener;
      return { dispose: jest.fn() };
    }),
  });
  const modal = new ProjectManagementModal({} as never, port, { project: project({ connectionStatus: 'connected' }) });
  modal.onOpen();
  await flush();
  const before = await port.readSnapshot('project-alpha');
  if (before.status !== 'success') throw new Error('Missing snapshot');
  port.readSnapshot.mockResolvedValue(success({ ...before.value, snapshot: {
    ...before.value.snapshot, members: [...members, member('member-new', 'New teammate')],
  } }));
  publish?.({ lifecycle: 'ready', projects: [project({ connectionStatus: 'connected' })], selectedProjectId: 'project-alpha' });
  await flush();
  expect(within(modal.contentEl).queryByText('New teammate')).toBeNull();
  changed?.(undefined, { members: true });
  await flush();
  expect(within(modal.contentEl).getByText('New teammate')).toBeTruthy();
  modal.close();
});
