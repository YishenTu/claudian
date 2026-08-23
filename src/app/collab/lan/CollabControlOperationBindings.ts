import {
  COLLAB_CONTROL_PROTOCOL_VERSION,
  COLLAB_CONTROL_ROUTE_PREFIX,
} from '@/app/collab/lan/LanCollabConstants';
import type { LanCollabControlOperation } from '@/app/collab/lan/LanCollabControlOperations';

export type CollabControlAdmission = 'active' | 'bypass' | 'terminal';
export type CollabControlAuthentication =
  | 'active-member'
  | 'active-or-left'
  | 'invitation'
  | 'public'
  | 'terminal-member';
export type CollabControlMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface CollabControlOperationBinding {
  readonly admission: CollabControlAdmission;
  readonly authentication: CollabControlAuthentication;
  readonly family: 'join' | 'lifecycle' | 'membership' | 'project' | 'request' | 'ticket';
  readonly method: CollabControlMethod;
  readonly requestSource: 'body' | 'path' | 'path-and-body' | 'path-and-query';
  readonly route: string;
  readonly successStatus: 200 | 201;
  readonly version: typeof COLLAB_CONTROL_PROTOCOL_VERSION;
}

type BindingMap = {
  readonly [Operation in LanCollabControlOperation]: CollabControlOperationBinding;
};

export const COLLAB_CONTROL_OPERATION_BINDINGS = {
  createJoinAttempt: binding('POST', 'join-attempts', 'join', 'invitation', 'active', 'body', 201),
  activateJoinAttempt: binding('POST', 'join-attempts/:joinAttemptId/activate', 'join', 'active-member', 'active', 'path-and-body', 200),
  getSnapshot: binding('GET', 'snapshot', 'project', 'active-member', 'active', 'path', 200),
  getRequest: binding('GET', 'requests/:requestId', 'request', 'active-member', 'active', 'path', 200),
  listRequestComments: binding('GET', 'requests/:requestId/comments', 'request', 'active-member', 'active', 'path-and-query', 200),
  ensureMyRequest: binding('PUT', 'requests/mine', 'request', 'active-member', 'active', 'body', 200),
  createComment: binding('POST', 'requests/:requestId/comments', 'request', 'active-member', 'active', 'path-and-body', 201),
  listTickets: binding('GET', 'tickets', 'ticket', 'active-member', 'active', 'path-and-query', 200),
  getTicket: binding('GET', 'tickets/:ticketId', 'ticket', 'active-member', 'active', 'path', 200),
  listTicketComments: binding('GET', 'tickets/:ticketId/comments', 'ticket', 'active-member', 'active', 'path-and-query', 200),
  listTicketAcceptedRelations: binding('GET', 'tickets/:ticketId/relations', 'ticket', 'active-member', 'active', 'path-and-query', 200),
  createTicket: binding('POST', 'tickets', 'ticket', 'active-member', 'active', 'body', 201),
  updateTicketContent: binding('PUT', 'tickets/:ticketId/content', 'ticket', 'active-member', 'active', 'path-and-body', 200),
  createTicketComment: binding('POST', 'tickets/:ticketId/comments', 'ticket', 'active-member', 'active', 'path-and-body', 201),
  closeTicket: binding('POST', 'tickets/:ticketId/close', 'ticket', 'active-member', 'active', 'path-and-body', 200),
  reopenTicket: binding('POST', 'tickets/:ticketId/reopen', 'ticket', 'active-member', 'active', 'path-and-body', 200),
  updateMyRequestMetadata: binding('PUT', 'requests/:requestId/metadata', 'request', 'active-member', 'active', 'path-and-body', 200),
  acceptRequest: binding('POST', 'requests/:requestId/accept', 'request', 'active-member', 'active', 'path-and-body', 200),
  createInvitation: binding('POST', 'invitations', 'project', 'active-member', 'active', 'body', 201),
  revokeInvitation: binding('DELETE', 'invitations/current', 'project', 'active-member', 'active', 'body', 200),
  createManagerResponsibilityOffer: binding('POST', 'manager-responsibility-offers', 'lifecycle', 'active-member', 'active', 'body', 201),
  getCurrentManagerResponsibilityOffer: binding('GET', 'manager-responsibility-offers/current', 'lifecycle', 'active-member', 'active', 'path', 200),
  getManagerResponsibilityOffer: binding('GET', 'manager-responsibility-offers/:offerId', 'lifecycle', 'active-member', 'active', 'path', 200),
  acknowledgeManagerResponsibility: binding('POST', 'manager-responsibility-offers/:offerId/acknowledge', 'lifecycle', 'active-member', 'active', 'path-and-body', 200),
  declineManagerResponsibility: binding('POST', 'manager-responsibility-offers/:offerId/decline', 'lifecycle', 'active-member', 'active', 'path-and-body', 200),
  cancelManagerResponsibilityOffer: binding('DELETE', 'manager-responsibility-offers/:offerId', 'lifecycle', 'active-member', 'active', 'path-and-body', 200),
  promoteManager: binding('POST', 'managers/:memberId/promote', 'lifecycle', 'active-member', 'active', 'path-and-body', 200),
  demoteManager: binding('POST', 'managers/:memberId/demote', 'lifecycle', 'active-member', 'active', 'path-and-body', 200),
  createHostTransfer: binding('POST', 'host-transfers', 'lifecycle', 'active-member', 'active', 'body', 201),
  acceptHostTransfer: binding('POST', 'host-transfers/:transferId/accept', 'lifecycle', 'active-member', 'active', 'path-and-body', 200),
  declineHostTransfer: binding('POST', 'host-transfers/:transferId/decline', 'lifecycle', 'active-member', 'active', 'path-and-body', 200),
  cancelHostTransfer: binding('DELETE', 'host-transfers/:transferId', 'lifecycle', 'active-member', 'bypass', 'path-and-body', 200),
  removeMember: binding('DELETE', 'members/:memberId', 'membership', 'active-member', 'active', 'path-and-body', 200),
  leaveProject: binding('POST', 'leave', 'lifecycle', 'active-or-left', 'active', 'body', 200),
  retireProject: binding('POST', 'retire', 'lifecycle', 'active-member', 'bypass', 'body', 200),
  acknowledgeRetirement: binding('POST', 'retirement/acknowledgements/current', 'lifecycle', 'terminal-member', 'terminal', 'body', 200),
  getHostTransitions: binding('GET', 'host-transitions', 'lifecycle', 'public', 'bypass', 'path', 200),
  refreshEndpoint: binding('POST', 'endpoint-refresh', 'project', 'active-member', 'active', 'body', 200),
  confirmEndpoint: binding('GET', 'endpoint', 'project', 'active-member', 'active', 'path', 200),
} as const satisfies BindingMap;

function binding<
  Method extends CollabControlOperationBinding['method'],
>(
  method: Method,
  route: string,
  family: CollabControlOperationBinding['family'],
  authentication: CollabControlOperationBinding['authentication'],
  admission: CollabControlOperationBinding['admission'],
  requestSource: CollabControlOperationBinding['requestSource'],
  successStatus: 200 | 201,
) {
  return {
    admission,
    authentication,
    family,
    method,
    requestSource,
    route,
    successStatus,
    version: COLLAB_CONTROL_PROTOCOL_VERSION,
  } as const;
}

export function collabControlOperationPath(
  operation: LanCollabControlOperation,
  projectId: string,
  parameters: Readonly<Record<string, string>> = {},
): string {
  const binding = COLLAB_CONTROL_OPERATION_BINDINGS[operation];
  const suffix = binding.route.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
    const value = parameters[name];
    if (!value) throw new Error(`Missing Collab route parameter: ${name}`);
    return value;
  });
  return `${COLLAB_CONTROL_ROUTE_PREFIX}/${projectId}/${suffix}`;
}

export interface CollabControlOperationMatch {
  readonly operation: LanCollabControlOperation;
  readonly parameters: Readonly<Record<string, string>>;
}

export function matchCollabControlOperation(
  method: string | undefined,
  segments: readonly string[],
): CollabControlOperationMatch | null {
  for (const operation of Object.keys(
    COLLAB_CONTROL_OPERATION_BINDINGS,
  ) as LanCollabControlOperation[]) {
    const binding = COLLAB_CONTROL_OPERATION_BINDINGS[operation];
    if (method !== binding.method) continue;
    const expected = binding.route.split('/');
    if (expected.length !== segments.length) continue;
    const parameters: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < expected.length; index += 1) {
      const part = expected[index];
      const actual = segments[index];
      if (part.startsWith(':')) {
        const name = part.slice(1);
        if (
          !(name === 'memberId'
            ? isCollabMemberId(actual)
            : isCollabOpaqueId(actual))
          || (name === 'offerId' && actual === 'current')
        ) {
          matches = false;
          break;
        }
        parameters[name] = actual;
      } else if (part !== actual) {
        matches = false;
        break;
      }
    }
    if (matches) return { operation, parameters };
  }
  return null;
}
import { isCollabMemberId, isCollabOpaqueId } from '@claudian-collab/protocol';
