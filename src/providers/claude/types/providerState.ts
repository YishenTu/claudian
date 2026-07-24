import type { Conversation } from '../../../core/types';
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

export function getClaudeConversationSessionIds(conversation: Conversation): string[] {
  const state = getClaudeState(conversation.providerState);
  const isPendingFork = !!state.forkSource
    && !state.providerSessionId
    && !conversation.sessionId;
  if (isPendingFork) {
    return [state.forkSource!.sessionId];
  }

  return [...new Set([
    ...(state.previousProviderSessionIds || []),
    state.providerSessionId ?? conversation.sessionId,
  ].filter((id): id is string => !!id))];
}

export function clearClaudeResumeState(conversation: Conversation): boolean {
  const providerState = { ...getClaudeState(conversation.providerState) };
  const isPendingFork = !!providerState.forkSource
    && !providerState.providerSessionId
    && !conversation.sessionId;
  const hadResumeState = conversation.sessionId != null
    || typeof providerState.providerSessionId === 'string'
    || providerState.forkSource !== undefined;
  if (!hadResumeState) {
    return false;
  }

  // Stop provider resume while retaining transcript segments for history replay.
  const preservedSessionIds = getClaudeConversationSessionIds(conversation);
  if (preservedSessionIds.length > 0) {
    providerState.previousProviderSessionIds = preservedSessionIds;
  } else {
    delete providerState.previousProviderSessionIds;
  }
  if (isPendingFork) {
    conversation.resumeAtMessageId = providerState.forkSource!.resumeAt;
  }

  conversation.sessionId = null;
  delete providerState.providerSessionId;
  delete providerState.forkSource;
  conversation.providerState = Object.keys(providerState).length > 0
    ? providerState
    : undefined;
  return true;
}
