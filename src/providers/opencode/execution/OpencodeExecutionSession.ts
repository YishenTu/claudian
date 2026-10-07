import { randomUUID } from 'node:crypto';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import {
  type ProviderBackgroundTurnCompletedEvent,
  type ProviderBackgroundTurnStartedEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionInvalidationReason,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  RequestedRunChannel,
  SessionSnapshotState,
  type SteerableExecutionSession,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ChatMessage } from '@/core/types';
import {
  ACPRequestedTurn,
  type ACPSessionNotification,
  buildACPUsageInfo,
  extractACPSessionThoughtLevelState,
} from '@/providers/acp';

import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { loadOpencodeTurnStats } from '../history/OpencodeTurnStats';
import type { OpencodeServerService } from '../http/OpencodeServerService';
import { projectOpencodeMetadata } from '../metadata/OpencodeMetadataProjection';
import { decodeOpencodeModelId } from '../models';
import { createOpencodeToolStreamAdapter } from '../normalization/opencodeToolNormalization';
import { buildOpencodePrompt } from '../runtime/buildOpencodePrompt';
import { AUX_AGENT_IDS, OPENCODE_BUILD_AGENT_ID } from '../runtime/OpencodeExecutionAgents';
import { assertOpencodeModelAvailable } from '../runtime/OpencodeModelAvailability';
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
import { OpencodeSessionPersistence } from './OpencodeSessionPersistence';

export type OpencodeACPSessionKernelFactory = (
  options: OpencodeSessionKernelOptions,
) => OpencodeSessionKernel;

export interface OpencodeExecutionSessionOptions {
  readonly commandCatalog?: Pick<OpencodeCommandCatalog, 'setCommandSnapshot'>;
  readonly serverService: OpencodeServerService;
  readonly createKernel?: OpencodeACPSessionKernelFactory;
}

/** One requested run: the neutral stream plus the ACP-shaped turn both kernels feed. */
interface OpencodeActiveRun {
  readonly run: RequestedRunChannel;
  readonly turn: ACPRequestedTurn;
  cancellationRequested: boolean;
  nativeCompleted: boolean;
  /** Whether this run started or configured native work that cancellation must stop. */
  ownsNativeWork: boolean;
}

export class OpencodeExecutionSession implements ProviderExecutionSession, SteerableExecutionSession {
  readonly providerId = 'opencode' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly persistence: OpencodeSessionPersistence;
  private readonly createKernel: OpencodeACPSessionKernelFactory;
  private activeRun: OpencodeActiveRun | null = null;
  private kernel: OpencodeSessionKernel | null = null;
  private kernelGeneration = 0;
  private kernelRetired = false;
  private kernelMetadataController = new AbortController();

  get usesSharedRuntime(): boolean { return this.kernel?.usesSharedRuntime ?? this.nativeVersion === 2; }
  private kernelConfigurationKey: string | null = null;
  private kernelDisposalPromise: Promise<void> | null = null;
  private nativeInfo: OpencodeNativeSessionInfo | null = null;
  private nativeSessionId: string | null;
  private nativeConversationContextEstablished: boolean;
  private nativeVersion: 1 | 2 | undefined;
  private databasePath: string | null;
  private readonly seedProviderState: Readonly<Record<string, unknown>>;
  private readonly state: SessionSnapshotState;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;
  private readonly backgroundScopes = new Map<string, { id: string; sequence: number; originatingTurnId?: string }>();
  private backgroundTurn: { id: string; sequence: number } | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: OpencodeExecutionSessionOptions,
  ) {
    this.persistence = new OpencodeSessionPersistence(config);
    this.createKernel = options.createKernel
      ?? ((kernelOptions) => new DefaultOpencodeSessionKernel(kernelOptions, options.serverService, this.persistence));
    const providerState = getOpencodeState(config.resumeSeed?.providerState);
    this.nativeSessionId = config.resumeSeed?.providerSessionId ?? providerState.sessionId ?? null;
    this.seedProviderState = Object.freeze({ ...providerState });
    this.databasePath = providerState.databasePath ?? null;
    this.nativeVersion = providerState.nativeVersion;
    this.nativeConversationContextEstablished = typeof providerState
      .nativeConversationContextEstablished === 'boolean'
      ? providerState.nativeConversationContextEstablished
      : this.nativeSessionId !== null;
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      providerState: this.seedProviderState,
      readProviderSessionId: () => this.nativeSessionId,
      projectProviderState: state => ({
        ...state,
        ...(this.nativeVersion ? { nativeVersion: this.nativeVersion } : {}),
        ...(this.databasePath ? { databasePath: this.databasePath } : {}),
        ...(
          this.nativeSessionId
          || typeof state.nativeConversationContextEstablished === 'boolean'
            ? {
                nativeConversationContextEstablished:
                  this.nativeConversationContextEstablished,
              }
            : {}
        ),
      }),
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('OpenCode execution session is disposed');
    if (this.activeRun || this.backgroundTurn) {
      throw new Error('OpenCode execution session already has an active run');
    }
    const run = new RequestedRunChannel({
      onCancel: () => this.#cancelRun(active),
      sessionInstanceId: this.sessionInstanceId,
    });
    const active: OpencodeActiveRun = {
      cancellationRequested: false,
      nativeCompleted: false,
      ownsNativeWork: false,
      run,
      turn: new ACPRequestedTurn({
        onAccept: () => this.#markNativeConversationContextEstablished(active),
        resolveUsageModel: () => this.#resolveSelectedRawModelId(undefined) ?? undefined,
        run,
        toolStreamAdapter: createOpencodeToolStreamAdapter(),
      }),
    };
    this.activeRun = active;
    run.attachAbortSignal(request.signal);
    if (!active.cancellationRequested) {
      void this.#startRun(active, request);
    }
    return run;
  }

  cancel(): void {
    if (this.activeRun && !this.activeRun.run.isTerminal) {
      this.activeRun.run.cancel();
      return;
    }
    if (this.disposed || (!this.backgroundTurn && this.backgroundScopes.size === 0)) return;
    this.lifecycleGeneration += 1;
    this.#interruptKernel();
    this.#invalidate('cancelled', true, new Error('Cancelled'));
    this.#emitSessionSnapshot();
    void this.#disposeKernel();
  }

  /** Only kernels whose native protocol can steer accept; V1 ACP declines. */
  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    try {
      assertOpencodeModelAvailable(this.plugin.settings, request.configuration.model);
    } catch (error) {
      if (error instanceof ProviderModelUnavailableError) return false;
      throw error;
    }
    const active = this.activeRun;
    const kernel = this.kernel;
    const native = this.nativeInfo;
    if (
      !active
      || active.run.isTerminal
      || active.cancellationRequested
      || !active.turn.acceptingLiveOutput
      || !kernel?.steer
      || !native
      || request.signal.aborted
    ) return false;
    const prompt = buildPrompt(request, false);
    return kernel.steer({
      prompt: prompt.blocks,
      sessionId: native.sessionId,
    }, prompt.userText);
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    return this.state.onEvent(listener);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    const active = this.activeRun;
    if (active && !active.run.isTerminal) {
      active.cancellationRequested = true;
      active.turn.endLiveOutput();
      active.run.finish(active.nativeCompleted
        ? { reason: 'completed', type: 'turn_completed' }
        : { reason: 'session-disposed', type: 'cancelled' });
    }
    this.activeRun = null;
    this.backgroundTurn = null;
    this.state.clearListeners();
    this.state.setStatus('disposed');
    this.disposePromise = this.#disposeKernel().finally(() => this.persistence.dispose());
    return this.disposePromise;
  }

  async #startRun(
    active: OpencodeActiveRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const { run, turn } = active;
    const generation = ++this.lifecycleGeneration;
    let phase: 'connect' | 'open' | 'run' = 'connect';
    let resumeAttempt: string | null = null;
    try {
      if (this.usesSharedRuntime) {
        await this.options.serverService.waitUntilAvailable(request.signal);
        if (!this.#isRunCurrent(active, generation)) return;
      }
      assertOpencodeModelAvailable(this.plugin.settings, request.configuration.model);
      const pendingDisposal = this.kernelDisposalPromise;
      if (pendingDisposal) {
        await pendingDisposal;
        if (!this.#isRunCurrent(active, generation)) return;
      }
      const kernelConfigurationKey = buildKernelConfigurationKey(request);
      let kernel = this.kernel;
      let native = this.nativeInfo;
      if (
        kernel
        && native
        && (this.kernelRetired || this.kernelConfigurationKey !== kernelConfigurationKey)
      ) {
        // A new turn cannot reuse a retired generation or interrupt its descendants.
        if (this.kernelRetired) {
          await kernel.whenIdle?.();
          if (!this.#isRunCurrent(active, generation)) return;
        }
        await this.#disposeKernel();
        if (!this.#isRunCurrent(active, generation)) return;
        kernel = null;
        native = null;
      }
      if (!kernel || !native) {
        active.ownsNativeWork = true;
        const kernelGeneration = ++this.kernelGeneration;
        this.kernelMetadataController = new AbortController();
        kernel = this.createKernel({
          onNativeWorkChanged: () => {
            if (kernelGeneration === this.kernelGeneration && !this.disposed) this.#releaseRetiredKernel();
          },
          onSuperseded: () => {
            if (kernelGeneration === this.kernelGeneration && !this.disposed) this.kernelMetadataController.abort();
          },
          onRetired: () => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            this.kernelRetired = true;
            this.kernelMetadataController.abort();
            this.#releaseRetiredKernel();
          },
          config: this.config,
          databasePath: this.databasePath ?? undefined,
          forkSource: getOpencodeState(this.seedProviderState).forkSource,
          nativeVersion: this.nativeVersion,
          getActiveTurnId: () => this.activeRun?.run.turnId ?? this.backgroundTurn?.id ?? null,
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
            this.state.emit(event);
            this.#closeBackgroundScope(event.subagentId, event.status === 'completed' ? 'completed' : 'provider-ended');
          },
          onNativeSubagentProgress: (progress) => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            this.state.emit({ type: 'subagent_progress', progress });
          },
          onNativeTurn: (status, error, requested) => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            if (status === 'started' && !requested) {
              this.state.setStatus('executing');
              this.#emitSessionSnapshot();
              this.backgroundTurn = { id: randomUUID(), sequence: 0 };
              this.#emitBackground({ type: 'background_turn_started', providerSessionId: this.nativeSessionId ?? undefined });
            } else if (status === 'completed' && !requested && this.backgroundTurn) {
              if (error) this.#emitBackground({ type: 'notice', level: 'warning', message: error });
              this.#emitBackground({ type: 'background_turn_completed', reason: 'completed', providerSessionId: this.nativeSessionId ?? undefined });
              this.backgroundTurn = null;
              this.state.setStatus(this.backgroundScopes.size ? 'executing' : 'idle');
              this.#emitSessionSnapshot();
              this.#releaseRetiredKernel();
            }
          },
          onNativeOutput: (event, childSessionId) => {
            if (kernelGeneration !== this.kernelGeneration || this.disposed) return;
            const current = this.activeRun;
            const child = childSessionId ? this.backgroundScopes.get(childSessionId) : undefined;
            if (child && (current?.run.turnId !== child.originatingTurnId || !current?.turn.acceptingLiveOutput)) {
              this.#emitBackground(event, child);
            } else if (this.backgroundTurn) {
              this.#emitBackground(event);
            } else if (current?.turn.acceptingLiveOutput) {
              current.turn.accept();
              current.run.emit(event);
            }
          },
          onClosed: (error) => {
            this.#handleKernelClosed(kernelGeneration, error);
          },
          onNotification: (notification) => {
            const current = this.activeRun;
            if (
              current
              && kernelGeneration === this.kernelGeneration
            ) {
              void this.handleNotification(
                this.lifecycleGeneration,
                current,
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
        if (!this.#isRunCurrent(active, generation)) return;
        phase = 'open';
        resumeAttempt = this.nativeSessionId;
        native = await kernel.openSession(resumeAttempt ?? undefined);
        this.#captureNativeSessionOwnership(native, active);
        if (!this.#isRunCurrent(active, generation)) return;
        phase = 'run';
        this.nativeInfo = native;
        await projectOpencodeMetadata(this.plugin, native, this.kernelMetadataController.signal);
      } else {
        // Configuring a reused kernel is native work: cancellation must stop it.
        active.ownsNativeWork = true;
        this.state.setStatus('executing');
        phase = 'run';
      }
      assertOpencodeModelAvailable(this.plugin.settings, request.configuration.model);
      await this.#applyConfiguration(kernel, native, request);
      if (!this.#isRunCurrent(active, generation)) return;

      assertOpencodeModelAvailable(this.plugin.settings, request.configuration.model);
      const text = getInputText(request);
      const compact = parseCompactCommand(text);
      if (compact && !this.nativeConversationContextEstablished && request.conversationHistory?.length) {
        throw new Error('Send a normal message to restore the native conversation before using /compact.');
      }
      turn.beginLiveOutput();
      const promptStartedAt = Date.now();
      const prompt = compact ? null : buildPrompt(request, !this.nativeConversationContextEstablished);
      const response = await kernel.prompt({
        prompt: prompt?.blocks ?? [{ type: 'text', text: text.trim() }],
        sessionId: native.sessionId,
      }, prompt?.userText);
      this.#markNativeConversationContextEstablished(active);
      if (!this.#isRunCurrent(active, generation)) return;
      active.nativeCompleted = response.stopReason !== 'cancelled';
      turn.accept(response.userMessageId);
      if (response.usage) {
        const usage = buildACPUsageInfo({
          contextWindow: turn.contextUsage,
          model: this.#resolveSelectedRawModelId(request.configuration.model) ?? undefined,
          promptUsage: response.usage,
        });
        if (usage) run.emit({ type: 'usage_updated', usage });
      }
      const turnStats = response.stopReason !== 'cancelled' && native.databasePath
        ? await loadOpencodeTurnStats(native.sessionId, {
          databasePath: native.databasePath, ...(native.nativeVersion ? { nativeVersion: native.nativeVersion } : {}),
        }, { userMessageId: response.userMessageId, startedAt: promptStartedAt }).catch(() => undefined)
        : undefined;
      if (!this.#isRunCurrent(active, generation)) return;
      this.state.setStatus(this.backgroundTurn || this.backgroundScopes.size ? 'executing' : 'idle');
      this.#emitRunSnapshot(active);
      run.finish(response.stopReason === 'cancelled'
        ? { reason: 'provider-cancelled', type: 'cancelled' }
        : { reason: 'completed', type: 'turn_completed', ...(turnStats ? { turnStats } : {}) });
      this.activeRun = null;
      this.#releaseRetiredKernel();
    } catch (error) {
      if (!this.#isRunCurrent(active, generation)) return;
      const missing = phase === 'open'
        && resumeAttempt !== null
        && error instanceof OpencodeSessionMissingError
        && error.sessionId === resumeAttempt;
      this.#invalidate(
        missing ? 'provider-session-missing' : 'provider-error',
        true,
        error,
      );
      this.#emitRunSnapshot(active);
      run.finish({
        category: error instanceof ProviderModelUnavailableError ? 'configuration' : missing ? 'provider-session-missing' : 'provider',
        message: formatError(error),
        ...(missing && resumeAttempt
          ? { missingProviderSessionId: resumeAttempt }
          : {}),
        recoverable: true,
        type: 'execution_error',
      });
      this.activeRun = null;
      await this.#disposeKernel();
    }
  }

  #openBackgroundScope(key: string, originatingTurnId?: string): { id: string; sequence: number } {
    const turn = { id: randomUUID(), sequence: 0, originatingTurnId };
    this.backgroundScopes.set(key, turn);
    this.state.setStatus('executing');
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
      this.state.setStatus('idle');
      this.#emitSessionSnapshot();
      this.#releaseRetiredKernel();
    }
  }

  #releaseRetiredKernel(): void {
    if (this.kernelRetired && !this.activeRun && !this.backgroundTurn && this.backgroundScopes.size === 0 && !this.kernel?.hasNativeWork) {
      void this.#disposeKernel();
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
    this.state.notify(scoped);
  }

  private async handleNotification(
    generation: number,
    active: OpencodeActiveRun,
    notification: ACPSessionNotification,
  ): Promise<void> {
    if (
      !this.#isRunCurrent(active, generation)
      || notification.sessionId !== this.nativeSessionId
    ) {
      return;
    }
    let metadata;
    try {
      metadata = active.turn.handleUpdate(notification.update);
    } catch {
      return;
    }
    if (metadata?.type === 'commands' && !this.kernelMetadataController.signal.aborted) {
      const commands = metadata.commands.map((command) => ({
        ...command,
      }));
      this.options.commandCatalog?.setCommandSnapshot(commands);
    }
    if (metadata?.type === 'config_options') {
      if (this.nativeInfo) {
        this.nativeInfo = {
          ...this.nativeInfo,
          configOptions: metadata.configOptions,
        };
      }
      await projectOpencodeMetadata(this.plugin, {
        configOptions: metadata.configOptions,
      }, this.kernelMetadataController.signal);
    }
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
      }, this.kernelMetadataController.signal);
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
    // Resumed sessions may still name an agent clone from an earlier lease.
    await kernel.setConfigOption({
      configId: 'mode',
      sessionId: native.sessionId,
      type: 'select',
      value: profile === 'managed' ? OPENCODE_BUILD_AGENT_ID : AUX_AGENT_IDS[profile],
    });
    kernel.setAutoApprove(request.configuration.permissionMode === 'yolo');
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

  #cancelRun(active: OpencodeActiveRun): void {
    if (!this.#isRunCurrent(active, this.lifecycleGeneration) || active.nativeCompleted) return;
    active.cancellationRequested = true;
    active.turn.endLiveOutput();
    const generation = ++this.lifecycleGeneration;
    if (!active.ownsNativeWork) {
      // The kernel may still serve an earlier turn's descendants; only stop waiting.
      this.state.setStatus(this.backgroundTurn || this.backgroundScopes.size ? 'executing' : 'idle');
      this.#emitRunSnapshot(active);
      active.run.finish({ reason: 'cancelled', type: 'cancelled' });
      this.activeRun = null;
      this.#releaseRetiredKernel();
      return;
    }
    this.#interruptKernel();
    this.#invalidate('cancelled', true, new Error('Cancelled'));
    this.#emitRunSnapshot(active);
    void this.#disposeKernel().finally(() => {
      if (this.disposed || generation !== this.lifecycleGeneration) return;
      active.run.finish({
        reason: 'cancelled',
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
    const active = this.activeRun;
    if (!active || active.run.isTerminal || this.disposed) {
      if (!this.disposed) {
        this.#invalidate('process-exited', true, error);
        this.#emitSessionSnapshot();
        this.#emitSessionError(error);
      }
      this.nativeInfo = null;
      void this.#disposeKernel();
      return;
    }
    this.lifecycleGeneration += 1;
    this.#invalidate('process-exited', true, error);
    this.#emitRunSnapshot(active);
    active.run.finish({
      category: 'process-exited',
      message: formatError(error),
      recoverable: true,
      type: 'execution_error',
    });
    this.activeRun = null;
    this.nativeInfo = null;
    void this.#disposeKernel();
  }

  #captureNativeSessionOwnership(
    native: OpencodeNativeSessionInfo,
    active: OpencodeActiveRun,
  ): void {
    if (this.disposed) return;
    this.nativeSessionId = native.sessionId;
    this.databasePath = native.databasePath;
    this.nativeVersion = native.nativeVersion ?? this.nativeVersion;
    this.#publishNativeOwnershipSnapshot(active);
  }

  #markNativeConversationContextEstablished(
    active: OpencodeActiveRun,
  ): void {
    if (this.disposed || this.nativeConversationContextEstablished) return;
    this.nativeConversationContextEstablished = true;
    this.#publishNativeOwnershipSnapshot(active);
  }

  #publishNativeOwnershipSnapshot(active: OpencodeActiveRun): void {
    const status = this.state.status;
    const isCurrentExecution = (
      this.activeRun === active
      && !active.run.isTerminal
      && !active.cancellationRequested
      && !this.disposed
      && status !== 'invalidated'
      && status !== 'disposed'
    );
    if (isCurrentExecution) {
      this.state.setStatus('executing');
      this.#emitRunSnapshot(active);
    } else {
      this.state.bumpRevision();
      this.#emitSessionSnapshot();
    }
  }

  #isRunCurrent(
    active: OpencodeActiveRun,
    generation: number,
  ): boolean {
    return (
      !this.disposed
      && this.activeRun === active
      && !active.run.isTerminal
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
    const releaseCleanup = this.kernelRetired && !this.disposed;
    this.kernelMetadataController.abort();
    this.kernelRetired = false;
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
      } finally {
        if (releaseCleanup) await this.persistence.releaseClient();
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

  #emitRunSnapshot(active: OpencodeActiveRun): void {
    active.run.emit({
      snapshot: this.state.getSnapshot(),
      type: 'session_state_changed',
    });
  }

  #emitSessionSnapshot(): void {
    this.state.emit({
      snapshot: this.state.getSnapshot(),
      type: 'session_state_changed',
    });
  }

  #emitSessionError(error: Error): void {
    this.state.emit({
      category: 'process-exited',
      message: error.message,
      recoverable: true,
      type: 'session_error',
    });
  }

  #invalidate(
    reason: Extract<
      ProviderSessionInvalidationReason,
      'cancelled' | 'process-exited' | 'provider-error' | 'provider-session-missing'
    >,
    recoverable: boolean,
    error: unknown,
  ): void {
    this.state.invalidate({
      message: formatError(error),
      reason,
      recoverable,
    });
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
      : null,
  ]);
}

function getInputText(request: ProviderExecutionRequest): string {
  return request.input
    .filter((block): block is Extract<typeof block, { type: 'text' }> => (
      block.type === 'text'
    ))
    .map(({ text: value }) => value)
    .join('\n');
}

function buildPrompt(
  request: ProviderExecutionRequest,
  bootstrapHistory: boolean,
) {
  const images = request.input
    .filter((block): block is Extract<typeof block, { type: 'image' }> => (
      block.type === 'image'
    ))
    .map(({ image }) => image);
  return buildOpencodePrompt({
    selections: request.context?.selections,
    browserSelection: request.context?.browserSelection,
    canvasSelection: request.context?.canvasSelection,
    editorSelection: request.context?.editorSelection,
    images,
    linkedContent: request.context?.linkedContent,
    sessionReferences: request.context?.sessionReferences,
    text: getInputText(request),
  }, bootstrapHistory
    ? [...(request.conversationHistory ?? [])] as ChatMessage[]
    : []);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
