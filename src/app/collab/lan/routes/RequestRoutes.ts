import { type CollabRequestTicketOperation } from '@claudian/collab-protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  matchCollabControlOperation,
} from '@/app/collab/lan/CollabControlOperationBindings';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import { requireOperationCredential } from '@/app/collab/lan/routes/RouteAuthentication';
import { decodeRoutePageQuery } from '@/app/collab/lan/routes/RoutePageQuery';
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decode<Operation extends CollabRequestTicketOperation>(
  operation: Operation,
  input: unknown,
) {
  const decoded = lanCollabControlOperationCodec(operation).decodeRequest(input);
  if (decoded.status !== 'ok') throw decoded.error;
  return decoded.value;
}

function parseEnsureRequest(request: CollabControlRouteRequest) {
  if (!isRecord(request.body)) throw routeError('request-ensure-body-invalid');
  const decoded = decode('ensureMyRequest', request.body);
  if (
    decoded.projectId !== request.projectId
    || decoded.idempotencyKey !== request.idempotencyKey
  ) {
    throw routeError('request-ensure-payload-invalid');
  }
  return decoded;
}

function parseCommentRequest(request: CollabControlRouteRequest, requestId: string) {
  if (!isRecord(request.body)) throw routeError('request-comment-body-invalid');
  const decoded = decode('createComment', request.body);
  if (
    decoded.projectId !== request.projectId
    || decoded.requestId !== requestId
    || decoded.idempotencyKey !== request.idempotencyKey
  ) {
    throw routeError('request-comment-payload-invalid');
  }
  return decoded;
}

function parseAcceptRequest(request: CollabControlRouteRequest, requestId: string) {
  if (!isRecord(request.body)) throw routeError('request-accept-body-invalid');
  const decoded = decode('acceptRequest', request.body);
  if (
    decoded.projectId !== request.projectId
    || decoded.requestId !== requestId
    || decoded.idempotencyKey !== request.idempotencyKey
  ) {
    throw routeError('request-accept-payload-invalid');
  }
  return decoded;
}

function parseMetadataRequest(request: CollabControlRouteRequest, requestId: string) {
  if (!isRecord(request.body)) throw routeError('request-metadata-body-invalid');
  const decoded = decode('updateMyRequestMetadata', request.body);
  if (
    decoded.projectId !== request.projectId
    || decoded.requestId !== requestId
    || decoded.idempotencyKey !== request.idempotencyKey
  ) {
    throw routeError('request-metadata-payload-invalid');
  }
  return decoded;
}

export const handleRequestRoute: CollabControlRouteHandler = async request => {
  const match = request.operationMatch
    ?? matchCollabControlOperation(request.method, request.segments);
  if (
    !match
    || COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family !== 'request'
  ) return null;
  const requestId = match.parameters.requestId;

  if (match.operation === 'updateMyRequestMetadata' && requestId) {
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.updateMyRequestMetadata(
        memberCredential,
        parseMetadataRequest(request, requestId),
      ),
    };
  }

  if (match.operation === 'getRequest' && requestId) {
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.readRequest(memberCredential, {
        projectId: request.projectId,
        requestId,
      }),
    };
  }

  if (match.operation === 'listRequestComments' && requestId) {
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.listRequestComments(
        memberCredential,
        decode('listRequestComments', {
          ...decodeRoutePageQuery(request, 'request-comment-page-query-invalid'),
          projectId: request.projectId,
          requestId,
        }),
      ),
    };
  }

  if (match.operation === 'acceptRequest' && requestId) {
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.acceptRequest(
        memberCredential,
        parseAcceptRequest(request, requestId),
      ),
    };
  }

  if (match.operation === 'createComment' && requestId) {
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const memberCredential = requireOperationCredential(request.authorization, match.operation);
    return {
      data: await request.service.createComment(
        memberCredential,
        parseCommentRequest(request, requestId),
      ),
    };
  }

  if (match.operation !== 'ensureMyRequest') return null;
  if (!request.idempotencyKey) throw routeError('idempotency-key-required');
  const memberCredential = requireOperationCredential(request.authorization, match.operation);
  return {
    data: await request.service.ensureMyRequest(
      memberCredential,
      parseEnsureRequest(request),
    ),
  };
};
