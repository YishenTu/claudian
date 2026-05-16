import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../../core/runtime/types';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { CURSOR_PROVIDER_CAPABILITIES } from '../capabilities';
import { encodeCursorTurn } from '../prompt/encodeCursorTurn';
import { getCursorState } from '../types';

/**
 * Phase 1 stub. The actual `cursor-agent` subprocess wrapper, NDJSON event
 * transport, and stream normalization land in Phase 2.
 *
 * Until then this satisfies the `ChatRuntime` contract so the provider can
 * register, the settings tab can render, and downstream feature code can
 * compile. The provider is gated behind `enabled: false`, so user-facing
 * code paths that would invoke `query` are unreachable by default.
 */
export class CursorChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'cursor';

  private threadId: string | null = null;
  private sessionInvalidated = false;
  private turnMetadata: ChatTurnMetadata = {};
  private readyListeners = new Set<(ready: boolean) => void>();

  constructor(_plugin: ClaudianPlugin) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CURSOR_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeCursorTurn(request);
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
    // Resume support deferred to Phase 2.
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.threadId = null;
      return;
    }

    const state = getCursorState(conversation.providerState);
    this.threadId = state.threadId ?? conversation.sessionId ?? null;
  }

  async reloadMcpServers(): Promise<void> {
    // MCP not supported by Cursor provider in MVP.
  }

  async ensureReady(_options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    return false;
  }

  async *query(
    _turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    _queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    yield {
      type: 'error',
      content: 'Cursor provider runtime is not yet implemented.',
    };
    yield { type: 'done' };
  }

  cancel(): void {
    // No active subprocess to cancel until Phase 2.
  }

  resetSession(): void {
    this.threadId = null;
    this.sessionInvalidated = true;
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  consumeSessionInvalidation(): boolean {
    const value = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return value;
  }

  isReady(): boolean {
    return false;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.readyListeners.clear();
    this.threadId = null;
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return {
      canRewind: false,
      error: 'Rewind is not supported by the Cursor provider.',
    };
  }

  setApprovalCallback(_callback: ApprovalCallback | null): void {
    // No approval flow until Phase 2 introduces real tool execution.
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {
    // No approval flow until Phase 2.
  }

  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {
    // No ask-user flow until Phase 2.
  }

  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {
    // Plan mode capability is disabled.
  }

  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {
    // No permission modes exposed by the Cursor provider yet.
  }

  setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {
    // Subagents not exposed by the Cursor provider yet.
  }

  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {
    // No auto-turn flow until Phase 2.
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.turnMetadata };
    this.turnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    if (params.sessionInvalidated) {
      return {
        updates: {
          sessionId: null,
          providerState: undefined,
        },
      };
    }

    if (!params.conversation || !this.threadId) {
      return { updates: {} };
    }

    const state = getCursorState(params.conversation.providerState);
    if (state.threadId === this.threadId) {
      return { updates: {} };
    }

    return {
      updates: {
        sessionId: this.threadId,
        providerState: { ...(params.conversation.providerState ?? {}), threadId: this.threadId },
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    if (!conversation) {
      return null;
    }
    const state = getCursorState(conversation.providerState);
    return state.threadId ?? conversation.sessionId ?? null;
  }
}
