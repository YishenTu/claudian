import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderCapabilities,
} from '../../../core/providers/types';
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
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../../core/types';
import { getEnhancedPath } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpReadTextFileRequest,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionModeState,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  type AcpUsage,
  type AcpUsageUpdate,
  type AcpWriteTextFileRequest,
  buildAcpUsageInfo,
  extractAcpSessionModelState,
  extractAcpSessionModeState,
  extractAcpSessionThoughtLevelState,
  resolveAcpLoadSessionId,
} from '../../acp';
import {
  buildAcpApprovalDecisionOptions,
  mapAcpApprovalDecision,
} from '../../acp/AcpPermissionAdapter';
import { OPENCODE_PROVIDER_CAPABILITIES } from '../capabilities';
import { updateOpencodeDiscoveryState } from '../discoveryState';
import {
  sameDiscoveredModels,
  sameModes,
  sameStringMap,
  sameThinkingOptionsByModel,
} from '../internal/compareCollections';
import { ensureProviderProjectionMap } from '../internal/providerProjection';
import {
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  isOpencodeModelSelectionId,
  normalizeOpencodeDiscoveredModels,
  normalizeOpencodeModelVariants,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  resolveOpencodeBaseModelRawId,
  resolveOpencodeDefaultThinkingLevel,
} from '../models';
import {
  getManagedOpencodeModes,
  isManagedOpencodeModeId,
  normalizeOpencodeAvailableModes,
  resolveOpencodeModeForPermissionMode,
  resolvePermissionModeForManagedOpencodeMode,
} from '../modes';
import { createOpencodeToolStreamAdapter } from '../normalization/opencodeToolNormalization';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '../settings';
import { getOpencodeState, type OpencodeProviderState } from '../types';
import { buildOpencodePromptBlocks, buildOpencodePromptText } from './buildOpencodePrompt';
import { prepareOpencodeLaunchArtifacts } from './OpencodeLaunchArtifacts';
import { buildOpencodeRuntimeEnv } from './OpencodeRuntimeEnvironment';

interface ActiveTurn {
  cancelled: boolean;
  queue: StreamChunkQueue;
  sessionId: string;
}

interface SupportedCommandWaiter {
  reject: (error: Error) => void;
  resolve: (commands: SlashCommand[]) => void;
  timeoutId: number;
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

export class OpencodeChatRuntime implements ChatRuntime {
  readonly providerId = 'opencode' as const;

  private activeTurn: ActiveTurn | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private conversationId: string | null = null;
  private conversationGeneration = 0;
  private contextUsage: AcpUsageUpdate | null = null;
  private currentDatabasePath: string | null = null;
  private currentLaunchKey: string | null = null;
  private currentSessionEffortConfigId: string | null = null;
  private currentSessionEffortValue: string | null = null;
  private currentSessionEffortValues = new Set<string>();
  private currentSessionModelId: string | null = null;
  private currentConversationModel: string | null = null;
  private currentSessionModeId: string | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private loadedSessionId: string | null = null;
  private permissionModeSyncCallback: ((mode: string) => void) | null = null;
  private process: AcpSubprocess | null = null;
  private promptUsage: AcpUsage | null = null;
  private readonly readyListeners: Array<(ready: boolean) => void> = [];
  private ready = false;
  private readinessFlight: { key: string; promise: Promise<boolean> } | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;
  private restartRequiredAfterCancel = false;
  private sessionInvalidated = false;
  private readonly pendingSupportedCommands = new Map<string, SlashCommand[]>();
  private readonly supportedCommandListeners = new Set<(
    commands: readonly SlashCommand[],
  ) => void>();
  private readonly supportedCommandWaiters: SupportedCommandWaiter[] = [];
  private supportedCommandsAdvertised = false;
  private supportedCommands: SlashCommand[] = [];
  private sessionCwds = new Map<string, string>();
  private sessionId: string | null = null;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private readonly toolStreamAdapter = createOpencodeToolStreamAdapter();
  private transport: AcpJsonRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;

  constructor(
    private readonly plugin: ProviderHost,
  ) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return OPENCODE_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildOpencodePromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.push(listener);
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
    const nextSessionId = conversation?.sessionId ?? null;
    const state = getOpencodeState(conversation?.providerState);
    const nextDatabasePath = state.databasePath
      ?? ((!nextSessionId || nextSessionId !== previousSessionId) ? null : this.currentDatabasePath);
    const targetChanged = nextConversationId !== this.conversationId
      || nextSessionId !== this.sessionId
      || nextDatabasePath !== this.currentDatabasePath;
    if (this.sessionId !== nextSessionId) {
      this.rejectSupportedCommandWaiters(
        new Error('OpenCode command discovery context changed.'),
      );
      this.pendingSupportedCommands.clear();
      this.currentSessionEffortConfigId = null;
      this.currentSessionEffortValue = null;
      this.currentSessionEffortValues = new Set<string>();
      this.currentSessionModelId = null;
      this.currentSessionModeId = null;
      this.sessionInvalidated = false;
      this.clearSupportedCommands();
    }
    this.conversationId = nextConversationId;
    this.sessionId = nextSessionId;
    this.currentDatabasePath = nextDatabasePath;
    if (targetChanged) {
      this.conversationGeneration += 1;
      if (this.readinessFlight) {
        void this.shutdownProcess();
      }
    }
  }

  async reloadMcpServers(): Promise<void> {}

  async warmModelMetadata(model: string): Promise<boolean> {
    const conversationGeneration = this.conversationGeneration;
    const selectedRawModelId = decodeOpencodeModelId(model);
    if (!selectedRawModelId) {
      return false;
    }

    if (!(await this.ensureReady({ allowSessionCreation: true }))) {
      return false;
    }
    if (
      !this.connection
      || !this.sessionId
      || !this.isConversationCurrent(conversationGeneration)
    ) {
      return false;
    }

    const discoveredModels = getOpencodeProviderSettings(this.plugin.settings).discoveredModels;
    const selectedBaseRawModelId = resolveOpencodeBaseModelRawId(selectedRawModelId, discoveredModels);
    if (!selectedBaseRawModelId) {
      return false;
    }

    const availableModelIds = new Set(discoveredModels.map((entry) => entry.rawId));
    if (availableModelIds.size > 0 && !availableModelIds.has(selectedBaseRawModelId)) {
      return false;
    }

    const response = await this.connection.setConfigOption({
      configId: 'model',
      sessionId: this.sessionId,
      type: 'select',
      value: selectedBaseRawModelId,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return false;
    }
    this.currentSessionModelId = selectedBaseRawModelId;
    await this.syncSessionModelState({
      configOptions: response.configOptions,
    }, conversationGeneration);
    return this.isConversationCurrent(conversationGeneration);
  }

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
    const settings = getOpencodeProviderSettings(this.plugin.settings);
    if (!settings.enabled) {
      this.setReady(false);
      return false;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const targetSessionId = this.sessionId;
    const resolvedCliPath = await this.plugin.getResolvedProviderCliPath('opencode') ?? 'opencode';
    const runtimeEnv = this.buildRuntimeEnv(
      resolvedCliPath,
      this.currentDatabasePath,
    );
    const promptSettings = this.getSystemPromptSettings(cwd);
    const artifacts = await prepareOpencodeLaunchArtifacts({
      runtimeEnv,
      settings: promptSettings,
      workspaceRoot: cwd,
    });
    if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
      return false;
    }
    this.currentDatabasePath = artifacts.databasePath;

    const nextLaunchKey = JSON.stringify({
      command: resolvedCliPath,
      configPath: artifacts.configPath,
      envText: getRuntimeEnvironmentText(this.plugin.settings, 'opencode'),
      promptKey: computeSystemPromptKey(promptSettings),
      artifactKey: artifacts.launchKey,
    });

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || options?.force === true
      || this.restartRequiredAfterCancel
      || this.currentLaunchKey !== nextLaunchKey;

    if (shouldRestart) {
      await this.shutdownProcess({ preserveCommandWaiters: true });
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        return false;
      }
      await this.startProcess({
        command: resolvedCliPath,
        configPath: artifacts.configPath,
        cwd,
        runtimeEnv,
      });
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
      this.restartRequiredAfterCancel = false;
      this.currentLaunchKey = nextLaunchKey;
      this.loadedSessionId = null;
      this.setReady(true);
    }

    if (targetSessionId) {
      if (this.loadedSessionId !== targetSessionId) {
        const loaded = await this.loadSession(targetSessionId, cwd, conversationGeneration);
        if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
          await this.shutdownProcess();
          return false;
        }
        if (!loaded) {
          this.sessionInvalidated = true;
          this.clearActiveSession();
        }
      }
      return true;
    }

    if (!this.sessionId && !this.sessionInvalidated) {
      if (options?.allowSessionCreation === false) {
        return true;
      }
      const sessionId = await this.createSession(cwd, conversationGeneration);
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
    if (this.activeTurn) {
      yield { type: 'error', content: 'OpenCode does not support overlapping turns.' };
      yield { type: 'done' };
      return;
    }
    if (queryOptions?.model) {
      this.setCurrentConversationModel(queryOptions.model);
    }
    if (!this.resolveSelectedRawModelId(queryOptions)) {
      yield {
        type: 'error',
        content: 'No OpenCode model is selected. Enable a discovered model in Claudian settings.',
      };
      yield { type: 'done' };
      return;
    }
    const conversationGeneration = this.conversationGeneration;
    const previousMessages = conversationHistory ?? [];
    const expectedSessionId = this.sessionId;
    let shouldBootstrapHistory = previousMessages.length > 0
      && (!expectedSessionId || this.sessionInvalidated);

    if (!(await this.ensureReady())) {
      yield { type: 'error', content: 'Failed to start OpenCode. Check the CLI path and login state.' };
      yield { type: 'done' };
      return;
    }

    if (!this.isConversationCurrent(conversationGeneration)) {
      yield { type: 'error', content: 'OpenCode conversation changed before the turn started.' };
      yield { type: 'done' };
      return;
    }

    if (!this.connection) {
      yield { type: 'error', content: 'OpenCode runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    if (expectedSessionId && !this.sessionId) {
      shouldBootstrapHistory = previousMessages.length > 0;
    }

    if (!this.sessionId) {
      const sessionId = await this.createSession(cwd, conversationGeneration);
      if (!sessionId) {
        yield { type: 'error', content: 'Failed to create an OpenCode session.' };
        yield { type: 'done' };
        return;
      }
    }

    const sessionId = this.sessionId!;
    this.activeTurn = {
      cancelled: false,
      queue: new StreamChunkQueue(),
      sessionId,
    };
    this.currentTurnMetadata = {};
    this.contextUsage = null;
    this.promptUsage = null;
    this.sessionUpdateNormalizer.reset();
    this.toolStreamAdapter.reset();

    const activeTurn = this.activeTurn;
    try {
      await this.applySelectedMode(sessionId, conversationGeneration);
      await this.applySelectedModel(sessionId, queryOptions, conversationGeneration);
      await this.applySelectedEffort(sessionId, conversationGeneration);
      if (!this.isConversationCurrent(conversationGeneration)) {
        throw new Error('OpenCode conversation changed before the turn started.');
      }
    } catch (error) {
      yield {
        type: 'error',
        content: this.formatRuntimeError(error),
      };
      yield { type: 'done' };
      activeTurn.queue.close();
      this.activeTurn = null;
      return;
    }

    const promptPromise = this.connection.prompt({
      prompt: buildOpencodePromptBlocks(
        turn.request,
        shouldBootstrapHistory ? previousMessages : [],
      ),
      sessionId,
    }).then((response) => {
      if (response.userMessageId) {
        this.currentTurnMetadata.userMessageId = response.userMessageId;
      }
      this.promptUsage = response.usage ?? null;

      const usage = buildAcpUsageInfo({
        contextWindow: this.contextUsage,
        model: this.getActiveDisplayModel(queryOptions),
        promptUsage: this.promptUsage,
      });
      if (usage) {
        activeTurn.queue.push({ sessionId, type: 'usage', usage });
      }

      activeTurn.queue.push({ type: 'done' });
      activeTurn.queue.close();
    }).catch((error) => {
      activeTurn.queue.push({
        type: 'error',
        content: this.formatRuntimeError(error),
      });
      activeTurn.queue.push({ type: 'done' });
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
      if (!activeTurn.cancelled) {
        await promptPromise;
      }
    } finally {
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
    if (this.connection && this.sessionId) {
      this.connection.cancel({ sessionId: this.sessionId });
    }
    this.restartRequiredAfterCancel = true;
    this.settleActiveTurn();
  }

  resetSession(): void {
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
    if (this.supportedCommandsAdvertised && this.loadedSessionId === this.sessionId) {
      return [...this.supportedCommands];
    }

    if (this.sessionId && this.loadedSessionId !== this.sessionId) {
      const ready = await this.ensureReady({ allowSessionCreation: false });
      if (!ready) {
        return [];
      }
    }

    if (!this.sessionId) {
      return [];
    }

    if (!this.sessionId || this.loadedSessionId !== this.sessionId) {
      return [];
    }

    try {
      return await this.discoverSupportedCommands();
    } catch {
      return [];
    }
  }

  discoverSupportedCommands(timeoutMs = 5_000): Promise<SlashCommand[]> {
    if (this.supportedCommandsAdvertised && this.loadedSessionId === this.sessionId) {
      return Promise.resolve(this.cloneSupportedCommands());
    }

    return new Promise<SlashCommand[]>((resolve, reject) => {
      const waiter: SupportedCommandWaiter = {
        reject,
        resolve,
        timeoutId: window.setTimeout(() => {
          const index = this.supportedCommandWaiters.indexOf(waiter);
          if (index >= 0) {
            this.supportedCommandWaiters.splice(index, 1);
          }
          reject(new Error('Timed out waiting for OpenCode commands.'));
        }, timeoutMs),
      };
      this.supportedCommandWaiters.push(waiter);
    });
  }

  onSupportedCommandsChange(
    listener: (commands: readonly SlashCommand[]) => void,
  ): () => void {
    this.supportedCommandListeners.add(listener);
    return () => {
      this.supportedCommandListeners.delete(listener);
    };
  }

  cleanup(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.activeTurn?.queue.close();
    this.rejectSupportedCommandWaiters(new Error('OpenCode runtime stopped.'));
    this.supportedCommandListeners.clear();
    void this.shutdownProcess();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return { canRewind: false };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {}

  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}

  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const existingState = params.conversation
      ? getOpencodeState(params.conversation.providerState)
      : null;
    const providerState: OpencodeProviderState = {
      ...(this.currentDatabasePath || existingState?.databasePath
        ? { databasePath: this.currentDatabasePath ?? existingState?.databasePath }
        : {}),
    };
    const updates: Partial<Conversation> = {
      providerState: Object.keys(providerState).length > 0
        ? providerState as Record<string, unknown>
        : undefined,
      sessionId: this.sessionId,
    };

    if (params.sessionInvalidated) {
      if (!this.sessionId) {
        updates.providerState = undefined;
        updates.sessionId = null;
      }
    }

    return { updates };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.sessionId ?? conversation?.sessionId ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private async startProcess(params: {
    command: string;
    configPath: string;
    cwd: string;
    runtimeEnv: NodeJS.ProcessEnv;
  }): Promise<void> {
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...params.runtimeEnv,
      OPENCODE_CONFIG: params.configPath,
      PATH: getEnhancedPath(
        params.runtimeEnv.PATH,
        path.isAbsolute(params.command) ? params.command : undefined,
      ),
    };

    this.process = new AcpSubprocess({
      args: ['acp', `--cwd=${params.cwd}`],
      command: params.command,
      cwd: params.cwd,
      env: processEnv,
    });
    this.process.start();

    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: (listener) => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    const transport = this.transport;
    this.unregisterTransportClose = transport.onClose((error) => {
      if (this.transport === transport) {
        this.setReady(false);
        this.rejectSupportedCommandWaiters(error ?? new Error('OpenCode runtime closed.'));
        this.settleActiveTurn(error ?? new Error('OpenCode runtime closed'));
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
    await this.connection.initialize();
  }

  private async shutdownProcess(options?: { preserveCommandWaiters?: boolean }): Promise<void> {
    this.connectionGeneration += 1;
    this.setReady(false);
    this.settleActiveTurn();
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
    if (!options?.preserveCommandWaiters) {
      this.rejectSupportedCommandWaiters(new Error('OpenCode runtime stopped.'));
    }
    this.clearSupportedCommands();
    this.pendingSupportedCommands.clear();

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
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) {
      return;
    }

    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
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

  private getSystemPromptSettings(vaultPath: string): SystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath,
    };
  }

  private buildRuntimeEnv(
    cliPath: string,
    databasePathOverride?: string | null,
  ): NodeJS.ProcessEnv {
    return buildOpencodeRuntimeEnv(
      this.plugin.settings,
      cliPath,
      databasePathOverride,
    );
  }

  private getProviderSettings(): Record<string, unknown> {
    const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings,
      this.providerId,
    );
    if (this.currentConversationModel) {
      settings.model = this.currentConversationModel;
    }
    return settings;
  }

  private resolveSelectedRawModelId(queryOptions?: ChatRuntimeQueryOptions): string | null {
    const providerSettings = this.getProviderSettings();
    const selectedModel = typeof queryOptions?.model === 'string'
      ? queryOptions.model
      : typeof providerSettings.model === 'string'
      ? providerSettings.model
      : '';

    if (!isOpencodeModelSelectionId(selectedModel)) {
      return null;
    }

    const selectedBaseRawModelId = decodeOpencodeModelId(selectedModel);
    if (!selectedBaseRawModelId) {
      return null;
    }

    const discoveredModels = getOpencodeProviderSettings(providerSettings).discoveredModels;
    const normalizedBaseRawModelId = resolveOpencodeBaseModelRawId(selectedBaseRawModelId, discoveredModels);
    if (!normalizedBaseRawModelId) {
      return null;
    }

    const availableModelIds = new Set(discoveredModels.map((model) => model.rawId));
    if (availableModelIds.size > 0 && !availableModelIds.has(normalizedBaseRawModelId)) {
      return null;
    }

    const visibleModels = getOpencodeProviderSettings(providerSettings).visibleModels;
    if (!visibleModels.includes(normalizedBaseRawModelId)) {
      return null;
    }

    return normalizedBaseRawModelId;
  }

  getAuxiliaryModel(): string | null {
    return this.currentConversationModel ?? this.getActiveDisplayModel() ?? null;
  }

  private setCurrentConversationModel(model: unknown): void {
    const selectedModel = typeof model === 'string' ? model.trim() : '';
    this.currentConversationModel = selectedModel || null;
  }

  private getActiveDisplayModel(queryOptions?: ChatRuntimeQueryOptions): string | undefined {
    const providerSettings = this.getProviderSettings();
    const selectedModel = typeof queryOptions?.model === 'string'
      ? queryOptions.model
      : typeof providerSettings.model === 'string'
      ? providerSettings.model
      : '';

    if (
      selectedModel
      && isOpencodeModelSelectionId(selectedModel)
    ) {
      const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
      return selectedRawModelId
        ? encodeOpencodeModelId(selectedRawModelId)
        : selectedModel;
    }

    return this.currentSessionModelId
      ? encodeOpencodeModelId(this.currentSessionModelId)
      : (selectedModel && isOpencodeModelSelectionId(selectedModel) ? selectedModel : undefined);
  }

  private resolveSelectedModeId(): string | null {
    const providerSettings = this.getProviderSettings();
    const opencodeSettings = getOpencodeProviderSettings(providerSettings);
    const availableModes = getManagedOpencodeModes(opencodeSettings.availableModes);
    const mappedModeId = resolveOpencodeModeForPermissionMode(
      providerSettings.permissionMode,
      opencodeSettings.availableModes,
    );
    if (mappedModeId) {
      return mappedModeId;
    }

    if (opencodeSettings.selectedMode) {
      if (
        availableModes.some((mode) => mode.id === opencodeSettings.selectedMode)
      ) {
        return opencodeSettings.selectedMode;
      }
    }

    return availableModes[0]?.id || null;
  }

  private async applySelectedMode(
    sessionId: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    if (!this.connection) {
      return;
    }

    const selectedModeId = this.resolveSelectedModeId();
    if (!selectedModeId || selectedModeId === this.currentSessionModeId) {
      return;
    }

    const response = await this.connection.setConfigOption({
      configId: 'mode',
      sessionId,
      type: 'select',
      value: selectedModeId,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionModeId = selectedModeId;
    await this.syncSessionModeState({
      configOptions: response.configOptions,
    }, conversationGeneration);
  }

  private async applySelectedModel(
    sessionId: string,
    queryOptions?: ChatRuntimeQueryOptions,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    if (!this.connection) {
      return;
    }

    const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
    if (!selectedRawModelId) {
      throw new Error('No OpenCode model is selected. Enable a discovered model in Claudian settings.');
    }
    if (selectedRawModelId === this.currentSessionModelId) {
      return;
    }

    const response = await this.connection.setConfigOption({
      configId: 'model',
      sessionId,
      type: 'select',
      value: selectedRawModelId,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionModelId = selectedRawModelId;
    await this.syncSessionModelState({
      configOptions: response.configOptions,
    }, conversationGeneration);
  }

  private resolveSelectedEffortValue(): string | null {
    const providerSettings = this.getProviderSettings();
    const selectedEffort = typeof providerSettings.effortLevel === 'string'
      ? providerSettings.effortLevel.trim()
      : '';
    if (!selectedEffort || selectedEffort === OPENCODE_DEFAULT_THINKING_LEVEL) {
      return null;
    }

    return this.currentSessionEffortValues.has(selectedEffort)
      ? selectedEffort
      : null;
  }

  private async applySelectedEffort(
    sessionId: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    if (!this.connection || !this.currentSessionEffortConfigId) {
      return;
    }

    const selectedEffort = this.resolveSelectedEffortValue();
    if (!selectedEffort || selectedEffort === this.currentSessionEffortValue) {
      return;
    }

    const response = await this.connection.setConfigOption({
      configId: this.currentSessionEffortConfigId,
      sessionId,
      type: 'select',
      value: selectedEffort,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionEffortValue = selectedEffort;
    await this.syncSessionModelState({
      configOptions: response.configOptions,
    }, conversationGeneration);
  }

  private async syncSessionModelState(params: {
    configOptions?: AcpSessionConfigOption[] | null;
    models?: AcpSessionModelState | null;
  }, conversationGeneration?: number): Promise<void> {
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) {
      return;
    }
    const acpState = extractAcpSessionModelState(params);
    const currentRawModelId = acpState.currentModelId ?? this.currentSessionModelId;
    const discoveredModels = normalizeOpencodeDiscoveredModels(
      acpState.availableModels.map((model) => ({
        ...(model.description ? { description: model.description } : {}),
        label: model.name,
        rawId: model.id,
      })),
    );
    if (currentRawModelId) {
      this.currentSessionModelId = currentRawModelId;
    }

    const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
    const currentSettings = getOpencodeProviderSettings(settingsBag);
    const currentBaseRawModelId = currentRawModelId
      ? resolveOpencodeBaseModelRawId(currentRawModelId, discoveredModels)
      : null;
    const currentPreferredThinking = currentBaseRawModelId
      ? currentSettings.preferredThinkingByModel[currentBaseRawModelId]
      : '';
    const thoughtLevelState = extractAcpSessionThoughtLevelState(params);
    const currentThinkingOptions = normalizeOpencodeModelVariants(
      thoughtLevelState.availableLevels.map((level) => ({
        ...(level.description ? { description: level.description } : {}),
        label: level.name,
        value: level.id,
      })),
    );
    const currentThinkingLevel = thoughtLevelState.currentLevel;
    const defaultThinkingLevel = currentThinkingOptions.length > 0
      ? resolveOpencodeDefaultThinkingLevel(
        currentThinkingOptions,
        currentPreferredThinking,
        currentThinkingLevel ?? undefined,
      )
      : currentThinkingLevel;
    this.currentSessionEffortConfigId = currentThinkingOptions.length > 0
      ? thoughtLevelState.configId
      : null;
    this.currentSessionEffortValue = currentThinkingOptions.length > 0
      ? currentThinkingLevel
      : null;
    this.currentSessionEffortValues = new Set(currentThinkingOptions.map((option) => option.value));

    const nextThinkingOptionsByModel = { ...currentSettings.thinkingOptionsByModel };
    if (currentBaseRawModelId) {
      if (currentThinkingOptions.length > 0) {
        nextThinkingOptionsByModel[currentBaseRawModelId] = currentThinkingOptions;
      } else {
        delete nextThinkingOptionsByModel[currentBaseRawModelId];
      }
    }

    const shouldSeedCurrentThinking = currentBaseRawModelId
      && defaultThinkingLevel
      && (
        !currentPreferredThinking
        || (
          currentThinkingOptions.length > 0
          && !this.currentSessionEffortValues.has(currentPreferredThinking)
        )
      );
    const nextPreferredThinkingByModel = shouldSeedCurrentThinking && currentBaseRawModelId && defaultThinkingLevel
      ? {
        ...currentSettings.preferredThinkingByModel,
        [currentBaseRawModelId]: defaultThinkingLevel,
      }
      : currentSettings.preferredThinkingByModel;
    const shouldSeedPreferredThinking = !sameStringMap(
      currentSettings.preferredThinkingByModel,
      nextPreferredThinkingByModel,
    );
    const shouldUpdateDiscoveredModels = discoveredModels.length > 0
      && !sameDiscoveredModels(currentSettings.discoveredModels, discoveredModels);
    const shouldUpdateThinkingOptions = !sameThinkingOptionsByModel(
      currentSettings.thinkingOptionsByModel,
      nextThinkingOptionsByModel,
    );
    const discoveryChanged = shouldUpdateDiscoveredModels
      && updateOpencodeDiscoveryState(settingsBag, { discoveredModels });
    let changed = shouldSeedPreferredThinking;

    if (currentBaseRawModelId && currentSettings.visibleModels.includes(currentBaseRawModelId)) {
      const probeSettings = {
        ...settingsBag,
        savedProviderEffort: {
          ...(settingsBag.savedProviderEffort as Record<string, unknown> | undefined),
        },
        savedProviderModel: {
          ...(settingsBag.savedProviderModel as Record<string, unknown> | undefined),
        },
      };
      const seeded = this.seedActiveModelSelection(
        probeSettings,
        encodeOpencodeModelId(currentBaseRawModelId),
        defaultThinkingLevel,
      );
      changed = changed || seeded;
    }

    if (!changed && !discoveryChanged && !shouldUpdateThinkingOptions) {
      return;
    }

    if (changed || shouldUpdateThinkingOptions) {
      await this.plugin.mutateSettings((settings) => {
        if (
          conversationGeneration !== undefined
          && !this.isConversationCurrent(conversationGeneration)
        ) {
          return;
        }
        if (currentBaseRawModelId && currentSettings.visibleModels.includes(currentBaseRawModelId)) {
          this.seedActiveModelSelection(
            settings,
            encodeOpencodeModelId(currentBaseRawModelId),
            defaultThinkingLevel,
          );
        }
        if (shouldUpdateThinkingOptions || shouldSeedPreferredThinking) {
          updateOpencodeProviderSettings(settings, {
            ...(shouldSeedPreferredThinking ? { preferredThinkingByModel: nextPreferredThinkingByModel } : {}),
            ...(shouldUpdateThinkingOptions ? { thinkingOptionsByModel: nextThinkingOptionsByModel } : {}),
          });
        }
      });
    }
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) {
      return;
    }
    this.refreshModelSelectors();
  }

  private seedActiveModelSelection(
    settingsBag: Record<string, unknown>,
    modelSelection: string,
    thinkingLevel: string | null,
  ): boolean {
    let changed = false;
    const savedProviderModel = ensureProviderProjectionMap(settingsBag, 'savedProviderModel');
    const savedModel = typeof savedProviderModel.opencode === 'string'
      ? savedProviderModel.opencode
      : '';
    if (!savedModel) {
      savedProviderModel.opencode = modelSelection;
      changed = true;
    }

    if (thinkingLevel) {
      const savedProviderEffort = ensureProviderProjectionMap(settingsBag, 'savedProviderEffort');
      const savedEffort = typeof savedProviderEffort.opencode === 'string'
        ? savedProviderEffort.opencode.trim()
        : '';
      if (
        !savedEffort
        || savedEffort === OPENCODE_DEFAULT_THINKING_LEVEL
        || !this.currentSessionEffortValues.has(savedEffort)
      ) {
        savedProviderEffort.opencode = thinkingLevel;
        changed = true;
      }
    }

    if (ProviderRegistry.resolveSettingsProviderId(settingsBag) !== this.providerId) {
      return changed;
    }

    const activeModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';
    if (!activeModel) {
      settingsBag.model = modelSelection;
      changed = true;
    }
    if (thinkingLevel) {
      const activeEffort = typeof settingsBag.effortLevel === 'string' ? settingsBag.effortLevel : '';
      if (
        !activeEffort
        || activeEffort === OPENCODE_DEFAULT_THINKING_LEVEL
        || !this.currentSessionEffortValues.has(activeEffort)
      ) {
        settingsBag.effortLevel = thinkingLevel;
        changed = true;
      }
    }
    return changed;
  }

  private async syncSessionModeState(params: {
    configOptions?: AcpSessionConfigOption[] | null;
    currentModeId?: string | null;
    modes?: AcpSessionModeState | null;
  }, conversationGeneration?: number): Promise<void> {
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) {
      return;
    }
    const acpState = extractAcpSessionModeState(params);
    const availableModes = normalizeOpencodeAvailableModes(acpState.availableModes);
    const currentModeId = params.currentModeId ?? acpState.currentModeId;
    if (currentModeId) {
      this.currentSessionModeId = currentModeId;
      this.emitPermissionModeSync(currentModeId);
    }

    const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
    const currentSettings = getOpencodeProviderSettings(settingsBag);
    const shouldSeedSelectedMode = typeof currentModeId === 'string'
      && !currentSettings.selectedMode
      && isManagedOpencodeModeId(currentModeId);
    const discoveryChanged = availableModes.length > 0
      && !sameModes(currentSettings.availableModes, availableModes)
      && updateOpencodeDiscoveryState(settingsBag, { availableModes });

    if (!discoveryChanged && !shouldSeedSelectedMode) {
      return;
    }

    if (shouldSeedSelectedMode && currentModeId) {
      await this.plugin.mutateSettings((settings) => {
        if (
          conversationGeneration !== undefined
          && !this.isConversationCurrent(conversationGeneration)
        ) {
          return;
        }
        updateOpencodeProviderSettings(settings, { selectedMode: currentModeId });
      });
    }
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) {
      return;
    }
    this.refreshModelSelectors();
  }

  private refreshModelSelectors(): void {
    this.plugin.refreshModelSelectors?.();
  }

  private emitPermissionModeSync(modeId: string): void {
    const permissionMode = resolvePermissionModeForManagedOpencodeMode(modeId);
    if (!permissionMode || !this.permissionModeSyncCallback) {
      return;
    }

    try {
      this.permissionModeSyncCallback(permissionMode);
    } catch {
      // Non-critical UI sync callback.
    }
  }

  private settleActiveTurn(error?: Error): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.cancelled) {
      return;
    }

    activeTurn.cancelled = true;
    if (error) {
      activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
    }
    activeTurn.queue.push({ type: 'done' });
    activeTurn.queue.close();
    if (this.activeTurn === activeTurn) {
      this.activeTurn = null;
    }
  }

  private async createSession(
    cwd: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<string | null> {
    if (!this.connection) {
      return null;
    }

    try {
      this.clearSupportedCommands();
      const response = await this.connection.newSession({
        cwd,
        mcpServers: [],
      });
      if (!this.isConversationCurrent(conversationGeneration)) {
        return null;
      }
      this.loadedSessionId = response.sessionId;
      this.sessionId = response.sessionId;
      this.sessionCwds.set(response.sessionId, cwd);
      this.publishPendingSupportedCommands(response.sessionId);
      await this.syncSessionModelState({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      }, conversationGeneration);
      if (!this.isConversationCurrent(conversationGeneration)) {
        return null;
      }
      await this.syncSessionModeState({
        configOptions: response.configOptions ?? null,
        modes: response.modes ?? null,
      }, conversationGeneration);
      if (!this.isConversationCurrent(conversationGeneration)) {
        return null;
      }
      return response.sessionId;
    } catch {
      this.rejectSupportedCommandWaiters(new Error('Failed to create an OpenCode session.'));
      return null;
    }
  }

  private async loadSession(
    sessionId: string,
    cwd: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<boolean> {
    if (!this.connection) {
      return false;
    }

    try {
      this.clearSupportedCommands();
      const response = await this.connection.loadSession({
        cwd,
        mcpServers: [],
        sessionId,
      });
      if (!this.isConversationCurrent(conversationGeneration)) {
        return false;
      }
      const loadedSessionId = resolveAcpLoadSessionId(response, sessionId);
      this.sessionInvalidated = false;
      this.loadedSessionId = loadedSessionId;
      this.sessionId = loadedSessionId;
      this.sessionCwds.set(loadedSessionId, cwd);
      await this.syncSessionModelState({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      }, conversationGeneration);
      if (!this.isConversationCurrent(conversationGeneration)) {
        return false;
      }
      await this.syncSessionModeState({
        configOptions: response.configOptions ?? null,
        modes: response.modes ?? null,
      }, conversationGeneration);
      if (!this.isConversationCurrent(conversationGeneration)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async handleSessionNotification(
    notification: AcpSessionNotification,
    connectionGeneration = this.connectionGeneration,
  ): Promise<void> {
    if (connectionGeneration !== this.connectionGeneration) {
      return;
    }
    let normalized: ReturnType<AcpSessionUpdateNormalizer['normalize']>;
    try {
      normalized = this.sessionUpdateNormalizer.normalize(notification.update);
    } catch {
      if (notification.update.sessionUpdate === 'available_commands_update') {
        this.rejectSupportedCommandWaiters(
          new Error('OpenCode sent malformed command metadata.'),
        );
      }
      return;
    }
    if (notification.sessionId !== this.sessionId) {
      if (
        normalized.type === 'commands'
        && !this.sessionId
        && this.supportedCommandWaiters.length > 0
      ) {
        this.pendingSupportedCommands.set(
          notification.sessionId,
          normalized.commands.map((command) => ({ ...command })),
        );
      }
      return;
    }
    if (normalized.type === 'config_options') {
      await this.syncSessionModelState({
        configOptions: normalized.configOptions,
      });
      await this.syncSessionModeState({
        configOptions: normalized.configOptions,
      });
      return;
    }

    if (normalized.type === 'current_mode') {
      await this.syncSessionModeState({
        currentModeId: normalized.currentModeId,
      });
      return;
    }

    if (normalized.type === 'commands') {
      this.publishSupportedCommands(normalized.commands);
      return;
    }

    if (!this.activeTurn || this.activeTurn.sessionId !== notification.sessionId) {
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
        const streamChunks = normalized.type === 'tool_call'
          ? this.toolStreamAdapter.normalizeToolCall(normalized.toolCall, normalized.streamChunks)
          : this.toolStreamAdapter.normalizeToolCallUpdate(normalized.toolCallUpdate, normalized.streamChunks);

        for (const chunk of streamChunks) {
          this.activeTurn.queue.push(chunk);
        }
        return;
      }
      case 'usage': {
        this.contextUsage = normalized.usage;
        const usage = buildAcpUsageInfo({
          contextWindow: normalized.usage,
          model: this.getActiveDisplayModel(),
          promptUsage: this.promptUsage,
        });
        if (usage) {
          this.activeTurn.queue.push({
            sessionId: notification.sessionId,
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

    const input = normalizeApprovalInput(request.toolCall.rawInput);
    const presentation = buildOpencodePermissionPresentation(request.toolCall.title, input, request.toolCall.locations);
    const decision = await this.approvalCallback(
      presentation.toolName,
      input,
      presentation.description,
      {
        ...(presentation.blockedPath ? { blockedPath: presentation.blockedPath } : {}),
        ...(presentation.decisionReason ? { decisionReason: presentation.decisionReason } : {}),
        decisionOptions: buildAcpApprovalDecisionOptions(request.options),
      },
    );

    return mapAcpApprovalDecision(decision, request.options);
  }

  private publishSupportedCommands(commands: SlashCommand[]): void {
    this.supportedCommands = commands.map((command) => ({ ...command }));
    this.supportedCommandsAdvertised = true;

    const waiters = this.supportedCommandWaiters.splice(0);
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve(this.cloneSupportedCommands());
    }

    const snapshot = Object.freeze(this.supportedCommands.map((command) => (
      Object.freeze({ ...command })
    )));
    for (const listener of this.supportedCommandListeners) {
      try {
        listener(snapshot);
      } catch {
        // Command snapshot observers cannot affect the provider runtime.
      }
    }
  }

  private publishPendingSupportedCommands(sessionId: string): void {
    const commands = this.pendingSupportedCommands.get(sessionId);
    this.pendingSupportedCommands.clear();
    if (commands) {
      this.publishSupportedCommands(commands);
    }
  }

  private clearSupportedCommands(): void {
    this.supportedCommands = [];
    this.supportedCommandsAdvertised = false;
  }

  private cloneSupportedCommands(): SlashCommand[] {
    return this.supportedCommands.map((command) => ({ ...command }));
  }

  private rejectSupportedCommandWaiters(error: Error): void {
    const waiters = this.supportedCommandWaiters.splice(0);
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(error);
    }
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
    request: AcpWriteTextFileRequest,
  ): Promise<Record<string, never>> {
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, request.content, 'utf-8');
    return {};
  }

  private resolveSessionPath(sessionId: string, rawPath: string): string {
    if (path.isAbsolute(rawPath)) {
      return rawPath;
    }

    const cwd = this.sessionCwds.get(sessionId)
      ?? getVaultPath(this.plugin.app)
      ?? process.cwd();
    return path.resolve(cwd, rawPath);
  }

  private formatRuntimeError(error: unknown): string {
    const baseMessage = error instanceof Error ? error.message : 'OpenCode request failed';
    const stderr = this.process?.getStderrSnapshot();
    return stderr ? `${baseMessage}\n\n${stderr}` : baseMessage;
  }

  private clearActiveSession(): void {
    this.currentDatabasePath = null;
    this.sessionId = null;
    this.loadedSessionId = null;
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
    this.clearSupportedCommands();
    this.pendingSupportedCommands.clear();
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

function buildOpencodePermissionPresentation(
  rawTitle: string | null | undefined,
  input: Record<string, unknown>,
  locations: Array<{ path: string }> | null | undefined,
): {
  blockedPath?: string;
  decisionReason?: string;
  description: string;
  toolName: string;
} {
  const permissionId = normalizePermissionId(rawTitle);
  const blockedPath = extractPermissionPath(input, locations);

  switch (permissionId) {
    case 'bash':
      return {
        decisionReason: 'Command execution permission required',
        description: 'OpenCode wants to run a shell command.',
        toolName: 'bash',
      };
    case 'codesearch':
      return {
        description: 'OpenCode wants to search indexed code outside the active buffer.',
        toolName: 'codesearch',
      };
    case 'doom_loop': {
      const repeatedTool = typeof input.tool === 'string' ? input.tool.trim() : '';
      return {
        decisionReason: 'OpenCode detected repeated identical tool calls',
        description: repeatedTool
          ? `Allow another repeated \`${repeatedTool}\` call.`
          : 'Allow another repeated tool call.',
        toolName: 'Doom Loop Guard',
      };
    }
    case 'edit':
      return {
        ...(blockedPath ? { blockedPath } : {}),
        decisionReason: 'File write permission required',
        description: blockedPath
          ? 'OpenCode wants to modify this file.'
          : 'OpenCode wants to apply file changes.',
        toolName: 'edit',
      };
    case 'external_directory':
      return {
        ...(blockedPath ? { blockedPath } : {}),
        decisionReason: 'Path is outside the session working directory',
        description: blockedPath
          ? 'OpenCode wants to access a path outside the working directory.'
          : 'OpenCode wants to access files outside the working directory.',
        toolName: 'External Directory',
      };
    case 'glob':
      return {
        description: 'OpenCode wants to scan file paths with a glob pattern.',
        toolName: 'glob',
      };
    case 'grep':
      return {
        description: 'OpenCode wants to search file contents with a pattern.',
        toolName: 'grep',
      };
    case 'lsp':
      return {
        description: 'OpenCode wants to query language server data.',
        toolName: 'lsp',
      };
    case 'plan_enter':
      return {
        description: 'OpenCode wants to switch this session into planning mode.',
        toolName: 'Enter Plan Mode',
      };
    case 'plan_exit':
      return {
        description: 'OpenCode wants to leave planning mode and resume implementation.',
        toolName: 'Exit Plan Mode',
      };
    case 'question':
      return {
        description: 'OpenCode wants to ask you a direct question before continuing.',
        toolName: 'Ask Question',
      };
    case 'read':
      return {
        ...(blockedPath ? { blockedPath } : {}),
        description: blockedPath
          ? 'OpenCode wants to read this path.'
          : 'OpenCode wants to read project files.',
        toolName: 'read',
      };
    case 'skill':
      return {
        description: 'OpenCode wants to load a skill into the current session.',
        toolName: 'skill',
      };
    case 'todowrite':
      return {
        description: 'OpenCode wants to update the shared task list.',
        toolName: 'todowrite',
      };
    case 'webfetch':
      return {
        description: 'OpenCode wants to fetch content from a URL.',
        toolName: 'webfetch',
      };
    case 'websearch':
      return {
        description: 'OpenCode wants to search the web.',
        toolName: 'websearch',
      };
    case 'workflow_tool_approval': {
      const summary = summarizeWorkflowTools(input);
      return {
        decisionReason: 'Session-level workflow approval requested',
        description: summary
          ? `Pre-approve workflow tools for this session: ${summary}.`
          : 'Pre-approve workflow tools for this session.',
        toolName: 'Workflow Approval',
      };
    }
    default:
      return {
        ...(blockedPath ? { blockedPath } : {}),
        description: blockedPath
          ? `OpenCode wants permission to use ${formatPermissionLabel(permissionId)} on this path.`
          : `OpenCode wants permission to use ${formatPermissionLabel(permissionId)}.`,
        toolName: formatPermissionLabel(permissionId),
      };
  }
}

function normalizePermissionId(value: string | null | undefined): string {
  return value?.trim().toLowerCase() || 'tool';
}

function extractPermissionPath(
  input: Record<string, unknown>,
  locations: Array<{ path: string }> | null | undefined,
): string | undefined {
  const candidateKeys = ['filepath', 'filePath', 'path', 'parentDir'];
  for (const key of candidateKeys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const locationPath = locations?.find((location) => location.path.trim())?.path;
  return locationPath?.trim() || undefined;
}

function summarizeWorkflowTools(input: Record<string, unknown>): string {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const names = tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      return [];
    }

    const entry = tool as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      return [];
    }

    let title = '';
    if (typeof entry.args === 'string') {
      try {
        const parsedArgs = JSON.parse(entry.args) as Record<string, unknown>;
        title = typeof parsedArgs.title === 'string'
          ? parsedArgs.title.trim()
          : typeof parsedArgs.name === 'string'
          ? parsedArgs.name.trim()
          : '';
      } catch {
        title = '';
      }
    }

    return [title ? `${name}: ${title}` : name];
  });

  if (names.length === 0) {
    return '';
  }

  if (names.length <= 3) {
    return names.join(', ');
  }

  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

function formatPermissionLabel(permissionId: string): string {
  return permissionId
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}
