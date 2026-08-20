import { CollabError } from './CollabError';
import {
  type CollabControlOperationMap,
  type CollabDecodeResult,
} from './CollabProtocol';
import {
  type CollabRequestTicketOperation,
  decodeCollabRequestTicketOperationRequest,
} from './CollabRequestTicketRequestCodecs';
import {
  decodeAcceptResponse,
  decodeCommentPageResponse,
  decodeCreateCommentResponse,
  decodeCreateTicketResponse,
  decodeEnsureMyRequestResponse,
  decodeRequestDetailResponse,
  decodeTicketAcceptedRelationPageResponse,
  decodeTicketCommentPageResponse,
  decodeTicketCommentResponse,
  decodeTicketDetailResponse,
  decodeTicketMutationResponse,
  decodeTicketPageResponse,
  decodeUpdateRequestMetadataResponse,
} from './CollabRequestTicketResponseCodecs';
export type CollabControlOperation = keyof CollabControlOperationMap;

export interface CollabControlOperationCodec<Request, Response> {
  readonly decodeRequest: (input: unknown) => CollabDecodeResult<Request>;
  readonly decodeResponse: (input: unknown) => Response;
}

type CodecMap = {
  readonly [Operation in CollabControlOperation]: CollabControlOperationCodec<
    CollabControlOperationMap[Operation]['request'],
    CollabControlOperationMap[Operation]['response']
  >;
};

function decodeRequest(
  operation: CollabControlOperation,
  input: unknown,
): CollabDecodeResult<unknown> {
  return decodeCollabRequestTicketOperationRequest(
    operation as CollabRequestTicketOperation,
    input,
  );
}

function decodeResponse(operation: CollabControlOperation, input: unknown): unknown {
  switch (operation) {
    case 'getRequest': return decodeRequestDetailResponse(input);
    case 'listRequestComments': return decodeCommentPageResponse(input);
    case 'ensureMyRequest': return decodeEnsureMyRequestResponse(input);
    case 'createComment': return decodeCreateCommentResponse(input);
    case 'listTickets': return decodeTicketPageResponse(input);
    case 'getTicket': return decodeTicketDetailResponse(input);
    case 'listTicketComments': return decodeTicketCommentPageResponse(input);
    case 'listTicketAcceptedRelations':
      return decodeTicketAcceptedRelationPageResponse(input);
    case 'createTicket': return decodeCreateTicketResponse(input);
    case 'updateTicketContent': return decodeTicketMutationResponse(input);
    case 'createTicketComment': return decodeTicketCommentResponse(input);
    case 'closeTicket': return decodeTicketMutationResponse(input);
    case 'reopenTicket': return decodeTicketMutationResponse(input);
    case 'updateMyRequestMetadata': return decodeUpdateRequestMetadataResponse(input);
    case 'acceptRequest': return decodeAcceptResponse(input);
  }
}

function codec<Operation extends CollabControlOperation>(
  operation: Operation,
): CodecMap[Operation] {
  return Object.freeze({
    decodeRequest: (input: unknown) => decodeRequest(operation, input) as CollabDecodeResult<
      CollabControlOperationMap[Operation]['request']
    >,
    decodeResponse: (input: unknown) => decodeResponse(operation, input) as
      CollabControlOperationMap[Operation]['response'],
  }) as unknown as CodecMap[Operation];
}

export const COLLAB_CONTROL_OPERATION_CODECS = Object.freeze({
  getRequest: codec('getRequest'),
  listRequestComments: codec('listRequestComments'),
  ensureMyRequest: codec('ensureMyRequest'),
  createComment: codec('createComment'),
  listTickets: codec('listTickets'),
  getTicket: codec('getTicket'),
  listTicketComments: codec('listTicketComments'),
  listTicketAcceptedRelations: codec('listTicketAcceptedRelations'),
  createTicket: codec('createTicket'),
  updateTicketContent: codec('updateTicketContent'),
  createTicketComment: codec('createTicketComment'),
  closeTicket: codec('closeTicket'),
  reopenTicket: codec('reopenTicket'),
  updateMyRequestMetadata: codec('updateMyRequestMetadata'),
  acceptRequest: codec('acceptRequest'),
} as const satisfies CodecMap);

export function collabControlOperationCodec<Operation extends CollabControlOperation>(
  operation: Operation,
): CodecMap[Operation] {
  if (!Object.hasOwn(COLLAB_CONTROL_OPERATION_CODECS, operation)) {
    throw new CollabError({
      code: 'operation-failed',
      safeContext: { reason: 'control-operation-codec-missing' },
    });
  }
  const selected = COLLAB_CONTROL_OPERATION_CODECS[operation];
  return selected;
}
