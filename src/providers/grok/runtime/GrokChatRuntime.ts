import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderCapabilities } from '../../../core/providers/types';
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
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendCurrentNote } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpLoadSessionResponse,
  type AcpMetadata,
  type AcpNewSessionResponse,
  type AcpSessionModelState,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  type AcpSubprocessLaunchSpec,
  AcpToolStreamAdapter,
  type AcpUsage,
  type AcpUsageUpdate,
  buildAcpUsageInfo,
  extractAcpSessionModelState,
} from '../../acp';
import type { GrokAuxiliaryLifecycleCoordinator } from '../auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { GROK_PROVIDER_CAPABILITIES } from '../capabilities';
import type { GrokCommandCatalog } from '../commands/GrokCommandCatalog';
import { computeGrokEnvironmentHash } from '../env/GrokSettingsReconciler';
import { resolveGrokSessionDirectory } from '../history/GrokHistoryPathResolver';
import {
  decodeGrokModelId,
  type GrokDiscoveredModel,
  normalizeGrokDiscoveredModels,
  normalizeGrokReasoningMetadata,
  resolveGrokDefaultReasoningEffort,
} from '../models';
import {
  buildGrokToolProviderPayload,
  normalizeGrokToolCall,
  normalizeGrokToolName,
  resolveGrokRawToolName,
} from '../normalization/grokToolNormalization';
import {
  computeGrokSystemPromptKey,
  type GrokSystemPromptSettings,
} from '../prompt/GrokSystemPrompt';
import { getGrokProviderSettings } from '../settings';
import { waitForGrokCancelDelivery } from './GrokCancelDelivery';
import { GrokCliResolver } from './GrokCliResolver';
import { buildGrokRuntimeEnv } from './GrokRuntimeEnvironment';
import {
  GROK_EXTENSION_NOTIFICATION_METHODS,
  GROK_EXTENSION_REQUEST_METHODS,
  GrokServerRequestRouter,
} from './GrokServerRequestRouter';
import { buildGrokSessionMeta } from './GrokSessionMeta';
import {
  GrokSessionNotificationMirrorDeduplicator,
  type GrokSessionNotificationSource,
} from './GrokSessionNotificationMirrorDeduplicator';
import {
  GROK_SESSION_UPDATE_NOTIFICATION_METHODS,
  GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
  parseGrokSessionNotification,
} from './GrokSessionNotifications';

const GROK_MODEL_UPDATE_ALIASES = [
  'x.ai/models/update',
  '_x.ai/models/update',
] as const;
interface ActiveTurn {
  abortController: AbortController;
  cancelled: boolean;
  execution: TurnExecution;
  promptSettled: boolean;
  queue: StreamChunkQueue;
  sessionId: string;
}

interface TurnExecution {
  abortController: AbortController;
  cancelled: boolean;
}

interface PendingGrokSessionNotification {
  notification: AcpSessionNotification;
  source: GrokSessionNotificationSource;
}

type GrokTurnPreparation =
  | { error: string; sessionId: null }
  | { error: null; sessionId: string };

interface GrokCliResolverLike {
  resolveFromSettings(settings: Record<string, unknown>): string | null;
}

interface GrokLiveModelCoordinatorLike {
  mergeLiveModels(
    models: GrokDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<unknown>;
}

interface PreparedGrokSessionModels {
  currentModelId: string | null;
  currentSessionEffort: string | null;
  models: GrokDiscoveredModel[];
}

interface PreparedGrokSessionResponse extends PreparedGrokSessionModels {
  sessionId: string;
}

export interface GrokRuntimeProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  getStderrSnapshot(): string;
  isAlive(): boolean;
  onClose(listener: (error?: Error) => void): () => void;
  shutdown(): Promise<void>;
  start(): void;
}

export interface GrokChatRuntimeOptions {
  capabilities?: Readonly<ProviderCapabilities>;
  cliResolver?: GrokCliResolverLike;
  commandCatalog?: Pick<GrokCommandCatalog, 'setRuntimeCommands'> | null;
  modelCatalogCoordinator?: GrokLiveModelCoordinatorLike | null;
  lifecycle?: GrokAuxiliaryLifecycleCoordinator;
  processFactory?: (launchSpec: AcpSubprocessLaunchSpec) => GrokRuntimeProcess;
  resolveSessionDirectory?: typeof resolveGrokSessionDirectory;
}

class StreamChunkQueue {
  private closed = false;
  private readonly items: StreamChunk[] = [];
  private readonly waiters: Array<(chunk: StreamChunk | null) => void> = [];

  push(chunk: StreamChunk): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.items.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(null);
  }

  async next(): Promise<StreamChunk | null> {
    if (this.items.length > 0) return this.items.shift() ?? null;
    if (this.closed) return null;
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export class GrokChatRuntime implements ChatRuntime {
  readonly providerId = 'grok' as const;

  private activeTurn: ActiveTurn | null = null;
  private cancelDeliveryFlight: Promise<void> | null = null;
  private cancelRecycleFlight: Promise<void> | null = null;
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private conversationGeneration = 0;
  private conversationId: string | null = null;
  private currentContextUsage: AcpUsageUpdate | null = null;
  private currentConversationModel: string | null = null;
  private currentExplicitModelId: string | null = null;
  private currentLaunchKey: string | null = null;
  private currentModelContextKey: string | null = null;
  private currentPromptUsage: AcpUsage | null = null;
  private currentSessionEffort: string | null = null;
  private currentSessionModelId: string | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private disposed = false;
  private lastError: Error | null = null;
  private lifecycleGeneration = 0;
  private loadedSessionId: string | null = null;
  private process: GrokRuntimeProcess | null = null;
  private ready = false;
  private readonly readyListeners = new Set<(ready: boolean) => void>();
  private readinessFlight: { key: string; promise: Promise<boolean> } | null = null;
  private readonly requestRouter = new GrokServerRequestRouter();
  private readonly notificationMirrorDeduplicator = new GrokSessionNotificationMirrorDeduplicator();
  private pendingNewSessionNotifications: PendingGrokSessionNotification[] | null = null;
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private shutdownFlight: Promise<void> | null = null;
  private supportedCommands: SlashCommand[] = [];
  private startingTurn: TurnExecution | null = null;
  private readonly toolStreamAdapter = createGrokToolStreamAdapter();
  private transport: AcpJsonRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;
  private readonly unregisterTransportHandlers: Array<() => void> = [];

  private readonly capabilities: Readonly<ProviderCapabilities>;
  private readonly cliResolver: GrokCliResolverLike;
  private readonly commandCatalog: Pick<GrokCommandCatalog, 'setRuntimeCommands'> | null;
  private readonly modelCatalogCoordinator: GrokLiveModelCoordinatorLike | null;
  private readonly lifecycle: GrokAuxiliaryLifecycleCoordinator | null;
  private readonly processFactory: (launchSpec: AcpSubprocessLaunchSpec) => GrokRuntimeProcess;
  private readonly resolveSessionDirectory: typeof resolveGrokSessionDirectory;

  constructor(
    private readonly plugin: ProviderHost,
    options: GrokChatRuntimeOptions = {},
  ) {
    this.capabilities = options.capabilities ?? GROK_PROVIDER_CAPABILITIES;
    this.cliResolver = options.cliResolver ?? new GrokCliResolver();
    this.commandCatalog = options.commandCatalog ?? null;
    this.modelCatalogCoordinator = options.modelCatalogCoordinator ?? null;
    this.lifecycle = options.lifecycle ?? null;
    this.processFactory = options.processFactory ?? (spec => new AcpSubprocess(spec));
    this.resolveSessionDirectory = options.resolveSessionDirectory ?? resolveGrokSessionDirectory;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return this.capabilities;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildGrokPromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(conversation: ChatRuntimeConversationState | null): void {
    const nextConversationId = conversation?.id ?? null;
    const nextSessionId = normalizeOpaqueString(conversation?.sessionId);
    const targetChanged = nextConversationId !== this.conversationId
      || nextSessionId !== this.sessionId;
    this.setCurrentConversationModel(conversation?.selectedModel);

    if (nextSessionId !== this.sessionId) {
      this.currentExplicitModelId = null;
      this.currentSessionEffort = null;
      this.currentSessionModelId = null;
      this.loadedSessionId = null;
      this.sessionInvalidated = false;
      this.setSupportedCommands([]);
      this.requestRouter.setActiveSessionId(nextSessionId);
    }
    this.conversationId = nextConversationId;
    this.sessionId = nextSessionId;

    if (targetChanged) {
      this.conversationGeneration += 1;
      this.currentLaunchKey = null;
      if (this.activeTurn) this.cancel();
      else if (this.startingTurn) this.recycleStartingTurn(this.startingTurn, false);
    }
  }

  async reloadMcpServers(): Promise<void> {}

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (this.disposed) return false;
    if (this.lifecycle) {
      if (options?.providerTransitionOwner === true) {
        try {
          this.lifecycle.acquireOwned(this);
        } catch {
          return false;
        }
      } else {
        const lifecycleGeneration = this.lifecycleGeneration;
        try {
          await this.lifecycle.acquire(this);
        } catch {
          return false;
        }
        if (lifecycleGeneration !== this.lifecycleGeneration || this.disposed) {
          this.lifecycle.untrack(this);
          return false;
        }
      }
    }
    const cancelRecycle = this.cancelRecycleFlight;
    if (cancelRecycle) await cancelRecycle.catch(() => undefined);
    if (this.disposed) return false;
    const key = JSON.stringify({
      conversationGeneration: this.conversationGeneration,
      options: options ?? {},
    });
    if (this.readinessFlight) {
      if (this.readinessFlight.key === key) return this.readinessFlight.promise;
      await this.readinessFlight.promise.catch(() => undefined);
      return this.ensureReady(options);
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    const conversationGeneration = this.conversationGeneration;
    const promise = this.ensureReadyInternal(
      options,
      lifecycleGeneration,
      conversationGeneration,
    );
    this.readinessFlight = { key, promise };
    return promise.finally(() => {
      if (this.readinessFlight?.promise === promise) this.readinessFlight = null;
    });
  }

  query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const execution: TurnExecution = { abortController: new AbortController(), cancelled: false };
    const iterator = this.runQuery(turn, queryOptions, execution);
    return wrapCancelableGenerator(iterator, () => this.cancelTurnExecution(execution));
  }

  private async *runQuery(
    turn: PreparedChatTurn,
    queryOptions: ChatRuntimeQueryOptions | undefined,
    execution: TurnExecution,
  ): AsyncGenerator<StreamChunk> {
    if (this.activeTurn || this.startingTurn) {
      yield { type: 'error', content: 'Grok does not support overlapping turns.' };
      yield { type: 'done' };
      return;
    }
    const conversationGeneration = this.conversationGeneration;
    this.startingTurn = execution;
    let preparation: GrokTurnPreparation;
    try {
      await this.lifecycle?.acquire(this, execution.abortController.signal);
      if (execution.cancelled) {
        yield { type: 'done' };
        return;
      }
      if (!this.isConversationCurrent(conversationGeneration)) {
        yield { type: 'error', content: 'The Grok conversation changed before the turn started.' };
        yield { type: 'done' };
        return;
      }
      preparation = await this.prepareTurnSession(queryOptions, execution, true);
    } catch (error) {
      if (execution.cancelled) {
        yield { type: 'done' };
        return;
      }
      yield { type: 'error', content: this.formatRuntimeError(error) };
      yield { type: 'done' };
      return;
    } finally {
      if (this.startingTurn === execution) this.startingTurn = null;
    }
    if (execution.cancelled) {
      yield { type: 'done' };
      return;
    }
    if (preparation.error !== null) {
      yield { type: 'error', content: preparation.error };
      yield { type: 'done' };
      return;
    }
    const connection = this.connection;
    if (!connection) {
      yield { type: 'error', content: 'The Grok runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    const activeTurn: ActiveTurn = {
      abortController: new AbortController(),
      cancelled: false,
      execution,
      promptSettled: false,
      queue: new StreamChunkQueue(),
      sessionId: preparation.sessionId,
    };
    this.activeTurn = activeTurn;
    this.currentContextUsage = null;
    this.currentPromptUsage = null;
    this.currentTurnMetadata = {};
    this.notificationMirrorDeduplicator.reset();
    this.sessionUpdateNormalizer.reset();
    this.toolStreamAdapter.reset();

    if (execution.cancelled) {
      this.activeTurn = null;
      yield { type: 'done' };
      return;
    }
    this.currentTurnMetadata.wasSent = true;
    const promptPromise = connection.prompt({
      prompt: [{ text: turn.prompt, type: 'text' }],
      sessionId: activeTurn.sessionId,
    }).then((response) => {
      if (response.userMessageId) this.currentTurnMetadata.userMessageId = response.userMessageId;
      const promptUsage = parseGrokPromptResponseUsage(response);
      if (promptUsage) this.currentPromptUsage = promptUsage;
      const usage = this.buildCurrentUsage(queryOptions);
      if (usage) activeTurn.queue.push({ sessionId: activeTurn.sessionId, type: 'usage', usage });
      activeTurn.queue.push({ type: 'done' });
      activeTurn.queue.close();
    }).catch((error) => {
      if (!activeTurn.cancelled) {
        activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
        activeTurn.queue.push({ type: 'done' });
      }
      activeTurn.queue.close();
    }).finally(() => {
      activeTurn.promptSettled = true;
      if (this.activeTurn === activeTurn) this.activeTurn = null;
    });

    try {
      while (true) {
        const chunk = await activeTurn.queue.next();
        if (!chunk) break;
        yield chunk;
      }
      if (!activeTurn.cancelled) await promptPromise;
    } finally {
      if (!activeTurn.promptSettled && !activeTurn.cancelled) {
        this.cancelTurnExecution(execution);
      }
      if (this.activeTurn === activeTurn) this.activeTurn = null;
    }
  }

  private async prepareTurnSession(
    queryOptions?: ChatRuntimeQueryOptions,
    execution?: TurnExecution,
    transitionAdmitted = false,
  ): Promise<GrokTurnPreparation> {
    if (queryOptions?.model) this.setCurrentConversationModel(queryOptions.model);
    const conversationGeneration = this.conversationGeneration;

    const ready = await this.ensureReady(
      transitionAdmitted ? { providerTransitionOwner: true } : undefined,
    );
    if (execution?.cancelled) {
      return { error: 'The Grok turn was cancelled before it started.', sessionId: null };
    }
    if (!this.isConversationCurrent(conversationGeneration)) {
      return { error: 'The Grok conversation changed before the turn started.', sessionId: null };
    }
    if (!ready) {
      return { error: this.formatRuntimeError(this.lastError), sessionId: null };
    }
    if (!this.connection || !this.sessionId) {
      return { error: 'The Grok runtime is not ready.', sessionId: null };
    }

    try {
      await this.applySelectedModel(this.sessionId, queryOptions);
    } catch (error) {
      if (execution?.cancelled) {
        return { error: 'The Grok turn was cancelled before it started.', sessionId: null };
      }
      if (!this.isConversationCurrent(conversationGeneration)) {
        return { error: 'The Grok conversation changed before the turn started.', sessionId: null };
      }
      return { error: this.formatModelSelectionError(error), sessionId: null };
    }
    if (!this.isConversationCurrent(conversationGeneration)) {
      return { error: 'The Grok conversation changed before the turn started.', sessionId: null };
    }
    if (execution?.cancelled) {
      return { error: 'The Grok turn was cancelled before it started.', sessionId: null };
    }
    if (!this.connection || !this.sessionId) {
      return { error: 'The Grok runtime is not ready.', sessionId: null };
    }
    return { error: null, sessionId: this.sessionId };
  }

  async steer(_turn: PreparedChatTurn): Promise<boolean> {
    return false;
  }

  cancel(): void {
    const activeTurn = this.activeTurn;
    if (activeTurn) {
      this.cancelActiveTurn(activeTurn);
      return;
    }
    const startingTurn = this.startingTurn;
    if (startingTurn) this.cancelStartingTurn(startingTurn);
  }

  private cancelActiveTurn(activeTurn: ActiveTurn): void {
    if (activeTurn.cancelled) return;
    activeTurn.cancelled = true;
    activeTurn.execution.cancelled = true;
    activeTurn.abortController.abort();
    this.requestRouter.abortPending();
    this.requestRouter.setActiveSessionId(null);
    this.connection?.cancel({ sessionId: activeTurn.sessionId });
    this.quarantineCancelledTurn(this.transport);
    activeTurn.queue.push({ type: 'done' });
    activeTurn.queue.close();
    if (this.activeTurn === activeTurn) this.activeTurn = null;
  }

  private cancelStartingTurn(execution: TurnExecution): void {
    if (execution.cancelled) return;
    execution.abortController.abort();
    this.recycleStartingTurn(execution, true);
  }

  private recycleStartingTurn(execution: TurnExecution, cancelled: boolean): void {
    if (cancelled) execution.cancelled = true;
    if (this.startingTurn === execution) this.startingTurn = null;
    this.lifecycleGeneration += 1;
    this.requestRouter.abortPending();
    this.requestRouter.setActiveSessionId(null);
    const readiness = this.readinessFlight?.promise;
    const recycle = (async () => {
      await this.shutdownProcess().catch(() => undefined);
      if (readiness) await readiness.catch(() => undefined);
    })();
    this.setCancelRecycleFlight(recycle);
  }

  private cancelTurnExecution(execution: TurnExecution): void {
    if (this.activeTurn?.execution === execution) {
      this.cancelActiveTurn(this.activeTurn);
      return;
    }
    if (this.startingTurn === execution) {
      this.cancelStartingTurn(execution);
      return;
    }
    execution.cancelled = true;
    execution.abortController.abort();
  }

  resetSession(): void {
    this.cancel();
    this.sessionId = null;
    this.loadedSessionId = null;
    this.currentExplicitModelId = null;
    this.currentSessionModelId = null;
    this.currentSessionEffort = null;
    this.currentLaunchKey = null;
    this.sessionInvalidated = false;
    this.requestRouter.setActiveSessionId(null);
    this.setSupportedCommands([]);
    void this.shutdownProcess();
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
    if (!this.sessionId) return [];
    if (this.loadedSessionId !== this.sessionId) {
      const ready = await this.ensureReady({ allowSessionCreation: false });
      if (!ready) return [];
    }
    return this.supportedCommands.map(command => ({ ...command }));
  }

  getAuxiliaryModel(): string | null {
    return this.currentConversationModel
      ?? (this.currentSessionModelId ? `grok/${this.currentSessionModelId}` : null);
  }

  cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    const activeTurn = this.activeTurn;
    if (activeTurn) {
      activeTurn.cancelled = true;
      activeTurn.abortController.abort();
      activeTurn.queue.close();
      this.activeTurn = null;
    }
    const startingTurn = this.startingTurn;
    if (startingTurn) {
      startingTurn.cancelled = true;
      startingTurn.abortController.abort();
      if (this.startingTurn === startingTurn) this.startingTurn = null;
    }
    this.requestRouter.dispose();
    this.lifecycle?.untrack(this);
    void this.shutdownProcess();
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.cancel();
    const readiness = this.readinessFlight?.promise;
    const recycle = this.cancelRecycleFlight;
    if (recycle) await recycle.catch(() => undefined);
    if (readiness) await readiness.catch(() => undefined);
    await this.shutdownProcess();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return { canRewind: false };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.requestRouter.setApprovalCallback(callback);
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.requestRouter.setApprovalDismisser(dismisser);
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.requestRouter.setAskUserQuestionCallback(callback);
  }

  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setUnsupportedPlanModeNoticeCallback(callback: ((message: string) => void) | null): void {
    this.requestRouter.setNoticeCallback(callback);
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.requestRouter.setPermissionModeSyncCallback(callback);
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
    const providerState = isRecord(params.conversation?.providerState)
      ? { ...params.conversation.providerState }
      : {};
    delete providerState.sessionDirectory;

    if (this.sessionId) {
      const cwd = getVaultPath(this.plugin.app);
      const cliPath = this.cliResolver.resolveFromSettings(this.plugin.settings) ?? 'grok';
      const environment = buildGrokRuntimeEnv(this.plugin.settings, cliPath);
      const currentHint = isRecord(params.conversation?.providerState)
        && typeof params.conversation.providerState.sessionDirectory === 'string'
        ? params.conversation.providerState.sessionDirectory
        : undefined;
      const sessionDirectory = this.resolveSessionDirectory(
        currentHint,
        this.sessionId,
        cwd,
        { environment, hostPlatform: process.platform },
      );
      if (sessionDirectory) providerState.sessionDirectory = sessionDirectory;
    }

    return {
      updates: {
        providerState: Object.keys(providerState).length > 0 ? providerState : undefined,
        sessionId: this.sessionId,
      },
    };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private async ensureReadyInternal(
    options: ChatRuntimeEnsureReadyOptions | undefined,
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): Promise<boolean> {
    if (!getGrokProviderSettings(this.plugin.settings).enabled) {
      this.lastError = new Error('Grok is disabled.');
      this.setReady(false);
      return false;
    }
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const cliPath = this.cliResolver.resolveFromSettings(this.plugin.settings);
    if (!cliPath) {
      this.lastError = new Error('Grok CLI was not found. Configure its path or install `grok`.');
      this.setReady(false);
      return false;
    }
    const environment = buildGrokRuntimeEnv(this.plugin.settings, cliPath);
    const environmentHash = computeGrokEnvironmentHash(this.plugin.settings);
    const promptSettings = this.getPromptSettings(cwd);
    const settings = this.getProviderSettings();
    const yoloMode = settings.permissionMode === 'yolo';
    const nextLaunchKey = JSON.stringify({
      cliPath,
      cwd,
      environmentHash,
      promptKey: computeGrokSystemPromptKey(promptSettings),
      sessionId: this.sessionId,
      yoloMode,
    });
    const shouldRestart = !this.process
      || !this.process.isAlive()
      || !this.transport
      || this.transport.isClosed
      || !this.connection
      || options?.force === true
      || this.currentLaunchKey !== nextLaunchKey;

    if (shouldRestart) {
      await this.shutdownProcess();
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) return false;
      try {
        await this.startProcess(cliPath, cwd, environment);
        this.currentModelContextKey = environmentHash;
      } catch (error) {
        this.lastError = toError(error, 'Failed to start Grok.');
        await this.shutdownProcess();
        return false;
      }
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
      this.currentLaunchKey = nextLaunchKey;
      this.loadedSessionId = null;
    }

    if (this.sessionId && this.loadedSessionId !== this.sessionId) {
      const targetSessionId = this.sessionId;
      if (!(await this.loadSession(targetSessionId, cwd, promptSettings, conversationGeneration))) {
        this.setReady(false);
        return false;
      }
    } else if (!this.sessionId && options?.allowSessionCreation !== false) {
      if (!(await this.createSession(cwd, promptSettings, conversationGeneration))) {
        this.setReady(false);
        return false;
      }
    }

    if (this.sessionId) {
      this.currentLaunchKey = JSON.stringify({
        cliPath,
        cwd,
        environmentHash,
        promptKey: computeGrokSystemPromptKey(promptSettings),
        sessionId: this.sessionId,
        yoloMode,
      });
    }
    this.lastError = null;
    this.setReady(true);
    return true;
  }

  private async startProcess(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const ownedProcess = this.processFactory({
      args: ['agent', '--no-leader', 'stdio'],
      command,
      cwd,
      env,
    });
    this.process = ownedProcess;
    ownedProcess.start();

    const transport = new AcpJsonRpcTransport({
      input: ownedProcess.stdout,
      onClose: listener => ownedProcess.onClose(listener),
      output: ownedProcess.stdin,
    });
    this.transport = transport;
    const connectionGeneration = ++this.connectionGeneration;
    this.notificationMirrorDeduplicator.reset();
    this.unregisterTransportClose = transport.onClose((error) => {
      if (this.transport !== transport) return;
      this.setReady(false);
      this.requestRouter.abortPending();
      this.settleActiveTurn(error ?? new Error('Grok runtime closed.'));
    });

    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        onSessionNotification: notification => this.handleSessionNotification(
          notification,
          connectionGeneration,
          'standard',
        ),
        requestPermission: request => this.requestRouter.handlePermissionRequest(
          request,
          this.activeTurn?.abortController.signal,
        ),
      },
      methodOverrides: { cancel: 'session/cancel' },
      transport,
    });

    for (const method of [
      ...GROK_SESSION_UPDATE_NOTIFICATION_METHODS,
      GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
    ]) {
      this.unregisterTransportHandlers.push(transport.onNotification(
        method,
        (params) => {
          const notification = parseGrokSessionNotification(method, params);
          if (notification) {
            void this.handleSessionNotification(notification, connectionGeneration, 'extension');
          }
        },
      ));
    }
    for (const method of GROK_MODEL_UPDATE_ALIASES) {
      this.unregisterTransportHandlers.push(transport.onNotification(
        method,
        params => {
          void this.handleModelUpdateNotification(params, connectionGeneration);
        },
      ));
    }
    for (const method of GROK_EXTENSION_REQUEST_METHODS) {
      this.unregisterTransportHandlers.push(transport.onRequest(
        method,
        params => this.requestRouter.handleRequest(
          method,
          params,
          this.activeTurn?.abortController.signal,
        ),
      ));
    }
    for (const method of GROK_EXTENSION_NOTIFICATION_METHODS) {
      this.unregisterTransportHandlers.push(transport.onNotification(
        method,
        params => { this.requestRouter.handleNotification(method, params); },
      ));
    }

    transport.start();
    await this.connection.initialize();
    this.setReady(true);
  }

  private async shutdownProcess(): Promise<void> {
    if (this.shutdownFlight) return this.shutdownFlight;
    const shutdown = this.shutdownProcessInternal();
    this.shutdownFlight = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownFlight === shutdown) this.shutdownFlight = null;
    }
  }

  private async shutdownProcessInternal(): Promise<void> {
    const cancelDelivery = this.cancelDeliveryFlight;
    if (cancelDelivery) {
      await cancelDelivery.catch(() => undefined);
      if (this.cancelDeliveryFlight === cancelDelivery) this.cancelDeliveryFlight = null;
    }
    this.connectionGeneration += 1;
    this.notificationMirrorDeduplicator.reset();
    this.setReady(false);
    this.requestRouter.abortPending();
    this.settleActiveTurn();

    this.unregisterTransportClose?.();
    this.unregisterTransportClose = null;
    while (this.unregisterTransportHandlers.length > 0) {
      this.unregisterTransportHandlers.pop()?.();
    }

    this.connection?.dispose();
    this.connection = null;
    this.transport?.dispose();
    this.transport = null;
    const ownedProcess = this.process;
    this.process = null;
    this.currentModelContextKey = null;
    if (ownedProcess) await ownedProcess.shutdown().catch(() => undefined);
    this.loadedSessionId = null;
    this.pendingNewSessionNotifications = null;
  }

  private quarantineCancelledTurn(transport: AcpJsonRpcTransport | null): void {
    const delivery = waitForGrokCancelDelivery(transport);
    this.cancelDeliveryFlight = delivery;
    const recycle = (async () => {
      await delivery.catch(() => undefined);
      if (this.transport === transport) await this.shutdownProcess();
    })();
    this.setCancelRecycleFlight(recycle);
  }

  private setCancelRecycleFlight(recycle: Promise<void>): void {
    this.cancelRecycleFlight = recycle;
    const clear = () => {
      if (this.cancelRecycleFlight === recycle) this.cancelRecycleFlight = null;
    };
    void recycle.then(clear, clear);
  }

  private async createSession(
    cwd: string,
    promptSettings: GrokSystemPromptSettings,
    conversationGeneration: number,
  ): Promise<boolean> {
    if (!this.connection) return false;
    const pendingNotifications: PendingGrokSessionNotification[] = [];
    this.pendingNewSessionNotifications = pendingNotifications;
    try {
      this.setSupportedCommands([]);
      const response = await this.connection.newSession({
        _meta: this.buildSessionMeta(promptSettings),
        cwd,
        mcpServers: [],
      });
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      const prepared = this.prepareSessionResponse(response);
      await this.mergeSessionModels(
        prepared.models,
        this.resolveSelectedModel() === 'grok'
          ? prepared.currentModelId ?? undefined
          : undefined,
      );
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      this.commitSessionResponse(prepared);
      this.currentExplicitModelId = decodeGrokModelId(this.resolveSelectedModel());
      this.notificationMirrorDeduplicator.reset();
      for (const pending of pendingNotifications) {
        if (pending.notification.sessionId === prepared.sessionId) {
          await this.handleSessionNotification(
            pending.notification,
            this.connectionGeneration,
            pending.source,
          );
        }
      }
      return this.isConversationCurrent(conversationGeneration);
    } catch (error) {
      this.lastError = toError(error, 'Failed to create a Grok session.');
      return false;
    } finally {
      if (this.pendingNewSessionNotifications === pendingNotifications) {
        this.pendingNewSessionNotifications = null;
      }
    }
  }

  private async loadSession(
    sessionId: string,
    cwd: string,
    promptSettings: GrokSystemPromptSettings,
    conversationGeneration: number,
  ): Promise<boolean> {
    if (!this.connection) return false;
    try {
      this.setSupportedCommands([]);
      const response = await this.connection.loadSession({
        _meta: this.buildSessionMeta(promptSettings),
        cwd,
        mcpServers: [],
        sessionId,
      });
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      const prepared = this.prepareSessionResponse(response, sessionId);
      await this.mergeSessionModels(
        prepared.models,
        this.resolveSelectedModel() === 'grok'
          ? prepared.currentModelId ?? undefined
          : undefined,
      );
      if (!this.isConversationCurrent(conversationGeneration)) return false;
      this.commitSessionResponse(prepared);
      this.currentExplicitModelId = decodeGrokModelId(this.resolveSelectedModel());
      return this.isConversationCurrent(conversationGeneration);
    } catch (error) {
      this.lastError = toError(error, `Failed to load Grok session ${sessionId}.`);
      return false;
    }
  }

  private buildSessionMeta(promptSettings: GrokSystemPromptSettings): AcpMetadata {
    const settings = this.getProviderSettings();
    return { ...buildGrokSessionMeta({
      model: this.resolveSelectedModel(),
      permissionMode: settings.permissionMode,
      promptSettings,
    }) };
  }

  private async applySelectedModel(
    sessionId: string,
    queryOptions?: ChatRuntimeQueryOptions,
  ): Promise<string> {
    if (!this.connection) return sessionId;
    const rawModelId = decodeGrokModelId(this.resolveSelectedModel(queryOptions));
    if (!rawModelId) {
      if (!this.currentExplicitModelId) return sessionId;
      await this.shutdownProcess();
      const loaded = await this.ensureReady({ allowSessionCreation: false });
      if (!loaded || this.sessionId !== sessionId) {
        throw this.lastError ?? new Error('Failed to restore the native-default Grok session.');
      }
      return sessionId;
    }
    const effort = this.resolveSelectedEffort(rawModelId);
    if (
      rawModelId === this.currentSessionModelId
      && effort === this.currentSessionEffort
    ) {
      this.currentExplicitModelId = rawModelId;
      return sessionId;
    }

    const response = await this.connection.setModel({
      ...(effort ? { _meta: { reasoningEffort: effort } } : {}),
      modelId: rawModelId,
      sessionId,
    });
    this.currentSessionModelId = rawModelId;
    this.currentSessionEffort = effort;
    this.currentExplicitModelId = rawModelId;
    await this.mergeSetModelMetadata(response._meta);
    return sessionId;
  }

  private async handleSessionNotification(
    notification: AcpSessionNotification,
    connectionGeneration: number,
    source: GrokSessionNotificationSource,
  ): Promise<void> {
    if (connectionGeneration !== this.connectionGeneration) return;
    if (!isRecord(notification)) return;
    if (notification.sessionId !== this.sessionId) {
      if (
        this.pendingNewSessionNotifications
        && this.notificationMirrorDeduplicator.shouldProcess(notification, source)
      ) {
        this.pendingNewSessionNotifications.push({ notification, source });
      }
      return;
    }
    if (!this.notificationMirrorDeduplicator.shouldProcess(notification, source)) return;

    const completedUsage = parseGrokTurnCompletedUsage(notification.update);
    if (completedUsage) {
      if (!this.activeTurn || this.activeTurn.sessionId !== notification.sessionId) return;
      this.currentPromptUsage = completedUsage;
      const usage = this.buildCurrentUsage();
      if (usage) {
        this.activeTurn.queue.push({
          sessionId: notification.sessionId,
          type: 'usage',
          usage,
        });
      }
      return;
    }

    let normalized: ReturnType<AcpSessionUpdateNormalizer['normalize']>;
    try {
      normalized = this.sessionUpdateNormalizer.normalize(notification.update);
    } catch {
      return;
    }
    if (!normalized) return;

    if (normalized.type === 'commands') {
      this.setSupportedCommands(normalized.commands);
      return;
    }
    if (normalized.type === 'config_options') {
      await this.syncSessionModels({ configOptions: normalized.configOptions });
      return;
    }
    if (!this.activeTurn || this.activeTurn.sessionId !== notification.sessionId) return;

    switch (normalized.type) {
      case 'message_chunk':
        if (normalized.role === 'assistant' && normalized.messageId) {
          this.currentTurnMetadata.assistantMessageId = normalized.messageId;
        }
        if (normalized.role === 'user' && normalized.messageId) {
          this.currentTurnMetadata.userMessageId = normalized.messageId;
        }
        for (const chunk of normalized.streamChunks) this.activeTurn.queue.push(chunk);
        return;
      case 'tool_call':
        for (const chunk of this.toolStreamAdapter.normalizeToolCall(
          normalized.toolCall,
          normalized.streamChunks,
        )) this.activeTurn.queue.push(chunk);
        return;
      case 'tool_call_update':
        for (const chunk of this.toolStreamAdapter.normalizeToolCallUpdate(
          normalized.toolCallUpdate,
          normalized.streamChunks,
        )) this.activeTurn.queue.push(chunk);
        return;
      case 'usage': {
        this.currentContextUsage = normalized.usage;
        const usage = this.buildCurrentUsage();
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

  private async syncSessionModels(
    response: Pick<AcpNewSessionResponse, '_meta' | 'configOptions' | 'models'>,
    conversationGeneration?: number,
  ): Promise<void> {
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) return;
    const prepared = this.prepareSessionModels(response);
    this.applySessionModels(prepared);
    await this.mergeSessionModels(prepared.models);
  }

  private prepareSessionResponse(
    response: AcpNewSessionResponse | AcpLoadSessionResponse,
    expectedSessionId?: string,
  ): PreparedGrokSessionResponse {
    if (!isRecord(response)) throw new Error('Grok returned a malformed ACP session response.');
    const responseSessionId = normalizeOpaqueString(response.sessionId);
    const sessionId = response.sessionId === undefined || response.sessionId === null
      ? expectedSessionId ?? null
      : responseSessionId;
    if (!sessionId) throw new Error('Grok ACP session response is missing a session id.');
    if (responseSessionId && expectedSessionId !== undefined && responseSessionId !== expectedSessionId) {
      throw new Error(`Grok ACP session response returned an unexpected session id: ${responseSessionId}.`);
    }
    return { ...this.prepareSessionModels(response), sessionId };
  }

  private prepareSessionModels(
    response: Pick<AcpNewSessionResponse, '_meta' | 'configOptions' | 'models'>,
  ): PreparedGrokSessionModels {
    const state = extractAcpSessionModelState(response);
    const models = normalizeGrokDiscoveredModels(state.availableModels.map(model => ({
      ...readGrokModelMetadata({
        ...(model.id === state.currentModelId
          ? normalizeGrokReasoningMetadata(response._meta)
          : {}),
        ...(isRecord(model._meta) ? model._meta : {}),
      }),
      description: model.description ?? undefined,
      displayName: model.name,
      rawId: model.id,
    })));
    const current = models.find(model => model.rawId === state.currentModelId);
    return {
      currentModelId: state.currentModelId,
      currentSessionEffort: current ? resolveGrokDefaultReasoningEffort(current) : null,
      models,
    };
  }

  private applySessionModels(prepared: PreparedGrokSessionModels): void {
    this.currentSessionModelId = prepared.currentModelId;
    this.currentSessionEffort = prepared.currentSessionEffort;
  }

  private async mergeSessionModels(
    models: GrokDiscoveredModel[],
    defaultModelId?: string,
  ): Promise<void> {
    if (models.length > 0) {
      await (defaultModelId
        ? this.modelCatalogCoordinator?.mergeLiveModels(
          models,
          defaultModelId,
          this.currentModelContextKey ?? undefined,
        )
        : this.modelCatalogCoordinator?.mergeLiveModels(
          models,
          undefined,
          this.currentModelContextKey ?? undefined,
        ));
    }
  }

  private commitSessionResponse(prepared: PreparedGrokSessionResponse): void {
    this.sessionId = prepared.sessionId;
    this.loadedSessionId = prepared.sessionId;
    this.requestRouter.setActiveSessionId(prepared.sessionId);
    this.applySessionModels(prepared);
  }

  private async handleModelUpdateNotification(
    params: unknown,
    connectionGeneration: number,
  ): Promise<void> {
    if (connectionGeneration !== this.connectionGeneration) return;
    const models = parseGrokSessionModelState(params);
    if (!models) return;
    try {
      const prepared = this.prepareSessionModels({ models });
      await this.mergeSessionModels(
        prepared.models,
        prepared.currentModelId ?? undefined,
      );
    } catch {
      // Catalog synchronization is best-effort and must not disrupt the ACP stream.
    }
  }

  private async mergeSetModelMetadata(metadata: AcpMetadata | null | undefined): Promise<void> {
    if (!isRecord(metadata) || !isRecord(metadata.model)) return;
    const model = normalizeGrokDiscoveredModels([metadata.model]);
    if (model.length > 0) {
      await this.modelCatalogCoordinator?.mergeLiveModels(
        model,
        undefined,
        this.currentModelContextKey ?? undefined,
      );
    }
  }

  private setSupportedCommands(commands: SlashCommand[]): void {
    this.supportedCommands = commands.map(command => ({ ...command }));
    this.commandCatalog?.setRuntimeCommands(this.supportedCommands);
  }

  private settleActiveTurn(error?: Error): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.cancelled) return;
    activeTurn.cancelled = true;
    activeTurn.abortController.abort();
    this.requestRouter.abortPending();
    if (error) activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
    activeTurn.queue.push({ type: 'done' });
    activeTurn.queue.close();
    if (this.activeTurn === activeTurn) this.activeTurn = null;
  }

  private getProviderSettings(): Record<string, unknown> {
    const settings: Record<string, unknown> = { ...this.plugin.settings };
    projectSavedProviderValue(settings, 'savedProviderModel', 'model');
    projectSavedProviderValue(settings, 'savedProviderEffort', 'effortLevel');
    projectSavedProviderValue(settings, 'savedProviderPermissionMode', 'permissionMode');
    if (this.currentConversationModel) settings.model = this.currentConversationModel;
    return settings;
  }

  private resolveSelectedModel(queryOptions?: ChatRuntimeQueryOptions): string {
    const settings = this.getProviderSettings();
    const model = queryOptions?.model ?? settings.model;
    return typeof model === 'string' && model.trim() ? model.trim() : 'grok';
  }

  private resolveSelectedEffort(rawModelId: string): string | null {
    const settings = this.getProviderSettings();
    const direct = typeof settings.effortLevel === 'string' ? settings.effortLevel.trim() : '';
    const preferred = getGrokProviderSettings(settings).preferredReasoningByModel[rawModelId];
    return direct || preferred || null;
  }

  private setCurrentConversationModel(model: unknown): void {
    const normalized = typeof model === 'string' ? model.trim() : '';
    this.currentConversationModel = normalized || null;
  }

  private getPromptSettings(cwd: string): GrokSystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath: cwd,
    };
  }

  private buildCurrentUsage(queryOptions?: ChatRuntimeQueryOptions) {
    const usage = buildAcpUsageInfo({
      contextWindow: this.currentContextUsage,
      model: this.resolveSelectedModel(queryOptions),
      promptUsage: this.currentPromptUsage,
    });
    if (!usage || !this.currentPromptUsage) return usage;
    const contextTokens = this.currentPromptUsage.totalTokens;
    return {
      ...usage,
      contextTokens,
      percentage: usage.contextWindow > 0
        ? Math.min(100, Math.max(0, Math.round((contextTokens / usage.contextWindow) * 100)))
        : 0,
    };
  }

  private formatModelSelectionError(error: unknown): string {
    const message = toError(error, 'Grok model selection failed.').message;
    if (/agent\s*type|agenttype|incompatible/i.test(message)) {
      return 'This model uses an agent type that is incompatible with the current Grok session. Start a new conversation with that model.';
    }
    return this.formatRuntimeError(error);
  }

  private formatRuntimeError(error: unknown): string {
    const baseMessage = toError(error ?? this.lastError, 'Grok request failed.').message;
    const redactedBaseMessage = redactDiagnostic(baseMessage);
    if (redactedBaseMessage !== baseMessage) {
      return redactedBaseMessage;
    }
    const diagnosticText = `${baseMessage}\n${this.process?.getStderrSnapshot() ?? ''}`;
    if (/api[ _-]?key|credential|env_key|custom model/i.test(diagnosticText)) {
      return 'Grok custom-model credentials are missing or invalid. Configure the model env_key in Grok and provide that variable through the Grok environment settings.';
    }
    if (/auth|log[ -]?in|token.*(?:expired|missing|invalid)|unauthorized/i.test(diagnosticText)) {
      return 'Grok authentication failed or expired. Run `grok login` in a terminal, then retry.';
    }
    return redactedBaseMessage;
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    for (const listener of this.readyListeners) listener(ready);
  }

  private isConversationCurrent(generation: number): boolean {
    return generation === this.conversationGeneration;
  }

  private isReadinessCurrent(
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): boolean {
    return !this.disposed
      && lifecycleGeneration === this.lifecycleGeneration
      && this.isConversationCurrent(conversationGeneration);
  }
}

function createGrokToolStreamAdapter(): AcpToolStreamAdapter {
  return new AcpToolStreamAdapter({
    normalizeToolInput(rawName, input) {
      return normalizeGrokToolCall({ rawInput: input, title: rawName }).input;
    },
    normalizeToolName(rawName) {
      return normalizeGrokToolName(rawName ?? 'tool');
    },
    normalizeToolUseResult(rawName, _input, rawOutput, rawInput) {
      return {
        providerPayload: buildGrokToolProviderPayload({
          rawInput,
          rawName: rawName ?? 'tool',
          rawOutput,
        }),
      };
    },
    resolveRawToolName(currentRawName, update) {
      return resolveGrokRawToolName(currentRawName, update);
    },
  });
}

function wrapCancelableGenerator(
  iterator: AsyncGenerator<StreamChunk>,
  cancel: () => void,
): AsyncGenerator<StreamChunk> {
  const wrapped: AsyncGenerator<StreamChunk> = {
    next: iterator.next.bind(iterator),
    return(value) {
      cancel();
      return iterator.return(value);
    },
    throw(error) {
      cancel();
      return iterator.throw(error);
    },
    [Symbol.asyncIterator]() {
      return wrapped;
    },
    async [Symbol.asyncDispose]() {
      cancel();
      await iterator[Symbol.asyncDispose]();
    },
  };
  return wrapped;
}

function buildGrokPromptText(request: ChatTurnRequest): string {
  let prompt = request.text;
  if (request.currentNotePath) prompt = appendCurrentNote(prompt, request.currentNotePath);
  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }
  if (request.browserSelection) prompt = appendBrowserContext(prompt, request.browserSelection);
  if (request.canvasSelection) prompt = appendCanvasContext(prompt, request.canvasSelection);
  return prompt;
}

function readGrokModelMetadata(metadata: AcpMetadata | null | undefined): Record<string, unknown> {
  if (!isRecord(metadata)) return {};
  return {
    ...normalizeGrokReasoningMetadata(metadata),
    agentType: readString(metadata.agentType),
    contextWindow: readNumber(metadata.totalContextTokens) ?? readNumber(metadata.contextWindow),
  };
}

function parseGrokSessionModelState(params: unknown): AcpSessionModelState | null {
  if (!isRecord(params)) return null;
  const candidate = isRecord(params.models) ? params.models : params;
  if (
    !Array.isArray(candidate.availableModels)
    || typeof candidate.currentModelId !== 'string'
  ) return null;

  if (!candidate.availableModels.every(isAcpModelInfo)) return null;
  return {
    ...candidate,
    availableModels: candidate.availableModels,
    currentModelId: candidate.currentModelId,
  };
}

function isAcpModelInfo(
  model: unknown,
): model is AcpSessionModelState['availableModels'][number] {
  return isRecord(model)
    && typeof model.name === 'string'
    && (typeof model.modelId === 'string' || typeof model.id === 'string');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeOpaqueString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseGrokTurnCompletedUsage(update: unknown): AcpUsage | null {
  if (!isRecord(update) || update.sessionUpdate !== 'turn_completed' || !isRecord(update.usage)) {
    return null;
  }
  return parseGrokUsageRecord(update.usage);
}

function parseGrokPromptResponseUsage(response: unknown): AcpUsage | null {
  if (!isRecord(response)) return null;
  const direct = parseGrokUsageRecord(response.usage);
  if (direct) return direct;
  if (!isRecord(response._meta)) return null;
  return parseGrokUsageRecord(response._meta)
    ?? parseGrokUsageRecord(response._meta.usage);
}

function parseGrokUsageRecord(value: unknown): AcpUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = readTokenCount(value.inputTokens);
  const outputTokens = readTokenCount(value.outputTokens);
  const totalTokens = readTokenCount(value.totalTokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return null;
  }
  const cachedReadTokens = readTokenCount(value.cachedReadTokens);
  const cachedWriteTokens = readTokenCount(value.cachedWriteTokens);
  const thoughtTokens = readTokenCount(value.reasoningTokens);
  return {
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    inputTokens,
    outputTokens,
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
    totalTokens,
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function projectSavedProviderValue(
  settings: Record<string, unknown>,
  mapKey: string,
  targetKey: string,
): void {
  const projection = settings[mapKey];
  if (!isRecord(projection) || typeof projection.grok !== 'string') return;
  settings[targetKey] = projection.grok;
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/gi, '<redacted>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(
      /(["']?\b(?:[A-Za-z_][A-Za-z0-9_-]*)?(?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}\]]+)/gi,
      (_match: string, prefix: string, value: string) => `${prefix}${redactAssignedValue(value)}`,
    );
}

function redactAssignedValue(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote
    ? `${quote}<redacted>${quote}`
    : '<redacted>';
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
