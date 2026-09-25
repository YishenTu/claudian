import {
  COLLAB_CONTROL_OPERATION_CODECS,
  type CollabControlOperationCodec,
  type CollabDecodeResult,
  type CollabProjectRecoveryOperationMap,
  type CollabRequestTicketOperation,
} from '@claudian-collab/protocol';

import type {
  LANCollabControlOperation,
  LANCollabControlOperationMap,
  LANCollabLifecycleControlOperation,
} from '@/app/collab/lan/LANCollabControlOperations';
import { decodeLANCollabEnvelopeData } from '@/app/collab/lan/LANCollabEnvelope';
import {
  type CollabGeneralControlOperation,
  decodeCollabGeneralOperationRequest,
  decodeEndpointResponse,
  decodeInvitationResponse,
  decodeJoinAttemptResponse,
  decodeMembershipTerminationResponse,
} from '@/app/collab/lan/LANCollabGeneralControlCodecs';
import {
  decodeLANCollabLifecycleOperationRequest,
  decodeLANCollabLifecycleOperationResponse,
} from '@/app/collab/lan/LANCollabLifecycleCodecs';
import { decodeLANCollabProjectSnapshot } from '@/app/collab/lan/LANCollabProjectSnapshotCodec';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type LANCodecMap = {
  readonly [Operation in LANCollabControlOperation]: CollabControlOperationCodec<
    LANCollabControlOperationMap[Operation]['request'],
    LANCollabControlOperationMap[Operation]['response']
  >;
};

function lifecycleResponse(
  operation: LANCollabLifecycleControlOperation,
  input: unknown,
): unknown {
  const decoded = decodeLANCollabLifecycleOperationResponse(
    operation,
    decodeLANCollabEnvelopeData(input),
  );
  if (decoded.status !== 'ok') throw decoded.error;
  return decoded.value;
}

function codec<Operation extends Exclude<
  LANCollabControlOperation,
  CollabRequestTicketOperation
>>(
  operation: Operation,
  decodeRequest: (input: unknown) => CollabDecodeResult<
    LANCollabControlOperationMap[Operation]['request']
  >,
  decodeResponse: (input: unknown) => LANCollabControlOperationMap[Operation]['response'],
): LANCodecMap[Operation] {
  return Object.freeze({ decodeRequest, decodeResponse }) as LANCodecMap[Operation];
}

function generalCodec<Operation extends CollabGeneralControlOperation>(
  operation: Operation,
  decodeResponse: (input: unknown) => LANCollabControlOperationMap[Operation]['response'],
): LANCodecMap[Operation] {
  return codec(
    operation,
    input => decodeCollabGeneralOperationRequest(operation, input),
    decodeResponse,
  );
}

function lifecycleCodec<Operation extends LANCollabLifecycleControlOperation>(
  operation: Operation,
): LANCodecMap[Operation] {
  return codec(
    operation,
    input => decodeLANCollabLifecycleOperationRequest(operation, input),
    input => lifecycleResponse(operation, input) as LANCollabControlOperationMap[Operation]['response'],
  );
}

function sharedCodec<Operation extends CollabRequestTicketOperation | keyof CollabProjectRecoveryOperationMap | 'listProjectMembers' | 'reissueTransferredMembershipClaim' | 'claimTransferredMembership'>(
  operation: Operation,
): LANCodecMap[Operation] {
  const shared = COLLAB_CONTROL_OPERATION_CODECS[operation];
  return Object.freeze({
    decodeRequest: shared.decodeRequest,
    decodeResponse: (input: unknown) => shared.decodeResponse(
      decodeLANCollabEnvelopeData(input),
    ),
  }) as LANCodecMap[Operation];
}

export const LAN_COLLAB_CONTROL_OPERATION_CODECS = Object.freeze({
  createProjectRecoveryLink: sharedCodec('createProjectRecoveryLink'),
  redeemProjectRecoveryLink: sharedCodec('redeemProjectRecoveryLink'),
  listProjectMembers: sharedCodec('listProjectMembers'),
  reissueTransferredMembershipClaim: sharedCodec('reissueTransferredMembershipClaim'),
  claimTransferredMembership: sharedCodec('claimTransferredMembership'),
  getRequest: sharedCodec('getRequest'),
  listRequestComments: sharedCodec('listRequestComments'),
  ensureMyRequest: sharedCodec('ensureMyRequest'),
  createComment: sharedCodec('createComment'),
  listTickets: sharedCodec('listTickets'),
  resolveTicketNumber: sharedCodec('resolveTicketNumber'),
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
    input => decodeLANCollabProjectSnapshot(decodeLANCollabEnvelopeData(input)),
  ),
  getSnapshot: generalCodec(
    'getSnapshot',
    input => decodeLANCollabProjectSnapshot(decodeLANCollabEnvelopeData(input)),
  ),
  createInvitation: generalCodec('createInvitation', decodeInvitationResponse),
  revokeInvitation: generalCodec(
    'revokeInvitation',
    input => decodeLANCollabProjectSnapshot(decodeLANCollabEnvelopeData(input)),
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
} as const satisfies LANCodecMap);

export function lanCollabControlOperationCodec<Operation extends LANCollabControlOperation>(
  operation: Operation,
): LANCodecMap[Operation] {
  if (!Object.hasOwn(LAN_COLLAB_CONTROL_OPERATION_CODECS, operation)) {
    throw new CollabError({
      code: 'operation-failed',
      safeContext: { reason: 'control-operation-codec-missing' },
    });
  }
  return LAN_COLLAB_CONTROL_OPERATION_CODECS[operation];
}
