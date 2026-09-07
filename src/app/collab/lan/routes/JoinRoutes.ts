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

function parseJoinRequest(request: CollabControlRouteRequest) {
  const decoded = lanCollabControlOperationCodec('createJoinAttempt')
    .decodeRequest(request.body);
  if (decoded.status !== 'ok') throw decoded.error;
  if (decoded.value.projectId !== request.projectId) throw routeError('project-id-mismatch');
  return decoded.value;
}

function parseActivationRequest(request: CollabControlRouteRequest, pathId: string) {
  const decoded = lanCollabControlOperationCodec('activateJoinAttempt')
    .decodeRequest(request.body);
  if (decoded.status !== 'ok') throw decoded.error;
  const { idempotencyKey, joinAttemptId, projectId } = decoded.value;
  if (
    projectId !== request.projectId
    || joinAttemptId !== pathId
    || idempotencyKey !== request.idempotencyKey
  ) {
    throw routeError('activation-request-mismatch');
  }
  return { idempotencyKey, joinAttemptId, projectId };
}

export const handleJoinRoute: CollabControlRouteHandler = async request => {
  const match = request.operationMatch
    ?? matchCollabControlOperation(request.method, request.segments);
  if (
    !match
    || COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family !== 'join'
  ) return null;

  if (match.operation === 'createJoinAttempt') {
    const invitationSecret = requireOperationCredential(request.authorization, match.operation);
    const joinAttempt = await request.service.createJoinAttempt(
      invitationSecret,
      parseJoinRequest(request),
      { remoteAddress: request.remoteAddress },
    );
    return { data: { joinAttempt } };
  }

  if (match.operation === 'activateJoinAttempt') {
    const joinAttemptId = match.parameters.joinAttemptId ?? '';
    if (!request.idempotencyKey) {
      throw routeError('activation-path-invalid');
    }
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    const snapshot = await request.service.activateJoinAttempt(
      memberCredential,
      parseActivationRequest(request, joinAttemptId),
    );
    return { data: snapshot };
  }

  return null;
};
