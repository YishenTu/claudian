import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { buildSystemPrompt } from '../../../core/prompt/mainAgent';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  ApprovalDecisionOption,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type {
  ApprovalDecision,
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpReadTextFileRequest,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  buildAcpUsageInfo,
} from '../../acp';
import { GROK_PROVIDER_CAPABILITIES } from '../capabilities';
import { getGrokProviderSettings } from '../settings';
import { getGrokState, type GrokProviderState } from '../types';
import { GROK_DEFAULT_MODEL } from '../ui/GrokChatUIConfig';
import {
  buildGrokAcpPromptBlocks,
  buildGrokAcpPromptText,
  buildGrokPromptWithHistory,
  buildGrokTurnPromptText,
} from './buildGrokPrompt';
import {
  buildGrokRuntimeEnv,
  resolveGrokHomeFromSettings,
} from './GrokRuntimeEnvironment';
import { type GrokAcpModeId, resolveGrokAcpModeId } from './grokSessionMode';

/**
 * ACP process launch fingerprint.
 *
 * Includes safeMode (maps to GROK_SANDBOX at spawn) and yolo (needs
 * --always-approve). Plan vs normal is applied via session/set_mode and must
 * not force a process restart.
 */
export function buildGrokAcpLaunchKey(params: {
  cliPath: string;
  cwd: string;
  effort: string;
  envText: string;
  model: string;
  safeMode: string;
  yolo: boolean;
}): string {
  return JSON.stringify({
    cliPath: params.cliPath,
    cwd: params.cwd,
    effort: params.effort,
    envText: params.envText,
    model: params.model,
    safeMode: params.safeMode,
    yolo: params.yolo,
  });
}

interface ActiveTurn {
  cancelled: boolean;
  queue: StreamChunkQueue;
  sessionId: string;
}

class StreamChunkQueue {
  private closed = false;
  private readonly items: StreamChunk[] = [];
  private readonly waiters: Array<(chunk: StreamChunk | null) => void> = [];

  push(chunk: StreamChunk): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(chunk);
      return;
    }
    this.items.push(chunk);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }

  async next(): Promise<StreamChunk | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    return new Promise<StreamChunk | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export class GrokChatRuntime implements ChatRuntime {
  readonly providerId = 'grok' as const;

  private activeTurn: ActiveTurn | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private conversationId: string | null = null;
  private conversationGeneration = 0;
  private currentConversationModel: string | null = null;
  private currentGrokHome: string | null = null;
  private currentLaunchKey: string | null = null;
  private currentSessionModeId: GrokAcpModeId | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private disposed = false;
  private lifecycleGeneration = 0;
  private loadedSessionId: string | null = null;
  private process: AcpSubprocess | null = null;
  private readinessFlight: { key: string; promise: Promise<boolean> } | null = null;
  private ready = false;
  private readonly readyListeners: Array<(ready: boolean) => void> = [];
  private sessionCwds = new Map<string, string>();
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private readonly supportedCommandWaiters: Array<(commands: SlashCommand[]) => void> = [];
  private supportedCommands: SlashCommand[] = [];
  private transport: AcpJsonRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;

  constructor(private readonly plugin: ProviderHost) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return GROK_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildGrokTurnPromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.push(listener);
    try {
      listener(this.ready);
    } catch {
      // ignore listener errors
    }
    return () => {
      const index = this.readyListeners.indexOf(listener);
      if (index >= 0) {
        this.readyListeners.splice(index, 1);
      }
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
  ): void {
    this.setCurrentConversationModel(conversation?.selectedModel);
    const previousSessionId = this.sessionId;
    const nextConversationId = conversation?.id ?? null;
    const state = getGrokState(conversation?.providerState);
    const nextSessionId = conversation?.sessionId
      ?? state.sessionId
      ?? null;

    if (previousSessionId !== nextSessionId) {
      this.loadedSessionId = null;
      this.currentSessionModeId = null;
      this.sessionInvalidated = false;
      this.sessionUpdateNormalizer.reset();
      this.setSupportedCommands([]);
    }

    const stateGrokHome = getGrokState(conversation?.providerState).grokHome;
    if (stateGrokHome) {
      this.currentGrokHome = stateGrokHome;
    }

    const targetChanged = nextConversationId !== this.conversationId
      || nextSessionId !== this.sessionId;
    this.conversationId = nextConversationId;
    this.sessionId = nextSessionId;
    if (targetChanged) {
      this.conversationGeneration += 1;
      if (this.readinessFlight) {
        void this.shutdownProcess();
      }
    }
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const conversationGeneration = this.conversationGeneration;
    const key = JSON.stringify({ conversationGeneration, options: options ?? {} });
    if (this.readinessFlight) {
      if (this.readinessFlight.key === key) {
        return this.readinessFlight.promise;
      }
      await this.readinessFlight.promise.catch(() => undefined);
      return this.ensureReady(options);
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    const promise = this.ensureReadyInternal(
      options,
      lifecycleGeneration,
      conversationGeneration,
    );
    this.readinessFlight = { key, promise };
    return promise.finally(() => {
      if (this.readinessFlight?.promise === promise) {
        this.readinessFlight = null;
      }
    });
  }

  private async ensureReadyInternal(
    options: ChatRuntimeEnsureReadyOptions | undefined,
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): Promise<boolean> {
    const settings = getGrokProviderSettings(this.plugin.settings);
    if (!settings.enabled) {
      this.setReady(false);
      return false;
    }

    const cliPath = await this.plugin.getResolvedProviderCliPath('grok');
    if (!cliPath) {
      this.setReady(false);
      return false;
    }

    if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
      return false;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings,
      'grok',
    );
    const model = this.resolveSelectedModel(providerSettings);
    const effort = typeof providerSettings.effortLevel === 'string' && providerSettings.effortLevel.trim()
      ? providerSettings.effortLevel.trim()
      : 'high';
    const permissionMode = typeof providerSettings.permissionMode === 'string'
      ? providerSettings.permissionMode
      : 'normal';
    const yolo = permissionMode === 'yolo';
    const safeMode = getGrokProviderSettings(this.plugin.settings).safeMode;
    const envText = getRuntimeEnvironmentText(this.plugin.settings, 'grok');
    const launchKey = buildGrokAcpLaunchKey({
      cliPath,
      cwd,
      effort,
      envText,
      model,
      safeMode,
      yolo,
    });

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || options?.force === true
      || this.currentLaunchKey !== launchKey;

    if (shouldRestart) {
      await this.shutdownProcess();
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        return false;
      }
      await this.startProcess({ cliPath, cwd, effort, model, yolo });
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
      this.currentLaunchKey = launchKey;
      this.loadedSessionId = null;
      this.currentSessionModeId = null;
      this.currentGrokHome = resolveGrokHomeFromSettings(this.plugin.settings, cliPath);
    } else if (!this.currentGrokHome) {
      this.currentGrokHome = resolveGrokHomeFromSettings(this.plugin.settings, cliPath);
    }

    const targetSessionId = this.sessionId;
    if (targetSessionId) {
      if (this.loadedSessionId !== targetSessionId) {
        const loaded = await this.loadSession(targetSessionId, cwd);
        if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
          await this.shutdownProcess();
          return false;
        }
        if (!loaded) {
          this.sessionInvalidated = true;
          this.clearActiveSession();
        }
      } else {
        await this.applySessionMode(targetSessionId);
      }
      return true;
    }

    if (!this.sessionId && !this.sessionInvalidated) {
      if (options?.allowSessionCreation === false) {
        return true;
      }
      const sessionId = await this.createSession(cwd);
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
      return Boolean(sessionId);
    }

    return true;
  }

  async *query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    // Reject until the previous ACP prompt RPC fully settles (including cancel).
    if (this.activeTurn) {
      yield { type: 'error', content: 'Grok does not support overlapping turns.' };
      yield { type: 'done' };
      return;
    }

    if (queryOptions?.model) {
      this.setCurrentConversationModel(queryOptions.model);
    }

    const conversationGeneration = this.conversationGeneration;
    const previousMessages = conversationHistory ?? [];
    const expectedSessionId = this.sessionId;
    let shouldBootstrapHistory = previousMessages.length > 0
      && (!expectedSessionId || this.sessionInvalidated);

    if (!(await this.ensureReady())) {
      yield {
        type: 'error',
        content: 'Failed to start Grok ACP runtime. Check the Grok CLI path and login state.',
      };
      yield { type: 'done' };
      return;
    }

    if (!this.isConversationCurrent(conversationGeneration)) {
      yield { type: 'error', content: 'Grok conversation changed before the turn started.' };
      yield { type: 'done' };
      return;
    }

    if (!this.connection) {
      yield { type: 'error', content: 'Grok ACP runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    // Re-check after await: cancel/settle of a concurrent turn cannot open a race here
    // because JS is single-threaded, but ensureReady may have yielded.
    if (this.activeTurn) {
      yield { type: 'error', content: 'Grok does not support overlapping turns.' };
      yield { type: 'done' };
      return;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    if (expectedSessionId && !this.sessionId) {
      shouldBootstrapHistory = previousMessages.length > 0;
    }

    if (!this.sessionId) {
      const sessionId = await this.createSession(cwd);
      if (!sessionId) {
        yield { type: 'error', content: 'Failed to create a Grok ACP session.' };
        yield { type: 'done' };
        return;
      }
    }

    if (this.activeTurn) {
      yield { type: 'error', content: 'Grok does not support overlapping turns.' };
      yield { type: 'done' };
      return;
    }

    const sessionId = this.sessionId!;
    try {
      await this.applySessionMode(sessionId);
    } catch (error) {
      yield {
        type: 'error',
        content: this.formatRuntimeError(error),
      };
      yield { type: 'done' };
      return;
    }

    this.activeTurn = {
      cancelled: false,
      queue: new StreamChunkQueue(),
      sessionId,
    };
    this.currentTurnMetadata = {};
    this.sessionUpdateNormalizer.reset();

    const activeTurn = this.activeTurn;
    const systemPrompt = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      vaultPath: cwd,
      userName: this.plugin.settings.userName,
    });
    const isFollowupTurn = Boolean(expectedSessionId) || previousMessages.length > 0;
    const promptText = expectedSessionId && !shouldBootstrapHistory
      ? turn.prompt
      : buildGrokPromptWithHistory(turn.prompt, previousMessages);
    const prompt = buildGrokAcpPromptBlocks(
      buildGrokAcpPromptText(systemPrompt, promptText, isFollowupTurn),
    );

    const promptPromise = this.connection.prompt({
      prompt,
      sessionId,
    }).then((response) => {
      if (response.userMessageId) {
        this.currentTurnMetadata.userMessageId = response.userMessageId;
      }
      const usage = buildAcpUsageInfo({
        model: this.resolveSelectedModel(
          ProviderSettingsCoordinator.getProviderSettingsSnapshot(this.plugin.settings, 'grok'),
        ),
        promptUsage: response.usage ?? null,
      });
      if (usage) {
        activeTurn.queue.push({ sessionId, type: 'usage', usage });
      }
      if (!activeTurn.cancelled) {
        activeTurn.queue.push({ type: 'done' });
      }
      activeTurn.queue.close();
    }).catch((error) => {
      if (!activeTurn.cancelled) {
        activeTurn.queue.push({
          type: 'error',
          content: this.formatRuntimeError(error),
        });
        activeTurn.queue.push({ type: 'done' });
      }
      activeTurn.queue.close();
    }).finally(() => {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    });

    try {
      while (true) {
        const chunk = await activeTurn.queue.next();
        if (!chunk) {
          break;
        }
        yield chunk;
      }
    } finally {
      // Always wait for the ACP prompt RPC so cancel keeps the busy barrier.
      await promptPromise.catch(() => undefined);
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    }
  }

  cancel(): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.cancelled) {
      return;
    }
    activeTurn.cancelled = true;
    if (this.connection && this.sessionId) {
      this.connection.cancel({ sessionId: this.sessionId });
    }
    // Close the consumer queue immediately, but keep activeTurn until the
    // ACP prompt promise settles so a second query cannot overlap.
    activeTurn.queue.close();
  }

  resetSession(): void {
    this.cancel();
    this.clearActiveSession();
    this.sessionInvalidated = false;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    if (this.supportedCommands.length > 0 && this.loadedSessionId === this.sessionId) {
      return [...this.supportedCommands];
    }
    if (!this.sessionId) {
      return [];
    }
    return this.waitForSupportedCommands();
  }

  cleanup(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.activeTurn?.queue.close();
    this.activeTurn = null;
    void this.shutdownProcess();
    this.readyListeners.length = 0;
    this.setReady(false);
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return {
      canRewind: false,
      error: 'Grok does not support rewind from Claudian yet',
    };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {}

  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}

  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}

  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.currentTurnMetadata };
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const existingState = params.conversation
      ? getGrokState(params.conversation.providerState)
      : null;
    const sessionId = this.sessionId;
    const grokHome = this.currentGrokHome ?? existingState?.grokHome;
    const providerState: GrokProviderState = {
      ...(sessionId
        ? { sessionId }
        : existingState?.sessionId
        ? { sessionId: existingState.sessionId }
        : {}),
      ...(grokHome ? { grokHome } : {}),
    };

    const updates: Partial<Conversation> = {
      providerState: Object.keys(providerState).length > 0
        ? providerState as Record<string, unknown>
        : undefined,
      sessionId,
    };

    if (params.sessionInvalidated && !this.sessionId) {
      updates.providerState = undefined;
      updates.sessionId = null;
    }

    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.sessionId
      ?? conversation?.sessionId
      ?? getGrokState(conversation?.providerState).sessionId
      ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private async startProcess(params: {
    cliPath: string;
    cwd: string;
    effort: string;
    model: string;
    yolo: boolean;
  }): Promise<void> {
    const args = ['agent'];
    if (params.model) {
      args.push('-m', params.model);
    }
    if (params.effort) {
      args.push('--reasoning-effort', params.effort);
    }
    if (params.yolo) {
      args.push('--always-approve');
    }
    args.push('stdio');

    const env = buildGrokRuntimeEnv(this.plugin.settings, params.cliPath);
    this.currentGrokHome = resolveGrokHomeFromSettings(this.plugin.settings, params.cliPath);
    this.process = new AcpSubprocess({
      args,
      command: params.cliPath,
      cwd: params.cwd,
      env,
    });
    this.process.start();

    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: (listener) => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    const transport = this.transport;
    this.unregisterTransportClose = transport.onClose(() => {
      if (this.transport === transport) {
        this.setReady(false);
        this.settleActiveTurn(new Error('Grok ACP runtime closed'));
      }
    });

    const connectionGeneration = ++this.connectionGeneration;
    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        fileSystem: {
          readTextFile: (request) => this.readTextFile(request),
          writeTextFile: (request) => this.writeTextFile(request),
        },
        onSessionNotification: (notification) => this.handleSessionNotification(
          notification,
          connectionGeneration,
        ),
        requestPermission: (request) => this.handlePermissionRequest(request),
      },
      transport: this.transport,
    });

    this.transport.start();
    await this.connection.initialize({
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    this.setReady(true);
  }

  private async shutdownProcess(): Promise<void> {
    this.connectionGeneration += 1;
    this.setReady(false);
    this.settleActiveTurn();
    this.setSupportedCommands([]);

    this.unregisterTransportClose?.();
    this.unregisterTransportClose = null;

    this.connection?.dispose();
    this.connection = null;

    this.transport?.dispose();
    this.transport = null;

    if (this.process) {
      await this.process.shutdown().catch(() => {});
      this.process = null;
    }

    this.currentLaunchKey = null;
    this.loadedSessionId = null;
    this.currentSessionModeId = null;
    this.sessionUpdateNormalizer.reset();
  }

  private async createSession(cwd: string): Promise<string | null> {
    if (!this.connection) {
      return null;
    }
    try {
      this.setSupportedCommands([]);
      this.currentSessionModeId = null;
      const response = await this.connection.newSession({
        cwd,
        mcpServers: [],
      });
      const sessionId = response.sessionId;
      if (!sessionId) {
        return null;
      }
      // Apply mode before committing local session state so setMode failures
      // do not leave a half-initialized sessionId/loadedSessionId.
      await this.applySessionMode(sessionId);
      this.loadedSessionId = sessionId;
      this.sessionId = sessionId;
      this.sessionInvalidated = false;
      this.sessionCwds.set(sessionId, cwd);
      return sessionId;
    } catch {
      this.clearActiveSession();
      return null;
    }
  }

  private async loadSession(sessionId: string, cwd: string): Promise<boolean> {
    if (!this.connection || !sessionId) {
      return false;
    }
    try {
      this.setSupportedCommands([]);
      this.currentSessionModeId = null;
      const response = await this.connection.loadSession({
        cwd,
        mcpServers: [],
        sessionId,
      });
      const resolvedSessionId = response.sessionId || sessionId;
      await this.applySessionMode(resolvedSessionId);
      this.loadedSessionId = resolvedSessionId;
      this.sessionId = resolvedSessionId;
      this.sessionInvalidated = false;
      this.sessionCwds.set(resolvedSessionId, cwd);
      return true;
    } catch {
      this.clearActiveSession();
      return false;
    }
  }

  /**
   * Apply Claudian permission mode to the live ACP session.
   * Plan => modeId "plan"; normal/yolo => modeId "default".
   */
  private async applySessionMode(sessionId: string): Promise<void> {
    if (!this.connection || !sessionId) {
      return;
    }

    const modeId = resolveGrokAcpModeId(this.resolvePermissionMode());
    if (modeId === this.currentSessionModeId) {
      return;
    }

    await this.connection.setMode({
      modeId,
      sessionId,
    });
    this.currentSessionModeId = modeId;
  }

  private resolvePermissionMode(): string {
    // Active toolbar permission mode is projected onto top-level settings.
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const mode = typeof settings.permissionMode === 'string'
      ? settings.permissionMode.trim()
      : '';
    return mode || 'normal';
  }

  private async handleSessionNotification(
    notification: AcpSessionNotification,
    connectionGeneration: number,
  ): Promise<void> {
    if (connectionGeneration !== this.connectionGeneration) {
      return;
    }
    const sessionId = notification.sessionId ?? this.sessionId;
    if (!sessionId || sessionId !== this.sessionId) {
      return;
    }

    const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
    if (!normalized) {
      return;
    }

    if (normalized.type === 'commands') {
      this.setSupportedCommands(normalized.commands);
      return;
    }

    if (!this.activeTurn || this.activeTurn.sessionId !== sessionId) {
      return;
    }

    switch (normalized.type) {
      case 'message_chunk': {
        if (normalized.role === 'assistant' && normalized.messageId) {
          this.currentTurnMetadata.assistantMessageId = normalized.messageId;
        }
        if (normalized.role === 'user' && normalized.messageId) {
          this.currentTurnMetadata.userMessageId = normalized.messageId;
        }
        for (const chunk of normalized.streamChunks) {
          this.activeTurn.queue.push(chunk);
        }
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        for (const chunk of normalized.streamChunks) {
          this.activeTurn.queue.push(chunk);
        }
        return;
      }
      case 'usage': {
        const usage = buildAcpUsageInfo({
          contextWindow: normalized.usage,
          model: this.resolveSelectedModel(
            ProviderSettingsCoordinator.getProviderSettingsSnapshot(this.plugin.settings, 'grok'),
          ),
        });
        if (usage) {
          this.activeTurn.queue.push({
            sessionId,
            type: 'usage',
            usage,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async handlePermissionRequest(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    if (!this.approvalCallback) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const toolCall = request.toolCall ?? {};
    const rawInput = (toolCall as { rawInput?: unknown; input?: unknown; arguments?: unknown }).rawInput
      ?? (toolCall as { input?: unknown }).input
      ?? (toolCall as { arguments?: unknown }).arguments;
    const input = normalizeApprovalInput(rawInput);
    const title = (
      (toolCall as { title?: unknown }).title
      ?? (toolCall as { kind?: unknown }).kind
      ?? (toolCall as { name?: unknown }).name
      ?? 'Grok tool'
    ).toString();
    const options = Array.isArray(request.options) ? request.options : [];
    const decision = await this.approvalCallback(
      title,
      input,
      `Grok wants to use ${title}.`,
      options.length > 0
        ? { decisionOptions: buildAcpApprovalDecisionOptions(options) }
        : undefined,
    );

    if (options.length > 0) {
      return mapApprovalDecision(decision, options);
    }

    if (decision === 'allow' || decision === 'allow-always') {
      return {
        outcome: {
          optionId: decision === 'allow-always' ? 'allow_always' : 'allow_once',
          outcome: 'selected',
        },
      };
    }

    return { outcome: { outcome: 'cancelled' } };
  }

  private setSupportedCommands(commands: SlashCommand[]): void {
    this.supportedCommands = commands.map((command) => ({ ...command }));
    const waiters = this.supportedCommandWaiters.splice(0);
    for (const waiter of waiters) {
      waiter(this.supportedCommands);
    }
  }

  private waitForSupportedCommands(timeoutMs = 250): Promise<SlashCommand[]> {
    if (this.supportedCommands.length > 0) {
      return Promise.resolve([...this.supportedCommands]);
    }
    return new Promise((resolve) => {
      const waiter = (commands: SlashCommand[]) => {
        window.clearTimeout(timeoutId);
        resolve([...commands]);
      };
      const timeoutId = window.setTimeout(() => {
        const index = this.supportedCommandWaiters.indexOf(waiter);
        if (index >= 0) {
          this.supportedCommandWaiters.splice(index, 1);
        }
        resolve([...this.supportedCommands]);
      }, timeoutMs);
      this.supportedCommandWaiters.push(waiter);
    });
  }

  private async readTextFile(
    request: AcpReadTextFileRequest,
  ): Promise<{ content: string }> {
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    const content = await fs.readFile(resolvedPath, 'utf-8');
    if (request.line === undefined && request.limit === undefined) {
      return { content };
    }
    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, (request.line ?? 1) - 1);
    const endIndex = request.limit
      ? startIndex + Math.max(0, request.limit)
      : lines.length;
    return {
      content: lines.slice(startIndex, endIndex).join('\n'),
    };
  }

  private async writeTextFile(
    request: { sessionId: string; path: string; content: string },
  ): Promise<Record<string, never>> {
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, request.content, 'utf-8');
    return {};
  }

  private resolveSessionPath(sessionId: string, rawPath: string): string {
    if (typeof rawPath !== 'string') {
      return getVaultPath(this.plugin.app) ?? process.cwd();
    }
    if (path.isAbsolute(rawPath)) {
      return rawPath;
    }
    const cwd = this.sessionCwds.get(sessionId)
      ?? getVaultPath(this.plugin.app)
      ?? process.cwd();
    return path.resolve(cwd, rawPath);
  }

  private formatRuntimeError(error: unknown): string {
    const baseMessage = error instanceof Error ? error.message : 'Grok ACP request failed';
    const stderr = this.process?.getStderrSnapshot();
    return stderr ? `${baseMessage}\n\n${stderr}` : baseMessage;
  }

  private clearActiveSession(): void {
    this.sessionId = null;
    this.loadedSessionId = null;
    this.currentSessionModeId = null;
    this.sessionUpdateNormalizer.reset();
    this.setSupportedCommands([]);
  }

  private settleActiveTurn(error?: Error): void {
    if (!this.activeTurn) {
      return;
    }
    this.activeTurn.cancelled = true;
    if (error) {
      this.activeTurn.queue.push({ type: 'error', content: error.message });
      this.activeTurn.queue.push({ type: 'done' });
    }
    // Close output for consumers; leave activeTurn until promptSettled so
    // overlapping queries stay blocked for the remainder of the ACP RPC.
    this.activeTurn.queue.close();
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) {
      return;
    }
    this.ready = ready;
    for (const listener of this.readyListeners) {
      try {
        listener(ready);
      } catch {
        // ignore
      }
    }
  }

  private isLifecycleCurrent(generation: number): boolean {
    return !this.disposed && generation === this.lifecycleGeneration;
  }

  private isConversationCurrent(generation: number): boolean {
    return generation === this.conversationGeneration;
  }

  private isReadinessCurrent(
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): boolean {
    return this.isLifecycleCurrent(lifecycleGeneration)
      && this.isConversationCurrent(conversationGeneration);
  }

  private setCurrentConversationModel(model: unknown): void {
    const selectedModel = typeof model === 'string' ? model.trim() : '';
    this.currentConversationModel = selectedModel || null;
  }

  private resolveSelectedModel(settings: Record<string, unknown>): string {
    if (this.currentConversationModel) {
      return this.currentConversationModel;
    }
    if (typeof settings.model === 'string' && settings.model.trim()) {
      return settings.model.trim();
    }
    return GROK_DEFAULT_MODEL;
  }
}

function normalizeApprovalInput(rawInput: unknown): Record<string, unknown> {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>;
  }
  if (rawInput === undefined) {
    return {};
  }
  return { value: rawInput };
}

function mapApprovalDecision(
  decision: ApprovalDecision,
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    optionId: string;
  }[],
): AcpRequestPermissionResponse {
  if (decision === 'allow') {
    return selectPermissionOption(options, ['allow_once', 'allow_always']);
  }
  if (decision === 'allow-always') {
    return selectPermissionOption(options, ['allow_always', 'allow_once']);
  }
  if (decision === 'deny') {
    return selectPermissionOption(options, ['reject_once', 'reject_always']);
  }
  if (typeof decision === 'object' && decision.type === 'select-option') {
    return {
      outcome: {
        optionId: decision.value,
        outcome: 'selected',
      },
    };
  }
  return { outcome: { outcome: 'cancelled' } };
}

function selectPermissionOption(
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    optionId: string;
  }[],
  preferredKinds: Array<'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'>,
): AcpRequestPermissionResponse {
  for (const kind of preferredKinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return {
        outcome: {
          optionId: match.optionId,
          outcome: 'selected',
        },
      };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

function buildAcpApprovalDecisionOptions(
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    name: string;
    optionId: string;
  }[],
): ApprovalDecisionOption[] {
  return options.map((option) => ({
    ...(option.kind === 'allow_once'
      ? { decision: 'allow' as const }
      : option.kind === 'allow_always'
      ? { decision: 'allow-always' as const }
      : {}),
    label: option.name,
    value: option.optionId,
  }));
}
