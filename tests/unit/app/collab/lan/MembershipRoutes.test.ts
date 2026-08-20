import { handleMembershipRoute } from '@/app/collab/lan/routes/MembershipRoutes';
import type {
  CollabControlProjectService,
  CollabControlRouteRequest,
} from '@/app/collab/lan/routes/RouteTypes';

const CREDENTIAL = 'A'.repeat(43);

function route(
  overrides: Partial<CollabControlRouteRequest> = {},
): CollabControlRouteRequest {
  return {
    authorization: `Bearer ${CREDENTIAL}`,
    body: {
      idempotencyKey: 'promote-key',
      managerResponsibilityOfferId: 'offer-a',
      projectId: 'project-a',
      targetMemberId: 'member-a',
    },
    idempotencyKey: 'promote-key',
    lifecycle: { execute: jest.fn() },
    method: 'POST',
    projectId: 'project-a',
    query: {},
    remoteAddress: '192.168.1.20',
    segments: ['managers', 'member-a', 'promote'],
    service: {} as CollabControlProjectService,
    ...overrides,
  };
}

describe('handleMembershipRoute', () => {
  it('dispatches exact-path Member removal', async () => {
    const service = {
      removeMember: jest.fn().mockResolvedValue({
        discardedRequestId: null,
        memberId: 'member-a',
        projectId: 'project-a',
        status: 'revoked',
      }),
    } as unknown as CollabControlProjectService;
    const request = route({
      body: {
        idempotencyKey: 'remove-key',
        memberId: 'member-a',
        projectId: 'project-a',
      },
      idempotencyKey: 'remove-key',
      method: 'DELETE',
      segments: ['members', 'member-a'],
      service,
    });

    await expect(handleMembershipRoute(request)).resolves.toEqual({
      data: {
        discardedRequestId: null,
        memberId: 'member-a',
        projectId: 'project-a',
        status: 'revoked',
      },
    });
    expect(service.removeMember).toHaveBeenCalledWith(CREDENTIAL, {
      idempotencyKey: 'remove-key',
      memberId: 'member-a',
      projectId: 'project-a',
    });
  });

  it.each([
    ['POST', ['managers', 'member-a', 'promote']],
    ['POST', ['managers', 'member-a', 'demote']],
    ['POST', ['leave']],
  ])('does not claim v7 lifecycle route %s %j', async (method, segments) => {
    await expect(handleMembershipRoute(route({ method, segments }))).resolves.toBeNull();
  });

  it.each([
    { body: {
      idempotencyKey: 'remove-key',
      memberId: 'member-b',
      projectId: 'project-a',
    } },
    { body: {
      idempotencyKey: 'remove-key',
      memberId: 'invalid/member',
      projectId: 'project-a',
    } },
  ])('rejects a removal body that does not match the path %#', async override => {
    await expect(handleMembershipRoute(route({
      idempotencyKey: 'remove-key',
      method: 'DELETE',
      segments: ['members', 'member-a'],
      service: { removeMember: jest.fn() } as unknown as CollabControlProjectService,
      ...override,
    }))).rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it('returns null outside membership administration endpoints', async () => {
    await expect(handleMembershipRoute(route({
      method: 'GET',
      segments: ['members'],
    }))).resolves.toBeNull();
  });
});
