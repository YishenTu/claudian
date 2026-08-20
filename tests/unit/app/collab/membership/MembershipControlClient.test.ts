import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import {
  decodeCreateInvitationResponse,
  decodeDemoteManagerResponse,
  decodeMembershipTerminationResponse,
  decodePromoteManagerResponse,
  decodeRefreshEndpointResponse,
  MembershipControlClient,
  type MembershipControlTransport,
} from '@/app/collab/membership/MembershipControlClient';

function envelope(data: unknown): unknown {
  return {
    data,
    protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    requestId: 'request-one',
  };
}

describe('MembershipControlClient', () => {
  it('confirms a discovered endpoint through pinned active-Member auth', async () => {
    const transport: MembershipControlTransport = {
      requestWithMember: jest.fn().mockImplementation(async request => request.decode(envelope({
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://192.168.1.20:54545',
      }))),
    };
    const client = new MembershipControlClient(transport);

    await expect(client.confirmEndpoint({
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
      memberCredential: 'credential',
      projectId: 'project-a',
      timeoutMs: 1_234,
    })).resolves.toEqual({
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
    });
    expect(transport.requestWithMember).toHaveBeenCalledWith({
      decode: expect.any(Function),
      method: 'GET',
      path: '/v9/projects/project-a/endpoint',
    }, 'credential', { timeoutMs: 1_234 });
  });

  it('refreshes an active membership endpoint through pinned member auth', async () => {
    const invitation = {
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
      expiresAt: '2026-08-08T00:15:00.000Z',
      invitationId: 'invitation-alpha',
      invitationSecret: Buffer.alloc(32, 7).toString('base64url'),
      projectId: 'project-a',
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    };
    const transport: MembershipControlTransport = {
      requestWithMember: jest.fn().mockImplementation(async request => request.decode(envelope({
        caFingerprint: invitation.caFingerprint,
        endpoint: invitation.endpoint,
      }))),
    };
    const client = new MembershipControlClient(transport);

    await expect(client.refreshEndpoint({
      invitation,
      memberCredential: 'credential',
      projectId: 'project-a',
    })).resolves.toEqual({
      caFingerprint: invitation.caFingerprint,
      endpoint: invitation.endpoint,
    });
    expect(transport.requestWithMember).toHaveBeenCalledWith({
      body: { invitation, projectId: 'project-a' },
      decode: expect.any(Function),
      method: 'POST',
      path: '/v9/projects/project-a/endpoint-refresh',
    }, 'credential', {});
  });

  it('sends promotion and demotion without a singular Manager precondition', async () => {
    const transport: MembershipControlTransport = {
      requestWithMember: jest.fn().mockImplementation(async request => request.decode(envelope(
        request.path.endsWith('/promote')
          ? {
            managerSetGeneration: 2,
            projectId: 'project-a',
            promotedMemberId: 'member-a',
          }
          : {
            demotedMemberId: 'member-a',
            managerSetGeneration: 3,
            projectId: 'project-a',
          },
      ))),
    };
    const client = new MembershipControlClient(transport);

    await expect(client.promoteManager({
      idempotencyKey: 'promote-key',
      managerResponsibilityOfferId: 'offer-one',
      memberCredential: 'credential',
      projectId: 'project-a',
      targetMemberId: 'member-a',
    })).resolves.toEqual({
      managerSetGeneration: 2,
      projectId: 'project-a',
      promotedMemberId: 'member-a',
    });
    await expect(client.demoteManager({
      idempotencyKey: 'demote-key',
      memberCredential: 'credential',
      projectId: 'project-a',
      targetMemberId: 'member-a',
    })).resolves.toEqual({
      demotedMemberId: 'member-a',
      managerSetGeneration: 3,
      projectId: 'project-a',
    });
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(1, {
      body: {
        idempotencyKey: 'promote-key',
        managerResponsibilityOfferId: 'offer-one',
        projectId: 'project-a',
        targetMemberId: 'member-a',
      },
      decode: expect.any(Function),
      idempotencyKey: 'promote-key',
      method: 'POST',
      path: '/v9/projects/project-a/managers/member-a/promote',
    }, 'credential', {});
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(2, {
      body: {
        idempotencyKey: 'demote-key',
        projectId: 'project-a',
        targetMemberId: 'member-a',
      },
      decode: expect.any(Function),
      idempotencyKey: 'demote-key',
      method: 'POST',
      path: '/v9/projects/project-a/managers/member-a/demote',
    }, 'credential', {});
  });

  it('sends removal and leave through their exact routes', async () => {
    const transport: MembershipControlTransport = {
      requestWithMember: jest.fn().mockImplementation(async request => request.decode(envelope({
        discardedRequestId: null,
        memberId: 'member-a',
        projectId: 'project-a',
        status: request.method === 'DELETE' ? 'revoked' : 'left',
      }))),
    };
    const client = new MembershipControlClient(transport);

    await client.removeMember({
      idempotencyKey: 'remove-key',
      memberCredential: 'credential',
      memberId: 'member-a',
      projectId: 'project-a',
    });
    await client.leaveProject({
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyKey: 'leave-key',
      idempotencyManagerMemberId: null,
      memberCredential: 'credential',
      projectId: 'project-a',
    });

    expect(transport.requestWithMember).toHaveBeenNthCalledWith(1, {
      body: {
        idempotencyKey: 'remove-key',
        memberId: 'member-a',
        projectId: 'project-a',
      },
      decode: expect.any(Function),
      idempotencyKey: 'remove-key',
      method: 'DELETE',
      path: '/v9/projects/project-a/members/member-a',
    }, 'credential', {});
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(2, {
      body: {
        expectedHostMemberId: 'member-host',
        expectedMemberId: 'member-a',
        idempotencyKey: 'leave-key',
        idempotencyManagerMemberId: null,
        projectId: 'project-a',
      },
      decode: expect.any(Function),
      idempotencyKey: 'leave-key',
      method: 'POST',
      path: '/v9/projects/project-a/leave',
    }, 'credential', {});
  });

  it('creates and acknowledges a Manager responsibility offer through v7 routes', async () => {
    const offer = {
      expiresAt: '2026-08-08T00:10:00.000Z',
      offerId: 'offer-one',
      offeredAt: '2026-08-08T00:00:00.000Z',
      purpose: 'manager-leave',
      sourceManagerMemberId: 'member-manager',
      status: 'offered',
      targetMemberId: 'member-a',
    };
    const transport: MembershipControlTransport = {
      requestWithMember: jest.fn().mockImplementation(async request => request.decode(envelope(
        request.path.endsWith('/acknowledge')
          ? { ...offer, acknowledgedAt: '2026-08-08T00:01:00.000Z', status: 'acknowledged' }
          : offer,
      ))),
    };
    const client = new MembershipControlClient(transport);

    await expect(client.createManagerResponsibilityOffer({
      idempotencyKey: 'offer-key',
      memberCredential: 'credential',
      projectId: 'project-a',
      purpose: 'manager-leave',
      targetMemberId: 'member-a',
    })).resolves.toEqual(offer);
    await expect(client.acknowledgeManagerResponsibility({
      expectedTargetMemberId: 'member-a',
      idempotencyKey: 'ack-key',
      memberCredential: 'credential',
      offerId: 'offer-one',
      projectId: 'project-a',
    })).resolves.toMatchObject({ status: 'acknowledged' });
    await expect(client.cancelManagerResponsibilityOffer({
      idempotencyKey: 'cancel-key',
      memberCredential: 'credential',
      offerId: 'offer-one',
      projectId: 'project-a',
    })).resolves.toMatchObject({ offerId: 'offer-one' });

    expect(transport.requestWithMember).toHaveBeenNthCalledWith(1, {
      body: {
        idempotencyKey: 'offer-key',
        projectId: 'project-a',
        purpose: 'manager-leave',
        targetMemberId: 'member-a',
      },
      decode: expect.any(Function),
      idempotencyKey: 'offer-key',
      method: 'POST',
      path: '/v9/projects/project-a/manager-responsibility-offers',
    }, 'credential', {});
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(2, {
      body: {
        expectedTargetMemberId: 'member-a',
        idempotencyKey: 'ack-key',
        offerId: 'offer-one',
        projectId: 'project-a',
      },
      decode: expect.any(Function),
      idempotencyKey: 'ack-key',
      method: 'POST',
      path: '/v9/projects/project-a/manager-responsibility-offers/offer-one/acknowledge',
    }, 'credential', {});
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(3, {
      body: {
        idempotencyKey: 'cancel-key',
        offerId: 'offer-one',
        projectId: 'project-a',
      },
      decode: expect.any(Function),
      idempotencyKey: 'cancel-key',
      method: 'DELETE',
      path: '/v9/projects/project-a/manager-responsibility-offers/offer-one',
    }, 'credential', {});
  });

  it('creates and revokes a Manager invitation through pinned member auth', async () => {
    const invitation = {
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.10:54545',
      expiresAt: '2026-08-08T00:15:00.000Z',
      invitationId: 'invitation-alpha',
      invitationSecret: Buffer.alloc(32, 7).toString('base64url'),
      projectId: 'project-a',
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    };
    const encodedInvitation = `claudian-collab:v${COLLAB_CONTROL_PROTOCOL_VERSION}:${Buffer.from(
      JSON.stringify(invitation),
      'utf8',
    ).toString('base64url')}`;
    const transport: MembershipControlTransport = {
      requestWithMember: jest.fn().mockImplementation(async request => request.decode(envelope(
        request.method === 'POST'
          ? { encodedInvitation, invitation }
          : {
            currentMember: {
              activatedAt: '2026-08-08T00:00:00.000Z',
              createdAt: '2026-08-08T00:00:00.000Z',
              displayName: 'Manager',
              id: 'member-manager',
              personalRef: 'refs/heads/members/member-manager',
              role: 'manager',
              status: 'active',
            },
            eventSequence: 1,
            members: [{
              activatedAt: '2026-08-08T00:00:00.000Z',
              createdAt: '2026-08-08T00:00:00.000Z',
              displayName: 'Manager',
              id: 'member-manager',
              personalRef: 'refs/heads/members/member-manager',
              role: 'manager',
              status: 'active',
            }],
            openRequests: [],
            openTicketCount: 0,
            project: {
              authorityKind: 'lan',
              createdAt: '2026-08-08T00:00:00.000Z',
              hostMemberId: 'member-manager',
              id: 'project-a',
              mainOid: 'a'.repeat(40),
              mainRef: 'refs/heads/main',
              managerSetGeneration: 0,
              name: 'Project A',
            },
            ticketHighlights: [],
          },
      ))),
    };
    const client = new MembershipControlClient(transport);

    await expect(client.createInvitation({
      idempotencyKey: 'invite-key',
      memberCredential: 'credential',
      projectId: 'project-a',
    })).resolves.toEqual({
      encodedInvitation,
      expiresAt: invitation.expiresAt,
    });
    await expect(client.revokeInvitation({
      idempotencyKey: 'revoke-key',
      memberCredential: 'credential',
      memberId: 'member-manager',
      projectId: 'project-a',
    })).resolves.toBeUndefined();

    expect(transport.requestWithMember).toHaveBeenNthCalledWith(1, {
      body: { idempotencyKey: 'invite-key', projectId: 'project-a' },
      decode: expect.any(Function),
      idempotencyKey: 'invite-key',
      method: 'POST',
      path: '/v9/projects/project-a/invitations',
    }, 'credential', {});
    expect(transport.requestWithMember).toHaveBeenNthCalledWith(2, {
      body: { idempotencyKey: 'revoke-key', projectId: 'project-a' },
      decode: expect.any(Function),
      idempotencyKey: 'revoke-key',
      method: 'DELETE',
      path: '/v9/projects/project-a/invitations/current',
    }, 'credential', {});
  });

  it('rejects an invitation response whose encoded payload does not match', () => {
    const invitation = {
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.10:54545',
      expiresAt: '2026-08-08T00:15:00.000Z',
      invitationId: 'invitation-alpha',
      invitationSecret: Buffer.alloc(32, 7).toString('base64url'),
      projectId: 'project-a',
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    };

    expect(() => decodeCreateInvitationResponse(envelope({
      encodedInvitation: 'claudian-collab:v2:invalid',
      invitation,
    }), { projectId: 'project-a' })).toThrow(expect.objectContaining({
      code: 'protocol-payload-invalid',
    }));
  });

  it.each([
    { managerSetGeneration: 1, projectId: 'project-a', promotedMemberId: 'invalid/member' },
    { managerSetGeneration: 1, projectId: 'project-b', promotedMemberId: 'member-a' },
  ])('rejects invalid promotion responses %#', response => {
    expect(() => decodePromoteManagerResponse(envelope(response), {
      projectId: 'project-a',
      targetMemberId: 'member-a',
    })).toThrow(expect.objectContaining({ code: 'protocol-payload-invalid' }));
  });

  it.each([
    { demotedMemberId: 'invalid/member', managerSetGeneration: 1, projectId: 'project-a' },
    { demotedMemberId: 'member-a', managerSetGeneration: 1, projectId: 'project-b' },
  ])('rejects invalid demotion responses %#', response => {
    expect(() => decodeDemoteManagerResponse(envelope(response), {
      projectId: 'project-a',
      targetMemberId: 'member-a',
    })).toThrow(expect.objectContaining({ code: 'protocol-payload-invalid' }));
  });

  it.each([
    { discardedRequestId: null, memberId: 'member-a', projectId: 'project-a', status: 'active' },
    { discardedRequestId: 'invalid/request', memberId: 'member-a', projectId: 'project-a', status: 'left' },
    { discardedRequestId: null, memberId: 'member-b', projectId: 'project-a', status: 'left' },
  ])('rejects invalid termination responses %#', response => {
    expect(() => decodeMembershipTerminationResponse(envelope(response), {
      expectedMemberId: 'member-a',
      expectedStatus: 'left',
      projectId: 'project-a',
    })).toThrow(expect.objectContaining({ code: 'protocol-payload-invalid' }));
  });

  it.each([
    { caFingerprint: 'cd'.repeat(32), endpoint: 'https://192.168.1.20:54545' },
    { caFingerprint: 'ab'.repeat(32), endpoint: 'https://192.168.1.21:54545' },
    { caFingerprint: 'ab'.repeat(32), endpoint: 'http://192.168.1.20:54545' },
  ])('rejects an endpoint refresh response outside the invitation trust %#', response => {
    expect(() => decodeRefreshEndpointResponse(envelope(response), {
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
    })).toThrow(expect.objectContaining({ code: 'protocol-payload-invalid' }));
  });
});
