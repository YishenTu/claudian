import { CollabError } from '@/core/collab/ClaudianCollabError';

export function cloudAuthorityError(
  code: 'cancelled' | 'endpoint-unreachable' | 'operation-failed'
    | 'operation-timeout' | 'protocol-payload-invalid',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'protocol-payload-invalid'
      ? ['open-diagnostics']
      : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

export function cloudAuthorityOperationError(reason: string): CollabError {
  return cloudAuthorityError('operation-failed', reason);
}

export function cloudAuthorityProtocolError(reason: string): CollabError {
  return cloudAuthorityError('protocol-payload-invalid', reason);
}
