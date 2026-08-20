import { type CollabRequestTicketOperation, type ListTicketsRequest } from '@claudian/collab-protocol';

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
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function routeError(reason: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { reason },
  });
}

function decode<Operation extends CollabRequestTicketOperation>(
  operation: Operation,
  input: unknown,
) {
  const decoded = lanCollabControlOperationCodec(operation).decodeRequest(input);
  if (decoded.status !== 'ok') throw decoded.error;
  return decoded.value;
}

function ticketMutation<
  Operation extends 'closeTicket' | 'reopenTicket' | 'updateTicketContent',
>(
  request: CollabControlRouteRequest,
  ticketId: string,
  operation: Operation,
) {
  if (!request.idempotencyKey) throw routeError('idempotency-key-required');
  const body = decode(operation, request.body);
  if (
    body.ticketId !== ticketId
    || body.projectId !== request.projectId
    || body.idempotencyKey !== request.idempotencyKey
  ) {
    throw routeError('ticket-mutation-payload-invalid');
  }
  return body;
}

function listRequest(request: CollabControlRouteRequest): ListTicketsRequest {
  const allowed = new Set(['cursor', 'limit', 'status']);
  if (Object.keys(request.query).some(field => !allowed.has(field))) {
    throw routeError('ticket-list-query-invalid');
  }
  const status = request.query.status;
  const limitValue = request.query.limit;
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (
    (status !== 'open' && status !== 'closed' && status !== 'all')
    || (limit !== undefined && (
      !/^\d+$/.test(limitValue)
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > CLAUDIAN_COLLAB_LIMITS.maxTicketPageSize
    ))
  ) {
    throw routeError('ticket-list-query-invalid');
  }
  return decode('listTickets', {
    ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
    ...(limit === undefined ? {} : { limit }),
    projectId: request.projectId,
    status,
  });
}

export const handleTicketRoute: CollabControlRouteHandler = async request => {
  const match = request.operationMatch
    ?? matchCollabControlOperation(request.method, request.segments);
  if (
    !match
    || COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family !== 'ticket'
  ) return null;
  const memberCredential = requireOperationCredential(request.authorization, match.operation);
  const ticketId = match.parameters.ticketId;

  if (match.operation === 'listTickets') {
    return {
      data: await request.service.listTickets(memberCredential, listRequest(request)),
    };
  }

  if (match.operation === 'getTicket' && ticketId) {
    return {
      data: await request.service.getTicket(
        memberCredential,
        request.projectId,
        ticketId,
      ),
    };
  }

  if (match.operation === 'listTicketComments' && ticketId) {
    return {
      data: await request.service.listTicketComments(
        memberCredential,
        decode('listTicketComments', {
          ...decodeRoutePageQuery(request, 'ticket-comment-page-query-invalid'),
          projectId: request.projectId,
          ticketId,
        }),
      ),
    };
  }

  if (match.operation === 'listTicketAcceptedRelations' && ticketId) {
    return {
      data: await request.service.listTicketAcceptedRelations(
        memberCredential,
        decode('listTicketAcceptedRelations', {
          ...decodeRoutePageQuery(request, 'ticket-relation-page-query-invalid'),
          projectId: request.projectId,
          ticketId,
        }),
      ),
    };
  }

  if (match.operation === 'createTicket') {
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const body = decode('createTicket', request.body);
    if (
      body.projectId !== request.projectId
      || body.idempotencyKey !== request.idempotencyKey
    ) {
      throw routeError('ticket-mutation-context-invalid');
    }
    return {
      data: await request.service.createTicket(memberCredential, {
        body: body.body,
        idempotencyKey: body.idempotencyKey,
        projectId: request.projectId,
        title: body.title,
      }),
    };
  }

  if (match.operation === 'updateTicketContent' && ticketId) {
    const body = ticketMutation(request, ticketId, match.operation);
    return {
      data: await request.service.updateTicketContent(memberCredential, {
        ...body,
        body: body.body,
        title: body.title,
      }),
    };
  }

  if (match.operation === 'createTicketComment' && ticketId) {
    if (!request.idempotencyKey) throw routeError('idempotency-key-required');
    const body = decode('createTicketComment', request.body);
    if (
      body.ticketId !== ticketId
      || body.projectId !== request.projectId
      || body.idempotencyKey !== request.idempotencyKey
    ) {
      throw routeError('ticket-comment-payload-invalid');
    }
    return {
      data: await request.service.createTicketComment(memberCredential, {
        body: body.body,
        idempotencyKey: body.idempotencyKey,
        projectId: request.projectId,
        ticketId,
      }),
    };
  }

  if (
    (match.operation === 'closeTicket' || match.operation === 'reopenTicket')
    && ticketId
  ) {
    const closing = match.operation === 'closeTicket';
    const mutation = ticketMutation(
      request,
      ticketId,
      match.operation,
    );
    const data = closing
      ? await request.service.closeTicket(memberCredential, mutation)
      : await request.service.reopenTicket(memberCredential, mutation);
    return { data };
  }

  return null;
};
