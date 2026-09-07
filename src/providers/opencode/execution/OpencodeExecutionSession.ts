import { randomUUID } from 'node:crypto';

import {
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
import type { ChatMessage } from '@/core/types';
import {
  AcpExecutionEventNormalizer,
  type AcpSessionNotification,
  buildAcpUsageInfo,
  extractAcpSessionThoughtLevelState,
} from '@/providers/acp';

import type { OpencodeCommandCatalog } from '../commands/OpencodeCommandCatalog';
import { projectOpencodeMetadata } from '../metadata/OpencodeMetadataProjection';
import { decodeOpencodeModelId } from '../models';
import {
  resolveOpencodeModeForPermissionMode,
  resolvePermissionModeForManagedOpencodeMode,
} from '../modes';
import { createOpencodeToolStreamAdapter } from '../normalization/opencodeToolNormalization';
import { buildOpencodePromptBlocks } from '../runtime/buildOpencodePrompt';
import { getOpencodeProviderSettings } from '../settings';
import { getOpencodeState } from '../types';
import {
  DefaultOpencodeAcpSessionKernel,
  type OpencodeAcpSessionKernel,
  type OpencodeAcpSessionKernelOptions,
  type OpencodeExecutionProfile,
  type OpencodeNativeSessionInfo,
  OpencodeSessionMissingError,
} from './OpencodeAcpSessionKernel';

export type OpencodeAcpSessionKernelFactory = (
  options: OpencodeAcpSessionKernelOptions,
) => OpencodeAcpSessionKernel;

export interface OpencodeExecutionSessionOptions {
  readonly commandCatalog?: Pick<OpencodeCommandCatalog, 'setCommandSnapshot'>;
  readonly createKernel?: OpencodeAcpSessionKernelFactory;
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private closed = false;
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];

  constructor(private readonly onEarlyReturn: () => void) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    if (!this.closed) this.onEarlyReturn();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}

class OpencodeExecutionRun implements ProviderExecutionRun {
  readonly executionId = randomUUID();
  readonly turnId = randomUUID();
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  readonly queue: AsyncEventQueue<ProviderExecutionEvent>;
  terminal = false;
  accepted = false;
  acceptingLiveOutput = false;
  cancellationRequested = false;
  lastSequence = 0;
  abortCleanup: (() => void) | null = null;

  constructor(
    readonly sessionInstanceId: string,
    private readonly cancelRun: (run: OpencodeExecutionRun) => void,
  ) {
    this.queue = new AsyncEventQueue(() => this.cancel());
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

  private readonly createKernel: OpencodeAcpSessionKernelFactory;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private activeRun: OpencodeExecutionRun | null = null;
  private kernel: OpencodeAcpSessionKernel | null = null;
  private kernelGeneration = 0;
  private kernelConfigurationKey: string | null = null;
  private kernelDisposalPromise: Promise<void> | null = null;
  private nativeInfo: OpencodeNativeSessionInfo | null = null;
  private nativeSessionId: string | null;
  private nativeConversationContextEstablished: boolean;
  private databasePath: string | null;
  private readonly seedProviderState: Readonly<Record<string, unknown>>;
  private snapshot: ProviderSessionSnapshot;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;
  private sessionEventSequence = 0;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: OpencodeExecutionSessionOptions = {},
  ) {
    this.createKernel = options.createKernel
      ?? ((kernelOptions) => new DefaultOpencodeAcpSessionKernel(kernelOptions));
    this.nativeSessionId = config.resumeSeed?.providerSessionId ?? null;
    const providerState = getOpencodeState(config.resumeSeed?.providerState);
    this.seedProviderState = Object.freeze({ ...providerState });
    this.databasePath = providerState.databasePath ?? null;
    this.nativeConversationContextEstablished = typeof providerState
      .nativeConversationContextEstablished === 'boolean'
      ? providerState.nativeConversationContextEstablished
      : this.nativeSessionId !== null;
    this.snapshot = this.createSnapshot('idle');
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('OpenCode execution session is disposed');
    if (this.activeRun) {
      throw new Error('OpenCode execution session already has an active run');
    }
    const run = new OpencodeExecutionRun(
      this.sessionInstanceId,
      (active) => this.cancelRun(active),
    );
    this.activeRun = run;
    const onAbort = () => run.cancel();
    request.signal.addEventListener('abort', onAbort, { once: true });
    run.abortCleanup = () => request.signal.removeEventListener('abort', onAbort);
    if (request.signal.aborted) run.cancel();
    if (!run.terminal) {
      void this.startRun(run, request);
    }
    return run;
  }

  cancel(): void {
    this.activeRun?.cancel();
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
      run.finish({
        reason: 'session-disposed',
        scope: run.scope(),
        type: 'cancelled',
      });
    }
    this.activeRun = null;
    this.listeners.clear();
    this.snapshot = this.createSnapshot('disposed');
    this.disposePromise = this.disposeKernel();
    return this.disposePromise;
  }

  private async startRun(
    run: OpencodeExecutionRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    let phase: 'connect' | 'open' | 'run' = 'connect';
    let resumeAttempt: string | null = null;
    try {
      const pendingDisposal = this.kernelDisposalPromise;
      if (pendingDisposal) {
        await pendingDisposal;
        if (!this.isRunCurrent(run, generation)) return;
      }
      const kernelConfigurationKey = buildKernelConfigurationKey(request);
      let kernel = this.kernel;
      let native = this.nativeInfo;
      if (
        kernel
        && native
        && this.kernelConfigurationKey !== kernelConfigurationKey
      ) {
        await this.disposeKernel();
        if (!this.isRunCurrent(run, generation)) return;
        kernel = null;
        native = null;
      }
      if (!kernel || !native) {
        const kernelGeneration = ++this.kernelGeneration;
        kernel = this.createKernel({
          config: this.config,
          databasePath: this.resolveDatabasePath(),
          getActiveTurnId: () => this.activeRun?.turnId ?? null,
          onClosed: (error) => {
            this.handleKernelClosed(kernelGeneration, error);
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
        if (!this.isRunCurrent(run, generation)) return;
        phase = 'open';
        resumeAttempt = this.nativeSessionId;
        native = await kernel.openSession(resumeAttempt ?? undefined);
        this.captureNativeSessionOwnership(native, run);
        if (!this.isRunCurrent(run, generation)) return;
        phase = 'run';
        this.nativeInfo = native;
        await projectOpencodeMetadata(this.plugin, native);
      } else {
        this.snapshot = this.createSnapshot('executing');
        phase = 'run';
      }
      await this.applyConfiguration(kernel, native, request);
      if (!this.isRunCurrent(run, generation)) return;

      this.getRunNormalizer(run).reset();
      run.acceptingLiveOutput = true;
      const response = await kernel.prompt({
        prompt: buildPromptBlocks(
          request,
          !this.nativeConversationContextEstablished,
        ),
        sessionId: native.sessionId,
      });
      this.markNativeConversationContextEstablished(run);
      if (!this.isRunCurrent(run, generation)) return;
      run.accept(response.userMessageId ?? undefined);
      this.snapshot = this.createSnapshot('idle');
      run.emit({
        scope: run.scope(),
        snapshot: this.snapshot,
        type: 'session_state_changed',
      });
      run.finish({
        reason: 'completed',
        scope: run.scope(),
        type: 'turn_completed',
      });
      this.activeRun = null;
    } catch (error) {
      if (!this.isRunCurrent(run, generation)) return;
      const missing = phase === 'open'
        && resumeAttempt !== null
        && error instanceof OpencodeSessionMissingError
        && error.sessionId === resumeAttempt;
      this.snapshot = this.createInvalidatedSnapshot(
        missing ? 'provider-session-missing' : 'provider-error',
        true,
        error,
      );
      this.emitRunSnapshot(run);
      run.finish({
        category: missing ? 'provider-session-missing' : 'provider',
        message: formatError(error),
        ...(missing && resumeAttempt
          ? { missingProviderSessionId: resumeAttempt }
          : {}),
        recoverable: true,
        scope: run.scope(),
        type: 'execution_error',
      });
      this.activeRun = null;
      await this.disposeKernel();
    }
  }

  private async handleNotification(
    generation: number,
    run: OpencodeExecutionRun,
    notification: AcpSessionNotification,
  ): Promise<void> {
    if (
      !this.isRunCurrent(run, generation)
      || notification.sessionId !== this.nativeSessionId
    ) {
      return;
    }
    const acceptingLiveOutput = run.acceptingLiveOutput;
    const normalizer = this.getRunNormalizer(run);
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
      if (mode) this.emitSessionMode(mode);
    }
    if (
      acceptingLiveOutput
      && result.events.length > 0
      && this.isRunCurrent(run, generation)
    ) {
      this.markNativeConversationContextEstablished(run);
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
    AcpExecutionEventNormalizer
  >();

  private getRunNormalizer(
    run: OpencodeExecutionRun,
  ): AcpExecutionEventNormalizer {
    let normalizer = this.runNormalizers.get(run);
    if (!normalizer) {
      normalizer = new AcpExecutionEventNormalizer({
        mapUsage: (usage) => buildAcpUsageInfo({
          contextWindow: usage,
          model: this.resolveSelectedRawModelId(undefined) ?? undefined,
          promptUsage: null,
        }),
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

  private async applyConfiguration(
    kernel: OpencodeAcpSessionKernel,
    native: OpencodeNativeSessionInfo,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const selectedModel = this.resolveSelectedRawModelId(
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

    const thoughtState = extractAcpSessionThoughtLevelState({ configOptions });
    if (
      request.configuration.reasoning
      && thoughtState.configId
      && thoughtState.availableLevels.some(
        ({ id }) => id === request.configuration.reasoning,
      )
    ) {
      await kernel.setConfigOption({
        configId: thoughtState.configId,
        sessionId: native.sessionId,
        type: 'select',
        value: request.configuration.reasoning,
      });
    }

    const profile = resolveProfile(request);
    const mode = profile === 'passive'
      ? 'claudian-execution-passive'
      : profile === 'readonly'
        ? 'claudian-execution-readonly'
        : request.configuration.mode
          ?? resolveOpencodeModeForPermissionMode(
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

  private resolveSelectedRawModelId(explicit?: string): string | null {
    const selection = explicit
      ?? (typeof this.plugin.settings.model === 'string'
        ? this.plugin.settings.model
        : '');
    return decodeOpencodeModelId(selection) ?? (selection || null);
  }

  private cancelRun(run: OpencodeExecutionRun): void {
    if (!this.isRunCurrent(run, this.lifecycleGeneration)) return;
    run.cancellationRequested = true;
    run.acceptingLiveOutput = false;
    const generation = ++this.lifecycleGeneration;
    if (this.nativeSessionId) {
      try {
        this.kernel?.cancel(this.nativeSessionId);
      } catch {
        // Disposal below remains authoritative when native cancellation fails.
      }
    }
    this.snapshot = this.createInvalidatedSnapshot(
      'cancelled',
      true,
      new Error('Cancelled'),
    );
    this.emitRunSnapshot(run);
    void this.disposeKernel().finally(() => {
      if (this.disposed || generation !== this.lifecycleGeneration) return;
      run.finish({
        reason: 'cancelled',
        scope: run.scope(),
        type: 'cancelled',
      });
      this.activeRun = null;
    });
  }

  private handleKernelClosed(
    kernelGeneration: number,
    error: Error,
  ): void {
    if (kernelGeneration !== this.kernelGeneration) return;
    const run = this.activeRun;
    if (!run || run.terminal || this.disposed) {
      if (!this.disposed) {
        this.snapshot = this.createInvalidatedSnapshot(
          'process-exited',
          true,
          error,
        );
        this.emitSessionSnapshot();
        this.emitSessionError(error);
      }
      this.nativeInfo = null;
      void this.disposeKernel();
      return;
    }
    this.lifecycleGeneration += 1;
    this.snapshot = this.createInvalidatedSnapshot(
      'process-exited',
      true,
      error,
    );
    this.emitRunSnapshot(run);
    run.finish({
      category: 'process-exited',
      message: formatError(error),
      recoverable: true,
      scope: run.scope(),
      type: 'execution_error',
    });
    this.activeRun = null;
    this.nativeInfo = null;
    void this.disposeKernel();
  }

  private captureNativeSessionOwnership(
    native: OpencodeNativeSessionInfo,
    run: OpencodeExecutionRun,
  ): void {
    if (this.disposed) return;
    this.nativeSessionId = native.sessionId;
    this.databasePath = native.databasePath;
    this.publishNativeOwnershipSnapshot(run);
  }

  private markNativeConversationContextEstablished(
    run: OpencodeExecutionRun,
  ): void {
    if (this.disposed || this.nativeConversationContextEstablished) return;
    this.nativeConversationContextEstablished = true;
    this.publishNativeOwnershipSnapshot(run);
  }

  private publishNativeOwnershipSnapshot(run: OpencodeExecutionRun): void {
    const currentSnapshot = this.snapshot;
    const isCurrentExecution = (
      this.activeRun === run
      && !run.terminal
      && !run.cancellationRequested
      && !this.disposed
      && currentSnapshot.status !== 'invalidated'
      && currentSnapshot.status !== 'disposed'
    );
    this.snapshot = this.refreshSnapshot(
      isCurrentExecution ? 'executing' : currentSnapshot.status,
      currentSnapshot.invalidation,
    );
    if (isCurrentExecution) {
      this.emitRunSnapshot(run);
    } else {
      this.emitSessionSnapshot();
    }
  }

  private resolveDatabasePath(): string | undefined {
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

  private isRunCurrent(
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

  private async disposeKernel(): Promise<void> {
    if (this.kernelDisposalPromise) return this.kernelDisposalPromise;
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

  private emitSessionMode(mode: string): void {
    const event: ProviderSessionEvent = {
      mode,
      scope: {
        kind: 'session',
        sequence: ++this.sessionEventSequence,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'mode_changed',
    };
    this.emitSessionEvent(event);
  }

  private emitRunSnapshot(run: OpencodeExecutionRun): void {
    run.emit({
      scope: run.scope(),
      snapshot: this.snapshot,
      type: 'session_state_changed',
    });
  }

  private emitSessionSnapshot(): void {
    this.emitSessionEvent({
      scope: {
        kind: 'session',
        sequence: ++this.sessionEventSequence,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'session_state_changed',
    });
  }

  private emitSessionError(error: Error): void {
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
    this.emitSessionEvent(event);
  }

  private emitSessionEvent(event: ProviderSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Session lifecycle must not depend on feature listener behavior.
      }
    }
  }

  private createSnapshot(
    status: Exclude<ProviderSessionStatus, 'invalidated'>,
  ): ProviderSessionSnapshot {
    return this.refreshSnapshot(status);
  }

  private createInvalidatedSnapshot(
    reason: 'cancelled' | 'process-exited' | 'provider-error' | 'provider-session-missing',
    recoverable: boolean,
    error: unknown,
  ): ProviderSessionSnapshot {
    const message = formatError(error);
    return this.refreshSnapshot('invalidated', {
      message,
      reason,
      recoverable,
    });
  }

  private refreshSnapshot(
    status: ProviderSessionStatus,
    invalidation?: ProviderSessionSnapshot['invalidation'],
  ): ProviderSessionSnapshot {
    const previousRevision = this.snapshot?.revision ?? -1;
    const providerState = {
      ...this.seedProviderState,
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
