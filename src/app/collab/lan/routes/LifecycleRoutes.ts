import { COLLAB_CONTROL_OPERATION_BINDINGS } from '@/app/collab/lan/CollabControlOperationBindings';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import type {
  LanCollabLifecycleControlOperation as CollabLifecycleControlOperation,
} from '@/app/collab/lan/LanCollabControlOperations';
import { requireOperationCredential } from '@/app/collab/lan/routes/RouteAuthentication';
import type {
  CollabControlRouteResult,
  CollabLifecycleRouteRequest,
} from '@/app/collab/lan/routes/RouteTypes';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function routeError(reason: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { reason },
  });
}

function decode<Operation extends CollabLifecycleControlOperation>(
  operation: Operation,
  input: unknown,
) {
  const decoded = lanCollabControlOperationCodec(operation).decodeRequest(input);
  if (decoded.status !== 'ok') throw decoded.error;
  return decoded.value;
}

function decodeMutation<Operation extends CollabLifecycleControlOperation>(
  operation: Operation,
  request: CollabLifecycleRouteRequest,
) {
  if (!request.idempotencyKey) throw routeError('idempotency-key-required');
  const decoded = decode(operation, request.body);
  if (
    !('projectId' in decoded)
    || decoded.projectId !== request.projectId
    || !('idempotencyKey' in decoded)
    || decoded.idempotencyKey !== request.idempotencyKey
  ) throw routeError('lifecycle-mutation-request-mismatch');
  return decoded;
}

function requirePathId(actual: string | undefined, expected: string, reason: string): void {
  if (actual !== expected) throw routeError(reason);
}

function execute<Operation extends CollabLifecycleControlOperation>(
  request: CollabLifecycleRouteRequest,
  credential: string | null,
  operation: Operation,
  input: ReturnType<typeof decode<Operation>>,
): Promise<CollabControlRouteResult> {
  return request.lifecycle.execute({ credential, operation, request: input });
}

export async function handleLifecycleRoute(
  request: CollabLifecycleRouteRequest,
): Promise<CollabControlRouteResult | null> {
  const { operationMatch: match } = request;
  if (COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family !== 'lifecycle') return null;
  const operation = match.operation as CollabLifecycleControlOperation;

  if (operation === 'getHostTransitions') {
    const input = decode('getHostTransitions', { projectId: request.projectId });
    return execute(request, null, operation, input);
  }

  const credential = requireOperationCredential(request.authorization, operation);
  switch (operation) {
    case 'getCurrentManagerResponsibilityOffer': {
      const input = decode(operation, { projectId: request.projectId });
      return execute(request, credential, operation, input);
    }
    case 'getManagerResponsibilityOffer': {
      const input = decode(operation, {
        offerId: match.parameters.offerId,
        projectId: request.projectId,
      });
      return execute(request, credential, operation, input);
    }
    case 'leaveProject': {
      const input = decodeMutation(operation, request);
      return execute(request, credential, operation, input);
    }
    case 'createManagerResponsibilityOffer': {
      const input = decodeMutation(operation, request);
      return execute(request, credential, operation, input);
    }
    case 'acknowledgeManagerResponsibility':
    case 'declineManagerResponsibility':
    case 'cancelManagerResponsibilityOffer': {
      const input = decodeMutation(operation, request);
      requirePathId(input.offerId, match.parameters.offerId ?? '', 'lifecycle-offer-path-mismatch');
      return execute(request, credential, operation, input);
    }
    case 'promoteManager':
    case 'demoteManager': {
      const input = decodeMutation(operation, request);
      requirePathId(input.targetMemberId, match.parameters.memberId ?? '', 'lifecycle-member-path-mismatch');
      return execute(request, credential, operation, input);
    }
    case 'createHostTransfer': {
      const input = decodeMutation(operation, request);
      return execute(request, credential, operation, input);
    }
    case 'acceptHostTransfer': {
      const input = decodeMutation(operation, request);
      requirePathId(input.transferId, match.parameters.transferId ?? '', 'lifecycle-transfer-path-mismatch');
      return execute(request, credential, operation, input);
    }
    case 'declineHostTransfer':
    case 'cancelHostTransfer': {
      const input = decodeMutation(operation, request);
      requirePathId(input.transferId, match.parameters.transferId ?? '', 'lifecycle-transfer-path-mismatch');
      return execute(request, credential, operation, input);
    }
    case 'retireProject': {
      const input = decodeMutation(operation, request);
      return execute(request, credential, operation, input);
    }
    case 'acknowledgeRetirement': {
      const input = decodeMutation(operation, request);
      return execute(request, credential, operation, input);
    }
  }
}
