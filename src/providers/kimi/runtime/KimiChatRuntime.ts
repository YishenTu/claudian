import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
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
  JsonRpcErrorResponse,
} from '../../acp';
import { KIMI_PROVIDER_CAPABILITIES } from '../capabilities';
import { updateKimiDiscoveryState } from '../discoveryState';
import {
  sameDiscoveredModels,
  sameModes,
  sameStringList,
  sameStringMap,
  sameThinkingOptionsByModel,
} from '../internal/compareCollections';
import { ensureProviderProjectionMap } from '../internal/providerProjection';
import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  KIMI_DEFAULT_THINKING_LEVEL,
  KIMI_SYNTHETIC_MODEL_ID,
  normalizeKimiDiscoveredModels,
  normalizeKimiModelVariants,
  resolveKimiBaseModelRawId,
  resolveKimiDefaultThinkingLevel,
} from '../models';
import {
  normalizeKimiAvailableModes,
  resolveKimiModeForPermissionMode,
  resolvePermissionModeForKimiMode,
} from '../modes';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';
import { getKimiState, type KimiProviderState } from '../types';
import { buildKimiPromptBlocks, buildKimiPromptText } from './buildKimiPrompt';
import {
  buildKimiRuntimeEnv,
  resolveKimiCodeHomeFromSettings,
} from './KimiRuntimeEnvironment';

/** ACP auth required (Kimi Code >= 0.27.0 may return this from session/new). */
export const KIMI_ACP_AUTH_REQUIRED_CODE = -32000;

export const KIMI_AUTH_REQUIRED_MESSAGE =
  'Kimi Code authentication required. Run `kimi login` in a terminal, then retry. '
  + 'You can also open Claudian Settings → Kimi Code for setup guidance.';

export function buildKimiAcpLaunchKey(params: {
  cliPath: string;
  cwd: string;
  envText: string;
}): string {
  return JSON.stringify({
    cliPath: params.cliPath,
    cwd: params.cwd,
    envText: params.envText,
  });
}

export function isKimiAuthRequiredError(error: unknown): boolean {
  if (error instanceof JsonRpcErrorResponse && error.code === KIMI_ACP_AUTH_REQUIRED_CODE) {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('authentication required')
      || message.includes('auth required')
      || message.includes('-32000');
  }
  return false;
}

export function formatKimiRuntimeError(error: unknown, stderr?: string | null): string {
  if (isKimiAuthRequiredError(error)) {
    return stderr ? `${KIMI_AUTH_REQUIRED_MESSAGE}\n\n${stderr}` : KIMI_AUTH_REQUIRED_MESSAGE;
  }
  const baseMessage = error instanceof Error ? error.message : 'Kimi Code ACP request failed';
  return stderr ? `${baseMessage}\n\n${stderr}` : baseMessage;
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

export class KimiChatRuntime implements ChatRuntime {
  readonly providerId = 'kimi' as const;

  private activeTurn: ActiveTurn | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private conversationId: string | null = null;
  private conversationGeneration = 0;
  private contextUsage: AcpUsageUpdate | null = null;
  private currentKimiCodeHome: string | null = null;
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
  private readonly supportedCommandWaiters: Array<(commands: SlashCommand[]) => void> = [];
  private supportedCommands: SlashCommand[] = [];
  private sessionCwds = new Map<string, string>();
  private sessionId: string | null = null;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private transport: AcpJsonRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;

  constructor(
    private readonly plugin: ProviderHost,
  ) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return KIMI_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildKimiPromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.push(listener);
    try {
      listener(this.ready);
    } catch {
      // ignore
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
    const state = getKimiState(conversation?.providerState);
    const nextSessionId = conversation?.sessionId
      ?? state.sessionId
      ?? null;

    if (previousSessionId !== nextSessionId) {
      this.loadedSessionId = null;
      this.currentSessionEffortConfigId = null;
      this.currentSessionEffortValue = null;
      this.currentSessionEffortValues = new Set<string>();
      this.currentSessionModelId = null;
      this.currentSessionModeId = null;
      this.sessionInvalidated = false;
      this.sessionUpdateNormalizer.reset();
      this.setSupportedCommands([]);
    }

    if (state.kimiCodeHome) {
      this.currentKimiCodeHome = state.kimiCodeHome;
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

  async warmModelMetadata(model: string): Promise<boolean> {
    const conversationGeneration = this.conversationGeneration;
    const selectedRawModelId = decodeKimiModelId(model);
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

    const discoveredModels = getKimiProviderSettings(this.plugin.settings).discoveredModels;
    const selectedBaseRawModelId = resolveKimiBaseModelRawId(selectedRawModelId, discoveredModels);
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
    const settings = getKimiProviderSettings(this.plugin.settings);
    if (!settings.enabled) {
      this.setReady(false);
      return false;
    }

    const cliPath = await this.plugin.getResolvedProviderCliPath('kimi');
    if (!cliPath) {
      this.setReady(false);
      return false;
    }

    if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
      return false;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const envText = getRuntimeEnvironmentText(this.plugin.settings, 'kimi');
    const launchKey = buildKimiAcpLaunchKey({ cliPath, cwd, envText });

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || options?.force === true
      || this.restartRequiredAfterCancel
      || this.currentLaunchKey !== launchKey;

    if (shouldRestart) {
      await this.shutdownProcess();
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        return false;
      }
      await this.startProcess({ cliPath, cwd });
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
      this.restartRequiredAfterCancel = false;
      this.currentLaunchKey = launchKey;
      this.loadedSessionId = null;
      this.currentSessionModeId = null;
      this.currentKimiCodeHome = resolveKimiCodeHomeFromSettings(this.plugin.settings, cliPath);
      this.setReady(true);
    } else if (!this.currentKimiCodeHome) {
      this.currentKimiCodeHome = resolveKimiCodeHomeFromSettings(this.plugin.settings, cliPath);
    }

    const targetSessionId = this.sessionId;
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
      yield { type: 'error', content: 'Kimi Code does not support overlapping turns.' };
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
        content: 'Failed to start Kimi Code ACP runtime. Check the CLI path and run `kimi login` if needed.',
      };
      yield { type: 'done' };
      return;
    }

    if (!this.isConversationCurrent(conversationGeneration)) {
      yield { type: 'error', content: 'Kimi Code conversation changed before the turn started.' };
      yield { type: 'done' };
      return;
    }

    if (!this.connection) {
      yield { type: 'error', content: 'Kimi Code ACP runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    if (this.activeTurn) {
      yield { type: 'error', content: 'Kimi Code does not support overlapping turns.' };
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
        yield {
          type: 'error',
          content: this.lastSessionError
            ?? 'Failed to create a Kimi Code ACP session. If authentication is required, run `kimi login`.',
        };
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

    const activeTurn = this.activeTurn;
    try {
      await this.applySelectedMode(sessionId, conversationGeneration);
      await this.applySelectedModel(sessionId, queryOptions, conversationGeneration);
      await this.applySelectedEffort(sessionId, conversationGeneration);
      if (!this.isConversationCurrent(conversationGeneration)) {
        throw new Error('Kimi Code conversation changed before the turn started.');
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
      prompt: buildKimiPromptBlocks(
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
    this.restartRequiredAfterCancel = true;
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

    if (this.sessionId && this.loadedSessionId !== this.sessionId) {
      const ready = await this.ensureReady({ allowSessionCreation: false });
      if (!ready) {
        return [];
      }
    }

    if (!this.sessionId) {
      return [];
    }

    if (this.supportedCommands.length > 0) {
      return [...this.supportedCommands];
    }

    if (!this.sessionId || this.loadedSessionId !== this.sessionId) {
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
      error: 'Kimi Code does not support rewind from Claudian yet',
    };
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
    const metadata = { ...this.currentTurnMetadata };
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const existingState = params.conversation
      ? getKimiState(params.conversation.providerState)
      : null;
    const sessionId = this.sessionId;
    const kimiCodeHome = this.currentKimiCodeHome ?? existingState?.kimiCodeHome;
    const providerState: KimiProviderState = {
      ...(sessionId
        ? { sessionId }
        : existingState?.sessionId
        ? { sessionId: existingState.sessionId }
        : {}),
      ...(kimiCodeHome ? { kimiCodeHome } : {}),
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
      ?? getKimiState(conversation?.providerState).sessionId
      ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  getAuxiliaryModel(): string | null {
    return this.currentConversationModel ?? this.getActiveDisplayModel() ?? null;
  }

  private lastSessionError: string | null = null;

  private async startProcess(params: {
    cliPath: string;
    cwd: string;
  }): Promise<void> {
    const env = buildKimiRuntimeEnv(this.plugin.settings, params.cliPath);
    env.PATH = getEnhancedPath(
      env.PATH,
      path.isAbsolute(params.cliPath) ? params.cliPath : undefined,
    );
    this.currentKimiCodeHome = resolveKimiCodeHomeFromSettings(this.plugin.settings, params.cliPath);

    this.process = new AcpSubprocess({
      args: ['acp'],
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
    this.unregisterTransportClose = transport.onClose((error) => {
      if (this.transport === transport) {
        this.setReady(false);
        this.settleActiveTurn(error ?? new Error('Kimi Code ACP runtime closed'));
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
    const init = await this.connection.initialize({
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    // Prefer agent verification when agentInfo is present; do not hard-fail on missing name
    // because some builds may omit it during early handshake.
    const agentName = init.agentInfo?.name?.toLowerCase() ?? '';
    if (agentName && !agentName.includes('kimi') && !agentName.includes('moonshot')) {
      throw new Error(
        `Unexpected ACP agent "${init.agentInfo?.name ?? 'unknown'}". Expected Kimi Code CLI.`,
      );
    }
  }

  private async shutdownProcess(): Promise<void> {
    this.connectionGeneration += 1;
    this.setReady(false);
    this.settleActiveTurn();
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
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
    this.sessionUpdateNormalizer.reset();
  }

  private async createSession(
    cwd: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<string | null> {
    if (!this.connection) {
      return null;
    }

    this.lastSessionError = null;
    try {
      this.setSupportedCommands([]);
      this.currentSessionModeId = null;
      // Phase 1: no Claudian-managed MCP forwarding.
      const response = await this.connection.newSession({
        cwd,
        mcpServers: [],
      });
      if (!this.isConversationCurrent(conversationGeneration)) {
        return null;
      }
      const sessionId = response.sessionId;
      if (!sessionId) {
        return null;
      }
      this.loadedSessionId = sessionId;
      this.sessionId = sessionId;
      this.sessionInvalidated = false;
      this.sessionCwds.set(sessionId, cwd);
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
      return sessionId;
    } catch (error) {
      this.lastSessionError = this.formatRuntimeError(error);
      this.clearActiveSession();
      return null;
    }
  }

  private async loadSession(
    sessionId: string,
    cwd: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<boolean> {
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
      if (!this.isConversationCurrent(conversationGeneration)) {
        return false;
      }
      const resolvedSessionId = response.sessionId || sessionId;
      this.sessionInvalidated = false;
      this.loadedSessionId = resolvedSessionId;
      this.sessionId = resolvedSessionId;
      this.sessionCwds.set(resolvedSessionId, cwd);
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
      this.clearActiveSession();
      return false;
    }
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

    if (!isKimiModelSelectionId(selectedModel)) {
      return null;
    }

    const selectedBaseRawModelId = decodeKimiModelId(selectedModel);
    if (!selectedBaseRawModelId) {
      return null;
    }

    const discoveredModels = getKimiProviderSettings(providerSettings).discoveredModels;
    const normalizedBaseRawModelId = resolveKimiBaseModelRawId(selectedBaseRawModelId, discoveredModels);
    if (!normalizedBaseRawModelId) {
      return null;
    }

    const availableModelIds = new Set(discoveredModels.map((model) => model.rawId));
    if (availableModelIds.size > 0 && !availableModelIds.has(normalizedBaseRawModelId)) {
      return null;
    }

    return normalizedBaseRawModelId;
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
      && selectedModel !== KIMI_SYNTHETIC_MODEL_ID
      && isKimiModelSelectionId(selectedModel)
    ) {
      const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
      return selectedRawModelId
        ? encodeKimiModelId(selectedRawModelId)
        : selectedModel;
    }

    return this.currentSessionModelId
      ? encodeKimiModelId(this.currentSessionModelId)
      : (selectedModel && isKimiModelSelectionId(selectedModel) ? selectedModel : undefined);
  }

  private resolveSelectedModeId(): string | null {
    const providerSettings = this.getProviderSettings();
    const kimiSettings = getKimiProviderSettings(providerSettings);
    return resolveKimiModeForPermissionMode(
      providerSettings.permissionMode,
      kimiSettings.availableModes,
    );
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
    if (!selectedRawModelId || selectedRawModelId === this.currentSessionModelId) {
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
    if (!selectedEffort) {
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
    const discoveredModels = normalizeKimiDiscoveredModels(
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
    const currentSettings = getKimiProviderSettings(settingsBag);
    const currentBaseRawModelId = currentRawModelId
      ? resolveKimiBaseModelRawId(currentRawModelId, discoveredModels)
      : null;
    const currentPreferredThinking = currentBaseRawModelId
      ? currentSettings.preferredThinkingByModel[currentBaseRawModelId]
      : '';
    const thoughtLevelState = extractAcpSessionThoughtLevelState(params);
    const currentThinkingOptions = normalizeKimiModelVariants(
      thoughtLevelState.availableLevels.map((level) => ({
        ...(level.description ? { description: level.description } : {}),
        label: level.name,
        value: level.id,
      })),
    );
    const currentThinkingLevel = thoughtLevelState.currentLevel;
    const defaultThinkingLevel = currentThinkingOptions.length > 0
      ? resolveKimiDefaultThinkingLevel(
        currentThinkingOptions,
        currentPreferredThinking,
        currentThinkingLevel ?? KIMI_DEFAULT_THINKING_LEVEL,
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

    const nextVisibleModels = currentSettings.visibleModels.length === 0 && currentBaseRawModelId
      ? [currentBaseRawModelId]
      : currentSettings.visibleModels;
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
    const shouldSeedVisibleModels = !sameStringList(currentSettings.visibleModels, nextVisibleModels);
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
      && updateKimiDiscoveryState(settingsBag, { discoveredModels });
    let changed = shouldSeedVisibleModels || shouldSeedPreferredThinking;

    if (currentBaseRawModelId) {
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
        encodeKimiModelId(currentBaseRawModelId),
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
        if (currentBaseRawModelId) {
          this.seedActiveModelSelection(
            settings,
            encodeKimiModelId(currentBaseRawModelId),
            defaultThinkingLevel,
          );
        }
        if (shouldUpdateThinkingOptions || shouldSeedPreferredThinking || shouldSeedVisibleModels) {
          updateKimiProviderSettings(settings, {
            ...(shouldSeedPreferredThinking ? { preferredThinkingByModel: nextPreferredThinkingByModel } : {}),
            ...(shouldUpdateThinkingOptions ? { thinkingOptionsByModel: nextThinkingOptionsByModel } : {}),
            ...(shouldSeedVisibleModels ? { visibleModels: nextVisibleModels } : {}),
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
    const savedModel = typeof savedProviderModel.kimi === 'string'
      ? savedProviderModel.kimi
      : '';
    if (!savedModel || savedModel === KIMI_SYNTHETIC_MODEL_ID) {
      savedProviderModel.kimi = modelSelection;
      changed = true;
    }

    if (thinkingLevel) {
      const savedProviderEffort = ensureProviderProjectionMap(settingsBag, 'savedProviderEffort');
      const savedEffort = typeof savedProviderEffort.kimi === 'string'
        ? savedProviderEffort.kimi.trim()
        : '';
      if (
        !savedEffort
        || savedEffort === KIMI_DEFAULT_THINKING_LEVEL
        || !this.currentSessionEffortValues.has(savedEffort)
      ) {
        savedProviderEffort.kimi = thinkingLevel;
        changed = true;
      }
    }

    if (ProviderRegistry.resolveSettingsProviderId(settingsBag) !== this.providerId) {
      return changed;
    }

    const activeModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';
    if (!activeModel || activeModel === KIMI_SYNTHETIC_MODEL_ID) {
      settingsBag.model = modelSelection;
      changed = true;
    }
    if (thinkingLevel) {
      const activeEffort = typeof settingsBag.effortLevel === 'string' ? settingsBag.effortLevel : '';
      if (
        !activeEffort
        || activeEffort === KIMI_DEFAULT_THINKING_LEVEL
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
    const availableModes = normalizeKimiAvailableModes(acpState.availableModes);
    const currentModeId = params.currentModeId ?? acpState.currentModeId;
    if (currentModeId) {
      this.currentSessionModeId = currentModeId;
      this.emitPermissionModeSync(currentModeId);
    }

    const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
    const currentSettings = getKimiProviderSettings(settingsBag);
    const discoveryChanged = availableModes.length > 0
      && !sameModes(currentSettings.availableModes, availableModes)
      && updateKimiDiscoveryState(settingsBag, { availableModes });

    if (!discoveryChanged) {
      return;
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
    const permissionMode = resolvePermissionModeForKimiMode(modeId);
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

  private async handleSessionNotification(
    notification: AcpSessionNotification,
    connectionGeneration = this.connectionGeneration,
  ): Promise<void> {
    if (connectionGeneration !== this.connectionGeneration) {
      return;
    }
    if (notification.sessionId !== this.sessionId) {
      return;
    }

    const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
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
      this.setSupportedCommands(normalized.commands);
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
        for (const chunk of normalized.streamChunks) {
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

    const toolCall = request.toolCall ?? {};
    const rawInput = (toolCall as { rawInput?: unknown; input?: unknown; arguments?: unknown }).rawInput
      ?? (toolCall as { input?: unknown }).input
      ?? (toolCall as { arguments?: unknown }).arguments;
    const input = normalizeApprovalInput(rawInput);
    const title = (
      (toolCall as { title?: unknown }).title
      ?? (toolCall as { kind?: unknown }).kind
      ?? (toolCall as { name?: unknown }).name
      ?? 'Kimi tool'
    ).toString();
    const options = Array.isArray(request.options) ? request.options : [];
    const decision = await this.approvalCallback(
      title,
      input,
      `Kimi Code wants to use ${title}.`,
      options.length > 0
        ? { decisionOptions: buildAcpApprovalDecisionOptions(options) }
        : undefined,
    );

    // Always map through the shared helper so deny / empty-options / optionId
    // fallbacks use Kimi-canonical ids (`approve_once` / `approve_always` /
    // `reject`) instead of silently cancelling when `decision` has no kind match.
    return mapApprovalDecision(decision, options);
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
    request: AcpWriteTextFileRequest,
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
    return formatKimiRuntimeError(error, this.process?.getStderrSnapshot());
  }

  private clearActiveSession(): void {
    this.sessionId = null;
    this.loadedSessionId = null;
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
    this.sessionUpdateNormalizer.reset();
    this.setSupportedCommands([]);
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

/** Kimi 0.27 canonical + legacy optionIds accepted by the ACP adapter. */
const KIMI_ALLOW_ONCE_OPTION_IDS = ['approve_once', 'approve', 'allow_once'] as const;
const KIMI_ALLOW_ALWAYS_OPTION_IDS = [
  'approve_always',
  'approve_for_session',
  'allow_always',
] as const;
/** Canonical is `reject`; also accept ACP-style reject_* ids if an agent advertises them. */
const KIMI_REJECT_OPTION_IDS = ['reject', 'reject_once', 'reject_always'] as const;

const KIMI_CANONICAL_ALLOW_ONCE_OPTION_ID = 'approve_once';
const KIMI_CANONICAL_ALLOW_ALWAYS_OPTION_ID = 'approve_always';
const KIMI_CANONICAL_REJECT_OPTION_ID = 'reject';

function mapApprovalDecision(
  decision: ApprovalDecision,
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    optionId: string;
  }[],
): AcpRequestPermissionResponse {
  if (decision === 'allow') {
    return selectPermissionOption(options, {
      fallbackOptionId: KIMI_CANONICAL_ALLOW_ONCE_OPTION_ID,
      preferredKinds: ['allow_once', 'allow_always'],
      preferredOptionIds: KIMI_ALLOW_ONCE_OPTION_IDS,
    });
  }
  if (decision === 'allow-always') {
    return selectPermissionOption(options, {
      fallbackOptionId: KIMI_CANONICAL_ALLOW_ALWAYS_OPTION_ID,
      preferredKinds: ['allow_always', 'allow_once'],
      preferredOptionIds: KIMI_ALLOW_ALWAYS_OPTION_IDS,
    });
  }
  if (decision === 'deny') {
    return selectPermissionOption(options, {
      fallbackOptionId: KIMI_CANONICAL_REJECT_OPTION_ID,
      preferredKinds: ['reject_once', 'reject_always'],
      preferredOptionIds: KIMI_REJECT_OPTION_IDS,
    });
  }
  // Arbitrary agent-advertised options (plan_opt_*, plan_revise, custom ids, …)
  // round-trip as select-option so the exact optionId is preserved.
  if (typeof decision === 'object' && decision.type === 'select-option') {
    const optionId = typeof decision.value === 'string' ? decision.value.trim() : '';
    if (optionId) {
      return {
        outcome: {
          optionId,
          outcome: 'selected',
        },
      };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

function selectPermissionOption(
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    optionId: string;
  }[],
  preference: {
    fallbackOptionId: string;
    preferredKinds: ReadonlyArray<'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'>;
    preferredOptionIds: readonly string[];
  },
): AcpRequestPermissionResponse {
  for (const optionId of preference.preferredOptionIds) {
    const match = options.find((option) => option.optionId === optionId);
    if (match) {
      return {
        outcome: {
          optionId: match.optionId,
          outcome: 'selected',
        },
      };
    }
  }

  for (const kind of preference.preferredKinds) {
    const match = options.find((option) => (
      option.kind === kind && !option.optionId.startsWith('plan_')
    ));
    if (match) {
      return {
        outcome: {
          optionId: match.optionId,
          outcome: 'selected',
        },
      };
    }
  }

  // Agent omitted options (or only advertised semantically distinct plan
  // choices): emit the canonical fail-safe selection rather than guessing.
  return {
    outcome: {
      optionId: preference.fallbackOptionId,
      outcome: 'selected',
    },
  };
}

function buildAcpApprovalDecisionOptions(
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    name: string;
    optionId: string;
  }[],
): ApprovalDecisionOption[] {
  return options.map((option) => {
    // Only canonical/legacy tool approvals map to shared decisions. Plan-review
    // choices reuse allow_once/reject_once kinds for styling, but every
    // `plan_*` option is semantically distinct and must round-trip by optionId.
    const decision = KIMI_ALLOW_ONCE_OPTION_IDS.some((id) => id === option.optionId)
      ? ('allow' as const)
      : KIMI_ALLOW_ALWAYS_OPTION_IDS.some((id) => id === option.optionId)
      ? ('allow-always' as const)
      : undefined;
    return {
      ...(decision ? { decision } : {}),
      label: option.name,
      value: option.optionId,
    };
  });
}
