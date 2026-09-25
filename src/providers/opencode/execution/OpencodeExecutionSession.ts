import { randomUUID } from 'node:crypto';

import {
  ExecutionEventQueue,
  type ProviderBackgroundTurnCompletedEvent,
  type ProviderBackgroundTurnStartedEvent,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderRequestedEventScope,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ChatMessage, PermissionMode } from '@/core/types';
import {
  ACPExecutionEventNormalizer,
  type ACPSessionNotification,
  type ACPUsageUpdate,
  buildACPUsageInfo,
  extractACPSessionThoughtLevelState,
} from '@/providers/acp';

import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { loadOpencodeTurnStats } from '../history/OpencodeTurnStats';
import type { OpencodeServerService } from '../http/OpencodeServerService';
import { projectOpencodeMetadata } from '../metadata/OpencodeMetadataProjection';
import { decodeOpencodeModelId } from '../models';
import {
  resolveOpencodeModeForPermissionMode,
  resolvePermissionModeForManagedOpencodeMode,
} from '../modes';
import { createOpencodeToolStreamAdapter } from '../normalization/opencodeToolNormalization';
import { buildOpencodePromptBlocks } from '../runtime/buildOpencodePrompt';
import { assertOpencodeModelAvailable } from '../runtime/OpencodeModelAvailability';
import { getOpencodeProviderSettings } from '../settings';
import { getOpencodeState } from '../types';
import {
  type OpencodeExecutionProfile,
  type OpencodeNativeOutput,
  type OpencodeNativeSessionInfo,
  type OpencodeSessionKernel,
  type OpencodeSessionKernelOptions,
  OpencodeSessionMissingError,
} from './OpencodeSessionContract';
import { DefaultOpencodeSessionKernel } from './OpencodeSessionKernel';

export type OpencodeACPSessionKernelFactory = (
  options: OpencodeSessionKernelOptions,
) => OpencodeSessionKernel;

export interface OpencodeExecutionSessionOptions {
  readonly commandCatalog?: Pick<OpencodeCommandCatalog, 'setCommandSnapshot'>;
  readonly serverService: OpencodeServerService;
  readonly createKernel?: OpencodeACPSessionKernelFactory;
}

class OpencodeExecutionRun implements ProviderExecutionRun {
  readonly executionId = randomUUID();
  readonly turnId = randomUUID();
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  readonly queue: ExecutionEventQueue<ProviderExecutionEvent>;
  terminal = false;
  accepted = false;
  acceptingLiveOutput = false;
  contextUsage: ACPUsageUpdate | null = null;
  cancellationRequested = false;
  lastSequence = 0;
  abortCleanup: (() => void) | null = null;
  nativeCompleted = false;

  constructor(
    readonly sessionInstanceId: string,
    private readonly cancelRun: (run: OpencodeExecutionRun) => void,
  ) {
    this.queue = new ExecutionEventQueue<ProviderExecutionEvent>(() => this.cancel());
    this.events = this.queue;
  }

  cancel(): void {
    if (!this.terminal) this.cancelRun(this);
  }

  scope(sequence = ++this.lastSequence): ProviderRequestedEventScope {
    this.lastSequence = Math.max(this.lastSequence, sequence);
    return {
      executionId: this.executionId,
      kind: 'requested',
      sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: this.turnId,
    };
  }

  emit(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.lastSequence = Math.max(this.lastSequence, event.scope.sequence);
    this.queue.push(event);
  }

  accept(nativeUserMessageId?: string): void {
    if (this.accepted || this.terminal) return;
    this.accepted = true;
    this.emit({
      accepted: true,
      ...(nativeUserMessageId ? { nativeUserMessageId } : {}),
      scope: this.scope(),
      type: 'turn_started',
    });
  }

  finish(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.acceptingLiveOutput = false;
    this.abortCleanup?.();
    this.abortCleanup = null;
    this.queue.push(event);
    this.queue.close();
  }
}

export class OpencodeExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'opencode' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly createKernel: OpencodeACPSessionKernelFactory;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private activeRun: OpencodeExecutionRun | null = null;
  private kernel: OpencodeSessionKernel | null = null;
  private kernelGeneration = 0;
  private kernelConfigurationKey: string | null = null;
  private kernelDisposalPromise: Promise<void> | null = null;
  private nativeInfo: OpencodeNativeSessionInfo | null = null;
  private nativeSessionId: string | null;
  private nativeConversationContextEstablished: boolean;
  private nativeVersion: 1 | 2 | undefined;
  private databasePath: string | null;
  private readonly seedProviderState: Readonly<Record<string, unknown>>;
  private snapshot: ProviderSessionSnapshot;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;
  private sessionEventSequence = 0;
  private readonly backgroundScopes = new Map<string, { id: string; sequence: number; originatingTurnId?: string }>();
  private backgroundTurn: { id: string; sequence: number } | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: OpencodeExecutionSessionOptions,
  ) {
    this.createKernel = options.createKernel
      ?? ((kernelOptions) => new DefaultOpencodeSessionKernel(kernelOptions, options.serverService));
    const providerState = getOpencodeState(config.resumeSeed?.providerState);
    this.nativeSessionId = config.resumeSeed?.providerSessionId ?? providerState.sessionId ?? null;
    this.seedProviderState = Object.freeze({ ...providerState });
    this.databasePath = providerState.databasePath ?? null;
    this.nativeVersion = providerState.nativeVersion;
    this.nativeConversationContextEstablished = typeof providerState
      .nativeConversationContextEstablished === 'boolean'
      ? providerState.nativeConversationContextEstablished
      : this.nativeSessionId !== null;
    this.snapshot = this.#createSnapshot('idle');
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('OpenCode execution session is disposed');
    if (this.activeRun || this.backgroundTurn) {
      throw new Error('OpenCode execution session already has an active run');
    }
    const run = new OpencodeExecutionRun(
      this.sessionInstanceId,
      (active) => this.#cancelRun(active),
    );
    this.activeRun = run;
    const onAbort = () => run.cancel();
    request.signal.addEventListener('abort', onAbort, { once: true });
    run.abortCleanup = () => request.signal.removeEventListener('abort', onAbort);
    if (request.signal.aborted) run.cancel();
    if (!run.terminal) {
      void this.#startRun(run, request);
    }
    return run;
  }

  cancel(): void {
    if (this.activeRun && !this.activeRun.terminal) {
      this.activeRun.cancel();
      return;
    }
    if (this.disposed || (!this.backgroundTurn && this.backgroundScopes.size === 0)) return;
    this.lifecycleGeneration += 1;
    this.#interruptKernel();
    this.snapshot = this.#createInvalidatedSnapshot('cancelled', true, new Error('Cancelled'));
    this.#emitSessionSnapshot();
    void this.#disposeKernel();
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
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    const run = this.activeRun;
    if (run && !run.terminal) {
      run.cancellationRequested = true;
      run.acceptingLiveOutput = false;
      run.finish(run.nativeCompleted
        ? { reason: 'completed', scope: run.scope(), type: 'turn_completed' }
        : { reason: 'session-disposed', scope: run.scope(), type: 'cancelled' });
    }
    this.activeRun = null;
    this.backgroundTurn = null;
    this.listeners.clear();
    this.snapshot = this.#createSnapshot('disposed');
    this.disposePromise = this.#disposeKernel();
    return this.disposePromise;
  }

  async #startRun(
    run: OpencodeExecutionRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    let phase: 'connect' | 'open' | 'run' = 'connect';
    let resumeAttempt: string | null = null;
    try {
      assertOpencodeModelAvailable(this.plugin.settings, request.configuration.model);
      const pendingDisposal = this.kernelDisposalPromise;
      if (pendingDisposal) {
        await pendingDisposal;
        if (!this.#isRunCurrent(run, generation)) return;
      }
      const kernelConfigurationKey = buildKernelConfigurationKey(request);
      let kernel = this.kernel;
      let native = this.nativeInfo;
      if (
        kernel
        && native
        && this.kernelConfigurationKey !== kernelConfigurationKey
      ) {
        await this.#disposeKernel();
        if (!this.#isRunCurrent(run, generation)) return;
        kernel = null;
        native = null;
      }
      if (!kernel || !native) {
        const kernelGeneration = ++this.kernelGeneration;
        kernel = this.createKernel({
          config: this.config,
          databasePath: this.#resolveDatabasePath(),
          nativeVersion: this.nativeVersion,
          getActiveTurnId: () => this.activeRun?.turnId ?? this.backgroundTurn?.id ?? null,
          openNativeInteraction: () => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            const key = randomUUID();
            const turn = this.#openBackgroundScope(key);
            return { turnId: turn.id, close: () => this.#closeBackgroundScope(key, 'completed') };
          },
          onNativeTaskStarted: (sessionId, originatingTurnId) => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            return this.#openBackgroundScope(sessionId, originatingTurnId).id;
          },
          onNativeTaskCompleted: (event) => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            this.#emitSessionEvent({ ...event, scope: {
              kind: 'session', sequence: ++this.sessionEventSequence, sessionInstanceId: this.sessionInstanceId,
            } });
            this.#closeBackgroundScope(event.subagentId, event.status === 'completed' ? 'completed' : 'provider-ended');
          },
          onNativeTurn: (status, error, requested) => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            if (status === 'started' && !requested) {
              this.snapshot = this.#createSnapshot('executing');
              this.#emitSessionSnapshot();
              this.backgroundTurn = { id: randomUUID(), sequence: 0 };
              this.#emitBackground({ type: 'background_turn_started', providerSessionId: this.nativeSessionId ?? undefined });
            } else if (status === 'completed' && !requested && this.backgroundTurn) {
              if (error) this.#emitBackground({ type: 'notice', level: 'warning', message: error });
              this.#emitBackground({ type: 'background_turn_completed', reason: 'completed', providerSessionId: this.nativeSessionId ?? undefined });
              this.backgroundTurn = null;
              this.snapshot = this.#createSnapshot(this.backgroundScopes.size ? 'executing' : 'idle');
              this.#emitSessionSnapshot();
            }
          },
          onNativeOutput: (event, childSessionId) => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            const active = this.activeRun;
            const child = childSessionId ? this.backgroundScopes.get(childSessionId) : undefined;
            if (child && (active?.turnId !== child.originatingTurnId || !active?.acceptingLiveOutput || active.terminal)) {
              this.#emitBackground(event, child);
            } else if (this.backgroundTurn) {
              this.#emitBackground(event);
            } else if (active?.acceptingLiveOutput && !active.terminal) {
              this.#markNativeConversationContextEstablished(active);
              active.accept();
              active.emit({ ...event, scope: active.scope() });
            }
          },
          onClosed: (error) => {
            this.#handleKernelClosed(kernelGeneration, error);
          },
          onNotification: (notification) => {
            const active = this.activeRun;
            if (
              active
              && kernelGeneration === this.kernelGeneration
            ) {
              void this.handleNotification(
                this.lifecycleGeneration,
                active,
                notification,
              );
            }
          },
          plugin: this.plugin,
          sessionInstanceId: this.sessionInstanceId,
        });
        this.kernel = kernel;
        await kernel.connect({
          profile: resolveProfile(request),
          systemInstructions: request.configuration.systemInstructions,
        });
        if (this.kernel === kernel) {
          this.kernelConfigurationKey = kernelConfigurationKey;
        }
        if (!this.#isRunCurrent(run, generation)) return;
        phase = 'open';
        resumeAttempt = this.nativeSessionId;
        native = await kernel.openSession(resumeAttempt ?? undefined);
        this.#captureNativeSessionOwnership(native, run);
        if (!this.#isRunCurrent(run, generation)) return;
        phase = 'run';
        this.nativeInfo = native;
        await projectOpencodeMetadata(this.plugin, native);
      } else {
        this.snapshot = this.#createSnapshot('executing');
        phase = 'run';
      }
      assertOpencodeModelAvailable(this.plugin.settings, request.configuration.model);
      await this.#applyConfiguration(kernel, native, request);
      if (!this.#isRunCurrent(run, generation)) return;

      assertOpencodeModelAvailable(this.plugin.settings, request.configuration.model);
      this.#getRunNormalizer(run).reset();
      run.acceptingLiveOutput = true;
      const promptStartedAt = Date.now();
      const response = await kernel.prompt({
        prompt: buildPromptBlocks(
          request,
          !this.nativeConversationContextEstablished,
        ),
        sessionId: native.sessionId,
      });
      this.#markNativeConversationContextEstablished(run);
      if (!this.#isRunCurrent(run, generation)) return;
      run.nativeCompleted = response.stopReason !== 'cancelled';
      run.accept(response.userMessageId ?? undefined);
      if (response.usage) {
        const usage = buildACPUsageInfo({
          contextWindow: run.contextUsage,
          model: this.#resolveSelectedRawModelId(request.configuration.model) ?? undefined,
          promptUsage: response.usage,
        });
        if (usage) run.emit({ type: 'usage_updated', scope: run.scope(), usage });
      }
      const turnStats = response.stopReason !== 'cancelled' && native.databasePath
        ? await loadOpencodeTurnStats(native.sessionId, {
          databasePath: native.databasePath, ...(native.nativeVersion ? { nativeVersion: native.nativeVersion } : {}),
        }, { userMessageId: response.userMessageId, startedAt: promptStartedAt }).catch(() => undefined)
        : undefined;
      if (!this.#isRunCurrent(run, generation)) return;
      this.snapshot = this.#createSnapshot(this.backgroundTurn || this.backgroundScopes.size ? 'executing' : 'idle');
      run.emit({
        scope: run.scope(),
        snapshot: this.snapshot,
        type: 'session_state_changed',
      });
      run.finish(response.stopReason === 'cancelled'
        ? { reason: 'provider-cancelled', scope: run.scope(), type: 'cancelled' }
        : { reason: 'completed', scope: run.scope(), type: 'turn_completed', ...(turnStats ? { turnStats } : {}) });
      this.activeRun = null;
    } catch (error) {
      if (!this.#isRunCurrent(run, generation)) return;
      const missing = phase === 'open'
        && resumeAttempt !== null
        && error instanceof OpencodeSessionMissingError
        && error.sessionId === resumeAttempt;
      this.snapshot = this.#createInvalidatedSnapshot(
        missing ? 'provider-session-missing' : 'provider-error',
        true,
        error,
      );
      this.#emitRunSnapshot(run);
      run.finish({
        category: error instanceof ProviderModelUnavailableError ? 'configuration' : missing ? 'provider-session-missing' : 'provider',
        message: formatError(error),
        ...(missing && resumeAttempt
          ? { missingProviderSessionId: resumeAttempt }
          : {}),
        recoverable: true,
        scope: run.scope(),
        type: 'execution_error',
      });
      this.activeRun = null;
      await this.#disposeKernel();
    }
  }

  #openBackgroundScope(key: string, originatingTurnId?: string): { id: string; sequence: number } {
    const turn = { id: randomUUID(), sequence: 0, originatingTurnId };
    this.backgroundScopes.set(key, turn);
    this.snapshot = this.#createSnapshot('executing');
    this.#emitSessionSnapshot();
    this.#emitBackground({ type: 'background_turn_started', providerSessionId: this.nativeSessionId ?? undefined }, turn);
    return turn;
  }

  #closeBackgroundScope(key: string, reason: 'completed' | 'provider-ended'): void {
    const turn = this.backgroundScopes.get(key);
    if (!turn) return;
    this.#emitBackground({ type: 'background_turn_completed', reason }, turn);
    this.backgroundScopes.delete(key);
    if (!this.activeRun && !this.backgroundTurn && this.backgroundScopes.size === 0) {
      this.snapshot = this.#createSnapshot('idle');
      this.#emitSessionSnapshot();
    }
  }

  #emitBackground(event: Omit<ProviderBackgroundTurnStartedEvent, 'scope'>
    | Omit<ProviderBackgroundTurnCompletedEvent, 'scope'>
    | OpencodeNativeOutput, turn = this.backgroundTurn): void {
    if (!turn) return;
    const scoped: ProviderSessionEvent = { ...event, scope: {
      kind: 'background', sessionInstanceId: this.sessionInstanceId,
      turnId: turn.id, sequence: ++turn.sequence,
    } };
    this.#emitSessionEvent(scoped);
  }

  private async handleNotification(
    generation: number,
    run: OpencodeExecutionRun,
    notification: ACPSessionNotification,
  ): Promise<void> {
    if (
      !this.#isRunCurrent(run, generation)
      || notification.sessionId !== this.nativeSessionId
    ) {
      return;
    }
    const acceptingLiveOutput = run.acceptingLiveOutput;
    const normalizer = this.#getRunNormalizer(run);
    let result;
    try {
      result = normalizer.normalize(notification.update);
    } catch {
      return;
    }
    if (result.metadata?.type === 'commands') {
      const commands = result.metadata.commands.map((command) => ({
        ...command,
      }));
      this.options.commandCatalog?.setCommandSnapshot(commands);
    }
    if (
      result.metadata?.type === 'config_options'
      || result.metadata?.type === 'current_mode'
    ) {
      if (
        result.metadata.type === 'config_options'
        && this.nativeInfo
      ) {
        this.nativeInfo = {
          ...this.nativeInfo,
          configOptions: result.metadata.configOptions,
        };
      }
      await projectOpencodeMetadata(this.plugin, {
        ...(result.metadata.type === 'config_options'
          ? { configOptions: result.metadata.configOptions }
          : {}),
      });
    }
    if (result.metadata?.type === 'current_mode') {
      const mode = resolvePermissionModeForManagedOpencodeMode(
        result.metadata.currentModeId,
      );
      if (mode) this.#emitPermissionMode(mode);
    }
    if (
      acceptingLiveOutput
      && result.events.length > 0
      && this.#isRunCurrent(run, generation)
    ) {
      this.#markNativeConversationContextEstablished(run);
      run.accept();
      for (const event of result.events) {
        run.emit({
          ...event,
          scope: run.scope(),
        });
      }
    }
  }

  private readonly runNormalizers = new WeakMap<
    OpencodeExecutionRun,
    ACPExecutionEventNormalizer
  >();

  #getRunNormalizer(
    run: OpencodeExecutionRun,
  ): ACPExecutionEventNormalizer {
    let normalizer = this.runNormalizers.get(run);
    if (!normalizer) {
      normalizer = new ACPExecutionEventNormalizer({
        mapUsage: (usage) => {
          if (run.acceptingLiveOutput) run.contextUsage = usage;
          return buildACPUsageInfo({
            contextWindow: usage,
            model: this.#resolveSelectedRawModelId(undefined) ?? undefined,
          });
        },
        scope: {
          executionId: run.executionId,
          kind: 'requested',
          sessionInstanceId: this.sessionInstanceId,
          turnId: run.turnId,
        },
        toolStreamAdapter: createOpencodeToolStreamAdapter(),
      });
      this.runNormalizers.set(run, normalizer);
    }
    return normalizer;
  }

  async #applyConfiguration(
    kernel: OpencodeSessionKernel,
    native: OpencodeNativeSessionInfo,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const selectedModel = this.#resolveSelectedRawModelId(
      request.configuration.model,
    );
    let configOptions = native.configOptions ?? [];
    if (selectedModel) {
      const response = await kernel.setConfigOption({
        configId: 'model',
        sessionId: native.sessionId,
        type: 'select',
        value: selectedModel,
      });
      configOptions = response.configOptions ?? configOptions;
      if (response.configOptions && this.nativeInfo === native) {
        this.nativeInfo = {
          ...native,
          configOptions: response.configOptions,
        };
      }
      await projectOpencodeMetadata(this.plugin, {
        configOptions,
        selectedRawModelId: selectedModel,
      });
    }

    const thoughtState = extractACPSessionThoughtLevelState({ configOptions });
    if (request.configuration.reasoning) {
      if (!thoughtState.configId || !thoughtState.availableLevels.some(({ id }) => id === request.configuration.reasoning)) {
        throw new Error(`OpenCode model "${selectedModel}" does not support thinking level "${request.configuration.reasoning}".`);
      }
      await kernel.setConfigOption({
        configId: thoughtState.configId,
        sessionId: native.sessionId,
        type: 'select',
        value: request.configuration.reasoning,
      });
    }

    const profile = resolveProfile(request);
    const mode = profile === 'passive'
      ? 'claudian-title'
      : profile === 'readonly'
        ? 'claudian-inline-edit'
        : resolveOpencodeModeForPermissionMode(
            request.configuration.permissionMode,
            getOpencodeProviderSettings(this.plugin.settings).availableModes,
          );
    if (mode) {
      await kernel.setConfigOption({
        configId: 'mode',
        sessionId: native.sessionId,
        type: 'select',
        value: mode,
      });
    }
  }

  #resolveSelectedRawModelId(explicit?: string): string | null {
    const selection = explicit
      ?? (typeof this.plugin.settings.model === 'string'
        ? this.plugin.settings.model
        : '');
    return decodeOpencodeModelId(selection) ?? (selection || null);
  }

  #interruptKernel(): void {
    if (this.nativeSessionId) {
      try {
        this.kernel?.cancel(this.nativeSessionId);
      } catch {
        // Disposal below remains authoritative when native cancellation fails.
      }
    }
  }

  #cancelRun(run: OpencodeExecutionRun): void {
    if (!this.#isRunCurrent(run, this.lifecycleGeneration) || run.nativeCompleted) return;
    run.cancellationRequested = true;
    run.acceptingLiveOutput = false;
    const generation = ++this.lifecycleGeneration;
    this.#interruptKernel();
    this.snapshot = this.#createInvalidatedSnapshot(
      'cancelled',
      true,
      new Error('Cancelled'),
    );
    this.#emitRunSnapshot(run);
    void this.#disposeKernel().finally(() => {
      if (this.disposed || generation !== this.lifecycleGeneration) return;
      run.finish({
        reason: 'cancelled',
        scope: run.scope(),
        type: 'cancelled',
      });
      this.activeRun = null;
    });
  }

  #handleKernelClosed(
    kernelGeneration: number,
    error: Error,
  ): void {
    if (kernelGeneration !== this.kernelGeneration) return;
    const run = this.activeRun;
    if (!run || run.terminal || this.disposed) {
      if (!this.disposed) {
        this.snapshot = this.#createInvalidatedSnapshot(
          'process-exited',
          true,
          error,
        );
        this.#emitSessionSnapshot();
        this.#emitSessionError(error);
      }
      this.nativeInfo = null;
      void this.#disposeKernel();
      return;
    }
    this.lifecycleGeneration += 1;
    this.snapshot = this.#createInvalidatedSnapshot(
      'process-exited',
      true,
      error,
    );
    this.#emitRunSnapshot(run);
    run.finish({
      category: 'process-exited',
      message: formatError(error),
      recoverable: true,
      scope: run.scope(),
      type: 'execution_error',
    });
    this.activeRun = null;
    this.nativeInfo = null;
    void this.#disposeKernel();
  }

  #captureNativeSessionOwnership(
    native: OpencodeNativeSessionInfo,
    run: OpencodeExecutionRun,
  ): void {
    if (this.disposed) return;
    this.nativeSessionId = native.sessionId;
    this.databasePath = native.databasePath;
    this.nativeVersion = native.nativeVersion ?? this.nativeVersion;
    this.#publishNativeOwnershipSnapshot(run);
  }

  #markNativeConversationContextEstablished(
    run: OpencodeExecutionRun,
  ): void {
    if (this.disposed || this.nativeConversationContextEstablished) return;
    this.nativeConversationContextEstablished = true;
    this.#publishNativeOwnershipSnapshot(run);
  }

  #publishNativeOwnershipSnapshot(run: OpencodeExecutionRun): void {
    const currentSnapshot = this.snapshot;
    const isCurrentExecution = (
      this.activeRun === run
      && !run.terminal
      && !run.cancellationRequested
      && !this.disposed
      && currentSnapshot.status !== 'invalidated'
      && currentSnapshot.status !== 'disposed'
    );
    this.snapshot = this.#refreshSnapshot(
      isCurrentExecution ? 'executing' : currentSnapshot.status,
      currentSnapshot.invalidation,
    );
    if (isCurrentExecution) {
      this.#emitRunSnapshot(run);
    } else {
      this.#emitSessionSnapshot();
    }
  }

  #resolveDatabasePath(): string | undefined {
    if (
      this.config.nativePersistence === 'disabled-if-supported'
      || (
        this.config.nativePersistence === 'provider-default'
        && this.config.lifecycle === 'ephemeral'
      )
    ) {
      return ':memory:';
    }
    return this.databasePath ?? undefined;
  }

  #isRunCurrent(
    run: OpencodeExecutionRun,
    generation: number,
  ): boolean {
    return (
      !this.disposed
      && this.activeRun === run
      && !run.terminal
      && generation === this.lifecycleGeneration
    );
  }

  async #disposeKernel(): Promise<void> {
    if (this.kernelDisposalPromise) return this.kernelDisposalPromise;
    for (const turn of this.backgroundScopes.values()) {
      this.#emitBackground({ type: 'background_turn_completed', reason: 'provider-ended' }, turn);
    }
    this.backgroundScopes.clear();
    if (this.backgroundTurn) {
      this.#emitBackground({ type: 'background_turn_completed', reason: 'provider-ended' });
      this.backgroundTurn = null;
    }
    const kernel = this.kernel;
    this.kernel = null;
    this.nativeInfo = null;
    this.kernelConfigurationKey = null;
    this.kernelGeneration += 1;
    if (!kernel) return;

    const pending = (async () => {
      try {
        await kernel.dispose();
      } catch {
        // Kernel disposal already owns best-effort cleanup for every resource.
      }
    })();
    this.kernelDisposalPromise = pending;
    void pending.then(() => {
      if (this.kernelDisposalPromise === pending) {
        this.kernelDisposalPromise = null;
      }
    });
    await pending;
  }

  #emitPermissionMode(permissionMode: PermissionMode): void {
    const event: ProviderSessionEvent = {
      permissionMode,
      scope: {
        kind: 'session',
        sequence: ++this.sessionEventSequence,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'permission_mode_changed',
    };
    this.#emitSessionEvent(event);
  }

  #emitRunSnapshot(run: OpencodeExecutionRun): void {
    run.emit({
      scope: run.scope(),
      snapshot: this.snapshot,
      type: 'session_state_changed',
    });
  }

  #emitSessionSnapshot(): void {
    this.#emitSessionEvent({
      scope: {
        kind: 'session',
        sequence: ++this.sessionEventSequence,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'session_state_changed',
    });
  }

  #emitSessionError(error: Error): void {
    const event: ProviderSessionEvent = {
      category: 'process-exited',
      message: error.message,
      recoverable: true,
      scope: {
        kind: 'session',
        sequence: ++this.sessionEventSequence,
        sessionInstanceId: this.sessionInstanceId,
      },
      type: 'session_error',
    };
    this.#emitSessionEvent(event);
  }

  #emitSessionEvent(event: ProviderSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Session lifecycle must not depend on feature listener behavior.
      }
    }
  }

  #createSnapshot(
    status: Exclude<ProviderSessionStatus, 'invalidated'>,
  ): ProviderSessionSnapshot {
    return this.#refreshSnapshot(status);
  }

  #createInvalidatedSnapshot(
    reason: 'cancelled' | 'process-exited' | 'provider-error' | 'provider-session-missing',
    recoverable: boolean,
    error: unknown,
  ): ProviderSessionSnapshot {
    const message = formatError(error);
    return this.#refreshSnapshot('invalidated', {
      message,
      reason,
      recoverable,
    });
  }

  #refreshSnapshot(
    status: ProviderSessionStatus,
    invalidation?: ProviderSessionSnapshot['invalidation'],
  ): ProviderSessionSnapshot {
    const previousRevision = this.snapshot?.revision ?? -1;
    const providerState = {
      ...this.seedProviderState,
      ...(this.nativeVersion ? { nativeVersion: this.nativeVersion } : {}),
      ...(this.databasePath ? { databasePath: this.databasePath } : {}),
      ...(
        this.nativeSessionId
        || typeof this.seedProviderState.nativeConversationContextEstablished
          === 'boolean'
          ? {
              nativeConversationContextEstablished:
                this.nativeConversationContextEstablished,
            }
          : {}
      ),
    };
    const base = {
      ...(this.nativeSessionId ? { providerSessionId: this.nativeSessionId } : {}),
      ...(Object.keys(providerState).length > 0
        ? { providerState: Object.freeze(providerState) }
        : {}),
      providerId: this.providerId,
      revision: previousRevision + 1,
    } as const;
    if (status === 'invalidated') {
      if (!invalidation) {
        throw new Error('Invalidated OpenCode snapshots require a reason.');
      }
      return Object.freeze({
        ...base,
        invalidation: Object.freeze({ ...invalidation }),
        status,
      });
    }
    return Object.freeze({ ...base, status });
  }
}

function resolveProfile(request: ProviderExecutionRequest): OpencodeExecutionProfile {
  if (
    request.toolPolicy.kind === 'passive'
    || request.toolPolicy.kind === 'allow-list'
  ) return 'passive';
  if (request.toolPolicy.kind === 'read-only') return 'readonly';
  return 'managed';
}

function buildKernelConfigurationKey(
  request: ProviderExecutionRequest,
): string {
  const instructions = request.configuration.systemInstructions;
  return JSON.stringify([
    resolveProfile(request),
    instructions.kind,
    instructions.kind === 'explicit'
      ? instructions.instructions
      : instructions.dynamicSections ?? null,
  ]);
}

function buildPromptBlocks(
  request: ProviderExecutionRequest,
  bootstrapHistory: boolean,
) {
  const text = request.input
    .filter((block): block is Extract<typeof block, { type: 'text' }> => (
      block.type === 'text'
    ))
    .map(({ text: value }) => value)
    .join('\n');
  const images = request.input
    .filter((block): block is Extract<typeof block, { type: 'image' }> => (
      block.type === 'image'
    ))
    .map(({ image }) => image);
  return buildOpencodePromptBlocks({
    browserSelection: request.context?.browserSelection,
    canvasSelection: request.context?.canvasSelection,
    editorSelection: request.context?.editorSelection,
    images,
    linkedContent: request.context?.linkedContent,
    text,
  }, bootstrapHistory
    ? [...(request.conversationHistory ?? [])] as ChatMessage[]
    : []);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
