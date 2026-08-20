import { handleRequestRoute } from '@/app/collab/lan/routes/RequestRoutes';
import type {
  CollabControlProjectService,
  CollabControlRouteRequest,
} from '@/app/collab/lan/routes/RouteTypes';

const CREDENTIAL = 'A'.repeat(43);
const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);

function route(
  overrides: Partial<CollabControlRouteRequest> = {},
): CollabControlRouteRequest {
  return {
    authorization: `Bearer ${CREDENTIAL}`,
    body: {
      description: 'Implements #12',
      expectedMainOid: MAIN,
      headOid: HEAD,
      idempotencyKey: 'publish-key',
      projectId: 'project-a',
    },
    idempotencyKey: 'publish-key',
    lifecycle: { execute: jest.fn() },
    method: 'PUT',
    projectId: 'project-a',
    query: {},
    remoteAddress: '192.168.1.20',
    segments: ['requests', 'mine'],
    service: {
      ensureMyRequest: jest.fn().mockResolvedValue({
        request: { id: 'request-a', latestHeadOid: HEAD },
      }),
    } as unknown as CollabControlProjectService,
    ...overrides,
  };
}

describe('handleRequestRoute', () => {
  it('dispatches exact pushed-head ensure with Bearer authentication', async () => {
    const request = route();

    await expect(handleRequestRoute(request)).resolves.toEqual({
      data: { request: { id: 'request-a', latestHeadOid: HEAD } },
    });
    expect(request.service.ensureMyRequest).toHaveBeenCalledWith(CREDENTIAL, {
      expectedMainOid: MAIN,
      description: 'Implements #12',
      headOid: HEAD,
      idempotencyKey: 'publish-key',
      projectId: 'project-a',
    });
  });

  it('dispatches request detail reads with Bearer authentication', async () => {
    const request = route({
      body: {},
      idempotencyKey: null,
      method: 'GET',
      segments: ['requests', 'request-a'],
      service: {
        readRequest: jest.fn().mockResolvedValue({ request: { id: 'request-a' } }),
      } as unknown as CollabControlProjectService,
    });

    await expect(handleRequestRoute(request)).resolves.toEqual({
      data: { request: { id: 'request-a' } },
    });
    expect(request.service.readRequest).toHaveBeenCalledWith(
      CREDENTIAL,
      { projectId: 'project-a', requestId: 'request-a' },
    );
  });

  it('dispatches immutable request comments with matching path and idempotency context', async () => {
    const request = route({
      body: {
        body: 'Please revise',
        idempotencyKey: 'comment-key',
        projectId: 'project-a',
        requestId: 'request-a',
      },
      idempotencyKey: 'comment-key',
      method: 'POST',
      segments: ['requests', 'request-a', 'comments'],
      service: {
        createComment: jest.fn().mockResolvedValue({ comment: { id: 'comment-a' } }),
      } as unknown as CollabControlProjectService,
    });

    await expect(handleRequestRoute(request)).resolves.toEqual({
      data: { comment: { id: 'comment-a' } },
    });
    expect(request.service.createComment).toHaveBeenCalledWith(CREDENTIAL, {
      body: 'Please revise',
      idempotencyKey: 'comment-key',
      projectId: 'project-a',
      requestId: 'request-a',
    });
  });

  it('dispatches exact reviewed main and head to Accept', async () => {
    const mainOid = 'b'.repeat(40);
    const request = route({
      body: {
        expectedHeadOid: HEAD,
        expectedMainOid: mainOid,
        expectedRequestRevision: 2,
        expectedResolvingTickets: [{ revision: 3, ticketId: 'ticket-a' }],
        idempotencyKey: 'accept-key',
        projectId: 'project-a',
        requestId: 'request-a',
      },
      idempotencyKey: 'accept-key',
      method: 'POST',
      segments: ['requests', 'request-a', 'accept'],
      service: {
        acceptRequest: jest.fn().mockResolvedValue({ mainOid: 'c'.repeat(40) }),
      } as unknown as CollabControlProjectService,
    });

    await expect(handleRequestRoute(request)).resolves.toEqual({
      data: { mainOid: 'c'.repeat(40) },
    });
    expect(request.service.acceptRequest).toHaveBeenCalledWith(CREDENTIAL, {
      expectedHeadOid: HEAD,
      expectedMainOid: mainOid,
      expectedRequestRevision: 2,
      expectedResolvingTickets: [{ revision: 3, ticketId: 'ticket-a' }],
      idempotencyKey: 'accept-key',
      projectId: 'project-a',
      requestId: 'request-a',
    });
  });

  it.each([
    { idempotencyKey: null },
    {
      body: {
        anchor: { path: 'notes/review.md' },
        body: 'Comment',
        idempotencyKey: 'comment-key',
        projectId: 'project-a',
        requestId: 'request-a',
      },
    },
    {
      body: {
        body: 'Comment',
        idempotencyKey: 'other-key',
        projectId: 'project-a',
        requestId: 'request-a',
      },
    },
    {
      body: {
        body: 'Comment',
        idempotencyKey: 'comment-key',
        projectId: 'project-a',
        requestId: 'request-b',
      },
    },
  ])('rejects invalid comment mutation context %#', async override => {
    await expect(handleRequestRoute(route({
      body: {
        body: 'Comment',
        idempotencyKey: 'comment-key',
        projectId: 'project-a',
        requestId: 'request-a',
      },
      idempotencyKey: 'comment-key',
      method: 'POST',
      segments: ['requests', 'request-a', 'comments'],
      service: {
        createComment: jest.fn(),
      } as unknown as CollabControlProjectService,
      ...override,
    }))).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it.each([
    { idempotencyKey: null },
    { body: {
      expectedHeadOid: HEAD,
      expectedMainOid: 'invalid',
      expectedRequestRevision: 2,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-key',
      projectId: 'project-a',
      requestId: 'request-a',
    } },
    { body: {
      expectedHeadOid: HEAD,
      expectedMainOid: 'b'.repeat(40),
      expectedRequestRevision: 2,
      expectedResolvingTickets: [],
      idempotencyKey: 'accept-key',
      projectId: 'project-a',
      requestId: 'request-b',
    } },
  ])('rejects invalid Accept mutation context %#', async override => {
    await expect(handleRequestRoute(route({
      body: {
        expectedHeadOid: HEAD,
        expectedMainOid: 'b'.repeat(40),
        expectedRequestRevision: 2,
        expectedResolvingTickets: [],
        idempotencyKey: 'accept-key',
        projectId: 'project-a',
        requestId: 'request-a',
      },
      idempotencyKey: 'accept-key',
      method: 'POST',
      segments: ['requests', 'request-a', 'accept'],
      service: { acceptRequest: jest.fn() } as unknown as CollabControlProjectService,
      ...override,
    }))).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it.each([
    { authorization: null },
    { idempotencyKey: null },
    { body: { description: 'Change', headOid: HEAD, idempotencyKey: 'different', projectId: 'project-a' } },
    { body: { description: 'Change', headOid: 'not-an-oid', idempotencyKey: 'publish-key', projectId: 'project-a' } },
    { body: { description: 'Change', headOid: HEAD, idempotencyKey: 'publish-key', projectId: 'project-b' } },
  ])('rejects invalid authentication or payload %#', async override => {
    await expect(handleRequestRoute(route(override))).rejects.toMatchObject({
      code: expect.stringMatching(/^(authentication-failed|protocol-payload-invalid)$/),
    });
  });

  it('returns null for routes outside the request endpoints', async () => {
    await expect(handleRequestRoute(route({
      method: 'GET',
      segments: ['requests'],
    }))).resolves.toBeNull();
  });
});
