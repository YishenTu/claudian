import type { ForkSource } from '../../../core/types/chat';
import type { SubagentInfo } from '../../../core/types/tools';

export interface ClaudeProviderState {
  providerSessionId?: string;
  previousProviderSessionIds?: string[];
  forkSource?: ForkSource;
  subagentData?: Record<string, SubagentInfo>;
}

/** Extracts typed Claude provider state from the opaque bag. */
export function getClaudeState(
  providerState: Record<string, unknown> | undefined,
): ClaudeProviderState {
  return (providerState ?? {});
}
