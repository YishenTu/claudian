import type { ProviderHistoryInput, ProviderHistoryState } from './types';

/** Give native parsers a detached working state without application metadata. */
export function copyProviderHistoryState(input: ProviderHistoryInput): ProviderHistoryState {
  return structuredClone({
    sessionId: input.sessionId,
    providerState: input.providerState,
    resumeAtMessageId: input.resumeAtMessageId,
    messages: input.messages,
  });
}
