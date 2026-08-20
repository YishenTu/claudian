import { COLLAB_CONTROL_OPERATION_CODECS, type CollabControlOperationCodec, type CollabDecodeResult } from '@claudian/collab-protocol';

import type {
  LanCollabControlOperation,
  LanCollabControlOperationMap,
  LanCollabLifecycleControlOperation,
} from '@/app/collab/lan/LanCollabControlOperations';
import { decodeLanCollabEnvelopeData } from '@/app/collab/lan/LanCollabEnvelope';
import {
  type CollabGeneralControlOperation,
  decodeCollabGeneralOperationRequest,
  decodeEndpointResponse,
  decodeInvitationResponse,
  decodeJoinAttemptResponse,
  decodeMembershipTerminationResponse,
} from '@/app/collab/lan/LanCollabGeneralControlCodecs';
import {
  decodeLanCollabLifecycleOperationRequest,
  decodeLanCollabLifecycleOperationResponse,
} from '@/app/collab/lan/LanCollabLifecycleCodecs';
import { decodeLanCollabProjectSnapshot } from '@/app/collab/lan/LanCollabProjectSnapshotCodec';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type LanCodecMap = {
  readonly [Operation in LanCollabControlOperation]: CollabControlOperationCodec<
    LanCollabControlOperationMap[Operation]['request'],
    LanCollabControlOperationMap[Operation]['response']
  >;
};

function lifecycleResponse(
  operation: LanCollabLifecycleControlOperation,
  input: unknown,
): unknown {
  const decoded = decodeLanCollabLifecycleOperationResponse(
    operation,
    decodeLanCollabEnvelopeData(input),
  );
  if (decoded.status !== 'ok') throw decoded.error;
  return decoded.value;
}

function codec<Operation extends Exclude<
  LanCollabControlOperation,
  keyof typeof COLLAB_CONTROL_OPERATION_CODECS
>>(
  operation: Operation,
  decodeRequest: (input: unknown) => CollabDecodeResult<
    LanCollabControlOperationMap[Operation]['request']
  >,
  decodeResponse: (input: unknown) => LanCollabControlOperationMap[Operation]['response'],
): LanCodecMap[Operation] {
  return Object.freeze({ decodeRequest, decodeResponse }) as LanCodecMap[Operation];
}

function generalCodec<Operation extends CollabGeneralControlOperation>(
  operation: Operation,
  decodeResponse: (input: unknown) => LanCollabControlOperationMap[Operation]['response'],
): LanCodecMap[Operation] {
  return codec(
    operation,
    input => decodeCollabGeneralOperationRequest(operation, input),
    decodeResponse,
  );
}

function lifecycleCodec<Operation extends LanCollabLifecycleControlOperation>(
  operation: Operation,
): LanCodecMap[Operation] {
  return codec(
    operation,
    input => decodeLanCollabLifecycleOperationRequest(operation, input),
    input => lifecycleResponse(operation, input) as LanCollabControlOperationMap[Operation]['response'],
  );
}

function sharedCodec<Operation extends keyof typeof COLLAB_CONTROL_OPERATION_CODECS>(
  operation: Operation,
): LanCodecMap[Operation] {
  const shared = COLLAB_CONTROL_OPERATION_CODECS[operation];
  return Object.freeze({
    decodeRequest: shared.decodeRequest,
    decodeResponse: (input: unknown) => shared.decodeResponse(
      decodeLanCollabEnvelopeData(input),
    ),
  }) as LanCodecMap[Operation];
}

export const LAN_COLLAB_CONTROL_OPERATION_CODECS = Object.freeze({
  getRequest: sharedCodec('getRequest'),
  listRequestComments: sharedCodec('listRequestComments'),
  ensureMyRequest: sharedCodec('ensureMyRequest'),
  createComment: sharedCodec('createComment'),
  listTickets: sharedCodec('listTickets'),
  getTicket: sharedCodec('getTicket'),
  listTicketComments: sharedCodec('listTicketComments'),
  listTicketAcceptedRelations: sharedCodec('listTicketAcceptedRelations'),
  createTicket: sharedCodec('createTicket'),
  updateTicketContent: sharedCodec('updateTicketContent'),
  createTicketComment: sharedCodec('createTicketComment'),
  closeTicket: sharedCodec('closeTicket'),
  reopenTicket: sharedCodec('reopenTicket'),
  updateMyRequestMetadata: sharedCodec('updateMyRequestMetadata'),
  acceptRequest: sharedCodec('acceptRequest'),
  createJoinAttempt: generalCodec('createJoinAttempt', decodeJoinAttemptResponse),
  activateJoinAttempt: generalCodec(
    'activateJoinAttempt',
    input => decodeLanCollabProjectSnapshot(decodeLanCollabEnvelopeData(input)),
  ),
  getSnapshot: generalCodec(
    'getSnapshot',
    input => decodeLanCollabProjectSnapshot(decodeLanCollabEnvelopeData(input)),
  ),
  createInvitation: generalCodec('createInvitation', decodeInvitationResponse),
  revokeInvitation: generalCodec(
    'revokeInvitation',
    input => decodeLanCollabProjectSnapshot(decodeLanCollabEnvelopeData(input)),
  ),
  createManagerResponsibilityOffer: lifecycleCodec('createManagerResponsibilityOffer'),
  getCurrentManagerResponsibilityOffer: lifecycleCodec('getCurrentManagerResponsibilityOffer'),
  getManagerResponsibilityOffer: lifecycleCodec('getManagerResponsibilityOffer'),
  acknowledgeManagerResponsibility: lifecycleCodec('acknowledgeManagerResponsibility'),
  declineManagerResponsibility: lifecycleCodec('declineManagerResponsibility'),
  cancelManagerResponsibilityOffer: lifecycleCodec('cancelManagerResponsibilityOffer'),
  promoteManager: lifecycleCodec('promoteManager'),
  demoteManager: lifecycleCodec('demoteManager'),
  createHostTransfer: lifecycleCodec('createHostTransfer'),
  acceptHostTransfer: lifecycleCodec('acceptHostTransfer'),
  declineHostTransfer: lifecycleCodec('declineHostTransfer'),
  cancelHostTransfer: lifecycleCodec('cancelHostTransfer'),
  removeMember: generalCodec('removeMember', decodeMembershipTerminationResponse),
  leaveProject: lifecycleCodec('leaveProject'),
  retireProject: lifecycleCodec('retireProject'),
  acknowledgeRetirement: lifecycleCodec('acknowledgeRetirement'),
  getHostTransitions: lifecycleCodec('getHostTransitions'),
  refreshEndpoint: generalCodec('refreshEndpoint', decodeEndpointResponse),
  confirmEndpoint: generalCodec('confirmEndpoint', decodeEndpointResponse),
} as const satisfies LanCodecMap);

export function lanCollabControlOperationCodec<Operation extends LanCollabControlOperation>(
  operation: Operation,
): LanCodecMap[Operation] {
  if (!Object.hasOwn(LAN_COLLAB_CONTROL_OPERATION_CODECS, operation)) {
    throw new CollabError({
      code: 'operation-failed',
      safeContext: { reason: 'control-operation-codec-missing' },
    });
  }
  return LAN_COLLAB_CONTROL_OPERATION_CODECS[operation];
}
