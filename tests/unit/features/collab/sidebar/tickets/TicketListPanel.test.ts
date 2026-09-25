/** @jest-environment jsdom */
import type { CollabTicketSummary } from '@claudian-collab/protocol';
import { testTime } from '@test/helpers/testClock';
import { within } from '@testing-library/dom';

import type { CollabFeaturePort, CollabLocalProjectSummary } from '@/core/collab';
import { TicketListPanel } from '@/features/collab/sidebar/tickets/TicketListPanel';

const CREATED_AT = testTime({ days: -17 });

describe('TicketListPanel', () => {
  it('keeps the sidebar list-only and opens create or detail in the main surface', async () => {
    const openTicket = ticket('ticket-open', 17, 'Open ticket', 'open');
    const nextOpenTicket = ticket('ticket-next', 16, 'Next open ticket', 'open');
    const closedTicket = ticket('ticket-closed', 18, 'Closed ticket', 'closed');
    const listTickets = jest.fn()
      .mockResolvedValueOnce({
        status: 'success',
        value: ticketPageRead({ nextCursor: 'next-page', tickets: [openTicket] }),
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: ticketPageRead({ tickets: [nextOpenTicket] }),
      })
      .mockResolvedValueOnce({
        status: 'success',
        value: ticketPageRead({ tickets: [closedTicket] }),
      });
    const onCreate = jest.fn();
    const onOpen = jest.fn();
    let focusedTicketId = openTicket.id;
    const focusListeners = new Set<() => void>();
    const disposeFocus = jest.fn();
    const root = document.createElement('div');
    const panel = new TicketListPanel(root, {
      focus: {
        read: () => ({ projectId: 'project-a', ticketId: focusedTicketId }),
        subscribe: listener => {
          focusListeners.add(listener);
          return {
            dispose: () => {
              focusListeners.delete(listener);
              disposeFocus();
            },
          };
        },
      },
      onCreate,
      onOpen,
      port: {
        listTickets,
        readSnapshot: jest.fn().mockResolvedValue({
          status: 'success',
          value: {
            snapshot: { openTicketCount: 1 },
            source: 'online',
            stale: false,
          },
        }),
        observeProject: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      } as unknown as CollabFeaturePort,
      project: project(),
    });

    panel.setActive(true);
    await nextTurn();

    expect(root.querySelector('.claudian-collab-ticket-list-header h4')?.textContent)
      .toBe('Tickets');
    expect(root.querySelectorAll('[data-ticket-status]')).toHaveLength(1);
    expect(root.querySelector('[data-ticket-status="open"]')?.textContent).toBe('Open');
    const openRow = root.querySelector('[data-ticket-id="ticket-open"]')!;
    expect([...openRow.children].map(child => child.className)).toEqual([
      'claudian-collab-ticket-title',
      'claudian-collab-ticket-number',
    ]);
    expect(openRow.querySelector('.claudian-collab-ticket-title')?.textContent)
      .toBe('Open ticket');
    expect(openRow.querySelector('.claudian-collab-ticket-number')?.textContent)
      .toBe('#17');
    expect(root.querySelector('[data-ticket-id="ticket-open"]')?.getAttribute('aria-current'))
      .toBe('true');
    expect(root.querySelector('form, input, textarea')).toBeNull();

    root.querySelector<HTMLButtonElement>('[data-ticket-id="ticket-open"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-action="add-ticket"]')?.click();
    expect(onOpen).toHaveBeenCalledWith(openTicket);
    expect(onCreate).toHaveBeenCalledTimes(1);

    root.querySelector<HTMLButtonElement>('[data-action="load-more-tickets"]')?.click();
    await nextTurn();
    expect(listTickets).toHaveBeenLastCalledWith(
      { cursor: 'next-page', projectId: 'project-a', status: 'open' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(root.querySelector('[data-ticket-id="ticket-next"]')).not.toBeNull();
    focusedTicketId = nextOpenTicket.id;
    for (const listener of focusListeners) listener();
    expect(root.querySelector('[data-ticket-id="ticket-open"]')?.hasAttribute('aria-current'))
      .toBe(false);
    expect(root.querySelector('[data-ticket-id="ticket-next"]')?.getAttribute('aria-current'))
      .toBe('true');

    root.querySelector<HTMLButtonElement>('[data-ticket-status="open"]')?.click();
    await nextTurn();
    expect(listTickets).toHaveBeenLastCalledWith(
      { projectId: 'project-a', status: 'closed' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(root.querySelectorAll('[data-ticket-status]')).toHaveLength(1);
    expect(root.querySelector('[data-ticket-status="closed"]')?.textContent).toBe('Closed');
    expect(root.querySelector('[data-ticket-id="ticket-closed"]')).not.toBeNull();

    panel.destroy();
    expect(root.childElementCount).toBe(0);
    expect(disposeFocus).toHaveBeenCalledTimes(1);
  });

  it('skips re-reading on an unchanged reopen and coalesces hidden invalidations', async () => {
    const listTickets = jest.fn().mockResolvedValue({
      status: 'success',
      value: ticketPageRead({ tickets: [ticket('ticket-open', 17, 'Open ticket', 'open')] }),
    });
    let invalidate: () => void = () => undefined;
    const root = document.createElement('div');
    const panel = new TicketListPanel(root, {
      onCreate: jest.fn(),
      onOpen: jest.fn(),
      port: {
        listTickets,
        readSnapshot: jest.fn(),
        observeProject: jest.fn().mockImplementation((_projectId: string, listener: () => void) => {
          invalidate = () => listener();
          return { dispose: jest.fn() };
        }),
      } as unknown as CollabFeaturePort,
      project: project(),
    });

    panel.setActive(true);
    await nextTurn();
    expect(listTickets).toHaveBeenCalledTimes(1);

    panel.setActive(false);
    panel.setActive(true);
    await nextTurn();
    expect(listTickets).toHaveBeenCalledTimes(1);

    panel.setActive(false);
    invalidate();
    invalidate();
    panel.setActive(true);
    await nextTurn();
    expect(listTickets).toHaveBeenCalledTimes(2);
    panel.destroy();
  });

  it('re-reads on the next activation when a read is aborted by hiding', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const listTickets = jest.fn()
      .mockReturnValueOnce(gate.then(() => ({
        status: 'success',
        value: ticketPageRead({ tickets: [ticket('ticket-open', 17, 'Open ticket', 'open')] }),
      })))
      .mockResolvedValueOnce({
        status: 'success',
        value: ticketPageRead({ tickets: [ticket('ticket-open', 17, 'Open ticket', 'open')] }),
      });
    const root = document.createElement('div');
    const panel = new TicketListPanel(root, {
      onCreate: jest.fn(),
      onOpen: jest.fn(),
      port: {
        listTickets,
        readSnapshot: jest.fn(),
        observeProject: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      } as unknown as CollabFeaturePort,
      project: project(),
    });

    panel.setActive(true);
    expect(listTickets).toHaveBeenCalledTimes(1);
    panel.setActive(false);
    release();
    await nextTurn();

    panel.setActive(true);
    await nextTurn();
    expect(listTickets).toHaveBeenCalledTimes(2);
    panel.destroy();
  });

  it('re-reads after an active invalidation is interrupted by hiding', async () => {
    let invalidate: () => void = () => undefined;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const result = {
      status: 'success' as const,
      value: ticketPageRead({ tickets: [ticket('ticket-open', 17, 'Open ticket', 'open')] }),
    };
    const listTickets = jest.fn()
      .mockResolvedValueOnce(result)
      .mockReturnValueOnce(refreshGate.then(() => result))
      .mockResolvedValueOnce(result);
    const panel = new TicketListPanel(document.createElement('div'), {
      onCreate: jest.fn(),
      onOpen: jest.fn(),
      port: {
        listTickets,
        readSnapshot: jest.fn(),
        observeProject: jest.fn().mockImplementation((_projectId: string, listener: () => void) => {
          invalidate = listener;
          return { dispose: jest.fn() };
        }),
      } as unknown as CollabFeaturePort,
      project: project(),
    });

    panel.setActive(true);
    await nextTurn();
    invalidate();
    expect(listTickets).toHaveBeenCalledTimes(2);
    panel.setActive(false);
    releaseRefresh();
    await nextTurn();

    panel.setActive(true);
    await nextTurn();
    expect(listTickets).toHaveBeenCalledTimes(3);
    panel.destroy();
  });

  it('shows the empty state when a fresh snapshot confirms there are no open Tickets', async () => {
    const root = document.createElement('div');
    const panel = new TicketListPanel(root, {
      onCreate: jest.fn(),
      onOpen: jest.fn(),
      port: {
        listTickets: jest.fn().mockResolvedValue({
          error: { code: 'operation-failed' },
          status: 'failure',
        }),
        readSnapshot: jest.fn().mockResolvedValue({
          status: 'success',
          value: {
            snapshot: { openTicketCount: 0 },
            source: 'online',
            stale: false,
          },
        }),
        observeProject: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      } as unknown as CollabFeaturePort,
      project: project(),
    });

    panel.setActive(true);
    await nextTurn();

    expect(root.textContent).toContain('No Tickets');
    expect(root.textContent).not.toContain('Tickets could not be loaded');
    expect(root.querySelector('.is-error')).toBeNull();
  });

  it('shows cached Ticket rows read-only while authority is offline', async () => {
    const cachedTicket = ticket('ticket-cached', 17, 'Saved Ticket', 'open');
    const onCreate = jest.fn();
    const root = document.createElement('div');
    const panel = new TicketListPanel(root, {
      onCreate,
      onOpen: jest.fn(),
      port: {
        listTickets: jest.fn().mockResolvedValue({
          status: 'success',
          value: {
            page: { tickets: [cachedTicket] },
            source: 'cache',
            stale: true,
          },
        }),
        readSnapshot: jest.fn().mockResolvedValue({
          status: 'success',
          value: {
            snapshot: { openTicketCount: 1 },
            source: 'cache',
            stale: true,
          },
        }),
        observeProject: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      } as unknown as CollabFeaturePort,
      project: project({ connectionStatus: 'offline' }),
    });

    panel.setActive(true);
    await nextTurn();

    expect(root.querySelector('[data-state="ticket-offline-read-only"]')).not.toBeNull();
    expect(root.querySelector('[data-ticket-id="ticket-cached"]')).not.toBeNull();
    const add = root.querySelector<HTMLButtonElement>('[data-action="add-ticket"]')!;
    expect(add.disabled).toBe(true);
    add.click();
    expect(onCreate).not.toHaveBeenCalled();
  });
});

function ticket(
  id: string,
  number: number,
  title: string,
  status: 'open' | 'closed',
): CollabTicketSummary {
  return {
    acceptedRelationCount: 0,
    authorMemberId: 'member-a',
    commentCount: 0,
    createdAt: CREATED_AT,
    id,
    number,
    revision: 1,
    status,
    title,
    updatedAt: CREATED_AT,
  };
}

function ticketPageRead(page: { readonly nextCursor?: string; readonly tickets: readonly CollabTicketSummary[] }) {
  return { page, source: 'online' as const, stale: false };
}

function project(
  overrides: Partial<CollabLocalProjectSummary> = {},
): CollabLocalProjectSummary {
  return {
    authorityKind: 'lan',
    connectionStatus: 'connected',
    health: 'healthy',
    hostInstallationStatus: 'not-host',
    hostStatus: 'not-host',
    id: 'project-a',
    name: 'Project A',
    role: 'member',
    workspacePath: 'workspace/project-a',
    ...overrides,
  };
}

async function nextTurn(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

it('preserves loaded tickets through unrelated events and refreshes the loaded pages in place', async () => {
  let notify: Parameters<CollabFeaturePort['observeProject']>[1] | undefined;
  let updated = false;
  const root = document.createElement('div');
  const viewport = document.createElement('div');
  document.body.append(viewport); viewport.append(root);
  const panel = new TicketListPanel(root, {
    scrollContainer: viewport,
    onCreate: () => undefined, onOpen: () => undefined, project: project(),
    port: {
      observeProject: (_id: string, listener: NonNullable<typeof notify>) => {
        notify = listener; return { dispose() {} };
      },
      listTickets: async ({ cursor }: { cursor?: string }) => ({ status: 'success', value: ticketPageRead(cursor
        ? { tickets: [ticket('second', 2, updated ? 'Updated second ticket' : 'Second ticket', 'open')] }
        : { nextCursor: 'page-two', tickets: [ticket('first', 3, 'First ticket', 'open')] }) }),
    } as unknown as CollabFeaturePort,
  });
  panel.setActive(true);
  await nextTurn();
  within(root).getByRole('button', { name: 'Load more' }).click();
  await nextTurn();
  const second = within(root).getByRole('button', { name: /Second ticket/ });
  second.focus();
  viewport.scrollTop = 80;
  notify?.(undefined, { requests: ['unrelated-pr'] });
  expect(within(root).getByRole('button', { name: /Second ticket/ })).toBe(second);
  updated = true;
  notify?.(undefined, { tickets: ['second'] });
  expect(within(root).getByRole('button', { name: /Second ticket/ })).toBe(second);
  await nextTurn();
  expect(within(root).getByRole('button', { name: /Updated second ticket/ })).toBe(document.activeElement);
  expect(viewport.scrollTop).toBe(80);
  within(root).getByRole('button', { name: 'Open' }).focus();
  notify?.(undefined, { tickets: ['second'] });
  await nextTurn();
  expect(within(root).getByRole('button', { name: 'Open' })).toBe(document.activeElement);
  panel.destroy(); viewport.remove();
});

it('waits for background convergence before allowing another page', async () => {
  let notify: Parameters<CollabFeaturePort['observeProject']>[1] | undefined;
  let release!: () => void;
  let waiting = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const root = document.createElement('div');
  const panel = new TicketListPanel(root, {
    onCreate: () => undefined, onOpen: () => undefined, project: project(),
    port: {
      observeProject: (_id: string, listener: NonNullable<typeof notify>) => { notify = listener; return { dispose() {} }; },
      listTickets: async () => {
        if (waiting) await gate;
        return { status: 'success', value: ticketPageRead({ nextCursor: 'page-two', tickets: [ticket('first', 3, 'First ticket', 'open')] }) };
      },
    } as unknown as CollabFeaturePort,
  });
  try {
    panel.setActive(true); await nextTurn();
    waiting = true;
    notify?.(undefined, { tickets: ['first'] });
    expect((within(root).getByRole('button', { name: 'Load more' }) as HTMLButtonElement).disabled).toBe(true);
    release(); await nextTurn();
    expect((within(root).getByRole('button', { name: 'Load more' }) as HTMLButtonElement).disabled).toBe(false);
  } finally { release(); panel.destroy(); }
});
