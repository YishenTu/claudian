import { isCollabMemberId } from '@claudian-collab/protocol';

import { COLLAB_CONTROL_OPERATION_BINDINGS } from '@/app/collab/lan/CollabControlOperationBindings';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LANCollabControlOperationCodecs';
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
  const match = request.operationMatch;
  if (match.operation === 'createProjectRecoveryLink') {
    const decoded = lanCollabControlOperationCodec(match.operation).decodeRequest(request.body);
    if (decoded.status !== 'ok') throw decoded.error;
    if (decoded.value.projectId !== request.projectId || decoded.value.idempotencyKey !== request.idempotencyKey) throw routeError('membership-mutation-request-mismatch');
    if (!request.service.createProjectRecoveryLink) throw routeError('project-recovery-unavailable');
    return { data: await request.service.createProjectRecoveryLink(requireOperationCredential(request.authorization, match.operation), decoded.value) };
  }
  if (match.operation === 'redeemProjectRecoveryLink') {
    const decoded = lanCollabControlOperationCodec(match.operation).decodeRequest(request.body);
    if (decoded.status !== 'ok') throw decoded.error;
    if (decoded.value.projectId !== request.projectId || decoded.value.idempotencyKey !== request.idempotencyKey) throw routeError('membership-mutation-request-mismatch');
    if (!request.service.redeemProjectRecoveryLink) throw routeError('project-recovery-unavailable');
    return { data: await request.service.redeemProjectRecoveryLink(decoded.value) };
  }
  if (match.operation === 'listProjectMembers') {
    if (!request.service.listProjectMembers) throw routeError('membership-claims-unavailable');
    return { data: await request.service.listProjectMembers(requireOperationCredential(request.authorization, match.operation), request.projectId) };
  }
  if (match.operation === 'reissueTransferredMembershipClaim' || match.operation === 'claimTransferredMembership') {
    const decoded = lanCollabControlOperationCodec(match.operation).decodeRequest(request.body);
    if (decoded.status !== 'ok') throw decoded.error;
    if (decoded.value.projectId !== request.projectId || decoded.value.idempotencyKey !== request.idempotencyKey) throw routeError('membership-mutation-request-mismatch');
    if (match.operation === 'claimTransferredMembership') {
      if (!request.service.claimTransferredMembership || !('credentialHash' in decoded.value) || typeof decoded.value.credentialHash !== 'string') throw routeError('membership-claims-unavailable');
      return { data: await request.service.claimTransferredMembership({ ...decoded.value, credentialHash: decoded.value.credentialHash }) };
    }
    if (!request.service.reissueTransferredMembershipClaim || !('expectedClaimGeneration' in decoded.value)) throw routeError('membership-claims-unavailable');
    return { data: await request.service.reissueTransferredMembershipClaim(requireOperationCredential(request.authorization, match.operation), decoded.value) };
  }

  if (
    COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family === 'membership'
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
