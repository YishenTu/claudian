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

function parseMutationContext(
  operation: 'createInvitation' | 'revokeInvitation',
  request: CollabControlRouteRequest,
) {
  const decoded = lanCollabControlOperationCodec(operation).decodeRequest(request.body);
  if (decoded.status !== 'ok') throw decoded.error;
  const { idempotencyKey, projectId } = decoded.value;
  if (
    projectId !== request.projectId
    || idempotencyKey !== request.idempotencyKey
  ) {
    throw routeError('mutation-request-mismatch');
  }
  return { idempotencyKey, projectId };
}

function parseRefreshInvitation(request: CollabControlRouteRequest) {
  const decoded = lanCollabControlOperationCodec('refreshEndpoint')
    .decodeRequest(request.body);
  if (decoded.status !== 'ok') throw decoded.error;
  if (decoded.value.projectId !== request.projectId) {
    throw routeError('endpoint-refresh-request-invalid');
  }
  return decoded.value.invitation;
}

export const handleProjectRoute: CollabControlRouteHandler = async request => {
  const match = request.operationMatch
    ?? matchCollabControlOperation(request.method, request.segments);
  if (
    !match
    || COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family !== 'project'
  ) return null;

  if (match.operation === 'getSnapshot') {
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return { data: await request.service.readSnapshot(memberCredential) };
  }

  if (match.operation === 'confirmEndpoint') {
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.confirmEndpoint(
        memberCredential,
        request.projectId,
      ),
    };
  }

  if (match.operation === 'createInvitation') {
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    const invitation = await request.service.createInvitation(
      memberCredential,
      parseMutationContext('createInvitation', request),
    );
    return {
      data: {
        encodedInvitation: request.service.encodeInvitation(invitation),
        invitation,
      },
    };
  }

  if (match.operation === 'revokeInvitation') {
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    await request.service.revokeInvitation(
      memberCredential,
      parseMutationContext('revokeInvitation', request),
    );
    return { data: await request.service.readSnapshot(memberCredential) };
  }

  if (match.operation === 'refreshEndpoint') {
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.refreshEndpoint(
        memberCredential,
        parseRefreshInvitation(request),
      ),
    };
  }

  return null;
};
