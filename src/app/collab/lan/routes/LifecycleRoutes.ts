import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  matchCollabControlOperation,
} from '@/app/collab/lan/CollabControlOperationBindings';
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

interface LifecycleRouteMatch {
  readonly memberId?: string;
  readonly offerId?: string;
  readonly operation: CollabLifecycleControlOperation;
  readonly transferId?: string;
}

function matchLifecycleControlRoute(
  method: string,
  segments: readonly string[],
): LifecycleRouteMatch | null {
  const match = matchCollabControlOperation(method, segments);
  if (
    !match
    || COLLAB_CONTROL_OPERATION_BINDINGS[match.operation].family !== 'lifecycle'
  ) return null;
  return {
    ...(match.parameters.memberId ? { memberId: match.parameters.memberId } : {}),
    ...(match.parameters.offerId ? { offerId: match.parameters.offerId } : {}),
    operation: match.operation as CollabLifecycleControlOperation,
    ...(match.parameters.transferId ? { transferId: match.parameters.transferId } : {}),
  };
}

export function isLifecycleControlRoute(
  method: string | undefined,
  segments: readonly string[],
): boolean {
  return matchLifecycleControlRoute(method ?? '', segments) !== null;
}

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
  const sharedMatch = request.operationMatch;
  const match = sharedMatch
    && COLLAB_CONTROL_OPERATION_BINDINGS[sharedMatch.operation].family === 'lifecycle'
    ? {
      ...(sharedMatch.parameters.memberId
        ? { memberId: sharedMatch.parameters.memberId }
        : {}),
      ...(sharedMatch.parameters.offerId
        ? { offerId: sharedMatch.parameters.offerId }
        : {}),
      operation: sharedMatch.operation as CollabLifecycleControlOperation,
      ...(sharedMatch.parameters.transferId
        ? { transferId: sharedMatch.parameters.transferId }
        : {}),
    }
    : matchLifecycleControlRoute(request.method, request.segments);
  if (!match) return null;

  if (match.operation === 'getHostTransitions') {
    const input = decode('getHostTransitions', { projectId: request.projectId });
    return execute(request, null, match.operation, input);
  }

  const credential = requireOperationCredential(request.authorization, match.operation);
  switch (match.operation) {
    case 'getCurrentManagerResponsibilityOffer': {
      const input = decode(match.operation, { projectId: request.projectId });
      return execute(request, credential, match.operation, input);
    }
    case 'getManagerResponsibilityOffer': {
      const input = decode(match.operation, {
        offerId: match.offerId,
        projectId: request.projectId,
      });
      return execute(request, credential, match.operation, input);
    }
    case 'leaveProject': {
      const input = decodeMutation(match.operation, request);
      return execute(request, credential, match.operation, input);
    }
    case 'createManagerResponsibilityOffer': {
      const input = decodeMutation(match.operation, request);
      return execute(request, credential, match.operation, input);
    }
    case 'acknowledgeManagerResponsibility':
    case 'declineManagerResponsibility':
    case 'cancelManagerResponsibilityOffer': {
      const input = decodeMutation(match.operation, request);
      requirePathId(input.offerId, match.offerId ?? '', 'lifecycle-offer-path-mismatch');
      return execute(request, credential, match.operation, input);
    }
    case 'promoteManager':
    case 'demoteManager': {
      const input = decodeMutation(match.operation, request);
      requirePathId(input.targetMemberId, match.memberId ?? '', 'lifecycle-member-path-mismatch');
      return execute(request, credential, match.operation, input);
    }
    case 'createHostTransfer': {
      const input = decodeMutation(match.operation, request);
      return execute(request, credential, match.operation, input);
    }
    case 'acceptHostTransfer': {
      const input = decodeMutation(match.operation, request);
      requirePathId(input.transferId, match.transferId ?? '', 'lifecycle-transfer-path-mismatch');
      return execute(request, credential, match.operation, input);
    }
    case 'declineHostTransfer':
    case 'cancelHostTransfer': {
      const input = decodeMutation(match.operation, request);
      requirePathId(input.transferId, match.transferId ?? '', 'lifecycle-transfer-path-mismatch');
      return execute(request, credential, match.operation, input);
    }
    case 'retireProject': {
      const input = decodeMutation(match.operation, request);
      return execute(request, credential, match.operation, input);
    }
    case 'acknowledgeRetirement': {
      const input = decodeMutation(match.operation, request);
      return execute(request, credential, match.operation, input);
    }
  }
}
