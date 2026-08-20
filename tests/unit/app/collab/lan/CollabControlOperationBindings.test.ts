import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
  matchCollabControlOperation,
} from '@/app/collab/lan/CollabControlOperationBindings';
import {
  LAN_COLLAB_CONTROL_OPERATION_CODECS,
  lanCollabControlOperationCodec,
} from '@/app/collab/lan/LanCollabControlOperationCodecs';
import { LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS } from '@/app/collab/lan/LanCollabControlOperations';

describe('CollabControlOperationBindings', () => {
  it('keeps the LAN codec authority immutable and rejects inherited keys', () => {
    expect(Object.isFrozen(LAN_COLLAB_CONTROL_OPERATION_CODECS)).toBe(true);
    for (const codec of Object.values(LAN_COLLAB_CONTROL_OPERATION_CODECS)) {
      expect(Object.isFrozen(codec)).toBe(true);
    }
    for (const operation of ['__proto__', 'constructor', 'toString']) {
      expect(() => lanCollabControlOperationCodec(operation as never))
        .toThrow('collab.error.operation-failed');
    }
  });

  it('binds every JSON control operation exactly once', () => {
    const operations = Object.keys(LAN_COLLAB_CONTROL_OPERATION_CODECS);
    expect(Object.keys(COLLAB_CONTROL_OPERATION_BINDINGS).sort())
      .toEqual([...operations].sort());
    expect(new Set(Object.entries(COLLAB_CONTROL_OPERATION_BINDINGS).map(([, binding]) => (
      `${binding.method} /v${binding.version}/projects/:projectId/${binding.route}`
    ))).size).toBe(operations.length);
    expect(new Set(Object.values(COLLAB_CONTROL_OPERATION_BINDINGS).map(binding => (
      binding.version
    )))).toEqual(new Set([9]));
    expect(COLLAB_CONTROL_OPERATION_BINDINGS).not.toHaveProperty('transferManager');
  });

  it('preserves the exact executable tuple for every v9 JSON control operation', () => {
    expect(Object.entries(COLLAB_CONTROL_OPERATION_BINDINGS).map(([
      operation,
      binding,
    ]) => [
      operation,
      binding.method,
      binding.route,
      binding.family,
      binding.authentication,
      binding.admission,
      binding.requestSource,
      binding.successStatus,
    ])).toEqual([
      ['createJoinAttempt', 'POST', 'join-attempts', 'join', 'invitation', 'active', 'body', 201],
      ['activateJoinAttempt', 'POST', 'join-attempts/:joinAttemptId/activate', 'join', 'active-member', 'active', 'path-and-body', 200],
      ['getSnapshot', 'GET', 'snapshot', 'project', 'active-member', 'active', 'path', 200],
      ['getRequest', 'GET', 'requests/:requestId', 'request', 'active-member', 'active', 'path', 200],
      ['listRequestComments', 'GET', 'requests/:requestId/comments', 'request', 'active-member', 'active', 'path-and-query', 200],
      ['ensureMyRequest', 'PUT', 'requests/mine', 'request', 'active-member', 'active', 'body', 200],
      ['createComment', 'POST', 'requests/:requestId/comments', 'request', 'active-member', 'active', 'path-and-body', 201],
      ['listTickets', 'GET', 'tickets', 'ticket', 'active-member', 'active', 'path-and-query', 200],
      ['getTicket', 'GET', 'tickets/:ticketId', 'ticket', 'active-member', 'active', 'path', 200],
      ['listTicketComments', 'GET', 'tickets/:ticketId/comments', 'ticket', 'active-member', 'active', 'path-and-query', 200],
      ['listTicketAcceptedRelations', 'GET', 'tickets/:ticketId/relations', 'ticket', 'active-member', 'active', 'path-and-query', 200],
      ['createTicket', 'POST', 'tickets', 'ticket', 'active-member', 'active', 'body', 201],
      ['updateTicketContent', 'PUT', 'tickets/:ticketId/content', 'ticket', 'active-member', 'active', 'path-and-body', 200],
      ['createTicketComment', 'POST', 'tickets/:ticketId/comments', 'ticket', 'active-member', 'active', 'path-and-body', 201],
      ['closeTicket', 'POST', 'tickets/:ticketId/close', 'ticket', 'active-member', 'active', 'path-and-body', 200],
      ['reopenTicket', 'POST', 'tickets/:ticketId/reopen', 'ticket', 'active-member', 'active', 'path-and-body', 200],
      ['updateMyRequestMetadata', 'PUT', 'requests/:requestId/metadata', 'request', 'active-member', 'active', 'path-and-body', 200],
      ['acceptRequest', 'POST', 'requests/:requestId/accept', 'request', 'active-member', 'active', 'path-and-body', 200],
      ['createInvitation', 'POST', 'invitations', 'project', 'active-member', 'active', 'body', 201],
      ['revokeInvitation', 'DELETE', 'invitations/current', 'project', 'active-member', 'active', 'body', 200],
      ['createManagerResponsibilityOffer', 'POST', 'manager-responsibility-offers', 'lifecycle', 'active-member', 'active', 'body', 201],
      ['getCurrentManagerResponsibilityOffer', 'GET', 'manager-responsibility-offers/current', 'lifecycle', 'active-member', 'active', 'path', 200],
      ['getManagerResponsibilityOffer', 'GET', 'manager-responsibility-offers/:offerId', 'lifecycle', 'active-member', 'active', 'path', 200],
      ['acknowledgeManagerResponsibility', 'POST', 'manager-responsibility-offers/:offerId/acknowledge', 'lifecycle', 'active-member', 'active', 'path-and-body', 200],
      ['declineManagerResponsibility', 'POST', 'manager-responsibility-offers/:offerId/decline', 'lifecycle', 'active-member', 'active', 'path-and-body', 200],
      ['cancelManagerResponsibilityOffer', 'DELETE', 'manager-responsibility-offers/:offerId', 'lifecycle', 'active-member', 'active', 'path-and-body', 200],
      ['promoteManager', 'POST', 'managers/:memberId/promote', 'lifecycle', 'active-member', 'active', 'path-and-body', 200],
      ['demoteManager', 'POST', 'managers/:memberId/demote', 'lifecycle', 'active-member', 'active', 'path-and-body', 200],
      ['createHostTransfer', 'POST', 'host-transfers', 'lifecycle', 'active-member', 'active', 'body', 201],
      ['acceptHostTransfer', 'POST', 'host-transfers/:transferId/accept', 'lifecycle', 'active-member', 'active', 'path-and-body', 200],
      ['declineHostTransfer', 'POST', 'host-transfers/:transferId/decline', 'lifecycle', 'active-member', 'active', 'path-and-body', 200],
      ['cancelHostTransfer', 'DELETE', 'host-transfers/:transferId', 'lifecycle', 'active-member', 'bypass', 'path-and-body', 200],
      ['removeMember', 'DELETE', 'members/:memberId', 'membership', 'active-member', 'active', 'path-and-body', 200],
      ['leaveProject', 'POST', 'leave', 'lifecycle', 'active-or-left', 'active', 'body', 200],
      ['retireProject', 'POST', 'retire', 'lifecycle', 'active-member', 'bypass', 'body', 200],
      ['acknowledgeRetirement', 'POST', 'retirement/acknowledgements/current', 'lifecycle', 'terminal-member', 'terminal', 'body', 200],
      ['getHostTransitions', 'GET', 'host-transitions', 'lifecycle', 'public', 'bypass', 'path', 200],
      ['refreshEndpoint', 'POST', 'endpoint-refresh', 'project', 'active-member', 'active', 'body', 200],
      ['confirmEndpoint', 'GET', 'endpoint', 'project', 'active-member', 'active', 'path', 200],
    ]);
  });

  it('binds every lifecycle operation to its exact v7 route tuple', () => {
    expect(LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS.map(operation => {
      const binding = COLLAB_CONTROL_OPERATION_BINDINGS[operation];
      return [operation, binding.method, `/v${binding.version}/projects/:projectId/${binding.route}`];
    })).toEqual([
      ['leaveProject', 'POST', '/v9/projects/:projectId/leave'],
      ['createManagerResponsibilityOffer', 'POST', '/v9/projects/:projectId/manager-responsibility-offers'],
      ['getCurrentManagerResponsibilityOffer', 'GET', '/v9/projects/:projectId/manager-responsibility-offers/current'],
      ['getManagerResponsibilityOffer', 'GET', '/v9/projects/:projectId/manager-responsibility-offers/:offerId'],
      ['acknowledgeManagerResponsibility', 'POST', '/v9/projects/:projectId/manager-responsibility-offers/:offerId/acknowledge'],
      ['declineManagerResponsibility', 'POST', '/v9/projects/:projectId/manager-responsibility-offers/:offerId/decline'],
      ['cancelManagerResponsibilityOffer', 'DELETE', '/v9/projects/:projectId/manager-responsibility-offers/:offerId'],
      ['promoteManager', 'POST', '/v9/projects/:projectId/managers/:memberId/promote'],
      ['demoteManager', 'POST', '/v9/projects/:projectId/managers/:memberId/demote'],
      ['createHostTransfer', 'POST', '/v9/projects/:projectId/host-transfers'],
      ['acceptHostTransfer', 'POST', '/v9/projects/:projectId/host-transfers/:transferId/accept'],
      ['declineHostTransfer', 'POST', '/v9/projects/:projectId/host-transfers/:transferId/decline'],
      ['cancelHostTransfer', 'DELETE', '/v9/projects/:projectId/host-transfers/:transferId'],
      ['retireProject', 'POST', '/v9/projects/:projectId/retire'],
      ['acknowledgeRetirement', 'POST', '/v9/projects/:projectId/retirement/acknowledgements/current'],
      ['getHostTransitions', 'GET', '/v9/projects/:projectId/host-transitions'],
    ]);
  });

  it('builds parameterized paths from the authoritative binding', () => {
    expect(collabControlOperationPath('createComment', 'project-a', {
      requestId: 'request-a',
    })).toBe('/v9/projects/project-a/requests/request-a/comments');
    expect(() => collabControlOperationPath('createComment', 'project-a'))
      .toThrow('Missing Collab route parameter: requestId');
  });

  it('matches parameterized routes from the same authoritative binding', () => {
    expect(matchCollabControlOperation('POST', [
      'requests', 'request-a', 'comments',
    ])).toEqual({
      operation: 'createComment',
      parameters: { requestId: 'request-a' },
    });
    expect(matchCollabControlOperation('GET', [
      'manager-responsibility-offers', 'current',
    ])).toEqual({
      operation: 'getCurrentManagerResponsibilityOffer',
      parameters: {},
    });
    expect(matchCollabControlOperation('POST', ['requests', '../bad', 'comments']))
      .toBeNull();
  });

  it('is the lifecycle authentication and admission policy authority', () => {
    const publicOperations = Object.entries(COLLAB_CONTROL_OPERATION_BINDINGS)
      .filter(([, binding]) => binding.authentication === 'public')
      .map(([operation]) => operation);
    const terminalOperations = Object.entries(COLLAB_CONTROL_OPERATION_BINDINGS)
      .filter(([, binding]) => binding.admission === 'terminal')
      .map(([operation]) => operation);
    const bypassOperations = Object.entries(COLLAB_CONTROL_OPERATION_BINDINGS)
      .filter(([, binding]) => binding.admission === 'bypass')
      .map(([operation]) => operation);

    expect(publicOperations).toEqual(['getHostTransitions']);
    expect(terminalOperations).toEqual(['acknowledgeRetirement']);
    expect(bypassOperations).toEqual([
      'cancelHostTransfer',
      'retireProject',
      'getHostTransitions',
    ]);
  });
});
