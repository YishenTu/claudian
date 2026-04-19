import { EventEmitter } from 'events';

import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnResult,
  ChatRewindResult,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type { ChatMessage, Conversation, ExitPlanModeCallback, SlashCommand, StreamChunk, ToolCallInfo } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import { OPENCODE_PROVIDER_CAPABILITIES } from '../capabilities';
import type { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import type { OpencodeProviderSettings } from '../settings';
import { getOpencodeProviderSettings } from '../settings';
import { resolveOpencodeCliPath } from './OpencodeBinaryLocator';
import { OpencodeNotificationRouter } from './OpencodeNotificationRouter';
import { OpencodeProcess } from './OpencodeProcess';
import { OpencodeRpcTransport } from './OpencodeRpcTransport';
import type {
  AgentCapabilities,
  ForkSessionResponse,
  InitializeParams,
  InitializeResult,
  LoadSessionResponse,
  NewSessionResponse,
  PromptParams,
  PromptResult,
} from './OpencodeTypes';

interface OpencodeReadyStateListener {
  (ready: boolean): void;
}

export class OpencodeChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'opencode';

  private proc: OpencodeProcess | null = null;
  private transport: OpencodeRpcTransport | null = null;
  private notificationRouter: OpencodeNotificationRouter | null = null;
  private settings: OpencodeProviderSettings | null = null;
  private sessionId: string | null = null;
  private readyStateListeners: OpencodeReadyStateListener[] = [];
  private ready = false;
  private currentTurnId: string | null = null;
  private pendingTurnNotifications: unknown[] = [];
  private conversation: Conversation | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private eventEmitter = new EventEmitter();
  private chunkBuffer: StreamChunk[] = [];
  private chunkResolve: (() => void) | null = null;
  private agentCapabilities: AgentCapabilities | null = null;

  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private autoTurnCallback: ((result: AutoTurnResult) => void) | null = null;

  constructor(
    private readonly plugin: ClaudianPlugin,
  ) {}

  getCapabilities() {
    return OPENCODE_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      request,
      persistedContent: '',
      prompt: request.text,
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.push(listener);
    return () => {
      const idx = this.readyStateListeners.indexOf(listener);
      if (idx !== -1) this.readyStateListeners.splice(idx, 1);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
  }

  syncConversationState(
    conversation: { providerState?: Record<string, unknown>; sessionId?: string | null } | null,
    _externalContextPaths?: string[],
  ): void {
    this.conversation = conversation as Conversation | null;

    if (conversation) {
      const state = conversation.providerState as { sessionId?: string } | undefined;
      const savedSessionId = state?.sessionId ?? conversation.sessionId ?? null;
      if (savedSessionId) {
        this.sessionId = savedSessionId;
      }
    }
  }

  async reloadMcpServers(): Promise<void> {
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const settings = getOpencodeProviderSettings(this.plugin.settings);
    this.settings = settings;

    if (!settings.enabled) {
      console.error('[OpenCode] Provider not enabled');
      return false;
    }

    try {
      if (!this.ready) {
        await this.startProcess();
      }

      const cwd = getVaultPath(this.plugin.app) ?? process.cwd();

      const sessionIdToUse = options?.sessionId ?? this.sessionId;

      if (sessionIdToUse && this.transport) {
        const loaded = await this.loadSession(sessionIdToUse, cwd);
        if (loaded) {
          return true;
        }
        const newSessionId = await this.createSession(cwd);
        return !!newSessionId;
      }

      if (!this.sessionId) {
        if (settings.prewarm) {
          const sessionId = await this.createSession(cwd);
          return !!sessionId;
        }
        return true;
      }

      return true;
    } catch (error) {
      console.error('[OpenCode] Failed to start runtime:', error);
      this.ready = false;
      return false;
    }
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    _queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const ready = await this.ensureReady();
    if (!ready) {
      yield { type: 'error', content: 'Failed to start OpenCode runtime. Make sure OpenCode is installed and logged in.' };
      return;
    }

    if (!this.transport) {
      yield { type: 'error', content: 'Runtime not ready' };
      return;
    }

    if (!this.sessionId) {
      const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
      const sessionId = await this.createSession(cwd);
      if (!sessionId) {
        yield { type: 'error', content: 'Failed to create session' };
        return;
      }
    }

    const sessionId = this.sessionId!;
    this.currentTurnId = crypto.randomUUID();
    this.pendingTurnNotifications = [];

    const isPlanTurn = false;
    if (isPlanTurn) {
      yield { type: 'text', content: '[plan mode entered]' };
    }

    this.notificationRouter?.beginTurn(sessionId, isPlanTurn);
    this.chunkBuffer = [];

    try {
      const prompt = this.buildPrompt(turn.request);

      const resultPromise = this.transport.request<PromptResult>('session/prompt', {
        sessionId,
        prompt,
      } as PromptParams, 120_000);

      while (true) {
        while (this.chunkBuffer.length > 0) {
          const chunk = this.chunkBuffer.shift()!;
          yield chunk;
        }

        const done = await Promise.race([
          resultPromise,
          new Promise<void>(resolve => {
            const check = () => {
              if (this.chunkBuffer.length > 0) {
                resolve();
              } else {
                setTimeout(check, 5);
              }
            };
            check();
          }),
        ]);

        if (done !== undefined) {
          const result = await resultPromise;
          console.log('[OpenCode] Prompt result:', JSON.stringify(result, null, 2));

          while (this.chunkBuffer.length > 0) {
            const chunk = this.chunkBuffer.shift()!;
            yield chunk;
          }

          if (result.stopReason === 'stopped') {
            this.exitPlanModeCallback?.({});
          }

          if (result.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: result.usage.inputTokens,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                contextWindow: 200000,
                contextWindowIsAuthoritative: true,
                contextTokens: result.usage.inputTokens + result.usage.outputTokens,
                percentage: 0,
              },
            };
          }

          break;
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', content: error instanceof Error ? error.message : 'Query failed' };
      yield { type: 'done' };
    } finally {
      this.notificationRouter?.endTurn();
      this.currentTurnId = null;
      this.currentTurnMetadata = {};
    }
  }

  async steer(turn: PreparedChatTurn): Promise<boolean> {
    if (!this.transport || !this.sessionId) {
      return false;
    }

    try {
      await this.transport.request('session/set_mode', {
        sessionId: this.sessionId,
        modeId: 'default',
      });
      return true;
    } catch {
      return false;
    }
  }

  cancel(): void {
    if (this.transport && this.sessionId) {
      this.transport.notify('session/cancel', { sessionId: this.sessionId });
    }
  }

  resetSession(): void {
    this.sessionId = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.proc) {
      this.proc.shutdown();
      this.proc = null;
    }
    this.ready = false;
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string,
  ): Promise<ChatRewindResult> {
    return { canRewind: false };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {
  }

  setSubagentHookProvider(_getState: () => { hasRunning: boolean }): void {
  }

  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void {
    this.autoTurnCallback = callback;
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(_params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    return { updates: {} };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return this.sessionId;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private async startProcess(): Promise<void> {
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();

    const envText = getRuntimeEnvironmentText(this.plugin.settings as Record<string, unknown>, 'opencode');
    const resolvedPath = resolveOpencodeCliPath(this.settings?.cliPath, envText);
    const command = resolvedPath || 'opencode';

    const launchSpec = {
      command,
      args: ['acp'],
      spawnCwd: cwd,
      env: process.env as Record<string, string>,
    };

    console.log('[OpenCode] Starting process:', command, 'acp');

    this.proc = new OpencodeProcess(launchSpec);
    this.proc.start();

    this.transport = new OpencodeRpcTransport(this.proc);
    this.transport.start();

    this.setupNotificationRouter();
    this.setupNotificationHandlers();

    await this.initialize();

    console.log('[OpenCode] Process started successfully');
  }

  private async initialize(): Promise<void> {
    if (!this.transport) throw new Error('Transport not initialized');

    const initParams: InitializeParams = {
      protocolVersion: 1,
      clientInfo: { name: 'claudian', version: '1.0.0' },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    };

    const initResult = await this.transport.request<InitializeResult>('initialize', initParams);
    this.agentCapabilities = initResult.agentCapabilities;

    this.transport.notify('initialized');

    this.ready = true;

    for (const listener of this.readyStateListeners) {
      listener(true);
    }
  }

  private async createSession(cwd: string): Promise<string | null> {
    if (!this.transport) throw new Error('Transport not initialized');

    try {
      console.log('[OpenCode] Creating new session...');
      const result = await this.transport.requestWithTimeout<NewSessionResponse>('session/new', {
        cwd,
        mcpServers: [],
      }, 60000);

      this.sessionId = result.sessionId;
      console.log('[OpenCode] Session created:', this.sessionId);
      return result.sessionId;
    } catch (error) {
      console.error('[OpenCode] Failed to create session:', error);
      return null;
    }
  }

  async loadSession(sessionId: string, cwd: string): Promise<boolean> {
    if (!this.transport) throw new Error('Transport not initialized');

    if (!this.agentCapabilities?.loadSession) {
      console.log('[OpenCode] loadSession not supported by agent');
      return false;
    }

    try {
      console.log('[OpenCode] Loading session:', sessionId);
      const result = await this.transport.requestWithTimeout<LoadSessionResponse>('session/load', {
        sessionId,
        cwd,
        mcpServers: [],
      }, 60000);

      this.sessionId = result.sessionId;
      console.log('[OpenCode] Session loaded:', this.sessionId);
      return true;
    } catch (error) {
      console.error('[OpenCode] Failed to load session:', error);
      return false;
    }
  }

  async forkSession(sourceSessionId: string, cwd: string): Promise<string | null> {
    if (!this.transport) throw new Error('Transport not initialized');

    try {
      console.log('[OpenCode] Forking session:', sourceSessionId);
      const result = await this.transport.requestWithTimeout<ForkSessionResponse>('session/fork', {
        sessionId: sourceSessionId,
        cwd,
      }, 60000);

      this.sessionId = result.sessionId;
      return result.sessionId;
    } catch (error) {
      console.error('[OpenCode] Failed to fork session:', error);
      return null;
    }
  }

  private setupNotificationRouter(): void {
    const catalog = ProviderWorkspaceRegistry.getCommandCatalog('opencode') as OpencodeCommandCatalog | null;

    this.notificationRouter = new OpencodeNotificationRouter(
      (chunk) => {
        this.chunkBuffer.push(chunk);
        if (this.chunkResolve) {
          this.chunkResolve();
          this.chunkResolve = null;
        }
      },
      (metadata) => {
        this.currentTurnMetadata = { ...this.currentTurnMetadata, ...metadata };
      },
    );

    if (catalog) {
      this.notificationRouter.setCommandsListener((commands) => {
        const entries: ProviderCommandEntry[] = commands.map(cmd => ({
          id: `opencode-cmd-${cmd.name}`,
          providerId: 'opencode',
          kind: 'command',
          name: cmd.name,
          description: cmd.description,
          content: '',
          scope: 'runtime',
          source: 'sdk',
          isEditable: false,
          isDeletable: false,
          displayPrefix: '/',
          insertPrefix: '/',
        }));
        catalog.setRuntimeCommands(entries);
      });
    }
  }

  private setupNotificationHandlers(): void {
    if (!this.transport) return;

    this.transport.onNotification('session/update', (params) => {
      const notification = params as { sessionId: string; update: Record<string, unknown> };
      this.notificationRouter?.handleSessionUpdate(notification as any);
    });

    this.transport.onServerRequest('session/request_permission', async (requestId, params) => {
      return this.handlePermissionRequest(requestId, params);
    });

    this.transport.onServerRequest('session/request_user_input', async (requestId, params) => {
      return this.handleUserInputRequest(requestId, params);
    });
  }

  private async handlePermissionRequest(
    requestId: string | number,
    params: unknown,
  ): Promise<unknown> {
    const request = params as {
      sessionId: string;
      toolCall: { toolCallId: string; title: string; kind?: string };
      options: Array<{ optionId: string; kind: string; name: string }>;
    };

    if (this.approvalCallback) {
      const approved = await this.approvalCallback(
        request.toolCall.title,
        request.toolCall as Record<string, unknown>,
        '',
      );

      return {
        outcome: {
          outcome: approved === 'allow' || approved === 'allow-always' ? 'selected' : 'cancelled',
          optionId: approved === 'allow-always' ? 'always' : approved === 'deny' ? 'reject' : 'once',
        },
      };
    }

    return {
      outcome: {
        outcome: 'cancelled',
        optionId: 'reject',
      },
    };
  }

  private async handleUserInputRequest(
    requestId: string | number,
    params: unknown,
  ): Promise<unknown> {
    const request = params as {
      sessionId: string;
      questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }>;
    };

    if (this.askUserQuestionCallback) {
      const input = request.questions[0] as { id: string; question: string } | undefined;
      if (input) {
        const answer = await this.askUserQuestionCallback({ [input.id]: input.question });
        return { answers: answer };
      }
    }

    return { answers: {} };
  }

  private buildPrompt(
    request: ChatTurnRequest,
  ): Array<{ type: string; text?: string; uri?: string; mimeType?: string; data?: string }> {
    const prompt: Array<{ type: string; text?: string; uri?: string; mimeType?: string; data?: string }> = [];

    prompt.push({ type: 'text', text: request.text });

    if (request.images) {
      for (const image of request.images) {
        if (image.data) {
          prompt.push({
            type: 'image',
            mimeType: image.mediaType,
            data: image.data,
          });
        }
      }
    }

    return prompt;
  }
}
