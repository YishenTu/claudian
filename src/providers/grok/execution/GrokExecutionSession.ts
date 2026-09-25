import { randomUUID } from 'node:crypto';

import {
  type ChatRewindMode,
  type ChatRewindPreview,
  type ChatRewindResult,
  ExecutionEventQueue,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderRequestedEventScope,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  type RewindableExecutionSession,
  type SteerableExecutionSession,
} from '../../../core/execution';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ChatMessage, PermissionMode } from '../../../core/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendLinkedContent } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../../utils/session';
import {
  type ACPContentBlock,
  ACPExecutionEventNormalizer,
  ACPInteractionController,
  type ACPPromptResponse,
  type ACPSessionConfigOption,
  type ACPSessionModelState,
  type ACPSessionNotification,
  ACPToolStreamAdapter,
  type ACPUsage,
  type ACPUsageUpdate,
  buildACPUsageInfo,
} from '../../acp';
import type { GrokCommandCatalog } from '../commands/GrokCommandCatalog';
import { computeGrokEnvironmentHash } from '../env/GrokSettingsReconciler';
import {
  resolveGrokSessionCwd,
  resolveGrokSessionDirectory,
} from '../history/GrokHistoryPathResolver';
import { resolveGrokLiveMessageId } from '../history/GrokHistoryStore';
import {
  decodeGrokModelId,
  findGrokModel,
  getGrokAvailableReasoningEfforts,
  type GrokDiscoveredModel,
  normalizeGrokDiscoveredModels,
} from '../models';
import {
  normalizeGrokToolCall,
  normalizeGrokToolName,
  normalizeGrokToolUseResult,
  resolveGrokRawToolName,
} from '../normalization/grokToolNormalization';
import { parseGrokPromptUsage, parseGrokUsage } from '../normalization/grokUsage';
import {
  buildGrokSystemPrompt,
  type GrokSystemPromptSettings,
} from '../prompt/GrokSystemPrompt';
import { waitForGrokCancelDelivery } from '../runtime/GrokCancelDelivery';
import { assertGrokModelAvailable } from '../runtime/GrokModelAvailability';
import type { GrokModelCatalogCoordinator } from '../runtime/GrokModelCatalogCoordinator';
import { buildGrokRuntimeEnv } from '../runtime/GrokRuntimeEnvironment';
import { GrokSessionNotificationMirrorDeduplicator } from '../runtime/GrokSessionNotificationMirrorDeduplicator';
import { getGrokProviderSettings } from '../settings';
import { parseGrokProviderState } from '../types';
import type {
  GrokExecutionNativeConnection,
  GrokExecutionNativeFactory,
} from './GrokExecutionBackend';
import { GrokExecutionInteractionRouter } from './GrokExecutionInteractionRouter';
import {
  normalizeGrokModelUpdateMetadata,
  normalizeGrokSessionModelMetadata,
  normalizeGrokSetModelMetadata,
} from './GrokSessionModelMetadata';

interface GrokExecutionSessionOptions {
  readonly commandCatalog?: Pick<GrokCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: Pick<GrokModelCatalogCoordinator, 'mergeLiveModels'>;
  readonly nativeFactory: GrokExecutionNativeFactory;
  readonly resolvePromptIndex?: (
    sessionDirectory: string,
    providerSessionId: string,
    assistantMessageId: string,
  ) => Promise<number | null>;
}

class GrokExecutionRunState implements ProviderExecutionRun {
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  private readonly queue: ExecutionEventQueue<ProviderExecutionEvent>;
  private terminal = false;
  private settle!: () => void;
  readonly settled = new Promise<void>(resolve => { this.settle = resolve; });

  constructor(
    readonly executionId: string,
    readonly turnId: string,
    private readonly cancelCallback: () => void,
  ) {
    this.queue = new ExecutionEventQueue<ProviderExecutionEvent>(cancelCallback);
    this.events = this.queue;
  }

  cancel(): void {
    this.cancelCallback();
  }

  emit(event: ProviderExecutionEvent): void {
    if (!this.terminal) this.queue.push(event);
  }

  finish(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.queue.push(event);
    this.queue.close();
    this.settle();
  }

  get isTerminal(): boolean {
    return this.terminal;
  }
}

interface PendingInterjection {
  accepted: boolean;
  applied: boolean;
  readonly text: string;
}

interface ActiveExecution {
  acceptingLiveOutput: boolean;
  readonly abortController: AbortController;
  accepted: boolean;
  readonly cancellationGeneration: number;
  readonly normalizer: ACPExecutionEventNormalizer;
  readonly request: ProviderExecutionRequest;
  readonly run: GrokExecutionRunState;
  sequence: number;
  contextUsage: ACPUsageUpdate | null;
  promptUsage: ACPUsage | null;
  promptResponse?: ACPPromptResponse;
  readonly interjections: Map<string, PendingInterjection>;
  observedTurnCompletions: number;
  requiredTurnCompletions: number;
}

interface GrokNativeOwner {
  readonly generation: number;
  initialized: boolean;
  loadedSessionConfigurationKey: string | null;
  loadedSessionId: string | null;
  modeUnsubscribe: () => void;
  interjectionUnsubscribe: () => void;
  readonly modelContextKey: string;
  modelsUnsubscribe: () => void;
  readonly native: GrokExecutionNativeConnection;
  notificationUnsubscribe: () => void;
  shutdownFlight: Promise<void> | null;
}

export class GrokExecutionSession
implements
ProviderExecutionSession,
SteerableExecutionSession,
RewindableExecutionSession {
  readonly providerId = 'grok' as const;
  readonly sessionInstanceId = randomUUID();

  private active: ActiveExecution | null = null;
  private cancellationFlight: Promise<void> | null = null;
  private cancellationGeneration = 0;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private forkCreationFlight: Promise<string> | null = null;
  private nativeGeneration = 0;
  private nativeOwner: GrokNativeOwner | null = null;
  private nativeStartupFlight: Promise<GrokExecutionNativeConnection> | null = null;
  private quarantineGeneration = 0;
  private readonly interactionController: ACPInteractionController;
  private readonly interactionRouter: GrokExecutionInteractionRouter;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private readonly mirrorDeduplicator = new GrokSessionNotificationMirrorDeduplicator();
  private nativeConversationContextEstablished: boolean;
  private readonly providerStateDeletes = new Set<string>();
  private providerSessionId: string | undefined;
  private providerState: Readonly<Record<string, unknown>>;
  private forkApplied = false;
  private revision = 0;
  private snapshot: ProviderSessionSnapshot;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: GrokExecutionSessionOptions,
  ) {
    this.providerSessionId = config.resumeSeed?.providerSessionId;
    const providerState = parseGrokProviderState(config.resumeSeed?.providerState);
    this.providerState = { ...providerState };
    this.nativeConversationContextEstablished = Boolean(providerState.forkSource)
      || Boolean(
        this.providerSessionId
        && providerState.nativeConversationContextEstablished !== false,
      );
    this.snapshot = this.#createSnapshot('idle');
    this.interactionController = new ACPInteractionController({
      getTurnId: () => this.active?.run.turnId ?? null,
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.interactionRouter = new GrokExecutionInteractionRouter(
      config.interactionPort,
      this.sessionInstanceId,
      () => this.active?.run.turnId ?? null,
      () => this.providerSessionId,
    );
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Grok execution session is disposed.');
    if (this.active) throw new Error('Grok execution session is already executing.');
    const run = new GrokExecutionRunState(
      randomUUID(),
      randomUUID(),
      () => { void this.#cancelRun(run, 'cancelled'); },
    );
    const active: ActiveExecution = {
      acceptingLiveOutput: false,
      abortController: new AbortController(),
      accepted: false,
      cancellationGeneration: this.cancellationGeneration,
      contextUsage: null,
      promptUsage: null,
      interjections: new Map(),
      observedTurnCompletions: 0,
      requiredTurnCompletions: 0,
      normalizer: new ACPExecutionEventNormalizer({
        mapUsage: usage => {
          if (active.acceptingLiveOutput) active.contextUsage = usage;
          return buildACPUsageInfo({ contextWindow: usage });
        },
        scope: {
          executionId: run.executionId,
          kind: 'requested',
          sessionInstanceId: this.sessionInstanceId,
          turnId: run.turnId,
        },
        toolStreamAdapter: createGrokToolStreamAdapter(),
      }),
      request,
      run,
      sequence: 0,
    };
    this.active = active;
    this.#updateSnapshot('executing');
    this.#emitCurrentSnapshot();
    const onAbort = (): void => { void this.#cancelRun(run, 'aborted'); };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) {
      request.signal.removeEventListener('abort', onAbort);
      onAbort();
    } else {
      void this.#performExecution(active).finally(() => {
        request.signal.removeEventListener('abort', onAbort);
      });
    }
    return run;
  }

  cancel(): void {
    const run = this.active?.run;
    if (run) void this.#cancelRun(run, 'cancelled');
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.snapshot;
  }

  getStatus(): ProviderSessionStatus {
    return this.snapshot.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalFlight) return this.disposalFlight;
    this.disposed = true;
    this.quarantineGeneration += 1;
    this.disposalFlight = (async () => {
      const active = this.active;
      if (active) await this.#cancelRun(active.run, 'session-disposed');
      if (this.cancellationFlight) await this.cancellationFlight;
      await this.#shutdownNative();
      this.interactionController.dispose();
      this.interactionRouter.dismissAll('session-disposed');
      this.listeners.clear();
      this.#updateSnapshot('disposed');
    })();
    return this.disposalFlight;
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    try { assertGrokModelAvailable(this.plugin.settings, request.configuration.model); }
    catch (error) { if (error instanceof ProviderModelUnavailableError) return false; throw error; }
    const active = this.active;
    const native = this.nativeOwner?.initialized ? this.nativeOwner.native : null;
    if (
      !active
      || this.#isCancellationRequested(active)
      || !native?.interject
      || !this.providerSessionId
      || request.signal.aborted
    ) return false;
    const blocks = buildPromptBlocks(request);
    const interjectionId = randomUUID();
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const pending: PendingInterjection = { accepted: false, applied: false, text };
    active.interjections.set(interjectionId, pending);
    try {
      await native.interject({ content: blocks, interjectionId, sessionId: this.providerSessionId, text }, request.signal);
      pending.accepted = true;
      if (pending.applied) active.interjections.delete(interjectionId);
      return true;
    } catch (error) {
      active.interjections.delete(interjectionId);
      throw error;
    } finally {
      this.#finishCompletedIfReady(active);
    }
  }

  async previewRewind(
    _userMessageId: string,
    assistantMessageId: string | undefined,
    mode: ChatRewindMode = 'conversation',
  ): Promise<ChatRewindPreview> {
    return this.#performRewind(assistantMessageId, mode, false);
  }

  async rewind(
    _userMessageId: string,
    assistantMessageId: string | undefined,
    mode: ChatRewindMode = 'conversation',
  ): Promise<ChatRewindResult> {
    const result = await this.#performRewind(assistantMessageId, mode, true);
    return {
      ...result,
      sessionStrategy: 'preserve-provider-session',
    };
  }

  async #performExecution(active: ActiveExecution): Promise<void> {
    if (active.request.toolPolicy.kind === 'allow-list') {
      this.#updateSnapshot('invalidated', {
        message: 'Exact Grok tool allow-list enforcement is unavailable.',
        reason: 'configuration-changed',
        recoverable: false,
      });
      this.#emitCurrentSnapshot();
      active.run.finish({
        category: 'configuration',
        message: 'Grok does not support reliable exact allow-list enforcement.',
        recoverable: false,
        scope: this.#nextScope(active),
        type: 'execution_error',
      });
      active.normalizer.dispose();
      if (this.active === active) this.active = null;
      return;
    }
    let unsubscribeClose: (() => void) | undefined;
    try {
      assertGrokModelAvailable(this.plugin.settings, active.request.configuration.model);
      if (this.cancellationFlight) await this.cancellationFlight;
      if (this.#isCancellationRequested(active)) return;
      const native = await this.#ensureNative(active);
      if (this.#isCancellationRequested(active)) return;
      const sessionId = await this.#ensureSession(native, active.request, active);
      if (this.#isCancellationRequested(active)) return;
      await this.#applyConfiguration(native, sessionId, active.request, active);
      if (this.#isCancellationRequested(active)) return;
      assertGrokModelAvailable(this.plugin.settings, active.request.configuration.model);
      active.normalizer.reset();
      active.acceptingLiveOutput = true;
      const closed = new Promise<never>((_resolve, reject) => {
        unsubscribeClose = native.onClose?.(error => {
          reject(new Error('Grok transport closed', { cause: error }));
        });
      });
      const response = await Promise.race([closed, native.prompt({
        prompt: buildPromptBlocks(
          active.request,
          !this.nativeConversationContextEstablished,
        ),
        sessionId,
      })]);
      if (this.#isCancellationRequested(active)) return;
      this.accept(active, response);
      active.promptResponse = response;
      active.promptUsage = parseGrokPromptUsage(response) ?? active.promptUsage;
      this.#finishCompletedIfReady(active);
      await Promise.race([closed, active.run.settled]);
    } catch (error) {
      if (this.#isCancellationRequested(active)) return;
      const category = classifyError(error);
      this.#updateSnapshot('invalidated', {
        message: error instanceof Error ? error.message : String(error),
        reason: category === 'provider-session-missing'
          ? 'provider-session-missing'
          : category === 'transport'
            ? 'transport-closed'
            : 'provider-error',
        recoverable: true,
      });
      this.#emitCurrentSnapshot();
      active.run.finish({
        category,
        message: error instanceof Error ? error.message : String(error),
        ...(category === 'provider-session-missing' && this.providerSessionId
          ? { missingProviderSessionId: this.providerSessionId }
          : {}),
        recoverable: true,
        scope: this.#nextScope(active),
        type: 'execution_error',
      });
      active.normalizer.dispose();
      this.active = null;
    } finally {
      unsubscribeClose?.();
    }
  }

  async #ensureNative(
    active?: ActiveExecution,
  ): Promise<GrokExecutionNativeConnection> {
    const currentOwner = this.nativeOwner;
    if (
      !this.nativeStartupFlight
      && currentOwner?.initialized
      && currentOwner.native.isAlive?.() !== false
    ) return currentOwner.native;
    let startupFlight = this.nativeStartupFlight;
    if (!startupFlight) {
      startupFlight = this.#startNative(this.quarantineGeneration);
      this.nativeStartupFlight = startupFlight;
      startupFlight.then(
        () => {
          if (this.nativeStartupFlight === startupFlight) this.nativeStartupFlight = null;
        },
        () => {
          if (this.nativeStartupFlight === startupFlight) this.nativeStartupFlight = null;
        },
      );
    }
    const native = await startupFlight;
    this.#throwIfCancellationRequested(active);
    return native;
  }

  async #startNative(
    quarantineGeneration: number,
  ): Promise<GrokExecutionNativeConnection> {
    const previousOwner = this.nativeOwner;
    if (previousOwner) await this.#shutdownNativeOwner(previousOwner);
    const host = this.plugin as ProviderHost & {
      getResolvedProviderCliPath?: ProviderHost['getResolvedProviderCliPath'];
    };
    const command = await host.getResolvedProviderCliPath?.('grok') ?? 'grok';
    if (quarantineGeneration !== this.quarantineGeneration || this.disposed) {
      throw new Error('Grok native startup was cancelled.');
    }
    const generation = ++this.nativeGeneration;
    const native = this.options.nativeFactory.create({
      command,
      cwd: this.config.vaultWorkingDirectory,
      env: buildGrokRuntimeEnv(this.plugin.settings, command),
      requestPermission: (request, signal) => {
        const policy = this.active?.request.toolPolicy.kind;
        if (policy === 'passive' || policy === 'read-only') {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        return this.interactionController.requestPermission(
          request,
          signal ?? this.active?.abortController.signal,
        );
      },
      requestExtension: (method, params, signal) => this.interactionRouter.handle(
        method,
        params,
        signal ?? this.active?.abortController.signal,
      ),
      version: this.plugin.manifest?.version ?? '0.0.0',
    });
    const owner: GrokNativeOwner = {
      generation,
      initialized: false,
      loadedSessionConfigurationKey: null,
      loadedSessionId: null,
      modeUnsubscribe: () => {},
      interjectionUnsubscribe: () => {},
      modelContextKey: computeGrokEnvironmentHash(this.plugin.settings),
      modelsUnsubscribe: () => {},
      native,
      notificationUnsubscribe: () => {},
      shutdownFlight: null,
    };
    this.nativeOwner = owner;
    try {
      this.mirrorDeduplicator.reset();
      owner.notificationUnsubscribe = native.onNotification((notification, source) => {
        if (this.#isCurrentNativeOwner(owner)) this.handleNotification(notification, source);
      });
      owner.interjectionUnsubscribe = native.onInterjection?.(notification => {
        if (this.#isCurrentNativeOwner(owner)) this.#handleInterjection(notification);
      }) ?? (() => {});
      owner.modeUnsubscribe = native.onModeChanged?.(mode => {
        if (!this.#isCurrentNativeOwner(owner)) return;
        this.#updateSnapshot(this.active ? 'executing' : 'idle');
        this.#emitPermissionMode(mode);
      }) ?? (() => {});
      owner.modelsUnsubscribe = native.onModelsChanged?.(models => {
        if (!this.#isCurrentNativeOwner(owner)) return;
        void this.#publishModelUpdate(owner, models).catch(() => {
          // Catalog synchronization is best-effort and cannot disrupt the session.
        });
      }) ?? (() => {});
      await native.initialize();
      if (
        quarantineGeneration !== this.quarantineGeneration
        || this.disposed
        || !this.#isCurrentNativeOwner(owner)
      ) {
        throw new Error('Grok native startup was cancelled.');
      }
      owner.initialized = true;
      return native;
    } catch (error) {
      try {
        await this.#shutdownNativeOwner(owner);
      } catch {
        // Startup cleanup cannot replace the error that initiated quarantine.
      }
      throw error;
    }
  }

  async #ensureSession(
    native: GrokExecutionNativeConnection,
    request: ProviderExecutionRequest | undefined,
    active?: ActiveExecution,
  ): Promise<string> {
    const owner = this.#getNativeOwner(native);
    const sessionConfigurationKey = request
      ? this.#buildSessionConfigurationKey(request)
      : null;
    if (this.providerSessionId) {
      if (owner.loadedSessionId === this.providerSessionId) {
        if (
          request
          && owner.loadedSessionConfigurationKey !== sessionConfigurationKey
        ) {
          await this.#shutdownNative();
          this.#throwIfCancellationRequested(active);
          const replacement = await this.#ensureNative(active);
          return this.#ensureSession(replacement, request, active);
        }
        return this.providerSessionId;
      }
      const targetSessionId = this.providerSessionId;
      return this.#loadProviderSession(
        native,
        targetSessionId,
        request,
        active,
        sessionConfigurationKey,
      );
    }
    const state = parseGrokProviderState(this.providerState);
    if (state.forkSource && !this.forkApplied) {
      if (!native.fork || !state.forkSourceSessionDirectory) {
        throw new Error('Grok fork metadata is incomplete.');
      }
      const targetPromptIndex = await this.options.resolvePromptIndex?.(
        state.forkSourceSessionDirectory,
        state.forkSource.sessionId,
        state.forkSource.resumeAt,
      );
      this.#throwIfCancellationRequested(active);
      if (targetPromptIndex === null || targetPromptIndex === undefined) {
        throw new Error('The Grok fork checkpoint could not be located.');
      }
      const sessionId = await this.#createForkSession(
        native,
        state.forkSource.sessionId,
        {
          newCwd: this.config.vaultWorkingDirectory,
          ...(request?.configuration.model
            ? { newModelId: decodeGrokModelId(request.configuration.model) ?? undefined }
            : {}),
          sourceCwd: resolveGrokSessionCwd(state.forkSourceSessionDirectory)
            ?? this.config.vaultWorkingDirectory,
          sourceSessionId: state.forkSource.sessionId,
          targetPromptIndex,
        },
      );
      this.#throwIfCancellationRequested(active);
      if (this.disposed) throw new GrokExecutionCancellationError();
      return this.#loadProviderSession(
        native,
        sessionId,
        request,
        active,
        sessionConfigurationKey,
      );
    }
    const response = await native.newSession({
      _meta: this.#buildSessionMeta(request),
      cwd: this.config.vaultWorkingDirectory,
      mcpServers: [],
    });
    this.#throwIfCancellationRequested(active);
    this.#captureProviderSession(response.sessionId, null);
    this.#setNativeConversationContextEstablished(false);
    owner.loadedSessionId = response.sessionId;
    owner.loadedSessionConfigurationKey = sessionConfigurationKey;
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    await this.#publishSessionModels(response, owner.modelContextKey);
    this.#throwIfCancellationRequested(active);
    return response.sessionId;
  }

  async #loadProviderSession(
    native: GrokExecutionNativeConnection,
    targetSessionId: string,
    request: ProviderExecutionRequest | undefined,
    active: ActiveExecution | undefined,
    sessionConfigurationKey: string | null,
  ): Promise<string> {
    const owner = this.#getNativeOwner(native);
    const response = await native.loadSession({
      _meta: this.#buildSessionMeta(request),
      cwd: this.config.vaultWorkingDirectory,
      mcpServers: [],
      sessionId: targetSessionId,
    });
    this.#throwIfCancellationRequested(active);
    const loadedSessionId = response.sessionId ?? targetSessionId;
    this.#captureProviderSession(
      loadedSessionId,
      typeof this.providerState.sessionDirectory === 'string'
        ? this.providerState.sessionDirectory
        : undefined,
    );
    owner.loadedSessionId = loadedSessionId;
    owner.loadedSessionConfigurationKey = sessionConfigurationKey;
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    await this.#publishSessionModels(response, owner.modelContextKey);
    this.#throwIfCancellationRequested(active);
    return loadedSessionId;
  }

  #buildSessionMeta(
    request: ProviderExecutionRequest | undefined,
  ): Record<string, unknown> {
    return buildSessionMeta(
      request,
      request?.configuration.systemInstructions.kind === 'provider-default'
        ? buildGrokSystemPrompt(this.#getSystemPromptSettings(), {
            dynamicSections: request.configuration.systemInstructions.dynamicSections,
          })
        : undefined,
    );
  }

  #buildSessionConfigurationKey(request: ProviderExecutionRequest): string {
    const meta = this.#buildSessionMeta(request);
    return JSON.stringify({
      systemPromptOverride: meta.systemPromptOverride ?? null,
      yoloMode: meta.yoloMode === true,
    });
  }

  #getSystemPromptSettings(): GrokSystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath: this.config.vaultWorkingDirectory,
    };
  }

  async #applyConfiguration(
    native: GrokExecutionNativeConnection,
    sessionId: string,
    request: ProviderExecutionRequest,
    active: ActiveExecution,
  ): Promise<void> {
    const rawModel = request.configuration.model
      ? decodeGrokModelId(request.configuration.model)
      : null;
    if (rawModel) {
      // The request can predate model discovery, so validate again after
      // ensureSession has published the live model catalog.
      const reasoningEffort = this.#resolveReasoningEffort(
        rawModel,
        request.configuration.reasoning ?? undefined,
      );
      const response = await native.setModel({
        ...(reasoningEffort
          ? { _meta: { reasoningEffort } }
          : {}),
        modelId: rawModel,
        sessionId,
      });
      this.#throwIfCancellationRequested(active);
      const model = normalizeGrokSetModelMetadata(rawModel, response._meta);
      if (model) {
        await this.#mergeModelMetadataBestEffort(
          [model],
          undefined,
          this.#getNativeOwner(native).modelContextKey,
        );
        this.#throwIfCancellationRequested(active);
      }
    }
    const permissionMode = request.configuration.permissionMode;
    if (permissionMode === 'normal' || permissionMode === 'yolo' || permissionMode === 'plan') {
      await native.setMode({
        modeId: 'default',
        sessionId,
      });
      this.#throwIfCancellationRequested(active);
    }
  }

  #resolveReasoningEffort(
    rawModelId: string,
    requestedReasoning: string | undefined,
  ): string | null {
    const settings = getGrokProviderSettings(this.plugin.settings);
    const model = findGrokModel(settings.currentCatalog?.models ?? [], rawModelId);
    if (model?.reasoningMetadataResolved !== true) return null;
    const advertisedValues = getGrokAvailableReasoningEfforts(model)
      .map(effort => effort.value);
    const requested = requestedReasoning?.trim() ?? '';
    if (!requested) return null;
    if (advertisedValues.includes(requested)) return requested;

    const preferred = settings.preferredReasoningByModel[rawModelId]?.trim() ?? '';
    return advertisedValues.includes(preferred) ? preferred : null;
  }

  private handleNotification(
    notification: ACPSessionNotification,
    source: 'extension' | 'standard',
  ): void {
    const active = this.active;
    if (
      this.disposed
      || !active
      || this.#isCancellationRequested(active)
      || notification.sessionId !== this.providerSessionId
      || !this.mirrorDeduplicator.shouldProcess(notification, source)
    ) return;
    if (isTurnCompleted(notification.update)) {
      if (active.acceptingLiveOutput) {
        active.promptUsage = parseGrokUsage((notification.update as unknown as { usage?: unknown }).usage)
          ?? active.promptUsage;
        active.observedTurnCompletions += 1;
        this.#finishCompletedIfReady(active);
      }
      return;
    }
    let update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'user_message_chunk') {
      const role = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'user';
      const messageId = resolveGrokLiveMessageId(update, role, notification._meta);
      if (messageId) update = { ...update, messageId };
    }
    const result = active.normalizer.normalize(update);
    if (result.metadata?.type === 'commands') {
      this.options.commandCatalog?.setCommandSnapshot([...result.metadata.commands]);
      return;
    }
    if (result.metadata?.type === 'config_options') {
      const owner = this.nativeOwner;
      if (owner) void this.#publishModelsFromConfig(result.metadata.configOptions, owner);
      return;
    }
    // ACP session modes do not describe Grok's Safe/YOLO permissions.
    if (result.metadata?.type === 'current_mode') return;
    if (!active.acceptingLiveOutput) return;
    this.accept(active);
    for (const event of result.events) {
      active.run.emit({
        ...event,
        scope: this.#nextScope(active),
      });
    }
  }

  private accept(active: ActiveExecution, response?: ACPPromptResponse): void {
    if (active.accepted) return;
    active.accepted = true;
    if (!this.nativeConversationContextEstablished) {
      this.#setNativeConversationContextEstablished(true);
      this.#updateSnapshot('executing');
      this.#emitCurrentSnapshot();
    }
    active.run.emit({
      accepted: true,
      ...(response?.userMessageId ? { nativeUserMessageId: response.userMessageId } : {}),
      scope: this.#nextScope(active),
      type: 'turn_started',
    });
  }

  #handleInterjection(notification: { sessionId: string; interjectionId?: string }): void {
    const active = this.active;
    if (!active || this.#isCancellationRequested(active) || notification.sessionId !== this.providerSessionId) return;
    const id = notification.interjectionId
      ?? (active.interjections.size === 1 ? active.interjections.keys().next().value : undefined);
    if (!id) return;
    const pending = active.interjections.get(id);
    if (!pending || pending.applied) return;
    pending.applied = true;
    active.requiredTurnCompletions = Math.max(active.requiredTurnCompletions, active.observedTurnCompletions + 1);
    active.run.emit({ type: 'user_message_started', scope: this.#nextScope(active), content: pending.text });
    if (pending.accepted) active.interjections.delete(id);
    this.#finishCompletedIfReady(active);
  }

  #finishCompletedIfReady(active: ActiveExecution): void {
    if (this.#isCancellationRequested(active)
      || !active.promptResponse
      || active.interjections.size > 0
      || active.observedTurnCompletions < active.requiredTurnCompletions) return;
    const response = active.promptResponse;
    if (active.promptUsage) {
      const model = active.request.configuration.model ?? '';
      const advertisedWindow = findGrokModel(
        getGrokProviderSettings(this.plugin.settings).currentCatalog?.models ?? [], model,
      )?.contextWindow;
      const size = active.contextUsage?.size || advertisedWindow;
      const usage = buildACPUsageInfo({
        model: decodeGrokModelId(model) ?? undefined,
        contextWindow: size ? { size, used: active.promptUsage.totalTokens } : null,
        promptUsage: active.promptUsage,
      });
      if (usage) active.run.emit({ type: 'usage_updated', scope: this.#nextScope(active), usage });
    }
    this.#updateSnapshot('idle');
    this.#emitCurrentSnapshot();
    active.run.finish({
      providerPayload: response,
      reason: mapStopReason(response.stopReason),
      scope: this.#nextScope(active),
      type: 'turn_completed',
    });
    active.normalizer.dispose();
    this.active = null;
  }

  async #cancelRun(run: GrokExecutionRunState, reason: string): Promise<void> {
    const active = this.active;
    if (!active || active.run !== run || run.isTerminal) return;
    if (this.cancellationFlight) return this.cancellationFlight;
    this.cancellationGeneration += 1;
    this.#updateSnapshot('cancelling');
    this.#emitCurrentSnapshot();
    this.quarantineGeneration += 1;
    active.abortController.abort();
    this.interactionController.dismissAll('cancelled');
    this.interactionRouter.dismissAll('cancelled');
    const native = this.nativeOwner?.native ?? null;
    this.cancellationFlight = (async () => {
      await this.#joinForkCreation();
      const sessionId = this.providerSessionId;
      if (native && sessionId) native.cancel(sessionId);
      try {
        await waitForGrokCancelDelivery(
          native?.flush ? { flush: () => native.flush!() } : undefined,
        );
        await this.#shutdownNative();
      } catch {
        // Teardown failure cannot replace the already-requested cancellation terminal.
      } finally {
        if (!this.disposed) {
          this.#updateSnapshot('invalidated', {
            message: 'The cancelled Grok process was quarantined and will be replaced.',
            reason: 'cancelled',
            recoverable: true,
          });
          this.#emitCurrentSnapshot();
        }
        if (!run.isTerminal) {
          run.finish({
            reason,
            scope: this.#nextScope(active),
            type: 'cancelled',
          });
        }
        active.normalizer.dispose();
        if (this.active === active) this.active = null;
      }
    })().finally(() => {
      this.cancellationFlight = null;
    });
    return this.cancellationFlight;
  }

  #isCancellationRequested(active: ActiveExecution): boolean {
    return this.disposed
      || active.cancellationGeneration !== this.cancellationGeneration
      || this.active !== active
      || active.run.isTerminal;
  }

  #throwIfCancellationRequested(active: ActiveExecution | undefined): void {
    if (active && this.#isCancellationRequested(active)) {
      throw new GrokExecutionCancellationError();
    }
  }

  async #shutdownNative(): Promise<void> {
    await this.#joinForkCreation();
    const startupFlight = this.nativeStartupFlight;
    const owner = this.nativeOwner;
    let shutdownError: Error | null = null;
    if (owner) {
      try {
        await this.#shutdownNativeOwner(owner);
      } catch (error) {
        shutdownError = toError(error);
      }
    }
    if (startupFlight) {
      try {
        await startupFlight;
      } catch {
        // The startup caller receives the initiating startup failure.
      }
    }
    const remainingOwner = this.nativeOwner;
    if (remainingOwner) {
      try {
        await this.#shutdownNativeOwner(remainingOwner);
      } catch (error) {
        shutdownError ??= toError(error);
      }
    }
    if (shutdownError) throw shutdownError;
  }

  #createForkSession(
    native: GrokExecutionNativeConnection,
    sourceSessionId: string,
    request: Parameters<NonNullable<GrokExecutionNativeConnection['fork']>>[0],
  ): Promise<string> {
    if (this.forkCreationFlight) return this.forkCreationFlight;
    const fork = native.fork?.bind(native);
    if (!fork) return Promise.reject(new Error('Grok fork metadata is incomplete.'));

    const flight = (async () => {
      const response = await fork(request);
      if (!response.newSessionId.trim()) {
        throw new Error('Grok returned a fork without a child session.');
      }
      this.#adoptForkSession(response.newSessionId);
      if (response.parentSessionId !== sourceSessionId) {
        throw new Error('Grok returned a fork for an unexpected parent session.');
      }
      return response.newSessionId;
    })();
    this.forkCreationFlight = flight;
    flight.then(
      () => {
        if (this.forkCreationFlight === flight) this.forkCreationFlight = null;
      },
      () => {
        if (this.forkCreationFlight === flight) this.forkCreationFlight = null;
      },
    );
    return flight;
  }

  #adoptForkSession(providerSessionId: string): void {
    this.forkApplied = true;
    const remainingProviderState = { ...this.providerState };
    delete remainingProviderState.forkSource;
    delete remainingProviderState.forkSourceSessionDirectory;
    this.providerState = remainingProviderState;
    this.providerStateDeletes.add('forkSource');
    this.providerStateDeletes.add('forkSourceSessionDirectory');
    this.#captureProviderSession(providerSessionId, null);
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
  }

  async #joinForkCreation(): Promise<void> {
    const flight = this.forkCreationFlight;
    if (!flight) return;
    try {
      await flight;
    } catch {
      // A fork without a valid child identity leaves the original seed retryable.
    }
  }

  #shutdownNativeOwner(owner: GrokNativeOwner): Promise<void> {
    if (this.nativeOwner === owner) {
      this.nativeOwner = null;
      try {
        owner.notificationUnsubscribe();
      } catch {
        // Listener cleanup cannot prevent process shutdown.
      }
      try {
        owner.modeUnsubscribe();
        owner.interjectionUnsubscribe();
      } catch {
        // Listener cleanup cannot prevent process shutdown.
      }
      try {
        owner.modelsUnsubscribe();
      } catch {
        // Listener cleanup cannot prevent process shutdown.
      }
    }
    if (!owner.shutdownFlight) {
      owner.shutdownFlight = Promise.resolve().then(() => owner.native.shutdown());
    }
    return owner.shutdownFlight;
  }

  #isCurrentNativeOwner(owner: GrokNativeOwner): boolean {
    return !this.disposed
      && owner.generation === this.nativeGeneration
      && this.nativeOwner === owner;
  }

  #getNativeOwner(
    native: GrokExecutionNativeConnection,
  ): GrokNativeOwner {
    const owner = this.nativeOwner;
    if (!owner || owner.native !== native) {
      throw new Error('Grok native connection ownership changed.');
    }
    return owner;
  }

  async #performRewind(
    assistantMessageId: string | undefined,
    mode: ChatRewindMode,
    force: boolean,
  ): Promise<ChatRewindPreview> {
    const state = parseGrokProviderState(this.providerState);
    if (!this.providerSessionId || !assistantMessageId || !state.sessionDirectory) {
      return { canRewind: false, error: 'Grok rewind metadata is unavailable.' };
    }
    if (!this.options.resolvePromptIndex) {
      return { canRewind: false, error: 'Grok prompt index resolution is unavailable.' };
    }
    const promptIndex = await this.options.resolvePromptIndex(
      state.sessionDirectory,
      this.providerSessionId,
      assistantMessageId,
    );
    if (promptIndex === null) {
      return { canRewind: false, error: 'The Grok prompt could not be located.' };
    }
    const native = await this.#ensureNative();
    await this.#ensureSession(native, undefined);
    if (!native.rewind) return { canRewind: false, error: 'Grok rewind is unavailable.' };
    const response = await native.rewind({
      force,
      mode: mode === 'code-and-conversation' ? 'all' : 'conversation_only',
      sessionId: this.providerSessionId,
      targetPromptIndex: promptIndex,
    });
    return {
      canRewind: response.success,
      ...(response.error ? { error: response.error } : {}),
      conflicts: response.conflicts,
      filesChanged: [...response.cleanFiles, ...response.revertedFiles],
    };
  }

  #captureProviderSession(
    providerSessionId: string,
    persistedSessionDirectory: string | null | undefined,
  ): void {
    this.providerSessionId = providerSessionId;
    const sessionDirectory = resolveGrokSessionDirectory(
      persistedSessionDirectory,
      providerSessionId,
      this.config.vaultWorkingDirectory,
      {
        environment: buildGrokRuntimeEnv(this.plugin.settings, ''),
        hostPlatform: process.platform,
        settings: this.plugin.settings,
        vaultPath: this.config.vaultWorkingDirectory,
      },
    );
    if (sessionDirectory) {
      this.providerState = {
        ...this.providerState,
        sessionDirectory,
      };
    }
  }

  #setNativeConversationContextEstablished(established: boolean): void {
    this.nativeConversationContextEstablished = established;
    this.providerState = {
      ...this.providerState,
      nativeConversationContextEstablished: established,
    };
  }

  async #publishSessionModels(
    response: Pick<
      Awaited<ReturnType<GrokExecutionNativeConnection['newSession']>>,
      '_meta' | 'configOptions' | 'models'
    >,
    sourceContextKey: string,
  ): Promise<void> {
    const { currentModelId, models } = normalizeGrokSessionModelMetadata(response);
    if (models.length > 0) {
      await this.#mergeModelMetadataBestEffort(
        models,
        currentModelId ?? undefined,
        sourceContextKey,
      );
    }
  }

  async #publishModelUpdate(
    owner: GrokNativeOwner,
    state: ACPSessionModelState,
  ): Promise<void> {
    if (!this.#isCurrentNativeOwner(owner)) return;
    const update = normalizeGrokModelUpdateMetadata(state);
    if (!update || !this.#isCurrentNativeOwner(owner)) return;
    await this.#mergeModelMetadataBestEffort(
      update.models,
      update.currentModelId ?? undefined,
      owner.modelContextKey,
    );
  }

  async #publishModelsFromConfig(
    options: readonly ACPSessionConfigOption[],
    owner: GrokNativeOwner,
  ): Promise<void> {
    if (!this.#isCurrentNativeOwner(owner)) return;
    const modelOption = options.find(option => option.id === 'model' && option.type === 'select');
    if (!modelOption || modelOption.type !== 'select') return;
    const flat = modelOption.options.flatMap(option => (
      'options' in option ? option.options : [option]
    ));
    const models = normalizeGrokDiscoveredModels(flat.map(option => ({
      displayName: option.name,
      rawId: option.value,
      reasoningEfforts: [],
      supportsReasoning: false,
    })));
    if (models.length > 0) {
      await this.#mergeModelMetadataBestEffort(
        models,
        modelOption.currentValue,
        owner.modelContextKey,
      );
    }
  }

  async #mergeModelMetadataBestEffort(
    models: GrokDiscoveredModel[],
    defaultModelId: string | undefined,
    sourceContextKey: string,
  ): Promise<void> {
    try {
      await this.options.modelCatalogCoordinator?.mergeLiveModels(
        models,
        defaultModelId,
        sourceContextKey,
      );
    } catch {
      // Catalog synchronization is best-effort and cannot disrupt execution.
    }
  }

  #nextScope(active: ActiveExecution): ProviderRequestedEventScope {
    return {
      executionId: active.run.executionId,
      kind: 'requested',
      sequence: ++active.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: active.run.turnId,
    };
  }

  #updateSnapshot(
    status: ProviderSessionStatus,
    invalidation?: Extract<ProviderSessionSnapshot, { status: 'invalidated' }>['invalidation'],
  ): void {
    this.snapshot = this.#createSnapshot(status, invalidation);
  }

  #createSnapshot(
    status: ProviderSessionStatus,
    invalidation?: Extract<ProviderSessionSnapshot, { status: 'invalidated' }>['invalidation'],
  ): ProviderSessionSnapshot {
    const providerState = this.providerState;
    const base = {
      ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
      ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
      ...(this.providerStateDeletes.size > 0
        ? { providerStateDeletes: [...this.providerStateDeletes] }
        : {}),
      providerId: this.providerId,
      revision: this.revision++,
    };
    return status === 'invalidated'
      ? { ...base, invalidation: invalidation!, status }
      : { ...base, status };
  }

  #emitCurrentSnapshot(): void {
    const active = this.active;
    if (active && !active.run.isTerminal) {
      active.run.emit({
        scope: this.#nextScope(active),
        snapshot: this.snapshot,
        type: 'session_state_changed',
      });
      return;
    }
    const event: ProviderSessionEvent = {
      scope: {
        kind: 'session',
        sequence: this.snapshot.revision,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'session_state_changed',
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Session listeners cannot interfere with native Grok lifecycle.
      }
    }
  }

  #emitPermissionMode(permissionMode: PermissionMode): void {
    const event: ProviderSessionEvent = {
      permissionMode,
      scope: {
        kind: 'session',
        sequence: this.revision,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'permission_mode_changed',
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Session listeners cannot interfere with native Grok lifecycle.
      }
    }
  }
}

class GrokExecutionCancellationError extends Error {
  constructor() {
    super('Grok execution was cancelled.');
    this.name = 'GrokExecutionCancellationError';
  }
}

function createGrokToolStreamAdapter(): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter({
    normalizeToolInput(rawName, input) {
      return normalizeGrokToolCall({ rawInput: input, title: rawName }).input;
    },
    normalizeToolName(rawName) {
      return normalizeGrokToolName(rawName ?? 'tool');
    },
    normalizeToolUseResult(rawName, _input, rawOutput, rawInput) {
      return normalizeGrokToolUseResult(
        rawName ?? 'tool',
        _input,
        rawOutput,
        rawInput,
      );
    },
    resolveRawToolName(currentRawName, update) {
      return resolveGrokRawToolName(currentRawName, update);
    },
  });
}

function buildPromptBlocks(
  request: ProviderExecutionRequest,
  replayConversationHistory = false,
): ACPContentBlock[] {
  const blocks: ACPContentBlock[] = [];
  let text = request.input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
  const context = request.context;
  if (context?.linkedContent) {
    text = appendLinkedContent(text, context.linkedContent.path);
  }
  if (context?.editorSelection && context.editorSelection.mode !== 'none') {
    text = appendEditorContext(text, context.editorSelection);
  }
  if (context?.browserSelection) text = appendBrowserContext(text, context.browserSelection);
  if (context?.canvasSelection) text = appendCanvasContext(text, context.canvasSelection);
  if (replayConversationHistory && request.conversationHistory?.length) {
    const history = [...request.conversationHistory] as ChatMessage[];
    text = buildPromptWithHistoryContext(
      buildContextFromHistory(history),
      text,
      text,
      history,
    );
  }
  if (text) blocks.push({ text, type: 'text' });
  for (const block of request.input) {
    if (block.type === 'image' && block.image.data) {
      blocks.push({
        data: block.image.data,
        mimeType: block.image.mediaType,
        type: 'image',
      });
    }
  }
  return blocks;
}

function buildSessionMeta(
  request: ProviderExecutionRequest | undefined,
  providerDefaultInstructions?: string,
): Record<string, unknown> {
  if (!request) return {};
  const rawModel = request.configuration.model
    ? decodeGrokModelId(request.configuration.model)
    : null;
  const systemPromptOverride = buildGrokSystemPromptOverride(
    request,
    providerDefaultInstructions,
  );
  return {
    ...(rawModel ? { modelId: rawModel } : {}),
    ...(systemPromptOverride ? { systemPromptOverride } : {}),
    yoloMode: request.configuration.permissionMode === 'yolo'
      || request.toolPolicy.kind === 'unrestricted',
  };
}

const GROK_PASSIVE_TOOL_INSTRUCTION = [
  'Do not use any tools for this request.',
  'Answer only from information supplied directly in the prompt.',
].join(' ');

function buildGrokSystemPromptOverride(
  request: ProviderExecutionRequest,
  providerDefaultInstructions?: string,
): string | undefined {
  const instructions = request.configuration.systemInstructions.kind === 'explicit'
    ? request.configuration.systemInstructions.instructions.trim()
    : providerDefaultInstructions?.trim() ?? '';
  if (request.toolPolicy.kind !== 'passive') {
    return instructions || undefined;
  }
  return [instructions, GROK_PASSIVE_TOOL_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');
}

function isTurnCompleted(update: unknown): boolean {
  return Boolean(
    update
    && typeof update === 'object'
    && (
      (update as Record<string, unknown>).sessionUpdate === 'turn_completed'
      || (update as Record<string, unknown>).type === 'turn_completed'
    ),
  );
}

function mapStopReason(reason: string): 'completed' | 'max-tokens' | 'provider-ended' {
  if (reason === 'max_tokens' || reason === 'max-tokens') return 'max-tokens';
  return reason === 'end_turn' || reason === 'completed' ? 'completed' : 'provider-ended';
}

function classifyError(
  error: unknown,
): 'authentication' | 'configuration' | 'provider-session-missing' | 'transport' | 'unknown' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (error instanceof ProviderModelUnavailableError) return 'configuration';
  if (message.includes('auth')) return 'authentication';
  if (message.includes('session') && (message.includes('missing') || message.includes('not found'))) {
    return 'provider-session-missing';
  }
  if (message.includes('config') || message.includes('model')) return 'configuration';
  if (message.includes('transport') || message.includes('closed')) return 'transport';
  return 'unknown';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
