import type {
  CollabControlProjectService,
  CollabControlRouteRequest,
} from '@/app/collab/lan/routes/RouteTypes';
import { handleTicketRoute } from '@/app/collab/lan/routes/TicketRoutes';

const CREDENTIAL = 'A'.repeat(43);

function route(
  overrides: Partial<CollabControlRouteRequest> = {},
): CollabControlRouteRequest {
  return {
    authorization: `Bearer ${CREDENTIAL}`,
    body: {},
    idempotencyKey: null,
    lifecycle: { execute: jest.fn() },
    method: 'GET',
    projectId: 'project-a',
    query: { status: 'open' },
    remoteAddress: '192.168.1.20',
    segments: ['tickets'],
    service: {} as CollabControlProjectService,
    ...overrides,
  };
}

describe('handleTicketRoute', () => {
  it('keeps the sidebar list endpoint filterable and paginated', async () => {
    const request = route({
      query: { cursor: 'next-page', limit: '20', status: 'closed' },
      service: {
        listTickets: jest.fn().mockResolvedValue({ tickets: [] }),
      } as unknown as CollabControlProjectService,
    });

    await expect(handleTicketRoute(request)).resolves.toEqual({
      data: { tickets: [] },
    });
    expect(request.service.listTickets).toHaveBeenCalledWith(CREDENTIAL, {
      cursor: 'next-page',
      limit: 20,
      projectId: 'project-a',
      status: 'closed',
    });
  });

  it('dispatches Ticket creation for the main editor', async () => {
    const request = route({
      body: {
        body: 'Ticket body',
        idempotencyKey: 'ticket-create',
        projectId: 'project-a',
        title: 'Ticket title',
      },
      idempotencyKey: 'ticket-create',
      method: 'POST',
      query: {},
      service: {
        createTicket: jest.fn().mockResolvedValue({ ticket: { id: 'ticket-a' } }),
      } as unknown as CollabControlProjectService,
    });

    await expect(handleTicketRoute(request)).resolves.toEqual({
      data: { ticket: { id: 'ticket-a' } },
    });
    expect(request.service.createTicket).toHaveBeenCalledWith(CREDENTIAL, {
      body: 'Ticket body',
      idempotencyKey: 'ticket-create',
      projectId: 'project-a',
      title: 'Ticket title',
    });
    await expect(handleTicketRoute({
      ...request,
      body: { ...(request.body as object), assigneeMemberId: 'member-a' },
    })).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it('reads one Ticket for the main editor', async () => {
    const request = route({
      query: {},
      segments: ['tickets', 'ticket-a'],
      service: {
        getTicket: jest.fn().mockResolvedValue({ ticket: { id: 'ticket-a' } }),
      } as unknown as CollabControlProjectService,
    });

    await expect(handleTicketRoute(request)).resolves.toEqual({
      data: { ticket: { id: 'ticket-a' } },
    });
    expect(request.service.getTicket).toHaveBeenCalledWith(
      CREDENTIAL,
      'project-a',
      'ticket-a',
    );
  });

  it('closes without accepting a close reason field', async () => {
    const closeTicket = jest.fn().mockResolvedValue({ ticket: { status: 'closed' } });
    const base = route({
      body: {
        expectedRevision: 3,
        idempotencyKey: 'ticket-close',
        projectId: 'project-a',
        ticketId: 'ticket-a',
      },
      idempotencyKey: 'ticket-close',
      method: 'POST',
      query: {},
      segments: ['tickets', 'ticket-a', 'close'],
      service: { closeTicket } as unknown as CollabControlProjectService,
    });

    await expect(handleTicketRoute(base)).resolves.toEqual({
      data: { ticket: { status: 'closed' } },
    });
    expect(closeTicket).toHaveBeenCalledWith(CREDENTIAL, {
      expectedRevision: 3,
      idempotencyKey: 'ticket-close',
      projectId: 'project-a',
      ticketId: 'ticket-a',
    });
    await expect(handleTicketRoute({
      ...base,
      body: { ...(base.body as object), closeReason: 'duplicate' },
    })).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });
});
