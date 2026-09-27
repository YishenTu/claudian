import type { ChatMessage, UsageInfo } from '../types';
import type { ProviderExecutionConfiguration } from './ProviderExecutionRequest';
import type { ProviderExecutionSession } from './ProviderExecutionSession';

export interface ConversationBranchRequest {
  readonly userMessageId: string;
  /** Omit to edit the selected prompt; supply a sibling prompt to switch branches. */
  readonly branchMessageId?: string;
  readonly configuration: ProviderExecutionConfiguration;
  readonly signal?: AbortSignal;
}

export type ConversationBranchResult =
  | { readonly status: 'committed'; readonly messages: ChatMessage[]; readonly usage?: UsageInfo | null }
  | { readonly status: 'cancelled'; readonly messages?: ChatMessage[]; readonly usage?: UsageInfo | null }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'recovery-required'; readonly error: string; readonly messages?: ChatMessage[] };

export type ConversationBranchRecoveryRequest = Pick<ConversationBranchRequest, 'configuration' | 'signal'>;

export interface ConversationBranchState {
  readonly branches: Record<string, readonly string[]>;
  /** Correlation from visible message IDs to native user IDs, recovered without replacing live content. */
  readonly userMessageIds: Record<string, string>;
}

export interface BranchableExecutionSession {
  getConversationBranches(messages?: readonly ChatMessage[]): Promise<ConversationBranchState>;
  navigateConversationBranch(request: ConversationBranchRequest): Promise<ConversationBranchResult>;
  reconcileConversationBranch(request: ConversationBranchRecoveryRequest): Promise<ConversationBranchResult>;
}

export function isBranchableExecutionSession(
  session: ProviderExecutionSession,
): session is ProviderExecutionSession & BranchableExecutionSession {
  return 'navigateConversationBranch' in session && 'getConversationBranches' in session
    && 'reconcileConversationBranch' in session;
}
