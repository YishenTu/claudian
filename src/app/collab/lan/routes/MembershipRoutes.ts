import { isCollabMemberId } from '@claudian-collab/protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  matchCollabControlOperation,
} from '@/app/collab/lan/CollabControlOperationBindings';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import { requireOperationCredential } from '@/app/collab/lan/routes/RouteAuthentication';
import type {
  CollabControlRouteHandler,
  CollabControlRouteRequest,
} from '@/app/collab/lan/routes/RouteTypes';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function routeError(reason: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { reason },
  });
}

function parseRemoval(request: CollabControlRouteRequest, memberId: string) {
  const decoded = lanCollabControlOperationCodec('removeMember').decodeRequest(request.body);
  if (decoded.status !== 'ok') throw decoded.error;
  const body = decoded.value;
  if (
    body.projectId !== request.projectId
    || body.idempotencyKey !== request.idempotencyKey
  ) throw routeError('membership-mutation-request-mismatch');
  if (!isCollabMemberId(memberId) || body.memberId !== memberId) {
    throw routeError('membership-removal-request-invalid');
  }
  return body;
}

export const handleMembershipRoute: CollabControlRouteHandler = async request => {
  const match = request.operationMatch
    ?? matchCollabControlOperation(request.method, request.segments);
  if (
    match
    && COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family === 'membership'
    && match.operation === 'removeMember'
  ) {
    const memberId = match.parameters.memberId ?? '';
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.removeMember(
        memberCredential,
        parseRemoval(request, memberId),
      ),
    };
  }

  return null;
};
