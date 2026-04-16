import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnResult,
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
import { getAcpProviderSettings, type AcpAgentConfig } from '../settings';
import { ACP_PROVIDER_CAPABILITIES } from '../capabilities';
import type { AcpChatParams, AcpInitializeResult, AcpMessage } from '../protocol/acpProtocolTypes';
import { AcpProcessManager } from '../transport/AcpProcessManager';
import { AcpNotificationRouter } from './AcpNotificationRouter';
import { AcpServerRequestRouter } from './AcpServerRequestRouter';
import { AcpStdioTransport } from '../transport/AcpStdioTransport';
import type { AcpTransport } from '../transport/AcpTransport';

export class AcpChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'acp';

  private plugin: ClaudianPlugin;
  private transport: AcpTransport | null = null;
  private processManager: AcpProcessManager | null = null;
  private notificationRouter: AcpNotificationRouter | null = null;
  private serverRequestRouter = new AcpServerRequestRouter();
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private sessionId: string | null = null;

  // Chunk buffering for streaming
  private chunkBuffer: StreamChunk[] = [];
  private chunkResolve: (() => void) | null = null;

  // Callbacks
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private subagentHookProvider: (() => SubagentRuntimeState) | null = null;
  private autoTurnCallback: ((result: AutoTurnResult) => void) | null = null;

  // Cancellation
  private canceled = false;
  private currentMessageId: string | null = null;
  private turnMetadata: ChatTurnMetadata = {};

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return ACP_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    // For ACP, we just need to prepare the text prompt
    return {
      request,
      persistedContent: request.text,
      prompt: request.text,
      isCompact: false,
      mcpMentions: new Set(),
    };
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.turnMetadata };
    this.turnMetadata = {};
    return metadata;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
    // ACP doesn't support resume checkpoints in MVP
  }

  syncConversationState(_conversation: ChatRuntimeConversationState | null): void {
    // ACP doesn't persist conversation state in MVP
    this.sessionId = null;
  }

  async reloadMcpServers(): Promise<void> {
    // ACP doesn't use MCP in MVP
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (this.ready && options?.force !== true) {
      return true;
    }

    const settings = getAcpProviderSettings(this.plugin.settings);
    if (!settings.enabled) {
      return false;
    }

    const agentConfig = this.getActiveAgentConfig(settings);
    if (!agentConfig) {
      return false;
    }

    // Start the agent process and transport
    if (!this.transport || !this.transport.isAlive()) {
      await this.startAgent(agentConfig);
    }

    this.setReady(true);
    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    _queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    await this.ensureReady();

    if (!this.transport) {
      yield { type: 'error', content: 'ACP transport not available' };
      yield { type: 'done' };
      return;
    }

    this.canceled = false;
    this.chunkBuffer = [];
    this.chunkResolve = null;
    this.currentMessageId = null;

    const enqueueChunk = (chunk: StreamChunk): void => {
      this.chunkBuffer.push(chunk);
      if (this.chunkResolve) {
        this.chunkResolve();
        this.chunkResolve = null;
      }
    };

    // Set up notification router
    this.notificationRouter = new AcpNotificationRouter(enqueueChunk);
    this.wireTransportHandlers();

    try {
      // Build ACP chat request
      const acpRequest = this.buildAcpChatRequest(turn);

      // Send chat request
      const result = await this.transport.request<{ messageId: string }>('chat/send', acpRequest);
      this.currentMessageId = result.messageId;
      this.recordTurnMetadata({ userMessageId: result.messageId, wasSent: true });

      // Yield chunks until done or canceled
      while (true) {
        if (this.canceled) {
          // Drain remaining chunks before exiting
          while (this.chunkBuffer.length > 0) {
            const chunk = this.chunkBuffer.shift()!;
            yield chunk;
            if (chunk.type === 'done') return;
          }
          yield { type: 'done' };
          return;
        }

        if (this.chunkBuffer.length === 0) {
          await new Promise<void>((resolve) => {
            this.chunkResolve = resolve;
            if (this.chunkBuffer.length > 0 || this.canceled) {
              resolve();
              this.chunkResolve = null;
            }
          });
        }

        while (this.chunkBuffer.length > 0) {
          const chunk = this.chunkBuffer.shift()!;
          yield chunk;
          if (chunk.type === 'done') {
            return;
          }
        }
      }
    } catch (err: unknown) {
      if (this.canceled) {
        yield { type: 'done' };
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown ACP error';
      yield { type: 'error', content: message };
      yield { type: 'done' };
      return;
    } finally {
      this.currentMessageId = null;
    }
  }

  cancel(): void {
    this.canceled = true;
    this.dismissAllPendingPrompts();

    // Unblock the chunk-wait loop
    if (this.chunkResolve) {
      this.chunkResolve();
      this.chunkResolve = null;
    }
  }

  resetSession(): void {
    this.sessionId = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    return false; // ACP doesn't have environment-based invalidation in MVP
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return []; // ACP doesn't have provider commands in MVP
  }

  cleanup(): void {
    this.cancel();
    this.readyListeners.clear();
    this.shutdownTransport().catch(() => {});
  }

  async rewind(_userMessageId: string, _assistantMessageId: string): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'ACP does not support rewind' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
    this.serverRequestRouter.setApprovalCallback(callback);
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
    this.serverRequestRouter.setAskUserCallback(callback);
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentRuntimeState): void {
    this.subagentHookProvider = getState;
  }

  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void {
    this.autoTurnCallback = callback;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const sessionId = this.sessionId;

    const updates: Partial<Conversation> = {
      sessionId,
      providerState: sessionId ? { sessionId } : undefined,
    };

    if (params.sessionInvalidated && params.conversation) {
      updates.sessionId = null;
      updates.providerState = undefined;
    }

    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.sessionId ?? conversation?.sessionId ?? null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getActiveAgentConfig(settings: ReturnType<typeof getAcpProviderSettings>): AcpAgentConfig | null {
    const defaultAgent = settings.agents.find(a => a.id === settings.defaultAgentId);
    const agent = defaultAgent ?? settings.agents.find(a => a.enabled) ?? settings.agents[0];

    if (!agent || !agent.enabled) {
      return null;
    }

    return agent;
  }

  private async startAgent(agentConfig: AcpAgentConfig): Promise<void> {
    this.shutdownTransport().catch(() => {});

    this.processManager = new AcpProcessManager(agentConfig);
    this.processManager.start();

    this.transport = new AcpStdioTransport(
      this.processManager.stdin,
      this.processManager.stdout,
      () => this.handleProcessExit(),
    );
    this.transport.start();

    // Initialize handshake
    const initResult = await this.transport.request<AcpInitializeResult>('initialize', {
      clientInfo: { name: 'claudian', version: '1.0.0' },
      capabilities: { chat: true, streaming: true },
    });

    if (initResult.capabilities.chat) {
      // Chat is supported
    }
  }

  private async shutdownTransport(): Promise<void> {
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.processManager) {
      await this.processManager.shutdown();
      this.processManager = null;
    }
    this.setReady(false);
  }

  private handleProcessExit(): void {
    this.setReady(false);
    this.rejectAllPending(new Error('ACP agent process exited'));
  }

  private rejectAllPending(_error: Error): void {
    if (this.chunkResolve) {
      this.chunkResolve();
      this.chunkResolve = null;
    }
  }

  private setReady(ready: boolean): void {
    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private resetTurnMetadata(): void {
    this.turnMetadata = {};
  }

  private recordTurnMetadata(update: Partial<ChatTurnMetadata>): void {
    this.turnMetadata = {
      ...this.turnMetadata,
      ...update,
    };
  }

  private buildAcpChatRequest(turn: PreparedChatTurn): AcpChatParams {
    const messages: AcpMessage[] = [
      { role: 'user', content: turn.prompt },
    ];

    return {
      messages,
      stream: true,
    };
  }

  private wireTransportHandlers(): void {
    if (!this.transport || !this.notificationRouter) return;

    const router = this.notificationRouter;
    const methods = [
      'chat/textDelta',
      'chat/toolUseStart',
      'chat/toolResult',
      'chat/messageStop',
      'chat/error',
    ];

    for (const method of methods) {
      this.transport.onNotification(method, (params) => {
        router.handleNotification(method, params);
      });
    }

    // Server requests (tool approval, user input)
    const requestMethods = [
      'tool/requestApproval',
      'user/requestInput',
    ];

    for (const method of requestMethods) {
      this.transport.onServerRequest(method, (requestId, params) => {
        return this.serverRequestRouter.handleServerRequest(requestId, method, params);
      });
    }
  }

  private dismissApprovalUI(): void {
    if (this.approvalDismisser) {
      this.approvalDismisser();
    }
  }

  private dismissAllPendingPrompts(): void {
    this.dismissApprovalUI();
    this.serverRequestRouter.abortPendingAskUser();
  }
}
