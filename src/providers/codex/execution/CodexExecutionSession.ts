import { randomUUID } from 'crypto';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import {
  type ProviderExecutionErrorCategory,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionInvalidation,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  RequestedRunChannel,
  SessionSnapshotState,
  type SteerableExecutionSession,
} from '@/core/execution';
import type { SystemPromptSettings } from '@/core/prompt/mainAgent';
import { ProviderModelUnavailableError } from '@/core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { StreamChunk } from '@/core/types';
import { createTurnStats, isTokenCount } from '@/core/types';
import {
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFileAsync,
} from '@/providers/codex/history/CodexHistoryStore';
import type { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import type {
  ConfigReadParams,
  ConfigReadResult,
  ItemCompletedNotification,
  ServerRequestResolvedNotification,
  ThreadCompactStartResult,
  ThreadReadResult,
  TurnCompletedNotification,
  TurnStartedNotification,
  TurnStartResult,
  TurnSteerResult,
} from '@/providers/codex/runtime/codexAppServerTypes';
import { assertCodexModelAvailable } from '@/providers/codex/runtime/CodexModelAvailability';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';
import { CodexRPCResponseError } from '@/providers/codex/runtime/CodexRPCTransport';
import {
  getCodexProviderSettings,
  getEffectiveCodexReasoningSummary,
} from '@/providers/codex/settings';
import type {
  CodexPendingForkTarget,
  CodexProviderState,
} from '@/providers/codex/types';

import type { CodexActiveRun } from './CodexActiveRun';
import { CodexCompletionRecovery } from './CodexCompletionRecovery';
import { adaptCodexStreamChunk } from './CodexExecutionEventNormalizer';
import { CodexExecutionServerRequestRouter } from './CodexExecutionServerRequestRouter';
import { CodexInputBundles } from './CodexInputBundles';
import { CodexSessionConnection } from './CodexSessionConnection';
import { CodexSubagentTracker } from './CodexSubagentTracker';
import { CodexThreadBinder } from './CodexThreadBinder';
import { CodexTurnBinding, extractNotificationScope } from './CodexTurnBinding';
import {
  buildCodexTurnPrompt,
  resolveCodexBaseInstructions,
  resolveCodexServiceTier,
  resolveCodexTurnModel,
  resolveCodexTurnPolicy,
  resolveCodexTurnReasoningEffort,
  resolveCodexTurnSandboxPolicy,
  resolveCodexTurnSettings,
} from './codexTurnConfig';

const CODEX_SUPPORTS_EXACT_BUILT_IN_TOOL_ALLOW_LIST = false;
const CODEX_CONSUMED_FORK_STATE_KEYS = [
  'forkSource',
  'forkSourceSessionFilePath',
  'forkSourceTranscriptRootPath',
  'pendingForkTarget',
] as const;
const JSON_RPC_PRE_HANDOFF_REJECTION_CODES = new Set([
  -32600,
  -32601,
  -32602,
]);

export class CodexExecutionSession
  implements ProviderExecutionSession, SteerableExecutionSession {
  readonly providerId = 'codex' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly state: SessionSnapshotState;
  private readonly serverRequestRouter: CodexExecutionServerRequestRouter;
  private readonly connection: CodexSessionConnection;
  private readonly inputBundles = new CodexInputBundles(
    hostPath => this.#mapRequiredHostPath(hostPath),
  );
  private readonly threads: CodexThreadBinder;
  private readonly completionRecovery: CodexCompletionRecovery;
  private readonly turn: CodexTurnBinding;

  private activeRun: CodexActiveRun | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;

  private readonly subagents = new CodexSubagentTracker(
    subagent => {
      this.state.emit({ type: 'subagent_updated', subagent });
      this.#releaseRetiredConnection();
    },
    async threadId => {
      const transport = this.connection.transport;
      if (!transport) throw new Error('Codex transport is unavailable');
      return (await transport.request<ThreadReadResult>('thread/read', { threadId, includeTurns: true }, 5_000)).thread;
    },
    () => this.connection.targetWorkingDirectory(),
  );

  hasBackgroundWork(): boolean { return this.connection.hasBackgroundWork; }

  private threadId: string | null;
  private sessionFilePath: string | null;
  private sessionFileLookupThreadId: string | null = null;
  private workspaceDependencyToolVersion: number | null;
  private nativeConversationContextEstablished: boolean;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly runtime: CodexAppServerRuntime,
  ) {
    const codexState = (config.resumeSeed?.providerState ?? {}) as CodexProviderState;
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      sessionInstanceId: this.sessionInstanceId,
      providerState: config.resumeSeed?.providerState,
      readProviderSessionId: () => this.threadId,
      projectProviderState: state => this.#projectProviderState(state),
    });
    this.connection = new CodexSessionConnection({
      vaultWorkingDirectory: config.vaultWorkingDirectory,
      observer: {
        notification: (method, params) => this.handleNotification(method, params),
        serverRequest: (id, method, params) => this.serverRequestRouter.handleServerRequest(id, method, params),
        stop: () => this.dispose(),
        workChanged: () => this.#releaseRetiredConnection(),
      },
      onExit: () => this.#handleConnectionExit(),
      onRetired: () => this.#releaseRetiredConnection(),
      onRelease: () => {
        this.subagents.clear();
        this.threads.unload();
        this.serverRequestRouter.setDynamicToolRegistry(null);
      },
    });
    this.threads = new CodexThreadBinder(
      {
        threadResumed: thread => this.subagents.seed(thread),
        threadStarted: (active, identity) => {
          this.workspaceDependencyToolVersion = identity.workspaceDependencyToolVersion;
          this.threadId = identity.threadId;
          this.sessionFilePath = identity.sessionFilePath;
          this.#publishNativeOwnershipSnapshot(active);
        },
        forkTargetAdopted: (active, target) => this.#adoptPendingForkTarget(active, target),
        forkConsumed: (active) => {
          for (const key of CODEX_CONSUMED_FORK_STATE_KEYS) {
            this.state.deleteProviderStateValue(key);
          }
          this.state.setStatus('idle');
          this.#emitSnapshot(active);
        },
      },
      this.connection,
      codexState.forkSource,
      normalizePendingForkTarget(codexState.pendingForkTarget),
    );
    const pendingForkTarget = this.threads.pendingForkTarget;
    this.threadId = pendingForkTarget?.threadId
      ?? codexState.threadId
      ?? config.resumeSeed?.providerSessionId
      ?? null;
    this.nativeConversationContextEstablished = typeof codexState
      .nativeConversationContextEstablished === 'boolean'
      ? codexState.nativeConversationContextEstablished
      : this.threadId !== null || this.threads.pendingFork !== undefined;
    this.sessionFilePath = pendingForkTarget?.sessionFilePath
      ?? codexState.sessionFilePath
      ?? null;
    this.workspaceDependencyToolVersion =
      codexState.workspaceDependencyToolVersion ?? null;
    this.serverRequestRouter = new CodexExecutionServerRequestRouter(
      this.sessionInstanceId,
      config.interactionPort,
      (threadId, turnId) => this.turn.observe(threadId, turnId),
    );
    this.completionRecovery = new CodexCompletionRecovery({
      lifecycleGeneration: () => this.lifecycleGeneration,
      activeRun: () => this.activeRun,
      transport: () => this.connection.transport,
      replayNotification: (method, params) => this.handleNotification(method, params),
      fail: (active, message) => this.#finishError(active, 'provider', message, true),
    });
    this.turn = new CodexTurnBinding(
      {
        activeRun: () => this.activeRun,
        markNativeContextEstablished: active => this.#markNativeConversationContextEstablished(active),
      },
      this.serverRequestRouter,
      this.completionRecovery,
    );
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) {
      throw new Error('Codex execution session has been disposed.');
    }
    if (this.activeRun) {
      throw new Error('Codex execution session already has an active requested run.');
    }

    const active: CodexActiveRun = {
      run: new RequestedRunChannel({
        sessionInstanceId: this.sessionInstanceId,
        onCancel: () => {
          active.cancellation.abort();
          this.#cancelRun(active);
        },
      }),
      cancellation: new AbortController(),
      nativeThreadId: null,
      nativeTurnId: null,
      nativeStartSubmitted: false,
      completion: null,
      responseTokens: new Map(),
    };
    this.activeRun = active;
    active.run.attachAbortSignal(request.signal);
    if (!active.run.isCancellationRequested) {
      void this.#executeRun(active, request);
    }
    return active.run;
  }

  cancel(): void {
    if (this.activeRun) {
      this.activeRun.run.cancel();
      return;
    }
    this.serverRequestRouter.abortAll('cancelled');
    void this.connection.scope?.stop();
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

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    try { assertCodexModelAvailable(this.plugin.settings, request.configuration.model); }
    catch (error) { if (error instanceof ProviderModelUnavailableError) return false; throw error; }
    const active = this.activeRun;
    const scope = this.connection.scope;
    const nativeThreadId = active?.nativeThreadId;
    const nativeTurnId = active?.nativeTurnId;
    if (
      this.disposed
      || !active
      || active.run.isTerminal
      || active.run.isCancellationRequested
      || !nativeThreadId
      || !nativeTurnId
      || !scope
      || request.signal.aborted
    ) {
      return false;
    }

    const bundle = this.inputBundles.create(request);
    try {
      const result = await scope.steer<TurnSteerResult>({
        threadId: nativeThreadId,
        input: bundle.input,
        expectedTurnId: nativeTurnId,
      }, this.inputBundles.handOff(bundle));
      if (
        !result
        || typeof result !== 'object'
        || result.turnId !== nativeTurnId
      ) {
        throw new Error('Codex returned an ambiguous steer acknowledgement.');
      }
      return true;
    } catch (error) {
      if (
        error instanceof CodexRPCResponseError
        && JSON_RPC_PRE_HANDOFF_REJECTION_CODES.has(error.code)
      ) {
        return false;
      }
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.cancel();
    this.serverRequestRouter.abortAll('session-disposed');
    this.disposePromise = this.#disposeInternal();
    return this.disposePromise;
  }

  async #disposeInternal(): Promise<void> {
    this.inputBundles.releaseAll();
    this.turn.release();
    try {
      const [releaseResult] = await Promise.allSettled([
        this.#releaseConnectionAfterForkIdentity(),
        this.threads.settleForkSetup(),
      ]);
      if (releaseResult.status === 'rejected') {
        throw releaseResult.reason;
      }
    } finally {
      this.state.setStatus('disposed');
      this.#emitSessionState();
      this.state.clearListeners();
    }
  }

  async #executeRun(
    active: CodexActiveRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    try {
      assertCodexModelAvailable(this.plugin.settings, request.configuration.model);
      let settings = resolveCodexTurnSettings(this.plugin.settings);
      let model = resolveCodexTurnModel(request, settings);
      if (!model) {
        this.#finishError(
          active,
          'configuration',
          'No Codex model is selected. Enable a model in Claudian settings.',
          true,
        );
        return;
      }
      let effort = resolveCodexTurnReasoningEffort(request, settings, model);

      if (
        request.toolPolicy.kind === 'allow-list'
        && !CODEX_SUPPORTS_EXACT_BUILT_IN_TOOL_ALLOW_LIST
      ) {
        this.#finishError(
          active,
          'configuration',
          'Codex app-server does not support exact allow-list enforcement for provider built-in tools.',
          false,
        );
        return;
      }

      const compact = parseCompactCommand(request.input.filter(block => block.type === 'text').map(block => block.text).join('\n\n'));
      if (
        compact && !compact.instructions
        && !this.nativeConversationContextEstablished
      ) {
        this.#finishError(
          active,
          'configuration',
          'Codex cannot compact before its native context is restored. Send a normal prompt first.',
          true,
        );
        return;
      }

      if (!this.#isRunCurrent(active, generation)) return;
      await this.#ensureConnection(generation, active.cancellation.signal);
      if (!this.#isRunCurrent(active, generation)) return;
      // Connection acquisition can wait out a settings transition.
      settings = resolveCodexTurnSettings(this.plugin.settings);
      model = resolveCodexTurnModel(request, settings)!;
      effort = resolveCodexTurnReasoningEffort(request, settings, model);

      const policy = resolveCodexTurnPolicy(request, settings);
      const serviceTier = resolveCodexServiceTier(request, model, settings);
      const replayConversationHistory = !this.nativeConversationContextEstablished;
      this.turn.setToolPolicy(request.toolPolicy);
      const thread = await this.threads.ensureThread(
        active,
        {
          model,
          policy,
          serviceTier,
          baseInstructions: resolveCodexBaseInstructions(request, this.#getSystemPromptSettings()),
          persistExtendedHistory: this.#resolveNativePersistence(),
          toolPolicy: request.toolPolicy,
        },
        {
          threadId: this.threadId,
          sessionFilePath: this.sessionFilePath,
          workspaceDependencyToolVersion: this.workspaceDependencyToolVersion,
        },
        () => this.#isRunCurrent(active, generation),
      );
      if (!this.#isRunCurrent(active, generation)) return;
      if (thread.forkCheckpoint) {
        this.nativeConversationContextEstablished = true;
      }
      active.nativeThreadId = thread.threadId;
      const threadIdentityChanged = this.threadId !== thread.threadId
        || (
          thread.sessionFilePath !== null
          && this.sessionFilePath !== thread.sessionFilePath
        );
      this.threadId = thread.threadId;
      if (thread.sessionFilePath) {
        this.sessionFilePath = thread.sessionFilePath;
      }
      if (threadIdentityChanged || this.state.status !== 'executing') {
        this.state.setStatus('executing');
        this.#emitSnapshot(active);
      }

      if (policy.approvalsReviewer === 'auto_review' && !this.threads.supportsApprovalReviewer) {
        throw new Error('Codex did not enable automatic approval review. Update Codex or choose Ask for approval.');
      }

      this.turn.begin(new CodexNotificationRouter(
        chunk => this.handleStreamChunk(active, chunk),
        this.connection.targetWorkingDirectory(),
      ));

      assertCodexModelAvailable(this.plugin.settings, request.configuration.model);
      if (compact && !compact.instructions) {
        if (!await this.#allowRequestedTurn(active, generation)) return;
        active.nativeStartSubmitted = true;
        await this.connection.scope!.startTurn<ThreadCompactStartResult>(
          'thread/compact/start',
          { threadId: thread.threadId },
        );
        return;
      }
      if (compact) {
        this.#finishError(
          active,
          'configuration',
          '/compact does not accept arguments',
          true,
        );
        return;
      }

      const turnInput = buildCodexTurnPrompt(
        request,
        hostPath => this.#mapRequiredHostPath(hostPath),
        thread.forkCheckpoint,
        replayConversationHistory,
      );
      const bundle = this.inputBundles.create(request, turnInput);
      const collaborationMode = {
        mode: 'default' as const,
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: null,
        },
      };

      const sandboxPolicy = await resolveCodexTurnSandboxPolicy(
        policy,
        this.threads.loadedThreadSandbox,
        () => this.connection.transport!.request<ConfigReadResult>('config/read', {
          cwd: this.connection.targetWorkingDirectory(),
        } satisfies ConfigReadParams),
      );
      if (!this.#isRunCurrent(active, generation)) return;
      // The override may take effect before, or without, its acknowledgement.
      const sandboxRevision = sandboxPolicy
        ? this.threads.beginSandboxOverride()
        : null;

      if (!await this.#allowRequestedTurn(active, generation)) return;
      active.nativeStartSubmitted = true;
      const result = await this.connection.scope!.startTurn<TurnStartResult>('turn/start', {
        threadId: thread.threadId,
        input: bundle.input,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        model,
        serviceTier,
        effort,
        summary: getEffectiveCodexReasoningSummary(settings, model),
        personality: getCodexProviderSettings(settings).responseStyle,
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
        collaborationMode,
      }, this.inputBundles.handOff(bundle));
      if (sandboxRevision !== null) {
        this.threads.confirmSandboxOverride(sandboxRevision, policy.sandbox);
      }
      this.#markNativeConversationContextEstablished(active);
      if (active.run.isCancellationRequested) {
        active.nativeTurnId = result.turn.id;
      }
      if (!this.#isRunCurrent(active, generation)) return;
      this.turn.observe(thread.threadId, result.turn.id);
    } catch (error) {
      if (!this.#isRunCurrent(active, generation) || active.run.isCancellationRequested) {
        return;
      }
      this.#handleExecutionFailure(active, error);
    }
  }

  async #ensureConnection(generation: number, signal: AbortSignal): Promise<void> {
    await this.connection.settleRelease();
    await this.connection.scope?.waitUntilReady();
    if (!this.#isLifecycleCurrent(generation)) {
      throw new Error('Codex execution session has been disposed.');
    }
    // Acquisition also waits out provider transitions and checks the launch fingerprint.
    const lease = await this.runtime.acquire({ signal });
    try {
      if (!this.#isLifecycleCurrent(generation) || this.connection.isAttachedTo(lease.connection)) {
        return;
      }
      if (this.connection.isDraining()) {
        throw new Error('Codex background work is still draining from the previous environment. Retry when it finishes.');
      }
      if (this.#resolveNativePersistence() === false && this.threadId) {
        throw new Error('This non-persistent Codex session cannot be restored after its process ends. Start a new side chat.');
      }
      await this.connection.release();
      if (!this.#isLifecycleCurrent(generation)) return;
      this.serverRequestRouter.setDynamicToolRegistry(await this.connection.attach(lease.connection));
    } finally {
      await lease.release();
    }
  }

  #releaseRetiredConnection(): void {
    if (!this.activeRun && this.connection.isReleasable()) {
      void this.connection.release().catch(() => undefined);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'item/completed') {
      const notification = params as ItemCompletedNotification;
      if (notification.item.type === 'subAgentActivity') {
        this.subagents.activity(notification.item, notification.turnId);
      }
    }
    if (this.disposed) return;
    if (method === 'thread/closed') {
      const closed = params as { threadId: string };
      if (closed.threadId !== this.threadId) {
        this.subagents.threadClosed(closed.threadId);
        return;
      }
      const active = this.activeRun;
      this.lifecycleGeneration += 1;
      void this.connection.release().catch(() => undefined);
      if (active && !active.run.isTerminal) {
        this.#finishError(active, 'provider', 'Codex thread was closed.', true);
      }
      return;
    }
    if (method === 'serverRequest/resolved') {
      const resolved = params as ServerRequestResolvedNotification;
      this.serverRequestRouter.resolveNativeRequest(
        resolved.requestId,
        resolved.threadId,
      );
      return;
    }

    if (method === 'turn/started') {
      const started = params as TurnStartedNotification;
      if (this.subagents.turnStarted(started.threadId, started.turn.id)) return;
    }
    if (method === 'turn/completed') {
      const completed = params as TurnCompletedNotification;
      if (this.subagents.turnCompleted(completed.threadId, completed.turn)) return;
    }

    const childScope = extractNotificationScope(method, params);
    if (childScope && this.subagents.handleNotification(childScope.threadId, childScope.turnId, method, params)) return;

    this.turn.handleNotification(method, params);
  }

  #markNativeConversationContextEstablished(
    active: CodexActiveRun,
  ): void {
    if (this.nativeConversationContextEstablished) return;
    this.nativeConversationContextEstablished = true;
    this.#publishNativeOwnershipSnapshot(active);
  }

  private handleStreamChunk(active: CodexActiveRun, chunk: StreamChunk): void {
    if (this.activeRun !== active || active.run.isTerminal) return;
    if (chunk.type === 'error') {
      this.#finishError(
        active,
        chunk.code === 'provider_session_missing'
          ? 'provider-session-missing'
          : 'provider',
        chunk.content,
        chunk.code === 'provider_session_missing',
        chunk.providerSessionId,
      );
      return;
    }
    if (chunk.type === 'done') {
      const completion = active.completion;
      if (completion?.status === 'failed') {
        this.#finishError(
          active,
          'provider',
          completion.errorMessage ?? 'Codex turn failed.',
          true,
        );
      } else if (
        completion?.status === 'interrupted'
        || active.run.isCancellationRequested
      ) {
        this.#finishCancelled(active);
      } else {
        this.#finishCompleted(active, completion?.nativeTurnId);
      }
      return;
    }

    const event = adaptCodexStreamChunk(chunk);
    if (event) active.run.emit(event);
  }

  #adoptPendingForkTarget(
    active: CodexActiveRun,
    target: CodexPendingForkTarget,
  ): void {
    this.threadId = target.threadId;
    this.sessionFilePath = target.sessionFilePath ?? null;
    this.state.setStatus('idle');
    this.#emitSnapshot(active);
  }

  /** Stops this session's native work on the shared server; `finishCancelled` is false for failures. */
  #cancelRun(active: CodexActiveRun, finishCancelled = true): void {
    if (this.activeRun !== active || active.run.isTerminal) return;
    this.completionRecovery.cancel();
    this.lifecycleGeneration += 1;
    this.serverRequestRouter.abortAll('cancelled');
    const stopping = this.connection.scope?.stop() ?? Promise.resolve();
    if (finishCancelled && this.threads.hasForkSetup) {
      void Promise.allSettled([stopping, this.threads.settleForkSetup()])
        .then(() => this.#finishCancelled(active));
    } else if (finishCancelled) {
      this.#finishCancelled(active);
    }
  }

  async #allowRequestedTurn(active: CodexActiveRun, generation: number): Promise<boolean> {
    await this.connection.scope!.beforeTurn();
    return this.#isRunCurrent(active, generation);
  }

  #finishCompleted(
    active: CodexActiveRun,
    nativeCheckpointId?: string,
  ): void {
    if (this.activeRun !== active || active.run.isTerminal) return;
    this.#finishRunState(active);
    const counts = [...active.responseTokens.values()];
    const turnStats = createTurnStats(
      counts.length > 0 && counts.every(isTokenCount) ? counts.reduce((sum, count) => sum + count, 0) : undefined,
      active.completion?.durationMs,
    );
    active.run.finish({
      type: 'turn_completed',
      ...(turnStats ? { turnStats } : {}),
      reason: 'completed',
      // Codex forks resume at turn IDs, not streaming agent-message item IDs.
      ...(nativeCheckpointId ? { nativeAssistantId: nativeCheckpointId, nativeCheckpointId } : {}),
    });
    this.#releaseRun(active);
  }

  #finishCancelled(active: CodexActiveRun): void {
    if (this.activeRun !== active || active.run.isTerminal) return;
    this.#finishRunState(active);
    active.run.finish({
      type: 'cancelled',
      reason: 'cancelled',
    });
    this.#releaseRun(active);
  }

  #finishError(
    active: CodexActiveRun,
    category: ProviderExecutionErrorCategory,
    message: string,
    recoverable: boolean,
    missingProviderSessionId?: string,
  ): void {
    if (this.activeRun !== active || active.run.isTerminal) return;
    const invalidationReason: ProviderSessionInvalidation['reason'] | null =
      category === 'provider-session-missing'
        ? 'provider-session-missing'
        : category === 'process-exited'
          ? 'process-exited'
          : category === 'transport'
            ? 'transport-closed'
            : null;
    if (invalidationReason) {
      this.state.invalidate({ reason: invalidationReason, recoverable, message });
    } else {
      this.state.setStatus('idle');
    }
    this.#emitSnapshot(active);
    active.run.finish({
      type: 'execution_error',
      category,
      message,
      recoverable,
      ...(missingProviderSessionId ? { missingProviderSessionId } : {}),
    });
    this.#releaseRun(active);
  }

  #finishRunState(active: CodexActiveRun): void {
    this.state.setStatus('idle');
    this.#emitSnapshot(active);
  }

  #releaseRun(active: CodexActiveRun): void {
    this.completionRecovery.cancel();
    this.turn.release();
    this.serverRequestRouter.abortAll(
      active.run.isCancellationRequested ? 'cancelled' : 'resolved',
    );
    this.inputBundles.releaseAll();
    if (this.activeRun === active) {
      this.activeRun = null;
    }
    this.#discoverSessionFile();
    this.#releaseRetiredConnection();
  }

  #handleExecutionFailure(
    active: CodexActiveRun,
    error: unknown,
  ): void {
    const message = error instanceof Error
      ? error.message
      : 'Unknown Codex error';
    if (isMissingThreadError(message)) {
      this.#finishError(
        active,
        'provider-session-missing',
        message,
        true,
        this.threadId ?? undefined,
      );
      return;
    }
    const category = error instanceof ProviderModelUnavailableError ? 'configuration' : isTransportError(message) ? 'transport' : 'provider';
    // A missing start acknowledgement does not establish that native work stopped.
    // Keep the execution error visible while joining the same targeted cleanup as cancellation.
    if (category === 'transport' && active.nativeStartSubmitted) this.#cancelRun(active, false);
    this.#finishError(active, category, message, category === 'transport');
  }

  #handleConnectionExit(): void {
    if (this.disposed) return;
    this.lifecycleGeneration += 1;
    const active = this.activeRun;
    // The dead transport cannot deliver an unresolved fork identity.
    const release = this.connection.release();
    const message = 'Codex app-server process exited unexpectedly.';
    if (active && !active.run.isTerminal && !active.run.isCancellationRequested) {
      if (this.threads.hasForkSetup) {
        void Promise.allSettled([
          release,
          this.threads.settleForkSetup(),
        ]).then(() => {
          this.#finishError(active, 'process-exited', message, true);
        });
      } else {
        this.#finishError(active, 'process-exited', message, true);
      }
    } else {
      this.state.invalidate({ reason: 'process-exited', recoverable: true, message });
      this.#emitSessionState();
    }
    void release.catch(() => undefined);
  }

  async #releaseConnectionAfterForkIdentity(): Promise<void> {
    await this.threads.settleForkIdentity();
    await this.connection.release();
  }

  #emitSnapshot(active: CodexActiveRun): void {
    active.run.emit({
      type: 'session_state_changed',
      snapshot: this.state.getSnapshot(),
    });
  }

  #emitSessionState(): void {
    this.state.emit({ type: 'session_state_changed', snapshot: this.state.getSnapshot() });
  }

  /** Publishes on the active run's stream while it is open, otherwise on the session channel. */
  #publishSnapshot(): void {
    const active = this.activeRun;
    if (active && !active.run.isTerminal) {
      this.#emitSnapshot(active);
    } else {
      this.#emitSessionState();
    }
  }

  #publishNativeOwnershipSnapshot(active: CodexActiveRun): void {
    const status = this.state.status;
    const isCurrentExecution = (
      this.activeRun === active
      && !active.run.isTerminal
      && !active.run.isCancellationRequested
      && !this.disposed
      && status !== 'invalidated'
      && status !== 'disposed'
      && status !== 'cancelling'
    );
    if (isCurrentExecution) {
      this.state.setStatus('executing');
    } else {
      this.state.bumpRevision();
    }
    if (this.activeRun === active && !active.run.isTerminal) {
      this.#emitSnapshot(active);
    } else {
      this.#emitSessionState();
    }
  }

  /** Overlays the session's native identity onto the stored resume state. */
  #projectProviderState(state: Record<string, unknown>): Record<string, unknown> {
    const pendingForkTarget = this.threads.pendingForkTarget;
    const transcriptRootPath = this.#resolveTranscriptRootHost();
    return {
      ...state,
      ...(this.threadId
        ? {
            threadId: this.threadId,
            nativeConversationContextEstablished:
              this.nativeConversationContextEstablished,
          }
        : {}),
      ...(this.sessionFilePath
        ? { sessionFilePath: this.sessionFilePath }
        : {}),
      ...(transcriptRootPath ? { transcriptRootPath } : {}),
      ...(this.workspaceDependencyToolVersion !== null
        ? {
            workspaceDependencyToolVersion:
              this.workspaceDependencyToolVersion,
          }
        : {}),
      ...(pendingForkTarget
        ? { pendingForkTarget: { ...pendingForkTarget } }
        : {}),
    } satisfies CodexProviderState & Record<string, unknown>;
  }

  #getSystemPromptSettings(): SystemPromptSettings {
    return {
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      vaultPath: this.config.vaultWorkingDirectory,
      userName: this.plugin.settings.userName,
    };
  }

  #resolveNativePersistence(): boolean | undefined {
    if (this.config.nativePersistence === 'enabled') return true;
    if (this.config.nativePersistence === 'disabled-if-supported') return false;
    return this.config.lifecycle === 'persistent';
  }

  #mapRequiredHostPath(hostPath: string): string {
    const targetPath = this.connection.toTargetPath(hostPath);
    if (!targetPath) {
      throw new Error(
        `Codex cannot access path from the selected target: ${hostPath}`,
      );
    }
    return targetPath;
  }

  #resolveTranscriptRootHost(): string | null {
    return this.connection.sessionsDirHost
      ?? deriveCodexSessionsRootFromSessionPath(this.sessionFilePath);
  }

  #discoverSessionFile(): void {
    const threadId = this.threadId;
    if (
      this.sessionFilePath
      || !threadId
      // Non-persistent threads are started and forked ephemeral; they never write a rollout.
      || this.#resolveNativePersistence() === false
      || this.sessionFileLookupThreadId === threadId
    ) {
      return;
    }
    // One bounded background lookup per thread; a miss is not retried after later runs.
    this.sessionFileLookupThreadId = threadId;
    void findCodexSessionFileAsync(
      threadId,
      this.#resolveTranscriptRootHost() ?? undefined,
    ).then(
      found => this.#adoptDiscoveredSessionFile(threadId, found),
      () => undefined,
    );
  }

  #adoptDiscoveredSessionFile(threadId: string, found: string | null): void {
    if (!found || this.disposed || this.threadId !== threadId || this.sessionFilePath) {
      return;
    }
    this.sessionFilePath = found;
    this.state.bumpRevision();
    this.#publishSnapshot();
  }

  #isLifecycleCurrent(generation: number): boolean {
    return !this.disposed && generation === this.lifecycleGeneration;
  }

  #isRunCurrent(
    active: CodexActiveRun,
    generation: number,
  ): boolean {
    return (
      this.#isLifecycleCurrent(generation)
      && this.activeRun === active
      && !active.run.isTerminal
      && !active.run.isCancellationRequested
    );
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePendingForkTarget(
  value: unknown,
): CodexPendingForkTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const threadId = normalizeString(record.threadId);
  if (!threadId) return undefined;
  const sessionFilePath = normalizeString(record.sessionFilePath);
  return {
    threadId,
    ...(sessionFilePath ? { sessionFilePath } : {}),
  };
}

function isMissingThreadError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('thread') && (
      normalized.includes('not found')
      || normalized.includes('does not exist')
      || normalized.includes('missing')
    )
  );
}

function isTransportError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('transport')
    || normalized.includes('request timeout')
    || normalized.includes('process exited')
  );
}
