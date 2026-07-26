import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
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
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type {
  ChatMessage,
  Conversation,
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
  resolveAcpLoadSessionId,
} from '../../acp';
import {
  buildAcpApprovalDecisionOptions,
  mapAcpApprovalDecision,
} from '../../acp/AcpPermissionAdapter';
import { KIMI_PROVIDER_CAPABILITIES } from '../capabilities';
import {
  getKimiDiscoveryState,
  sameKimiCurrentThinkingByModel,
  sameKimiDiscoveredModels,
  sameKimiThinkingOptionsByModel,
  updateKimiDiscoveryState,
} from '../discoveryState';
import { resolveKimiSessionDirectory } from '../history/KimiHistoryPathResolver';
import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  type KimiDiscoveredModel,
  type KimiThinkingOption,
  normalizeKimiDiscoveredModels,
  normalizeKimiThinkingOptions,
} from '../models';
import {
  resolveKimiModeForPermissionMode,
  resolvePermissionModeForKimiMode,
} from '../modes';
import { stripKimiToolCallPrefix } from '../normalization/kimiToolCallId';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';
import { getKimiState, type KimiProviderState } from '../types';
import { buildKimiPromptBlocks, buildKimiPromptText } from './buildKimiPrompt';
import { buildKimiRuntimeEnv } from './KimiRuntimeEnvironment';

interface ActiveTurn {
  cancelled: boolean;
  queue: StreamChunkQueue;
  sessionId: string;
}

interface SupportedCommandWaiter {
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (commands: SlashCommand[]) => void;
}

export interface KimiThinkingProbeResult {
  currentThinkingByModel: Record<string, string>;
  /** Models whose set_config_option probe failed; their stored entries stay untouched. */
  failedRawIds: string[];
  /** Models successfully probed that advertise no thought_level option. */
  noThinkingRawIds: string[];
  thinkingOptionsByModel: Record<string, KimiThinkingOption[]>;
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
  private availableModeIds = new Set<string>();
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private conversationId: string | null = null;
  private conversationGeneration = 0;
  private contextUsage: AcpUsageUpdate | null = null;
  private currentLaunchCommand: string | null = null;
  private currentLaunchKey: string | null = null;
  private currentSessionModeId: string | null = null;
  private currentSessionModelId: string | null = null;
  private currentConversationModel: string | null = null;
  private currentThinkingConfigId: string | null = null;
  private currentThinkingValue: string | null = null;
  private currentThinkingValues = new Set<string>();
  private currentTurnMetadata: ChatTurnMetadata = {};
  private discoveredModels: KimiDiscoveredModel[] = [];
  private discoveryMirroringSuspended = false;
  private lastSessionError: unknown = null;
  private lastSyncedPermissionMode: string | null = null;
  private loadedSessionId: string | null = null;
  private permissionModeSyncCallback: ((mode: string) => void) | null = null;
  private process: AcpSubprocess | null = null;
  private promptUsage: AcpUsage | null = null;
  private readonly readyListeners: Array<(ready: boolean) => void> = [];
  private ready = false;
  private readinessFlight: { key: string; promise: Promise<boolean> } | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;
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
    const nextConversationId = conversation?.id ?? null;
    const nextSessionId = conversation?.sessionId ?? null;
    const targetChanged = nextConversationId !== this.conversationId
      || nextSessionId !== this.sessionId;
    if (this.sessionId !== nextSessionId) {
      this.rejectSupportedCommandWaiters(
        new Error('Kimi command discovery context changed.'),
      );
      this.pendingSupportedCommands.clear();
      this.resetSessionConfigState();
      this.sessionInvalidated = false;
      this.clearSupportedCommands();
    }
    this.conversationId = nextConversationId;
    this.sessionId = nextSessionId;
    if (targetChanged) {
      this.conversationGeneration += 1;
      if (this.readinessFlight) {
        void this.shutdownProcess();
      }
    }
  }

  // Kimi reads .kimi-code/mcp.json at process start, so reload restarts the
  // process; the next ensureReady re-creates sessions from native history. A
  // running turn keeps its process to avoid breaking the stream.
  async reloadMcpServers(): Promise<void> {
    if (this.activeTurn) {
      return;
    }
    await this.shutdownProcess({ preserveCommandWaiters: true });
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

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const targetSessionId = this.sessionId;
    const resolvedCliPath = await this.plugin.getResolvedProviderCliPath('kimi') ?? 'kimi';
    const runtimeEnv = buildKimiRuntimeEnv(this.plugin.settings, resolvedCliPath);

    const nextLaunchKey = JSON.stringify({
      command: resolvedCliPath,
      envText: getRuntimeEnvironmentText(this.plugin.settings, 'kimi'),
    });

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || options?.force === true
      || this.currentLaunchKey !== nextLaunchKey;

    if (shouldRestart) {
      await this.shutdownProcess({ preserveCommandWaiters: true });
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        return false;
      }
      await this.startProcess({
        command: resolvedCliPath,
        cwd,
        runtimeEnv,
      });
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
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
      yield { type: 'error', content: 'Kimi does not support overlapping turns.' };
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
        content: this.lastSessionError
          ? this.formatRuntimeError(this.lastSessionError)
          : 'Failed to start Kimi. Check the CLI path and login state.',
      };
      yield { type: 'done' };
      return;
    }

    if (!this.isConversationCurrent(conversationGeneration)) {
      yield { type: 'error', content: 'Kimi conversation changed before the turn started.' };
      yield { type: 'done' };
      return;
    }

    if (!this.connection) {
      yield { type: 'error', content: 'Kimi runtime is not ready.' };
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
            ? this.formatRuntimeError(this.lastSessionError)
            : 'Failed to create a Kimi session.',
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
        throw new Error('Kimi conversation changed before the turn started.');
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
      // kimi 0.29.x sends no usage over ACP (prompt responses carry only
      // stopReason) and persists no token counters to state.json or wire.jsonl
      // (verified against the CLI source and a live session), so this stays
      // null and the usage meter stays empty. Kept for protocol parity.
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

  discoverSupportedCommands(
    timeoutMs = 5_000,
    signal?: AbortSignal,
  ): Promise<SlashCommand[]> {
    signal?.throwIfAborted();
    if (this.supportedCommandsAdvertised && this.loadedSessionId === this.sessionId) {
      return Promise.resolve(this.cloneSupportedCommands());
    }

    return new Promise<SlashCommand[]>((resolve, reject) => {
      let timeoutId: number | null = null;
      let onAbort: (() => void) | null = null;
      const cleanup = (): void => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const waiter: SupportedCommandWaiter = { cleanup, reject, resolve };
      timeoutId = window.setTimeout(() => {
        const index = this.supportedCommandWaiters.indexOf(waiter);
        if (index >= 0) {
          this.supportedCommandWaiters.splice(index, 1);
        }
        cleanup();
        reject(new Error('Timed out waiting for Kimi commands.'));
      }, timeoutMs);

      if (signal) {
        onAbort = () => {
          const index = this.supportedCommandWaiters.indexOf(waiter);
          if (index >= 0) {
            this.supportedCommandWaiters.splice(index, 1);
          }
          cleanup();
          reject(new Error('Kimi command discovery aborted.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
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
    this.rejectSupportedCommandWaiters(new Error('Kimi runtime stopped.'));
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
      ? getKimiState(params.conversation.providerState)
      : null;
    const sessionDirectory = this.resolveSessionDirectoryHint(
      existingState?.sessionDirectory ?? null,
    );
    const providerState: KimiProviderState = {
      ...(sessionDirectory ? { sessionDirectory } : {}),
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

  private resolveSessionDirectoryHint(currentHint: string | null): string | null {
    if (!this.sessionId) {
      return null;
    }
    const cwd = getVaultPath(this.plugin.app);
    const cliPath = this.currentLaunchCommand ?? 'kimi';
    const environment = buildKimiRuntimeEnv(this.plugin.settings, cliPath);
    return resolveKimiSessionDirectory(
      currentHint,
      this.sessionId,
      cwd,
      { environment, hostPlatform: process.platform },
    );
  }

  private async startProcess(params: {
    command: string;
    cwd: string;
    runtimeEnv: NodeJS.ProcessEnv;
  }): Promise<void> {
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...params.runtimeEnv,
      PATH: getEnhancedPath(
        params.runtimeEnv.PATH,
        path.isAbsolute(params.command) ? params.command : undefined,
      ),
    };

    this.currentLaunchCommand = params.command;
    this.process = new AcpSubprocess({
      args: ['acp'],
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
        this.rejectSupportedCommandWaiters(error ?? new Error('Kimi runtime closed.'));
        this.settleActiveTurn(error ?? new Error('Kimi runtime closed'));
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
    this.resetSessionConfigState();
    if (!options?.preserveCommandWaiters) {
      this.rejectSupportedCommandWaiters(new Error('Kimi runtime stopped.'));
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

    return decodeKimiModelId(selectedModel);
  }

  getAuxiliaryModel(): string | null {
    return this.currentConversationModel ?? this.getActiveDisplayModel() ?? null;
  }

  getDiscoveredModels(): KimiDiscoveredModel[] {
    return this.discoveredModels.map((model) => ({ ...model }));
  }

  // Switches the warmup session through each model and parses the thought_level
  // select from every response. Discovery mirroring stays suspended so the
  // config_option_update notifications triggered by each switch do not mirror or
  // persist per model; callers accumulate and write through once at the end.
  async probeThinkingOptionsForModels(rawIds: string[]): Promise<KimiThinkingProbeResult> {
    const result: KimiThinkingProbeResult = {
      currentThinkingByModel: {},
      failedRawIds: [],
      noThinkingRawIds: [],
      thinkingOptionsByModel: {},
    };
    const connection = this.connection;
    const sessionId = this.sessionId;
    const normalizedRawIds = rawIds.map((rawId) => rawId.trim()).filter(Boolean);
    if (!connection || !sessionId) {
      result.failedRawIds.push(...normalizedRawIds);
      return result;
    }

    this.discoveryMirroringSuspended = true;
    try {
      for (const rawId of normalizedRawIds) {
        try {
          const response = await connection.setConfigOption({
            configId: 'model',
            sessionId,
            type: 'select',
            value: rawId,
          });
          const thoughtLevelState = extractAcpSessionThoughtLevelState({
            configOptions: response.configOptions,
          });
          const options = normalizeKimiThinkingOptions(
            thoughtLevelState.availableLevels.map((level) => ({
              ...(level.description ? { description: level.description } : {}),
              label: level.name,
              value: level.id,
            })),
          );
          if (options.length === 0) {
            result.noThinkingRawIds.push(rawId);
            continue;
          }
          result.thinkingOptionsByModel[rawId] = options;
          if (thoughtLevelState.currentLevel) {
            result.currentThinkingByModel[rawId] = thoughtLevelState.currentLevel;
          }
        } catch {
          result.failedRawIds.push(rawId);
        }
      }
    } finally {
      this.discoveryMirroringSuspended = false;
    }
    return result;
  }

  private setCurrentConversationModel(model: unknown): void {
    const selectedModel = typeof model === 'string' ? model.trim() : '';
    this.currentConversationModel = selectedModel || null;
  }

  private getActiveDisplayModel(queryOptions?: ChatRuntimeQueryOptions): string | undefined {
    const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
    if (selectedRawModelId) {
      return encodeKimiModelId(selectedRawModelId);
    }

    return this.currentSessionModelId
      ? encodeKimiModelId(this.currentSessionModelId)
      : undefined;
  }

  private resolveSelectedModeId(): string {
    const providerSettings = this.getProviderSettings();
    return resolveKimiModeForPermissionMode(providerSettings.permissionMode);
  }

  private async applySelectedMode(
    sessionId: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    if (!this.connection || this.availableModeIds.size === 0) {
      return;
    }

    const selectedModeId = this.resolveSelectedModeId();
    if (
      !this.availableModeIds.has(selectedModeId)
      || selectedModeId === this.currentSessionModeId
    ) {
      return;
    }

    await this.connection.setMode({
      modeId: selectedModeId,
      sessionId,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionModeId = selectedModeId;
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
    await this.syncSessionConfigState({
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

    return this.currentThinkingValues.has(selectedEffort) ? selectedEffort : null;
  }

  private async applySelectedEffort(
    sessionId: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    if (!this.connection || !this.currentThinkingConfigId) {
      return;
    }

    const selectedEffort = this.resolveSelectedEffortValue();
    if (!selectedEffort || selectedEffort === this.currentThinkingValue) {
      return;
    }

    const response = await this.connection.setConfigOption({
      configId: this.currentThinkingConfigId,
      sessionId,
      type: 'select',
      value: selectedEffort,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentThinkingValue = selectedEffort;
    await this.syncSessionConfigState({
      configOptions: response.configOptions,
    }, conversationGeneration);
  }

  private async syncSessionConfigState(params: {
    configOptions?: AcpSessionConfigOption[] | null;
    models?: AcpSessionModelState | null;
  }, conversationGeneration?: number): Promise<void> {
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) {
      return;
    }

    const modelState = extractAcpSessionModelState(params);
    if (modelState.currentModelId) {
      this.currentSessionModelId = modelState.currentModelId;
    }
    if (modelState.availableModels.length > 0) {
      this.discoveredModels = normalizeKimiDiscoveredModels(
        modelState.availableModels.map((model) => ({
          ...(model.description ? { description: model.description } : {}),
          label: model.name,
          rawId: model.id,
        })),
      );
    }

    const thoughtLevelState = extractAcpSessionThoughtLevelState(params);
    const thinkingOptions = normalizeKimiThinkingOptions(
      thoughtLevelState.availableLevels.map((level) => ({
        ...(level.description ? { description: level.description } : {}),
        label: level.name,
        value: level.id,
      })),
    );
    this.currentThinkingConfigId = thinkingOptions.length > 0
      ? thoughtLevelState.configId
      : null;
    this.currentThinkingValue = thinkingOptions.length > 0
      ? thoughtLevelState.currentLevel
      : null;
    this.currentThinkingValues = new Set(thinkingOptions.map((option) => option.value));

    const modeState = extractAcpSessionModeState(params);
    if (modeState.availableModes.length > 0) {
      this.availableModeIds = new Set(modeState.availableModes.map((mode) => mode.id));
    }
    if (modeState.currentModeId) {
      this.currentSessionModeId = modeState.currentModeId;
      this.emitPermissionModeSync(modeState.currentModeId);
    }

    await this.mirrorThinkingDiscovery(
      modelState.currentModelId,
      thinkingOptions,
      thoughtLevelState.currentLevel,
      conversationGeneration,
    );
  }

  // Thinking options are per-model and only advertised for thinking-capable models,
  // so the mirror keys them by the session's current model id. The discovered
  // catalog and per-model thinking state are mirrored whenever available and
  // written through to the persisted provider config so the model and effort
  // dropdowns survive a plugin reload.
  private async mirrorThinkingDiscovery(
    currentRawModelId: string | null,
    thinkingOptions: ReturnType<typeof normalizeKimiThinkingOptions>,
    currentThinkingLevel: string | null,
    conversationGeneration?: number,
  ): Promise<void> {
    if (this.discoveryMirroringSuspended) {
      return;
    }

    const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
    const discoveredModels = this.discoveredModels;
    // Read first so a cold mirror seeds from the persisted config before the
    // session snapshot merges on top of it.
    const discovery = getKimiDiscoveryState(settingsBag);
    const updates: {
      currentThinkingByModel?: Record<string, unknown>;
      discoveredModels?: unknown;
      thinkingOptionsByModel?: Record<string, unknown>;
    } = {
      ...(discoveredModels.length > 0 ? { discoveredModels } : {}),
    };

    if (currentRawModelId) {
      const thinkingOptionsByModel = { ...discovery.thinkingOptionsByModel };
      const currentThinkingByModel = { ...discovery.currentThinkingByModel };
      if (thinkingOptions.length > 0) {
        thinkingOptionsByModel[currentRawModelId] = thinkingOptions;
        if (currentThinkingLevel) {
          currentThinkingByModel[currentRawModelId] = currentThinkingLevel;
        } else {
          delete currentThinkingByModel[currentRawModelId];
        }
      } else {
        delete thinkingOptionsByModel[currentRawModelId];
        delete currentThinkingByModel[currentRawModelId];
      }
      updates.currentThinkingByModel = currentThinkingByModel;
      updates.thinkingOptionsByModel = thinkingOptionsByModel;
    }

    const changed = updateKimiDiscoveryState(settingsBag, updates);

    const mirrored = getKimiDiscoveryState(settingsBag);
    const persisted = getKimiProviderSettings(settingsBag);
    const shouldPersistModels = discoveredModels.length > 0
      && !sameKimiDiscoveredModels(persisted.discoveredModels, discoveredModels);
    const shouldPersistThinking = !sameKimiThinkingOptionsByModel(
      persisted.thinkingOptionsByModel,
      mirrored.thinkingOptionsByModel,
    ) || !sameKimiCurrentThinkingByModel(
      persisted.currentThinkingByModel,
      mirrored.currentThinkingByModel,
    );
    if (shouldPersistModels || shouldPersistThinking) {
      await this.plugin.mutateSettings((settings) => {
        updateKimiProviderSettings(settings, {
          ...(shouldPersistModels ? { discoveredModels } : {}),
          ...(shouldPersistThinking
            ? {
              currentThinkingByModel: mirrored.currentThinkingByModel,
              thinkingOptionsByModel: mirrored.thinkingOptionsByModel,
            }
            : {}),
        });
      });
    }

    if (
      !changed
      || (
        conversationGeneration !== undefined
        && !this.isConversationCurrent(conversationGeneration)
      )
    ) {
      return;
    }
    this.plugin.notifyProviderChatOptionsChanged('kimi');
  }

  private emitPermissionModeSync(modeId: string): void {
    const permissionMode = resolvePermissionModeForKimiMode(modeId);
    if (
      !permissionMode
      || permissionMode === this.lastSyncedPermissionMode
      || !this.permissionModeSyncCallback
    ) {
      return;
    }

    this.lastSyncedPermissionMode = permissionMode;
    try {
      this.permissionModeSyncCallback(permissionMode);
    } catch {
      // Non-critical UI sync callback.
    }
  }

  private resetSessionConfigState(): void {
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
    this.availableModeIds = new Set();
    this.currentThinkingConfigId = null;
    this.currentThinkingValue = null;
    this.currentThinkingValues = new Set();
    this.lastSyncedPermissionMode = null;
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
      this.lastSessionError = null;
      this.loadedSessionId = response.sessionId;
      this.sessionId = response.sessionId;
      this.sessionCwds.set(response.sessionId, cwd);
      this.publishPendingSupportedCommands(response.sessionId);
      await this.syncSessionConfigState({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      }, conversationGeneration);
      return response.sessionId;
    } catch (error) {
      this.lastSessionError = error;
      this.rejectSupportedCommandWaiters(
        error instanceof Error ? error : new Error('Failed to create a Kimi session.'),
      );
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
      this.lastSessionError = null;
      const loadedSessionId = resolveAcpLoadSessionId(response ?? {}, sessionId);
      this.sessionInvalidated = false;
      this.loadedSessionId = loadedSessionId;
      this.sessionId = loadedSessionId;
      this.sessionCwds.set(loadedSessionId, cwd);
      await this.syncSessionConfigState({
        configOptions: response?.configOptions ?? null,
        models: response?.models ?? null,
      }, conversationGeneration);
      return true;
    } catch (error) {
      this.lastSessionError = error;
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
      normalized = this.sessionUpdateNormalizer.normalize(
        stripKimiToolCallIds(notification.update),
      );
    } catch {
      if (notification.update.sessionUpdate === 'available_commands_update') {
        this.rejectSupportedCommandWaiters(
          new Error('Kimi sent malformed command metadata.'),
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
    if (normalized.type === 'commands') {
      this.publishSupportedCommands(normalized.commands);
      return;
    }

    if (normalized.type === 'config_options') {
      await this.syncSessionConfigState({
        configOptions: normalized.configOptions,
      });
      return;
    }

    if (normalized.type === 'current_mode') {
      this.currentSessionModeId = normalized.currentModeId;
      this.emitPermissionModeSync(normalized.currentModeId);
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
        // Dead in practice: kimi emits no `usage_update` notifications (see the
        // note at the prompt-response usage handling above).
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

    const isPlanReview = request.options.some((option) => isKimiPlanReviewOptionId(option.optionId));
    const presentation = buildKimiPermissionPresentation(request, isPlanReview);
    const decision = await this.approvalCallback(
      presentation.toolName,
      presentation.input,
      presentation.description,
      {
        // Plan-review options are distinct choices (approve / revise / reject-and-exit),
        // not allow/deny decisions, so each one round-trips its own option id.
        decisionOptions: isPlanReview
          ? request.options.map((option) => ({ label: option.name, value: option.optionId }))
          : buildAcpApprovalDecisionOptions(request.options),
      },
    );

    return mapAcpApprovalDecision(decision, request.options);
  }

  private publishSupportedCommands(commands: SlashCommand[]): void {
    this.supportedCommands = commands.map((command) => ({ ...command }));
    this.supportedCommandsAdvertised = true;

    const waiters = this.supportedCommandWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.cleanup();
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
      waiter.cleanup();
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
    if (isKimiAuthRequiredError(error)) {
      return buildKimiAuthRequiredMessage(error);
    }
    const baseMessage = error instanceof Error ? error.message : 'Kimi request failed';
    const stderr = this.process?.getStderrSnapshot();
    return stderr ? `${baseMessage}\n\n${stderr}` : baseMessage;
  }

  private clearActiveSession(): void {
    this.sessionId = null;
    this.loadedSessionId = null;
    this.resetSessionConfigState();
    this.clearSupportedCommands();
    this.pendingSupportedCommands.clear();
  }
}

// ACP reserves -32000 for AUTH_REQUIRED; kimi raises it when login is missing or expired.
const ACP_AUTH_REQUIRED_ERROR_CODE = -32000;

function isKimiAuthRequiredError(error: unknown): error is JsonRpcErrorResponse {
  return error instanceof JsonRpcErrorResponse
    && error.code === ACP_AUTH_REQUIRED_ERROR_CODE;
}

function buildKimiAuthRequiredMessage(error: JsonRpcErrorResponse): string {
  const authCommand = extractKimiAuthCommand(error.data);
  const guidance = authCommand
    ? `Run \`${authCommand}\` in a terminal to log in, then retry.`
    : 'Run `kimi login` in a terminal to log in, then retry.';
  return `Kimi requires authentication. ${guidance}`;
}

function extractKimiAuthCommand(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const authMethods = (data as Record<string, unknown>).authMethods;
  if (!Array.isArray(authMethods)) {
    return null;
  }

  for (const entry of authMethods) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const meta = (record._meta ?? record.field_meta) as Record<string, unknown> | undefined;
    const terminalAuth = meta?.['terminal-auth'] as Record<string, unknown> | undefined;
    if (terminalAuth) {
      const command = typeof terminalAuth.command === 'string' ? terminalAuth.command.trim() : '';
      const args = Array.isArray(terminalAuth.args)
        ? terminalAuth.args.filter((arg): arg is string => typeof arg === 'string')
        : [];
      if (command) {
        return [command, ...args].join(' ').trim() || null;
      }
    }
  }
  return null;
}

function stripKimiToolCallIds(
  update: AcpSessionNotification['update'],
): AcpSessionNotification['update'] {
  if (update.sessionUpdate === 'tool_call') {
    return { ...update, toolCallId: stripKimiToolCallPrefix(update.toolCallId) };
  }
  if (update.sessionUpdate === 'tool_call_update') {
    return { ...update, toolCallId: stripKimiToolCallPrefix(update.toolCallId) };
  }
  return update;
}

// Kimi 0.29.x surfaces ExitPlanMode-style approvals as `plan_review` permission
// requests whose option ids live in the `plan_*` namespace.
function isKimiPlanReviewOptionId(optionId: string): boolean {
  return optionId.startsWith('plan_');
}

function buildKimiPermissionPresentation(
  request: AcpRequestPermissionRequest,
  isPlanReview: boolean,
): {
  description: string;
  input: Record<string, unknown>;
  toolName: string;
} {
  const title = request.toolCall.title?.trim() || 'tool';
  const separatorIndex = title.indexOf(':');
  const toolName = isPlanReview
    ? 'Exit Plan Mode'
    : (separatorIndex > 0 ? title.slice(0, separatorIndex) : title).trim() || 'tool';

  const contentText = (request.toolCall.content ?? [])
    .flatMap((entry) => {
      if (entry.type !== 'content') {
        return [];
      }
      const block = entry.content;
      return block.type === 'text' && block.text.trim() ? [block.text.trim()] : [];
    })
    .join('\n\n');

  const input = request.toolCall.rawInput !== undefined
      && typeof request.toolCall.rawInput === 'object'
      && request.toolCall.rawInput !== null
      && !Array.isArray(request.toolCall.rawInput)
    ? request.toolCall.rawInput as Record<string, unknown>
    : {};

  const fallbackDescription = isPlanReview
    ? 'Kimi wants to exit plan mode and apply this plan.'
    : `Kimi wants to use ${toolName}.`;

  return {
    description: contentText || fallbackDescription,
    input,
    toolName,
  };
}
