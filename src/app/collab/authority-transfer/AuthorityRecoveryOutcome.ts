import { CollabError, type CollabErrorCode } from '@/core/collab/ClaudianCollabError';

/** An observation result, never proof that a durable transfer may be abandoned. */
export type AuthorityRecoveryOutcome =
  | { readonly kind: 'completed' | 'idle' | 'waiting' | 'cancelled' }
  | { readonly kind: 'retryable' | 'blocked'; readonly code: CollabErrorCode };

/** Keep raw transport exceptions and credentials out of background recovery state. */
export async function attemptAuthorityRecovery(
  operation: () => Promise<AuthorityRecoveryOutcome>,
  signal: AbortSignal,
): Promise<AuthorityRecoveryOutcome> {
  if (signal.aborted) return { kind: 'cancelled' };
  try {
    return await operation();
  } catch (error) {
    if (signal.aborted || error instanceof CollabError && error.code === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (error instanceof CollabError) {
      const blocked = error.code === 'durable-progress-recovery-required'
        || error.group === 'integrity' || error.group === 'authorization'
        || error.code === 'tls-ca-mismatch' || error.code === 'tls-untrusted';
      return { kind: blocked ? 'blocked' : 'retryable', code: error.code };
    }
    return { kind: 'retryable', code: 'operation-failed' };
  }
}
