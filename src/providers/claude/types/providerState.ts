import type { Conversation } from '../../../core/types';
import type { ForkSource } from '../../../core/types/chat';
import type { SubagentInfo } from '../../../core/types/tools';

export interface ClaudeProviderState {
  providerSessionId?: string;
  previousProviderSessionIds?: string[];
  historyReplayPending?: boolean;
  forkSource?: ForkSource;
  /** Only what native history lacks: full records without a native sidecar, otherwise async overlays. */
  subagentData?: Record<string, SubagentInfo | ClaudeSubagentOverlay>;
}

/** Async lifecycle state Claudian observed live; the transcript may lack the completion notice. */
export type ClaudeSubagentOverlay = Pick<SubagentInfo, 'id' | 'mode' | 'agentId' | 'status' | 'asyncStatus' | 'result'>;

export function isFullClaudeSubagent(
  subagent: SubagentInfo | ClaudeSubagentOverlay,
): subagent is SubagentInfo {
  return Array.isArray((subagent as Partial<SubagentInfo>).toolCalls);
}

/** Extracts typed Claude provider state from the opaque bag. */
export function getClaudeState(
  providerState: Record<string, unknown> | undefined,
): ClaudeProviderState {
  return (providerState ?? {});
}

/** A fork that has not started its own native session yet still resumes from its source session. */
function getPendingForkSource(
  conversation: Pick<Conversation, 'sessionId' | 'providerState'>,
): ForkSource | undefined {
  const state = getClaudeState(conversation.providerState);
  return state.forkSource && !state.providerSessionId && !conversation.sessionId
    ? state.forkSource
    : undefined;
}

export function getClaudeConversationSessionIds(conversation: Pick<Conversation, 'sessionId' | 'providerState'>): string[] {
  const state = getClaudeState(conversation.providerState);
  const pendingForkSource = getPendingForkSource(conversation);
  if (pendingForkSource) {
    return [pendingForkSource.sessionId];
  }

  return [...new Set([
    ...(state.previousProviderSessionIds || []),
    state.providerSessionId ?? conversation.sessionId,
  ].filter((id): id is string => !!id))];
}
