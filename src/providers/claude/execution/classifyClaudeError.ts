import type { ProviderSessionInvalidation } from '../../../core/execution';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import {
  getMissingSessionId,
  isSessionMissingError,
} from '../../../utils/session';

export type ClaudeErrorCategory =
  | 'provider-session-missing'
  | 'authentication'
  | 'configuration'
  | 'transport'
  | 'process-exited'
  | 'provider';

export interface ClaudeErrorDetails {
  category: ClaudeErrorCategory;
  message: string;
  recoverable: boolean;
  missingProviderSessionId?: string;
}

/**
 * Typed signals win. Text matching is the fallback for plain `Error`s whose
 * only contract is their message: the SDK's ProcessTransport throws untyped
 * `Error`s ("Claude Code process exited with code N", "ProcessTransport is not
 * ready for writing"), CLI/Node resolution failures carry no code, and
 * `native_error` messages arrive re-wrapped without their origin.
 * The SDK `AbortError` is deliberately not checked: it sets no `name`, and a
 * value import would evaluate the lazily loaded SDK bundle at plugin startup.
 */
export function classifyClaudeError(
  error: unknown,
  expectedSessionId: string | null,
  explicitMissingSessionId?: string,
): ClaudeErrorDetails {
  const message = error instanceof Error
    ? error.message
    : String(error);
  if (
    explicitMissingSessionId
    || isSessionMissingError(error, expectedSessionId ?? undefined)
  ) {
    return {
      category: 'provider-session-missing',
      message,
      recoverable: true,
      missingProviderSessionId: explicitMissingSessionId
        ?? getMissingSessionId(error)
        ?? undefined,
    };
  }
  if (error instanceof ProviderModelUnavailableError) {
    return { category: 'configuration', message, recoverable: true };
  }
  if ((error as NodeJS.ErrnoException | null)?.code === 'EPIPE') {
    return { category: 'process-exited', message, recoverable: true };
  }
  return {
    category: classifyErrorText(message.toLowerCase()),
    message,
    recoverable: true,
  };
}

function classifyErrorText(normalized: string): ClaudeErrorCategory {
  if (
    normalized.includes('authentication')
    || normalized.includes('unauthorized')
    || normalized.includes('api key')
  ) {
    return 'authentication';
  }
  if (
    normalized.includes('cli not found')
    || normalized.includes('node.js')
    || normalized.includes('could not determine')
  ) {
    return 'configuration';
  }
  if (
    normalized.includes('process exited')
    || normalized.includes('epipe')
  ) {
    return 'process-exited';
  }
  if (
    normalized.includes('transport')
    || normalized.includes('connection')
  ) {
    return 'transport';
  }
  return 'provider';
}

export function getClaudeInvalidationReason(
  category: ClaudeErrorCategory,
): ProviderSessionInvalidation['reason'] {
  switch (category) {
    case 'provider-session-missing':
      return 'provider-session-missing';
    case 'process-exited':
      return 'process-exited';
    case 'transport':
      return 'transport-closed';
    default:
      return 'provider-error';
  }
}
