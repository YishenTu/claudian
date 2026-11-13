import { t } from '@/i18n/i18n';

import type { ProviderExecutionErrorCategory } from './ProviderExecutionEvent';

/**
 * The user-facing form of a terminal execution error. A missing native session keeps its binding,
 * so it explains that the session is unavailable under the current CLI configuration instead of
 * showing the native wording.
 */
export function presentExecutionError<T extends { category: ProviderExecutionErrorCategory; message: string }>(
  error: T,
): T {
  return error.category === 'provider-session-missing'
    ? { ...error, message: t('chat.executionNotices.sessionUnavailable') }
    : error;
}
