import type {
  CollabListTicketsRequest,
  CollabOperationOptions,
  CollabResult,
  CollabTicketPageProjection,
} from '@/core/collab';
import {
  TicketReferenceResolver,
} from '@/features/collab/detail/sessions/TicketReferenceResolver';

function page(
  tickets: readonly { id: string; number: number }[],
  nextCursor?: string,
): CollabTicketPageProjection {
  return {
    page: {
      tickets: tickets.map(ticket => ({
        ...ticket,
        authorMemberId: 'member-a',
        body: '',
        commentCount: 0,
        createdAt: '2026-08-08T00:00:00.000Z',
        revision: 1,
        status: 'open',
        title: `Ticket ${ticket.number}`,
        updatedAt: '2026-08-08T00:00:00.000Z',
      })),
      ...(nextCursor ? { nextCursor } : {}),
    },
    source: 'online',
    stale: false,
  } as unknown as CollabTicketPageProjection;
}

function port(
  handler: (
    request: CollabListTicketsRequest,
    options?: CollabOperationOptions,
  ) => Promise<CollabResult<CollabTicketPageProjection>>,
) {
  return { listTickets: jest.fn(handler) };
}

describe('TicketReferenceResolver', () => {
  it('never opens after cancel even when the deferred lookup resolves with a match', async () => {
    let release!: (result: CollabResult<CollabTicketPageProjection>) => void;
    const deferred = new Promise<CollabResult<CollabTicketPageProjection>>(resolve => {
      release = resolve;
    });
    const listTickets = port(() => deferred);
    const resolver = new TicketReferenceResolver(listTickets);
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);

    const pending = resolver.openReference(
      'project-a',
      17,
      openTicketInNewTab,
      () => true,
    );
    resolver.cancel();
    release({ status: 'success', value: page([{ id: 'ticket-a', number: 17 }]) });
    await pending;

    expect(openTicketInNewTab).not.toHaveBeenCalled();
  });

  it('never opens when the session-current predicate fails after the lookup', async () => {
    const listTickets = port(async () => ({
      status: 'success',
      value: page([{ id: 'ticket-a', number: 17 }]),
    }));
    const resolver = new TicketReferenceResolver(listTickets);
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);
    let current = true;

    const pending = resolver.openReference(
      'project-a',
      17,
      openTicketInNewTab,
      () => current,
    );
    current = false;
    await pending;

    expect(openTicketInNewTab).not.toHaveBeenCalled();
  });

  it('supersedes an in-flight lookup when a newer click arrives', async () => {
    let calls = 0;
    let releaseFirst!: (result: CollabResult<CollabTicketPageProjection>) => void;
    const listTickets = port(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<CollabResult<CollabTicketPageProjection>>(resolve => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve({
        status: 'success',
        value: page([{ id: 'ticket-a', number: 17 }]),
      });
    });
    const resolver = new TicketReferenceResolver(listTickets);
    const firstOpen = jest.fn().mockResolvedValue(undefined);
    const secondOpen = jest.fn().mockResolvedValue(undefined);

    const first = resolver.openReference('project-a', 17, firstOpen, () => true);
    await new Promise(resolve => setImmediate(resolve));
    const second = resolver.openReference('project-a', 17, secondOpen, () => true);
    await second;
    // The abandoned lookup still settles later; it must not open a tab.
    releaseFirst({ status: 'success', value: page([{ id: 'ticket-stale', number: 17 }]) });
    await first;

    expect(firstOpen).not.toHaveBeenCalled();
    expect(secondOpen).toHaveBeenCalledTimes(1);
    expect(secondOpen).toHaveBeenCalledWith('project-a', 'ticket-a');
  });

  it('pages open tickets before closed tickets and stops on a repeated cursor', async () => {
    const calls: CollabListTicketsRequest[] = [];
    const listTickets = port(async (request: CollabListTicketsRequest) => {
      calls.push(request);
      if (request.status === 'open') {
        if (!request.cursor) {
          return { status: 'success', value: page([{ id: 'other', number: 1 }], 'cursor-1') };
        }
        // A repeated cursor must terminate the loop instead of cycling.
        return { status: 'success', value: page([{ id: 'other-2', number: 2 }], 'cursor-1') };
      }
      return {
        status: 'success',
        value: page([{ id: 'ticket-closed', number: 17 }]),
      };
    });
    const resolver = new TicketReferenceResolver(listTickets);
    const openTicketInNewTab = jest.fn().mockResolvedValue(undefined);

    await resolver.openReference('project-a', 17, openTicketInNewTab, () => true);

    expect(calls.map(call => call.status)).toEqual(['open', 'open', 'closed']);
    expect(openTicketInNewTab).toHaveBeenCalledWith('project-a', 'ticket-closed');
  });
});
