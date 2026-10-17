import type { Conversation } from '../../../core/types';
import type { ForkSource } from '../../../core/types/chat';
import type { SubagentInfo } from '../../../core/types/tools';

export interface ClaudeProviderState {
  providerSessionId?: string;
  previousProviderSessionIds?: string[];
  /**
   * Retired-binding migration (#1647, added 2026-10-16; remove after 2027-01-16). Set whenever Claudian retires the live
   * binding, so only retirements left by earlier versions get the one-time restore. Remove this
   * field, its writes, and every block tagged "Retired-binding migration" together.
   */
  bindingRetired?: boolean;
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

export function clearClaudeResumeState(conversation: Conversation): boolean {
  const providerState = { ...getClaudeState(conversation.providerState) };
  const pendingForkSource = getPendingForkSource(conversation);
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
  if (pendingForkSource) {
    conversation.resumeAtMessageId = pendingForkSource.resumeAt;
  }

  conversation.sessionId = null;
  providerState.bindingRetired = true;
  delete providerState.providerSessionId;
  delete providerState.forkSource;
  conversation.providerState = Object.keys(providerState).length > 0
    ? providerState
    : undefined;
  return true;
}
