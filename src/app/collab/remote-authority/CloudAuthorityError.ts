import type { CollabCloudErrorEnvelope } from '@claudian-collab/protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

/** A decoded, request-correlated HTTP rejection; only an explicit outcome settles a mutation. */
export class CloudAuthorityRejection extends CollabError {
  constructor(
    error: ConstructorParameters<typeof CollabError>[0],
    readonly mutationOutcome?: CollabCloudErrorEnvelope['mutationOutcome'],
  ) {
    super(error);
  }

  // CollabError deliberately recognizes shared protocol errors. This narrower
  // provenance marker must recognize only errors constructed by this adapter.
  static override [Symbol.hasInstance](value: unknown): boolean {
    return Boolean(Function.prototype[Symbol.hasInstance].call(this, value));
  }
}

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
