/** @jest-environment jsdom */

import { testTime } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
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

import type { CollabInvitationOperation, CollabInvitationState } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { ProjectInvitationModal } from '@/features/collab/modals/project/ProjectInvitationModal';

const axe = configureAxe({ rules: { region: { enabled: false } } });
const invitation = { encodedInvitation: 'invitation-string', expiresAt: testTime({ days: 6, minutes: 15 }) };
const ready: CollabInvitationState = { status: 'ready', invitation, availableUntil: invitation.expiresAt };
const failure = { status: 'failure' as const, error: new CollabError({ code: 'offline' }) };
function success<T>(value: T) { return { status: 'success' as const, value }; }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function operation(): jest.Mocked<CollabInvitationOperation> {
  return {
    run: jest.fn().mockResolvedValue(success(ready)),
    read: jest.fn().mockResolvedValue(success(ready)),
    acknowledge: jest.fn().mockResolvedValue(success(undefined)),
    dispose: jest.fn(),
  };
}
function open(intent: 'create' | 'resume' = 'create', current = operation()) {
  const port = { openInvitation: jest.fn().mockReturnValue(current) };
  const copyText = jest.fn().mockResolvedValue(undefined);
  const modal = new ProjectInvitationModal({} as never, port, { projectId: 'project-alpha', intent, copyText });
  modal.open();
  return { modal, port, current, copyText, ui: within(modal.contentEl) };
}

beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(Date.parse(testTime({ days: 6 }))); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('ProjectInvitationModal', () => {
  it.each(['create', 'resume'] as const)('opens the application %s operation and renders a copyable link', async intent => {
    const { modal, port, current, copyText, ui } = open(intent);
    await flush();
    expect(port.openInvitation).toHaveBeenCalledWith({ projectId: 'project-alpha', intent });
    const button = ui.getByRole('button', { name: 'Copy invitation' });
    expect(button.textContent).toBe(invitation.encodedInvitation);
    expect(button.getAttribute('type')).toBe('button');
    expect(ui.getByText('This link will expire in 15 min.')).not.toBeNull();
    fireEvent.click(button);
    await flush();
    expect(copyText).toHaveBeenCalledWith(invitation.encodedInvitation);
    expect(current.acknowledge).toHaveBeenCalled();
    expect(ui.getByRole('button', { name: 'Copy invitation' }).textContent).toBe(invitation.encodedInvitation);
    expect(await axe(modal.contentEl)).toHaveNoViolations();
    modal.close();
    expect(current.dispose).toHaveBeenCalled();
  });

  it('retries through the same application operation', async () => {
    const current = operation();
    current.run.mockResolvedValueOnce(failure);
    const { modal, port, ui } = open('create', current);
    await flush();
    expect(ui.getByRole('alert')).not.toBeNull();
    fireEvent.click(ui.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(ui.getByRole('button', { name: 'Copy invitation' }).textContent).toBe(invitation.encodedInvitation);
    expect(port.openInvitation).toHaveBeenCalledTimes(1);
    modal.close();
  });

  it('requires a successful clipboard write before acknowledging', async () => {
    const { modal, current, copyText, ui } = open();
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await flush();
    fireEvent.click(ui.getByRole('button', { name: 'Copy invitation' }));
    await flush();
    expect(ui.getByRole('alert').textContent).toBe('The invitation could not be copied.');
    expect(current.acknowledge).not.toHaveBeenCalled();
    fireEvent.click(ui.getByRole('button', { name: 'Copy invitation' }));
    await flush();
    expect(current.acknowledge).toHaveBeenCalled();
    modal.close();
  });

  it('honors application revalidation before touching the clipboard', async () => {
    const { modal, current, copyText, ui } = open();
    current.read.mockResolvedValue(success({ status: 'unavailable', reason: 'unavailable' }));
    await flush();
    fireEvent.click(ui.getByRole('button', { name: 'Copy invitation' }));
    await flush();
    expect(copyText).not.toHaveBeenCalled();
    expect(current.acknowledge).not.toHaveBeenCalled();
    expect(ui.getByText('This invitation is no longer available.')).not.toBeNull();
    modal.close();
  });

  it('shows acknowledgement failures without removing the link', async () => {
    const { modal, current, ui } = open();
    current.acknowledge.mockResolvedValue(failure);
    await flush();
    fireEvent.click(ui.getByRole('button', { name: 'Copy invitation' }));
    await flush();
    expect(ui.getByRole('alert')).not.toBeNull();
    expect(ui.getByRole('button', { name: 'Copy invitation' })).not.toBeNull();
    modal.close();
  });

  it('redacts the link after a failed revalidation and makes retry reachable', async () => {
    const { modal, current, copyText, ui } = open();
    current.read.mockResolvedValue(failure);
    await flush();
    fireEvent.click(ui.getByRole('button', { name: 'Copy invitation' }));
    await flush();
    expect(copyText).not.toHaveBeenCalled();
    expect(ui.getByRole('button', { name: 'Retry' })).not.toBeNull();
    modal.close();
  });

  it('updates expiry and opens a new Create operation only on an explicit click', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse(testTime({ days: 6 })));
    const { modal, port, current, ui } = open();
    await flush();
    jest.advanceTimersByTime(60_000);
    expect(ui.getByText('This link will expire in 14 min.')).not.toBeNull();
    jest.advanceTimersByTime(14 * 60_000);
    expect(ui.getByText('This link has expired.')).not.toBeNull();
    expect(port.openInvitation).toHaveBeenCalledTimes(1);
    const next = operation();
    next.run.mockResolvedValue(success({
      status: 'ready', availableUntil: testTime({ days: 6, minutes: 30 }),
      invitation: { encodedInvitation: 'second-link', expiresAt: testTime({ days: 6, minutes: 30 }) },
    }));
    port.openInvitation.mockReturnValue(next);
    fireEvent.click(ui.getByRole('button', { name: 'Create new invitation' }));
    await flush();
    expect(current.dispose).toHaveBeenCalled();
    expect(ui.getByRole('button', { name: 'Copy invitation' }).textContent).toBe('second-link');
    modal.close();
  });

  it('does not acknowledge after closing during a clipboard write', async () => {
    const { modal, current, copyText, ui } = open();
    let copied!: () => void;
    copyText.mockReturnValue(new Promise<void>(resolve => { copied = resolve; }));
    await flush();
    fireEvent.click(ui.getByRole('button', { name: 'Copy invitation' }));
    await flush();
    modal.close();
    copied();
    await flush();
    expect(current.acknowledge).not.toHaveBeenCalled();
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('ignores late results belonging to the previously closed operation', async () => {
    const { modal, port, ui } = open();
    modal.close();
    let finish!: (result: ReturnType<typeof success<CollabInvitationState>>) => void;
    const delayed = operation();
    delayed.run.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    port.openInvitation.mockReturnValue(delayed);
    modal.open();
    modal.close();
    const next = operation();
    next.run.mockResolvedValue(success({ ...ready, invitation: { ...invitation, encodedInvitation: 'current-link' } }));
    port.openInvitation.mockReturnValue(next);
    modal.open();
    finish(success(ready));
    await flush();
    expect(ui.getByRole('button', { name: 'Copy invitation' }).textContent).toBe('current-link');
    modal.close();
  });
});
