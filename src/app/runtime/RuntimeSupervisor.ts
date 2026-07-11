import type { ProviderCapabilities, ProviderId } from '../../core/providers/types';
import type { ChatRuntime } from '../../core/runtime/ChatRuntime';
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
} from '../../core/runtime/types';
import type {
  ChatMessage,
  Conversation,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../core/types';

/** The sole tab-level owner and behavior-preserving facade for one provider runtime. */
export class RuntimeSupervisor implements ChatRuntime {
  constructor(private runtime: ChatRuntime | null = null) {}

  get current(): ChatRuntime | null { return this.runtime; }

  get providerId(): ProviderId { return this.requireRuntime().providerId; }

  setCurrent(runtime: ChatRuntime | null): void {
    if (runtime !== this) this.runtime = runtime;
  }

  getCapabilities(): Readonly<ProviderCapabilities> { return this.requireRuntime().getCapabilities(); }
  prepareTurn(request: ChatTurnRequest): PreparedChatTurn { return this.requireRuntime().prepareTurn(request); }
  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    return this.requireRuntime().onReadyStateChange(listener);
  }
  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.requireRuntime().setResumeCheckpoint(checkpointId);
  }
  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    externalContextPaths?: string[],
  ): void {
    this.requireRuntime().syncConversationState(conversation, externalContextPaths);
  }
  reloadMcpServers(): Promise<void> { return this.requireRuntime().reloadMcpServers(); }
  ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    return this.requireRuntime().ensureReady(options);
  }
  query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    return this.requireRuntime().query(turn, conversationHistory, queryOptions);
  }
  steer(turn: PreparedChatTurn): Promise<boolean> {
    return this.requireRuntime().steer?.(turn) ?? Promise.resolve(false);
  }
  cancel(): void { this.requireRuntime().cancel(); }
  resetSession(): void { this.requireRuntime().resetSession(); }
  getSessionId(): string | null { return this.requireRuntime().getSessionId(); }
  consumeSessionInvalidation(): boolean { return this.requireRuntime().consumeSessionInvalidation(); }
  isReady(): boolean { return this.requireRuntime().isReady(); }
  getSupportedCommands(): Promise<SlashCommand[]> { return this.requireRuntime().getSupportedCommands(); }
  getAuxiliaryModel(): string | null { return this.requireRuntime().getAuxiliaryModel?.() ?? null; }

  cleanup(): void {
    const runtime = this.runtime;
    runtime?.cleanup();
    if (this.runtime === runtime) {
      this.runtime = null;
    }
  }

  rewind(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return this.requireRuntime().rewind(userMessageId, assistantMessageId, mode);
  }
  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.requireRuntime().setApprovalCallback(callback);
  }
  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.requireRuntime().setApprovalDismisser(dismisser);
  }
  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.requireRuntime().setAskUserQuestionCallback(callback);
  }
  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.requireRuntime().setExitPlanModeCallback(callback);
  }
  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.requireRuntime().setPermissionModeSyncCallback(callback);
  }
  setSubagentHookProvider(getState: () => SubagentRuntimeState): void {
    this.requireRuntime().setSubagentHookProvider(getState);
  }
  setAutoTurnCallback(callback: AutoTurnCallback | null): void {
    this.requireRuntime().setAutoTurnCallback(callback);
  }
  consumeTurnMetadata(): ChatTurnMetadata { return this.requireRuntime().consumeTurnMetadata(); }
  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    return this.requireRuntime().buildSessionUpdates(params);
  }
  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.requireRuntime().resolveSessionIdForFork(conversation);
  }
  loadSubagentToolCalls(agentId: string): Promise<ToolCallInfo[]> {
    return this.requireRuntime().loadSubagentToolCalls?.(agentId) ?? Promise.resolve([]);
  }
  loadSubagentFinalResult(agentId: string): Promise<string | null> {
    return this.requireRuntime().loadSubagentFinalResult?.(agentId) ?? Promise.resolve(null);
  }

  private requireRuntime(): ChatRuntime {
    if (!this.runtime) throw new Error('RuntimeSupervisor has no active runtime.');
    return this.runtime;
  }
}
