import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ExecutionEventQueue,
  type ProviderExecutionErrorCategory,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderRequestedEventScope,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionInvalidation,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  type ProviderToolPolicy,
  type SteerableExecutionSession,
} from '../../../core/execution';
import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ChatMessage, ImageAttachment, StreamChunk } from '../../../core/types';
import { createTurnStats, isTokenCount } from '../../../core/types';
import {
  appendLinkedContent,
  appendLinkedContentBody,
  appendSelectionContexts,
  appendSessionReferences,
} from '../../../utils/context';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../../utils/session';
import {
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFileAsync,
} from '../history/CodexHistoryStore';
import { getCodexModelOptions } from '../modelOptions';
import {
  findCodexModel,
  getCodexReasoningEffortOptions,
  resolveCodexModelServiceTier,
  resolveCodexReasoningEffort,
} from '../models';
import { toCodexRuntimeModelId } from '../modelSelection';
import type { CodexAppServerConnection, CodexAppServerRuntime } from '../runtime/CodexAppServerRuntime';
import type {
  ConfigReadParams,
  ConfigReadResult,
  ItemCompletedNotification,
  SandboxPolicy,
  ServerRequestResolvedNotification,
  ThreadCompactStartResult,
  ThreadForkResult,
  ThreadReadResult,
  ThreadResumeResult,
  ThreadRollbackResult,
  ThreadStartResult,
  ThreadStatusChangedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
  TurnStartResult,
  TurnSteerResult,
  UserInput,
} from '../runtime/codexAppServerTypes';
import { CodexDynamicToolRegistry } from '../runtime/CodexDynamicToolRegistry';
import type { CodexLaunchSpec } from '../runtime/codexLaunchTypes';
import { assertCodexModelAvailable } from '../runtime/CodexModelAvailability';
import { CodexNotificationRouter } from '../runtime/CodexNotificationRouter';
import { CodexRPCResponseError, type CodexRPCTransport } from '../runtime/CodexRPCTransport';
import type { CodexRuntimeContext } from '../runtime/CodexRuntimeContext';
import type { CodexThreadScope } from '../runtime/CodexThreadScope';
import {
  CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME,
  CODEX_WORKSPACE_DEPENDENCY_TOOL_NAMESPACE,
  CODEX_WORKSPACE_DEPENDENCY_TOOL_VERSION,
  createCodexWorkspaceDependencyTool,
} from '../runtime/CodexWorkspaceDependencyTool';
import {
  type CodexSafeMode,
  getCodexProviderSettings,
  getEffectiveCodexReasoningSummary,
} from '../settings';
import type {
  CodexPendingForkTarget,
  CodexProviderState,
} from '../types';
import { adaptCodexStreamChunk } from './CodexExecutionEventAdapter';
import { CodexExecutionServerRequestRouter } from './CodexExecutionServerRequestRouter';
import { CodexSubagentTracker } from './CodexSubagentTracker';

const PASSIVE_INSTRUCTIONS =
  'Do not invoke tools. Complete the request only from the supplied input and context.';
const LEGACY_WORKSPACE_DEPENDENCY_INSTRUCTIONS =
  'This thread predates Claudian client-hosted workspace dependency tools. Do not emulate load_workspace_dependencies or install replacement dependencies.';
const CODEX_SUPPORTS_EXACT_BUILT_IN_TOOL_ALLOW_LIST = false;
const MISSED_TURN_COMPLETION_GRACE_MS = 1_000;
const MISSED_TURN_COMPLETION_MAX_ATTEMPTS = 3;
const MISSED_TURN_COMPLETION_RETRY_BASE_MS = 500;
const THREAD_READ_RECOVERY_TIMEOUT_MS = 5_000;
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

interface CodexPolicy {
  readonly approvalPolicy: string;
  readonly approvalsReviewer: string;
  readonly sandbox: string;
  /** Config-independent policy; config-derived modes leave the policy to Codex. */
  readonly sandboxPolicy?: SandboxPolicy;
}

interface CodexInputBundle {
  readonly input: UserInput[];
  cleanup(): void;
}

interface TurnCompletion {
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly nativeTurnId: string;
  readonly errorMessage?: string;
  readonly durationMs?: number | null;
}

interface CompletionRecovery {
  readonly run: CodexExecutionRun;
  readonly generation: number;
  attempt: number;
  inFlight: boolean;
  timer: number | null;
}

interface CodexEnsuredThread {
  threadId: string;
  sessionFilePath: string | null;
  forkCheckpoint?: string;
}

class CodexExecutionRun implements ProviderExecutionRun {
  readonly executionId = randomUUID();
  readonly turnId = randomUUID();
  readonly events: AsyncIterable<ProviderExecutionEvent>;

  private readonly queue = new ExecutionEventQueue<ProviderExecutionEvent>(
    () => this.cancel(),
  );
  private sequence = 0;
  private terminal = false;
  private cancelRequested = false;
  private readonly cancellation = new AbortController();
  readonly signal = this.cancellation.signal;
  private abortListener: (() => void) | null = null;

  nativeThreadId: string | null = null;
  nativeTurnId: string | null = null;
  nativeStartSubmitted = false;
  completion: TurnCompletion | null = null;
  readonly responseTokens = new Map<string, number | undefined>();

  constructor(
    private readonly sessionInstanceId: string,
    private readonly cancelRun: (run: CodexExecutionRun) => void,
  ) {
    this.events = this.queue;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  get isCancellationRequested(): boolean {
    return this.cancelRequested;
  }

  createScope(): ProviderRequestedEventScope {
    return Object.freeze({
      kind: 'requested',
      sessionInstanceId: this.sessionInstanceId,
      executionId: this.executionId,
      turnId: this.turnId,
      sequence: ++this.sequence,
    });
  }

  emit(event: ProviderExecutionEvent): void {
    if (!this.terminal) {
      this.queue.push(event);
    }
  }

  finish(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.#detachAbortSignal();
    this.queue.push(event);
    this.queue.close();
  }

  cancel(): void {
    if (this.cancelRequested || this.terminal) return;
    this.cancelRequested = true;
    this.cancellation.abort();
    this.cancelRun(this);
  }

  attachAbortSignal(signal: AbortSignal): void {
    const listener = () => this.cancel();
    this.abortListener = () => signal.removeEventListener('abort', listener);
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) this.cancel();
  }

  #detachAbortSignal(): void {
    this.abortListener?.();
    this.abortListener = null;
  }
}

export class CodexExecutionSession
  implements ProviderExecutionSession, SteerableExecutionSession {
  readonly providerId = 'codex' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly seedState: Readonly<Record<string, unknown>>;
  private readonly serverRequestRouter: CodexExecutionServerRequestRouter;
  private readonly sessionEventListeners =
    new Set<(event: ProviderSessionEvent) => void>();
  private readonly activeInputBundles = new Set<CodexInputBundle>();

  private connection: CodexAppServerConnection | null = null;
  private threadScope: CodexThreadScope | null = null;
  private detachConnectionListeners: (() => void) | null = null;
  private transport: CodexRPCTransport | null = null;
  private launchSpec: CodexLaunchSpec | null = null;
  private runtimeContext: CodexRuntimeContext | null = null;
  private dynamicToolRegistry = new CodexDynamicToolRegistry();
  private notificationRouter: CodexNotificationRouter | null = null;
  private activeRun: CodexExecutionRun | null = null;
  private pendingTurnNotifications: Array<{ method: string; params: unknown }> = [];
  private connectionReleasePromise: Promise<void> | null = null;
  private forkIdentityPromise: Promise<CodexPendingForkTarget> | null = null;
  private forkSetupPromise: Promise<CodexEnsuredThread> | null = null;
  private disposePromise: Promise<void> | null = null;
  private completionRecovery: CompletionRecovery | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;

  private sessionSequence = 0;
  private readonly subagents = new CodexSubagentTracker(
    subagent => {
      this.#emitSessionEvent({ type: 'subagent_updated', subagent });
      this.#releaseRetiredConnection();
    },
    async threadId => {
      if (!this.transport) throw new Error('Codex CLI transport is unavailable');
      return (await this.transport.request<ThreadReadResult>('thread/read', { threadId, includeTurns: true }, 5_000)).thread;
    },
    () => this.#resolveTargetWorkingDirectory(),
  );

  hasBackgroundWork(): boolean { return this.threadScope?.hasBackgroundWork ?? false; }

  private threadId: string | null;
  private loadedThreadId: string | null = null;
  /** Sandbox mode in effect on the loaded thread; turn/start overrides persist across turns. */
  private loadedThreadSandbox: string | null = null;
  private loadedThreadSandboxRevision = 0;
  private loadedThreadBaseInstructions: string | null = null;
  private supportsApprovalReviewer = false;
  private sessionFilePath: string | null;
  private sessionFileLookupThreadId: string | null = null;
  private workspaceDependencyToolVersion: number | null;
  private pendingFork: CodexProviderState['forkSource'];
  private pendingForkTarget: CodexPendingForkTarget | undefined;
  private nativeConversationContextEstablished: boolean;
  private readonly providerStateDeletes = new Set<string>();
  private snapshot: ProviderSessionSnapshot;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly runtime: CodexAppServerRuntime,
  ) {
    this.seedState = Object.freeze({ ...(config.resumeSeed?.providerState ?? {}) });
    const codexState = this.seedState as CodexProviderState;
    this.pendingFork = codexState.forkSource;
    this.pendingForkTarget = this.pendingFork
      ? normalizePendingForkTarget(codexState.pendingForkTarget)
      : undefined;
    this.threadId = this.pendingForkTarget?.threadId
      ?? codexState.threadId
      ?? config.resumeSeed?.providerSessionId
      ?? null;
    this.nativeConversationContextEstablished = typeof codexState
      .nativeConversationContextEstablished === 'boolean'
      ? codexState.nativeConversationContextEstablished
      : this.threadId !== null || this.pendingFork !== undefined;
    this.sessionFilePath = this.pendingForkTarget?.sessionFilePath
      ?? codexState.sessionFilePath
      ?? null;
    this.workspaceDependencyToolVersion =
      codexState.workspaceDependencyToolVersion ?? null;
    this.snapshot = this.#buildSnapshot('idle', 0);
    this.serverRequestRouter = new CodexExecutionServerRequestRouter(
      this.sessionInstanceId,
      config.interactionPort,
      (threadId, turnId) => this.#observeNativeTurn(threadId, turnId),
    );
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) {
      throw new Error('Codex CLI execution session has been disposed.');
    }
    if (this.activeRun) {
      throw new Error('Codex CLI execution session already has an active requested run.');
    }

    const run = new CodexExecutionRun(
      this.sessionInstanceId,
      current => this.#cancelRun(current),
    );
    this.activeRun = run;
    run.attachAbortSignal(request.signal);
    if (!run.isCancellationRequested) {
      void this.#executeRun(run, request);
    }
    return run;
  }

  cancel(): void {
    if (this.activeRun) {
      this.activeRun.cancel();
      return;
    }
    this.serverRequestRouter.abortAll('cancelled');
    void this.threadScope?.stop();
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.snapshot;
  }

  getStatus(): ProviderSessionStatus {
    return this.snapshot.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.sessionEventListeners.add(listener);
    return () => {
      this.sessionEventListeners.delete(listener);
    };
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    try { assertCodexModelAvailable(this.plugin.settings, request.configuration.model); }
    catch (error) { if (error instanceof ProviderModelUnavailableError) return false; throw error; }
    const run = this.activeRun;
    const transport = this.transport;
    const nativeThreadId = run?.nativeThreadId;
    const nativeTurnId = run?.nativeTurnId;
    if (
      this.disposed
      || !run
      || run.isTerminal
      || run.isCancellationRequested
      || !nativeThreadId
      || !nativeTurnId
      || !transport
      || request.signal.aborted
    ) {
      return false;
    }

    const bundle = this.#buildInputBundle(request);
    try {
      const result = await this.threadScope!.steer<TurnSteerResult>({
        threadId: nativeThreadId,
        input: bundle.input,
        expectedTurnId: nativeTurnId,
      }, () => bundle.cleanup());
      if (
        !result
        || typeof result !== 'object'
        || result.turnId !== nativeTurnId
      ) {
        throw new Error('Codex CLI returned an ambiguous steer acknowledgement.');
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
    this.#cleanupInputBundles();
    this.notificationRouter?.endTurn();
    this.notificationRouter = null;
    this.pendingTurnNotifications = [];
    try {
      const processDisposal = this.#releaseConnectionAfterForkIdentity();
      const [processResult] = await Promise.allSettled([
        processDisposal,
        this.#settleForkSetup(),
      ]);
      if (processResult.status === 'rejected') {
        throw processResult.reason;
      }
    } finally {
      this.#updateSnapshot('disposed');
      this.#emitSessionState();
      this.sessionEventListeners.clear();
    }
  }

  async #executeRun(
    run: CodexExecutionRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    try {
      assertCodexModelAvailable(this.plugin.settings, request.configuration.model);
      let settings = this.#resolveProviderSettings();
      let model = this.#resolveModel(request, settings);
      if (!model) {
        this.#finishError(
          run,
          'configuration',
          'No Codex CLI model is selected. Enable a model in Claudian settings.',
          true,
        );
        return;
      }
      let effort = this.#resolveReasoningEffort(request, settings, model);

      if (
        request.toolPolicy.kind === 'allow-list'
        && !CODEX_SUPPORTS_EXACT_BUILT_IN_TOOL_ALLOW_LIST
      ) {
        this.#finishError(
          run,
          'configuration',
          'Codex CLI app-server does not support exact allow-list enforcement for provider built-in tools.',
          false,
        );
        return;
      }

      if (
        isCompactRequest(request)
        && !this.nativeConversationContextEstablished
      ) {
        this.#finishError(
          run,
          'configuration',
          'Codex CLI cannot compact before its native context is restored. Send a normal prompt first.',
          true,
        );
        return;
      }

      if (!this.#isRunCurrent(run, generation)) return;
      await this.#ensureConnection(generation, run.signal);
      if (!this.#isRunCurrent(run, generation)) return;
      settings = this.#resolveProviderSettings();
      model = this.#resolveModel(request, settings)!;
      effort = this.#resolveReasoningEffort(request, settings, model);

      const policy = this.#resolvePolicy(request, settings);
      const baseInstructions = this.#resolveBaseInstructions(request);
      const nativePersistence = this.#resolveNativePersistence();
      const replayConversationHistory = !this.nativeConversationContextEstablished;
      const thread = await this.#ensureThread(
        run,
        request,
        model,
        settings,
        policy,
        baseInstructions,
        nativePersistence,
        generation,
      );
      if (!this.#isRunCurrent(run, generation)) return;
      if (thread.forkCheckpoint) {
        this.nativeConversationContextEstablished = true;
      }

      run.nativeThreadId = thread.threadId;
      const threadIdentityChanged = this.threadId !== thread.threadId
        || (
          thread.sessionFilePath !== null
          && this.sessionFilePath !== thread.sessionFilePath
        );
      this.threadId = thread.threadId;
      if (thread.sessionFilePath) {
        this.sessionFilePath = thread.sessionFilePath;
      }
      if (threadIdentityChanged || this.snapshot.status !== 'executing') {
        this.#updateSnapshot('executing');
        this.#emitSnapshot(run);
      }

      if (policy.approvalsReviewer === 'auto_review' && !this.supportsApprovalReviewer) {
        throw new Error('Codex CLI did not enable automatic approval review. Update Codex or choose Ask for approval.');
      }

      this.notificationRouter = new CodexNotificationRouter(
        chunk => this.handleStreamChunk(run, chunk),
        this.#resolveTargetWorkingDirectory(),
      );
      this.notificationRouter.beginTurn();
      this.pendingTurnNotifications = [];

      assertCodexModelAvailable(this.plugin.settings, request.configuration.model);
      if (isCompactRequest(request)) {
        if (!await this.#allowRequestedTurn(run, generation)) return;
        run.nativeStartSubmitted = true;
        await this.threadScope!.startTurn<ThreadCompactStartResult>(
          'thread/compact/start',
          { threadId: thread.threadId },
        );
        return;
      }
      if (startsWithCompactCommand(request)) {
        this.#finishError(
          run,
          'configuration',
          '/compact does not accept arguments',
          true,
        );
        return;
      }

      const turnInput = this.#buildTurnPrompt(
        request,
        thread.forkCheckpoint,
        replayConversationHistory,
      );
      const bundle = this.#buildInputBundle(request, turnInput);
      this.activeInputBundles.add(bundle);
      const serviceTier = resolveCodexServiceTier(
        request.configuration.serviceTier ?? settings.serviceTier,
        model,
        settings,
      );
      const collaborationMode = {
        mode: 'default' as const,
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: null,
        },
      };

      const sandboxPolicy = await this.#resolveTurnSandboxPolicy(policy);
      if (!this.#isRunCurrent(run, generation)) return;
      // The override may take effect before, or without, its acknowledgement.
      const sandboxRevision = sandboxPolicy
        ? this.#setLoadedThreadSandbox(null)
        : null;

      if (!await this.#allowRequestedTurn(run, generation)) return;
      run.nativeStartSubmitted = true;
      this.activeInputBundles.delete(bundle);
      const result = await this.threadScope!.startTurn<TurnStartResult>('turn/start', {
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
      }, () => bundle.cleanup());
      if (sandboxRevision === this.loadedThreadSandboxRevision) {
        this.#setLoadedThreadSandbox(policy.sandbox);
      }
      this.#markNativeConversationContextEstablished(run);
      if (run.isCancellationRequested) {
        run.nativeTurnId = result.turn.id;
      }
      if (!this.#isRunCurrent(run, generation)) return;
      this.#observeNativeTurn(thread.threadId, result.turn.id);
    } catch (error) {
      if (!this.#isRunCurrent(run, generation) || run.isCancellationRequested) {
        return;
      }
      this.#handleExecutionFailure(run, error);
    }
  }

  async #ensureConnection(generation: number, signal: AbortSignal): Promise<void> {
    await this.connectionReleasePromise;
    await this.threadScope?.waitUntilReady();
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('Codex CLI execution session has been disposed.');
    }
    // Acquisition also waits out provider transitions and checks the launch fingerprint.
    const lease = await this.runtime.acquire({ signal });
    if (this.disposed || generation !== this.lifecycleGeneration) {
      await lease.release();
      return;
    }
    if (this.connection === lease.connection) {
      await lease.release();
      return;
    }
    if (this.connection?.isAlive() && this.threadScope?.hasWork) {
      await lease.release();
      throw new Error('Codex background work is still draining from the previous environment. Retry when it finishes.');
    }
    if (this.#resolveNativePersistence() === false && this.threadId) {
      await lease.release();
      throw new Error('This non-persistent Codex CLI session cannot be restored after its process ends. Start a new side chat.');
    }
    await this.#releaseConnection();
    if (this.disposed || generation !== this.lifecycleGeneration) {
      await lease.release();
      return;
    }
    const connection = lease.connection;
    this.connection = connection;
    this.transport = connection.transport;
    this.launchSpec = connection.launchSpec;
    this.runtimeContext = await connection.initialized;
    this.dynamicToolRegistry = new CodexDynamicToolRegistry();
    this.dynamicToolRegistry.register(createCodexWorkspaceDependencyTool(this.runtimeContext));
    this.serverRequestRouter.setDynamicToolRegistry(this.dynamicToolRegistry);
    this.threadScope = connection.createThreadScope({
      notification: (method, params) => this.handleNotification(method, params),
      serverRequest: (id, method, params) => this.serverRequestRouter.handleServerRequest(id, method, params),
      stop: () => this.dispose(),
      workChanged: () => this.#releaseRetiredConnection(),
    });
    await lease.release();
    const offExit = connection.onExit(() => this.#handleConnectionExit(connection));
    const offRetire = connection.onRetired(() => this.#releaseRetiredConnection());
    this.detachConnectionListeners = () => { offExit(); offRetire(); };
  }

  #releaseRetiredConnection(): void {
    if (this.connection?.isRetired() && !this.activeRun && !this.threadScope?.hasWork) {
      void this.#releaseConnection().catch(() => undefined);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const scope = extractNotificationScope(method, params);
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
      const run = this.activeRun;
      this.lifecycleGeneration++;
      void this.#releaseConnection().catch(() => undefined);
      if (run && !run.isTerminal) this.#finishError(run, 'provider', 'Codex thread was closed.', true);
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

    const run = this.activeRun;
    if (!run || run.isTerminal || run.isCancellationRequested) return;
    if (method === 'turn/started') {
      const started = params as TurnStartedNotification;
      this.#observeNativeTurn(started.threadId, started.turn.id);
      return;
    }

    if (method === 'thread/status/changed') {
      const changed = params as ThreadStatusChangedNotification;
      if (changed.threadId !== run.nativeThreadId) return;
      if (changed.status.type === 'idle') {
        this.#observeThreadIdle(run);
      } else {
        this.#cancelMissedTurnCompletionRecovery();
      }
      return;
    }

    if (scope) {
      if (!run.nativeTurnId) {
        this.pendingTurnNotifications.push({ method, params });
        return;
      }
      if (!this.#observeNativeTurn(scope.threadId, scope.turnId)) return;
      if (
        scope.threadId !== run.nativeThreadId
        || scope.turnId !== run.nativeTurnId
      ) {
        return;
      }
    } else if (!run.nativeTurnId) {
      this.pendingTurnNotifications.push({ method, params });
      return;
    }

    this.#captureResponseUsage(run, method, params);
    if (method === 'turn/completed') {
      this.#cancelMissedTurnCompletionRecovery();
      const completed = params as TurnCompletedNotification;
      run.completion = {
        status: completed.turn.status === 'inProgress'
          ? 'failed'
          : completed.turn.status,
        nativeTurnId: completed.turn.id,
        durationMs: completed.turn.durationMs,
        ...(completed.turn.error?.message
          ? { errorMessage: completed.turn.error.message }
          : {}),
      };
    }
    this.notificationRouter?.handleNotification(method, params);
  }

  #observeThreadIdle(run: CodexExecutionRun): void {
    let recovery = this.completionRecovery;
    if (
      !recovery
      || recovery.run !== run
      || recovery.generation !== this.lifecycleGeneration
    ) {
      this.#cancelMissedTurnCompletionRecovery();
      recovery = {
        run,
        generation: this.lifecycleGeneration,
        attempt: 0,
        inFlight: false,
        timer: null,
      };
      this.completionRecovery = recovery;
    }
    this.#scheduleMissedTurnCompletionRecovery(
      recovery,
      MISSED_TURN_COMPLETION_GRACE_MS,
    );
  }

  #scheduleMissedTurnCompletionRecovery(
    recovery: CompletionRecovery,
    delayMs: number,
  ): void {
    if (
      this.completionRecovery !== recovery
      || recovery.timer !== null
      || recovery.inFlight
      || !this.#isCompletionRecoveryCurrent(recovery)
      || !recovery.run.nativeTurnId
    ) {
      return;
    }
    recovery.timer = window.setTimeout(() => {
      recovery.timer = null;
      void this.#recoverMissedTurnCompletion(recovery);
    }, delayMs);
  }

  #cancelMissedTurnCompletionRecovery(): void {
    const recovery = this.completionRecovery;
    if (recovery && recovery.timer !== null) {
      window.clearTimeout(recovery.timer);
    }
    this.completionRecovery = null;
  }

  async #recoverMissedTurnCompletion(
    recovery: CompletionRecovery,
  ): Promise<void> {
    const { run } = recovery;
    const transport = this.transport;
    const threadId = run.nativeThreadId;
    const turnId = run.nativeTurnId;
    if (
      !transport
      || !threadId
      || !turnId
      || !this.#isCompletionRecoveryCurrent(recovery)
    ) {
      return;
    }
    recovery.attempt += 1;
    recovery.inFlight = true;

    let result: ThreadReadResult;
    try {
      result = await transport.request<ThreadReadResult>(
        'thread/read',
        { threadId, includeTurns: true },
        THREAD_READ_RECOVERY_TIMEOUT_MS,
      );
    } catch {
      recovery.inFlight = false;
      this.#retryOrFailMissedTurnCompletion(recovery);
      return;
    }
    if (!this.#isCompletionRecoveryCurrent(recovery)) return;
    recovery.inFlight = false;
    const turn = result.thread.turns.find(candidate => candidate.id === turnId);
    if (
      result.thread.id !== threadId
      || !turn
      || turn.status === 'inProgress'
    ) {
      this.#retryOrFailMissedTurnCompletion(recovery);
      return;
    }
    this.#replayRecoveredTurnItems(threadId, turn);
    this.handleNotification('turn/completed', { threadId, turn });
  }

  #retryOrFailMissedTurnCompletion(
    recovery: CompletionRecovery,
  ): void {
    if (!this.#isCompletionRecoveryCurrent(recovery)) return;
    if (recovery.attempt < MISSED_TURN_COMPLETION_MAX_ATTEMPTS) {
      const retryDelay = MISSED_TURN_COMPLETION_RETRY_BASE_MS
        * (2 ** (recovery.attempt - 1));
      this.#scheduleMissedTurnCompletionRecovery(recovery, retryDelay);
      return;
    }

    this.#cancelMissedTurnCompletionRecovery();
    this.#finishError(
      recovery.run,
      'provider',
      'Codex CLI became idle, but its completed turn could not be recovered.',
      true,
    );
  }

  #isCompletionRecoveryCurrent(
    recovery: CompletionRecovery,
  ): boolean {
    const { run, generation } = recovery;
    return (
      this.completionRecovery === recovery
      && this.activeRun === run
      && !run.isTerminal
      && !run.isCancellationRequested
      && generation === this.lifecycleGeneration
    );
  }

  #replayRecoveredTurnItems(
    threadId: string,
    turn: ThreadReadResult['thread']['turns'][number],
  ): void {
    for (const item of turn.items) {
      this.handleNotification('item/completed', {
        threadId,
        turnId: turn.id,
        item,
      });
    }
  }

  #observeNativeTurn(threadId: string, nativeTurnId: string): boolean {
    const run = this.activeRun;
    if (
      !run
      || run.isTerminal
      || run.isCancellationRequested
      || run.nativeThreadId !== threadId
    ) {
      return false;
    }
    if (run.nativeTurnId && run.nativeTurnId !== nativeTurnId) {
      return false;
    }
    this.#markNativeConversationContextEstablished(run);
    if (!run.nativeTurnId) {
      run.nativeTurnId = nativeTurnId;
      this.serverRequestRouter.setActiveTurn({
        localTurnId: run.turnId,
        nativeThreadId: threadId,
        nativeTurnId,
        toolPolicy: this.currentRunToolPolicy ?? { kind: 'provider-default' },
      });
      run.emit({
        type: 'turn_started',
        scope: run.createScope(),
        accepted: true,
        nativeTurnId,
      });
      this.#flushPendingTurnNotifications(run);
      const recovery = this.completionRecovery;
      if (recovery?.run === run) {
        this.#scheduleMissedTurnCompletionRecovery(
          recovery,
          MISSED_TURN_COMPLETION_GRACE_MS,
        );
      }
    }
    return true;
  }

  #markNativeConversationContextEstablished(
    run: CodexExecutionRun,
  ): void {
    if (this.nativeConversationContextEstablished) return;
    this.nativeConversationContextEstablished = true;
    this.#publishNativeOwnershipSnapshot(run);
  }

  private currentRunToolPolicy: ProviderToolPolicy | null = null;

  #flushPendingTurnNotifications(run: CodexExecutionRun): void {
    const pending = this.pendingTurnNotifications;
    this.pendingTurnNotifications = [];
    for (const notification of pending) {
      const scope = extractNotificationScope(
        notification.method,
        notification.params,
      );
      if (
        scope
        && (
          scope.threadId !== run.nativeThreadId
          || scope.turnId !== run.nativeTurnId
        )
      ) {
        continue;
      }
      this.#captureResponseUsage(run, notification.method, notification.params);
      if (notification.method === 'turn/completed') {
        const completed = notification.params as TurnCompletedNotification;
        run.completion = {
          status: completed.turn.status === 'inProgress'
            ? 'failed'
            : completed.turn.status,
          nativeTurnId: completed.turn.id,
        durationMs: completed.turn.durationMs,
          ...(completed.turn.error?.message
            ? { errorMessage: completed.turn.error.message }
            : {}),
        };
      }
      this.notificationRouter?.handleNotification(
        notification.method,
        notification.params,
      );
    }
  }

  private handleStreamChunk(run: CodexExecutionRun, chunk: StreamChunk): void {
    if (this.activeRun !== run || run.isTerminal) return;
    if (chunk.type === 'error') {
      this.#finishError(
        run,
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
      const completion = run.completion;
      if (completion?.status === 'failed') {
        this.#finishError(
          run,
          'provider',
          completion.errorMessage ?? 'Codex CLI turn failed.',
          true,
        );
      } else if (
        completion?.status === 'interrupted'
        || run.isCancellationRequested
      ) {
        this.#finishCancelled(run);
      } else {
        this.#finishCompleted(run, completion?.nativeTurnId);
      }
      return;
    }

    const event = adaptCodexStreamChunk(chunk, run.createScope());
    if (event) run.emit(event);
  }

  async #ensureThread(
    run: CodexExecutionRun,
    request: ProviderExecutionRequest,
    model: string,
    settings: Record<string, unknown>,
    policy: CodexPolicy,
    baseInstructions: string,
    persistExtendedHistory: boolean | undefined,
    generation: number,
  ): Promise<CodexEnsuredThread> {
    this.currentRunToolPolicy = request.toolPolicy;
    if (this.threadId) this.threadScope!.claim(this.threadId);
    if (
      this.pendingFork
      && (this.pendingForkTarget !== undefined || !this.threadId)
    ) {
      return this.#ensureForkThread(
        run,
        request,
        model,
        settings,
        policy,
        baseInstructions,
        persistExtendedHistory,
        generation,
      );
    }

    if (
      this.threadId
      && (
        this.loadedThreadId !== this.threadId
        || this.loadedThreadBaseInstructions !== baseInstructions
      )
    ) {
      if (persistExtendedHistory === false) {
        throw new Error('This non-persistent Codex CLI session cannot be restored after its configuration changes. Start a new side chat.');
      }
      const result = await this.threadScope!.open<ThreadResumeResult>(
        'thread/resume',
        {
          threadId: this.threadId,
          model,
          approvalPolicy: policy.approvalPolicy,
          approvalsReviewer: policy.approvalsReviewer,
          sandbox: policy.sandbox,
          serviceTier: resolveCodexServiceTier(
            request.configuration.serviceTier ?? settings.serviceTier,
            model,
            settings,
          ),
          baseInstructions: this.workspaceDependencyToolVersion === null
            ? `${baseInstructions}\n\n${LEGACY_WORKSPACE_DEPENDENCY_INSTRUCTIONS}`
            : baseInstructions,
          experimentalRawEvents: true,
          ...(persistExtendedHistory !== undefined
            ? { persistExtendedHistory }
            : {}),
        },
      );
      this.#recordApprovalReviewer(result, policy.approvalsReviewer);
      this.subagents.seed(result.thread);
      this.loadedThreadId = result.thread.id;
      this.#setLoadedThreadSandbox(sandboxModeOf(result.sandbox));
      this.loadedThreadBaseInstructions = baseInstructions;
      return {
        threadId: result.thread.id,
        sessionFilePath: this.#toHostSessionPath(result.thread.path),
      };
    }

    if (this.threadId) {
      return {
        threadId: this.threadId,
        sessionFilePath: this.sessionFilePath,
      };
    }

    const dynamicTools = shouldExposeDynamicTools(request.toolPolicy)
      ? this.dynamicToolRegistry.getThreadStartSpecs().filter(spec =>
        isThreadStartToolAllowed(request.toolPolicy, spec.namespace, spec.name)
      )
      : [];
    const result = await this.threadScope!.open<ThreadStartResult>(
      'thread/start',
      {
        model,
        cwd: this.#resolveTargetWorkingDirectory(),
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandbox: policy.sandbox,
        serviceTier: resolveCodexServiceTier(
          request.configuration.serviceTier ?? settings.serviceTier,
          model,
          settings,
        ),
        baseInstructions,
        experimentalRawEvents: true,
        ...(persistExtendedHistory === false
          ? { ephemeral: true }
          : {}),
        ...(persistExtendedHistory !== undefined
          ? { persistExtendedHistory }
          : {}),
        ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      },
    );
    this.#recordApprovalReviewer(result, policy.approvalsReviewer);
    this.loadedThreadId = result.thread.id;
    this.#setLoadedThreadSandbox(sandboxModeOf(result.sandbox));
    this.loadedThreadBaseInstructions = baseInstructions;
    this.workspaceDependencyToolVersion = dynamicTools.some(spec =>
      spec.namespace === CODEX_WORKSPACE_DEPENDENCY_TOOL_NAMESPACE
      && spec.name === CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME
    )
      ? CODEX_WORKSPACE_DEPENDENCY_TOOL_VERSION
      : null;
    const sessionFilePath = this.#toHostSessionPath(result.thread.path);
    this.threadId = result.thread.id;
    this.sessionFilePath = sessionFilePath;
    this.#publishNativeOwnershipSnapshot(run);
    return {
      threadId: result.thread.id,
      sessionFilePath,
    };
  }

  #ensureForkThread(
    run: CodexExecutionRun,
    request: ProviderExecutionRequest,
    model: string,
    settings: Record<string, unknown>,
    policy: CodexPolicy,
    baseInstructions: string,
    persistExtendedHistory: boolean | undefined,
    generation: number,
  ): Promise<CodexEnsuredThread> {
    if (this.forkSetupPromise) return this.forkSetupPromise;
    const transport = this.transport;
    if (!transport || !this.pendingFork) {
      return Promise.reject(new Error('Codex CLI fork setup is not available.'));
    }

    const setup = this.#materializeForkThread(
      run,
      request,
      model,
      settings,
      policy,
      baseInstructions,
      persistExtendedHistory,
      generation,
      transport,
    );
    this.forkSetupPromise = setup;
    void setup.then(
      () => this.#clearForkSetup(setup),
      () => this.#clearForkSetup(setup),
    );
    return setup;
  }

  async #materializeForkThread(
    run: CodexExecutionRun,
    request: ProviderExecutionRequest,
    model: string,
    settings: Record<string, unknown>,
    policy: CodexPolicy,
    baseInstructions: string,
    persistExtendedHistory: boolean | undefined,
    generation: number,
    transport: CodexRPCTransport,
  ): Promise<CodexEnsuredThread> {
    const fork = this.pendingFork;
    if (!fork) throw new Error('Codex CLI fork source is not available.');

    let target = this.pendingForkTarget;
    if (!target) {
      target = await this.#resolveForkIdentity(run, fork, persistExtendedHistory === false ? {
        ephemeral: true,
        excludeTurns: true,
        lastTurnId: fork.resumeAt,
        model,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandbox: policy.sandbox,
        serviceTier: resolveCodexServiceTier(request.configuration.serviceTier ?? settings.serviceTier, model, settings),
        baseInstructions: `${baseInstructions}\n\n${LEGACY_WORKSPACE_DEPENDENCY_INSTRUCTIONS}`,
        experimentalRawEvents: true,
        persistExtendedHistory: false,
      } : {});
    }

    if (!this.#isRunCurrent(run, generation)) {
      throw new Error('Codex CLI fork setup was interrupted after child adoption.');
    }

    if (persistExtendedHistory === false) {
      // thread/fork already loaded the ephemeral child at the captured checkpoint.
      this.loadedThreadId = target.threadId;
      this.loadedThreadBaseInstructions = baseInstructions;
      this.#consumePendingForkState();
      this.#updateSnapshot('idle');
      this.#emitSnapshot(run);
      return { threadId: target.threadId, sessionFilePath: null };
    }

    const resumeResult = await this.threadScope!.open<ThreadResumeResult>(
      'thread/resume',
      {
        threadId: target.threadId,
        model,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandbox: policy.sandbox,
        serviceTier: resolveCodexServiceTier(
          request.configuration.serviceTier ?? settings.serviceTier,
          model,
          settings,
        ),
        baseInstructions: `${baseInstructions}\n\n${LEGACY_WORKSPACE_DEPENDENCY_INSTRUCTIONS}`,
        experimentalRawEvents: true,
        ...(persistExtendedHistory !== undefined
          ? { persistExtendedHistory }
          : {}),
      },
    );
    if (!this.#isRunCurrent(run, generation)) {
      throw new Error('Codex CLI fork setup was interrupted while resuming the child.');
    }
    if (resumeResult.thread.id !== target.threadId) {
      throw new Error('Codex CLI resumed a different thread than the owned fork target.');
    }

    this.#recordApprovalReviewer(resumeResult, policy.approvalsReviewer);
    this.loadedThreadId = target.threadId;
    this.#setLoadedThreadSandbox(sandboxModeOf(resumeResult.sandbox));
    this.loadedThreadBaseInstructions = baseInstructions;
    const checkpointIndex = resumeResult.thread.turns.findIndex(
      turn => turn.id === fork.resumeAt,
    );
    if (checkpointIndex < 0) {
      throw new Error(`Fork checkpoint not found: ${fork.resumeAt}`);
    }
    const rollbackCount = resumeResult.thread.turns.length - checkpointIndex - 1;
    if (rollbackCount > 0) {
      const rollbackResult = await transport.request<ThreadRollbackResult>(
        'thread/rollback',
        {
          threadId: target.threadId,
          numTurns: rollbackCount,
        },
      );
      if (!this.#isRunCurrent(run, generation)) {
        throw new Error('Codex CLI fork setup was interrupted while rolling back the child.');
      }
      if (rollbackResult.thread.id !== target.threadId) {
        throw new Error('Codex CLI rolled back a different thread than the owned fork target.');
      }
    }

    this.#consumePendingForkState();
    this.#updateSnapshot('idle');
    this.#emitSnapshot(run);
    return {
      threadId: target.threadId,
      sessionFilePath: target.sessionFilePath ?? null,
      forkCheckpoint: fork.resumeAt,
    };
  }

  #resolveForkIdentity(
    run: CodexExecutionRun,
    fork: NonNullable<CodexProviderState['forkSource']>,
    overrides: Record<string, unknown> = {},
  ): Promise<CodexPendingForkTarget> {
    if (this.forkIdentityPromise) return this.forkIdentityPromise;

    const pathMapper = this.launchSpec?.pathMapper;
    const identity = this.threadScope!.open<ThreadForkResult>(
      'thread/fork',
      { threadId: fork.sessionId, ...overrides },
    ).then((forkResult) => {
      this.#recordApprovalReviewer(forkResult, overrides.approvalsReviewer);
      this.#setLoadedThreadSandbox(sandboxModeOf(forkResult.sandbox));
      const threadId = normalizeString(forkResult.thread.id);
      if (!threadId) {
        throw new Error('Codex CLI fork did not return a child thread ID.');
      }
      const sessionFilePath = forkResult.thread.path
        ? pathMapper?.toHostPath(forkResult.thread.path) ?? forkResult.thread.path
        : null;
      const target: CodexPendingForkTarget = {
        threadId,
        ...(sessionFilePath
          ? { sessionFilePath }
          : {}),
      };
      this.#adoptPendingForkTarget(run, target);
      return target;
    });
    this.forkIdentityPromise = identity;
    void identity.then(
      () => this.#clearForkIdentity(identity),
      () => this.#clearForkIdentity(identity),
    );
    return identity;
  }

  #adoptPendingForkTarget(
    run: CodexExecutionRun,
    target: CodexPendingForkTarget,
  ): void {
    this.pendingForkTarget = target;
    this.threadId = target.threadId;
    this.sessionFilePath = target.sessionFilePath ?? null;
    this.#updateSnapshot('idle');
    this.#emitSnapshot(run);
  }

  #clearForkSetup(setup: Promise<CodexEnsuredThread>): void {
    if (this.forkSetupPromise === setup) {
      this.forkSetupPromise = null;
    }
  }

  #clearForkIdentity(
    identity: Promise<CodexPendingForkTarget>,
  ): void {
    if (this.forkIdentityPromise === identity) {
      this.forkIdentityPromise = null;
    }
  }

  async #settleForkIdentity(): Promise<void> {
    const identity = this.forkIdentityPromise;
    if (!identity) return;
    try {
      await identity;
    } catch {
      // A rejected fork request exposes no child identity to retain.
    }
  }

  async #settleForkSetup(): Promise<void> {
    const setup = this.forkSetupPromise;
    if (!setup) return;
    try {
      await setup;
    } catch {
      // The active run owns error or cancellation projection.
    }
  }

  #cancelRun(run: CodexExecutionRun, finishCancelled = true): void {
    if (this.activeRun !== run || run.isTerminal) return;
    this.#cancelMissedTurnCompletionRecovery();
    this.lifecycleGeneration++;
    this.serverRequestRouter.abortAll('cancelled');
    const stopping = this.threadScope?.stop() ?? Promise.resolve();
    if (finishCancelled && this.forkSetupPromise) {
      void Promise.allSettled([stopping, this.#settleForkSetup()]).then(() => this.#finishCancelled(run));
    } else if (finishCancelled) {
      this.#finishCancelled(run);
    }
  }

  async #allowRequestedTurn(run: CodexExecutionRun, generation: number): Promise<boolean> {
    await this.threadScope!.beforeTurn();
    return this.#isRunCurrent(run, generation);
  }

  #captureResponseUsage(run: CodexExecutionRun, method: string, params: unknown): void {
    if (method !== 'rawResponse/completed' || !params || typeof params !== 'object') return;
    const response = params as { threadId?: string; turnId?: string; responseId?: string; usage?: { outputTokens?: unknown } };
    if (response.threadId !== run.nativeThreadId || response.turnId !== run.nativeTurnId || !response.responseId) return;
    run.responseTokens.set(response.responseId, isTokenCount(response.usage?.outputTokens) ? response.usage.outputTokens : undefined);
  }

  #finishCompleted(
    run: CodexExecutionRun,
    nativeCheckpointId?: string,
  ): void {
    if (this.activeRun !== run || run.isTerminal) return;
    this.#finishRunState(run);
    const counts = [...run.responseTokens.values()];
    const turnStats = createTurnStats(
      counts.length > 0 && counts.every(isTokenCount) ? counts.reduce((sum, count) => sum + count, 0) : undefined,
      run.completion?.durationMs,
    );
    run.finish({
      type: 'turn_completed',
      ...(turnStats ? { turnStats } : {}),
      scope: run.createScope(),
      reason: 'completed',
      // Codex forks resume at turn IDs, not streaming agent-message item IDs.
      ...(nativeCheckpointId ? { nativeAssistantId: nativeCheckpointId, nativeCheckpointId } : {}),
    });
    this.#releaseRun(run);
  }

  #finishCancelled(run: CodexExecutionRun): void {
    if (this.activeRun !== run || run.isTerminal) return;
    this.#finishRunState(run);
    run.finish({
      type: 'cancelled',
      scope: run.createScope(),
      reason: 'cancelled',
    });
    this.#releaseRun(run);
  }

  #finishError(
    run: CodexExecutionRun,
    category: ProviderExecutionErrorCategory,
    message: string,
    recoverable: boolean,
    missingProviderSessionId?: string,
  ): void {
    if (this.activeRun !== run || run.isTerminal) return;
    const shouldInvalidate =
      category === 'provider-session-missing'
      || category === 'process-exited'
      || category === 'transport';
    if (shouldInvalidate) {
      const reason: ProviderSessionInvalidation['reason'] =
        category === 'provider-session-missing'
          ? 'provider-session-missing'
          : category === 'process-exited'
            ? 'process-exited'
            : 'transport-closed';
      this.#updateSnapshot('invalidated', {
        reason,
        recoverable,
        message,
      });
    } else {
      this.#updateSnapshot('idle');
    }
    this.#emitSnapshot(run);
    run.finish({
      type: 'execution_error',
      scope: run.createScope(),
      category,
      message,
      recoverable,
      ...(missingProviderSessionId ? { missingProviderSessionId } : {}),
    });
    this.#releaseRun(run);
  }

  #finishRunState(run: CodexExecutionRun): void {
    this.#updateSnapshot('idle');
    this.#emitSnapshot(run);
  }

  #releaseRun(run: CodexExecutionRun): void {
    this.#cancelMissedTurnCompletionRecovery();
    this.notificationRouter?.endTurn();
    this.notificationRouter = null;
    this.pendingTurnNotifications = [];
    this.serverRequestRouter.abortAll(
      run.isCancellationRequested ? 'cancelled' : 'resolved',
    );
    this.#cleanupInputBundles();
    this.currentRunToolPolicy = null;
    if (this.activeRun === run) {
      this.activeRun = null;
    }
    this.#discoverSessionFile();
    this.#releaseRetiredConnection();
  }

  #handleExecutionFailure(
    run: CodexExecutionRun,
    error: unknown,
  ): void {
    const message = error instanceof Error
      ? error.message
      : 'Unknown Codex CLI error';
    if (isMissingThreadError(message)) {
      this.#finishError(
        run,
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
    if (category === 'transport' && run.nativeStartSubmitted) this.#cancelRun(run, false);
    this.#finishError(run, category, message, category === 'transport');
  }

  #handleConnectionExit(connection: CodexAppServerConnection): void {
    if (this.connection !== connection || this.disposed) return;
    this.lifecycleGeneration += 1;
    const run = this.activeRun;
    // The dead transport cannot deliver an unresolved fork identity.
    const processDisposal = this.#releaseConnection();
    if (run && !run.isTerminal && !run.isCancellationRequested) {
      const forkSetup = this.forkSetupPromise;
      if (forkSetup) {
        void Promise.allSettled([
          processDisposal,
          this.#settleForkSetup(),
        ]).then(() => {
          this.#finishError(
            run,
            'process-exited',
            'Codex CLI app-server process exited unexpectedly.',
            true,
          );
        });
      } else {
        this.#finishError(
          run,
          'process-exited',
          'Codex CLI app-server process exited unexpectedly.',
          true,
        );
      }
    } else {
      this.#updateSnapshot('invalidated', {
        reason: 'process-exited',
        recoverable: true,
        message: 'Codex CLI app-server process exited unexpectedly.',
      });
      this.#emitSessionState();
    }
    void processDisposal.catch(() => undefined);
  }

  async #releaseConnectionAfterForkIdentity(): Promise<void> {
    await this.#settleForkIdentity();
    await this.#releaseConnection();
  }

  #releaseConnection(): Promise<void> {
    if (this.connectionReleasePromise) return this.connectionReleasePromise;
    const scope = this.threadScope;
    this.threadScope = null;
    this.connection = null;
    this.transport = null;
    this.detachConnectionListeners?.();
    this.detachConnectionListeners = null;
    this.launchSpec = null;
    this.runtimeContext = null;
    this.subagents.clear();
    this.loadedThreadId = null;
    this.#setLoadedThreadSandbox(null);
    this.loadedThreadBaseInstructions = null;
    this.supportsApprovalReviewer = false;
    this.dynamicToolRegistry = new CodexDynamicToolRegistry();
    this.serverRequestRouter.setDynamicToolRegistry(null);
    const pending = scope?.detach() ?? Promise.resolve();
    this.connectionReleasePromise = pending;
    void pending.finally(() => {
      if (this.connectionReleasePromise === pending) this.connectionReleasePromise = null;
    }).catch(() => undefined);
    return pending;
  }

  #emitSnapshot(run: CodexExecutionRun): void {
    run.emit({
      type: 'session_state_changed',
      scope: run.createScope(),
      snapshot: this.snapshot,
    });
  }

  #emitSessionState(): void {
    this.#emitSessionEvent({ type: 'session_state_changed', snapshot: this.snapshot });
  }

  #emitSessionEvent(event: Omit<Extract<ProviderSessionEvent, { type: 'session_state_changed' }>, 'scope'>
    | Omit<Extract<ProviderSessionEvent, { type: 'subagent_updated' }>, 'scope'>): void {
    const scoped = { ...event, scope: {
      kind: 'session' as const, sessionInstanceId: this.sessionInstanceId, sequence: ++this.sessionSequence,
    } };
    for (const listener of this.sessionEventListeners) {
      try { listener(scoped); } catch { /* Listeners cannot interrupt native event handling. */ }
    }
  }

  #publishNativeOwnershipSnapshot(run: CodexExecutionRun): void {
    const currentSnapshot = this.snapshot;
    const isCurrentExecution = (
      this.activeRun === run
      && !run.isTerminal
      && !run.isCancellationRequested
      && !this.disposed
      && currentSnapshot.status !== 'invalidated'
      && currentSnapshot.status !== 'disposed'
      && currentSnapshot.status !== 'cancelling'
    );
    if (isCurrentExecution) {
      this.#updateSnapshot('executing');
    } else if (currentSnapshot.status === 'invalidated') {
      this.#updateSnapshot('invalidated', currentSnapshot.invalidation);
    } else {
      this.#updateSnapshot(currentSnapshot.status);
    }
    if (this.activeRun === run && !run.isTerminal) {
      this.#emitSnapshot(run);
    } else {
      this.#emitSessionState();
    }
  }

  #updateSnapshot(
    status: ProviderSessionStatus,
    invalidation?: ProviderSessionInvalidation,
  ): void {
    this.snapshot = status === 'invalidated'
      ? this.#buildSnapshot(status, this.snapshot.revision + 1, invalidation)
      : this.#buildSnapshot(status, this.snapshot.revision + 1);
  }

  #buildSnapshot(
    status: ProviderSessionStatus,
    revision: number,
    invalidation?: ProviderSessionInvalidation,
  ): ProviderSessionSnapshot {
    const providerState = {
      ...this.seedState,
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
      ...(this.#resolveTranscriptRootHost()
        ? { transcriptRootPath: this.#resolveTranscriptRootHost()! }
        : {}),
      ...(this.workspaceDependencyToolVersion !== null
        ? {
            workspaceDependencyToolVersion:
              this.workspaceDependencyToolVersion,
          }
        : {}),
      ...(this.pendingForkTarget
        ? { pendingForkTarget: { ...this.pendingForkTarget } }
        : {}),
    } as CodexProviderState & Record<string, unknown>;
    for (const key of this.providerStateDeletes) {
      delete providerState[key];
    }
    const providerStateDeletes = [...this.providerStateDeletes];
    const base = {
      providerId: this.providerId,
      revision,
      ...(this.threadId ? { providerSessionId: this.threadId } : {}),
      providerState: Object.freeze(providerState),
      ...(providerStateDeletes.length > 0
        ? { providerStateDeletes: Object.freeze(providerStateDeletes) }
        : {}),
    };
    if (status === 'invalidated') {
      const resolvedInvalidation: ProviderSessionInvalidation = invalidation ?? {
        reason: 'provider-error',
        recoverable: false,
      };
      return Object.freeze({
          ...base,
          status,
          invalidation: Object.freeze(resolvedInvalidation),
        });
    }
    return Object.freeze({ ...base, status });
  }

  #consumePendingForkState(): void {
    this.pendingFork = undefined;
    this.pendingForkTarget = undefined;
    for (const key of CODEX_CONSUMED_FORK_STATE_KEYS) {
      this.providerStateDeletes.add(key);
    }
  }

  #resolveProviderSettings(): Record<string, unknown> {
    const settings = this.plugin.settings as Record<string, unknown>;
    return {
      ...settings,
      model: readProviderProjection(settings, 'savedProviderModel')
        ?? settings.model,
      effortLevel: readProviderProjection(settings, 'savedProviderEffort')
        ?? settings.effortLevel,
      serviceTier: readProviderProjection(settings, 'savedProviderServiceTier')
        ?? settings.serviceTier,
      permissionMode: readProviderProjection(
        settings,
        'savedProviderPermissionMode',
      ) ?? settings.permissionMode,
    };
  }

  #resolveModel(
    request: ProviderExecutionRequest,
    settings: Record<string, unknown>,
  ): string | null {
    const selected = normalizeString(request.configuration.model)
      ?? normalizeString(settings.model);
    if (!selected) return null;
    const runtimeModel = toCodexRuntimeModelId(selected);
    const enabled = getCodexModelOptions(settings).some(
      option => toCodexRuntimeModelId(option.value) === runtimeModel,
    );
    return enabled ? runtimeModel : null;
  }

  #resolveReasoningEffort(
    request: ProviderExecutionRequest,
    settings: Record<string, unknown>,
    model: string,
  ): string | null {
    if (request.configuration.reasoning === null) return null;
    const codexSettings = getCodexProviderSettings(settings);
    const modelMetadata = findCodexModel(codexSettings.discoveredModels, model);
    const effort = resolveCodexReasoningEffort(
      modelMetadata,
      codexSettings.enableUltraEffort,
      normalizeString(request.configuration.reasoning)
        ?? normalizeString(settings.effortLevel),
    );
    if (request.configuration.reasoning !== undefined && (effort !== request.configuration.reasoning
      || (modelMetadata && !getCodexReasoningEffortOptions(modelMetadata, codexSettings.enableUltraEffort)
        .some(option => option.value === request.configuration.reasoning)))) {
      throw new Error(`Codex CLI model "${model}" does not support reasoning effort "${request.configuration.reasoning}".`);
    }
    if (!effort) {
      throw new Error(`Codex CLI model "${model}" has no enabled reasoning efforts.`);
    }
    return effort;
  }

  #resolveBaseInstructions(request: ProviderExecutionRequest): string {
    const base = request.configuration.systemInstructions.kind === 'explicit'
      ? request.configuration.systemInstructions.instructions
      : buildSystemPrompt(this.#getSystemPromptSettings(), {
          dynamicSections: request.configuration.systemInstructions.dynamicSections
            ? [...request.configuration.systemInstructions.dynamicSections]
            : undefined,
        });
    return request.toolPolicy.kind === 'passive'
      ? `${base}\n\n${PASSIVE_INSTRUCTIONS}`
      : base;
  }

  #getSystemPromptSettings(): SystemPromptSettings {
    return {
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      vaultPath: this.config.vaultWorkingDirectory,
      userName: this.plugin.settings.userName,
    };
  }

  #recordApprovalReviewer(result: ThreadStartResult, requested: unknown): void {
    // Older servers may ignore unknown request fields. Never claim automatic review in that case.
    this.supportsApprovalReviewer = typeof result.approvalsReviewer === 'string'
      && (requested !== 'auto_review' || result.approvalsReviewer === 'auto_review');
  }

  #resolveNativePersistence(): boolean | undefined {
    if (this.config.nativePersistence === 'enabled') return true;
    if (this.config.nativePersistence === 'disabled-if-supported') return false;
    return this.config.lifecycle === 'persistent';
  }

  #resolvePolicy(
    request: ProviderExecutionRequest,
    settings: Record<string, unknown>,
  ): CodexPolicy {
    const toolPolicy = request.toolPolicy;
    if (toolPolicy.kind === 'passive' || toolPolicy.kind === 'read-only') {
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        sandboxPolicy: strictReadOnlySandbox(),
      };
    }
    if (toolPolicy.kind === 'allow-list') {
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        sandboxPolicy: strictReadOnlySandbox(),
      };
    }
    if (toolPolicy.kind === 'unrestricted') {
      return {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    }

    const permissionMode =
      normalizeString(request.configuration.permissionMode)
      ?? normalizeString(settings.permissionMode)
      ?? 'auto-review';
    const safeMode = getCodexProviderSettings(settings).safeMode;
    const sandboxConfig = resolveCodexSandboxConfig(permissionMode, safeMode);
    return sandboxConfig.sandbox === 'danger-full-access'
      ? { ...sandboxConfig, sandboxPolicy: { type: 'dangerFullAccess' } }
      : sandboxConfig;
  }

  #setLoadedThreadSandbox(mode: string | null): number {
    this.loadedThreadSandbox = mode;
    return ++this.loadedThreadSandboxRevision;
  }

  async #resolveTurnSandboxPolicy(policy: CodexPolicy): Promise<SandboxPolicy | undefined> {
    if (policy.sandboxPolicy) return policy.sandboxPolicy;
    if (this.loadedThreadSandbox === policy.sandbox) return undefined;
    // turn/start cannot select a mode, and resuming a loaded thread ignores one, so a mode
    // switch must restore the policy Codex derives from the user's config for that mode.
    if (policy.sandbox !== 'workspace-write') return strictReadOnlySandbox();
    const { config } = await this.transport!.request<ConfigReadResult>('config/read', {
      cwd: this.#resolveTargetWorkingDirectory(),
    } satisfies ConfigReadParams);
    const configured = config.sandbox_workspace_write;
    return {
      type: 'workspaceWrite',
      writableRoots: configured?.writable_roots ?? [],
      networkAccess: configured?.network_access ?? false,
      excludeTmpdirEnvVar: configured?.exclude_tmpdir_env_var ?? false,
      excludeSlashTmp: configured?.exclude_slash_tmp ?? false,
    };
  }

  #buildTurnPrompt(
    request: ProviderExecutionRequest,
    forkCheckpoint?: string,
    replayConversationHistory = false,
  ): string {
    let prompt = request.input
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
    const context = request.context;
    prompt = appendSessionReferences(prompt, context?.sessionReferences, path => this.#mapRequiredHostPath(path));
    if (context?.linkedContent) {
      prompt = context.linkedContent.content === undefined
        ? appendLinkedContent(prompt, context.linkedContent.path)
        : appendLinkedContentBody(
          prompt,
          context.linkedContent.path,
          context.linkedContent.content,
        );
    }
    prompt = appendSelectionContexts(prompt, context);

    const history = request.conversationHistory;
    if (!history?.length) return prompt;
    if (forkCheckpoint) {
      const checkpointIndex = history.findIndex(
        message => message.assistantMessageId === forkCheckpoint,
      );
      if (checkpointIndex >= 0 && checkpointIndex < history.length - 1) {
        const suffix = buildContextFromHistory(
          history.slice(checkpointIndex + 1),
        );
        if (suffix.trim()) return `${suffix}\n\nUser: ${prompt}`;
      }
      return prompt;
    }
    if (replayConversationHistory) {
      const historyContext = buildContextFromHistory(history as ChatMessage[]);
      return buildPromptWithHistoryContext(
        historyContext || null,
        prompt,
        prompt,
        history as ChatMessage[],
      );
    }
    return prompt;
  }

  #buildInputBundle(
    request: ProviderExecutionRequest,
    promptOverride?: string,
  ): CodexInputBundle {
    const input: UserInput[] = [];
    let tempDirectory: string | null = null;
    const cleanup = () => {
      if (!tempDirectory) return;
      try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      } catch {
        // Temporary image cleanup is best-effort.
      }
      tempDirectory = null;
    };

    try {
      const images = request.input
        .filter(block => block.type === 'image')
        .map(block => block.image);
      if (images.length > 0) {
        tempDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), 'claudian-codex-images-'),
        );
        images.forEach((image, index) => {
          if (!image.mediaType.startsWith('image/')) return;
          const filePath = path.join(
            tempDirectory!,
            `${index + 1}-${toAttachmentFilename(image, index)}`,
          );
          fs.writeFileSync(filePath, Buffer.from(image.data, 'base64'));
          input.push({
            type: 'localImage',
            path: this.#mapRequiredHostPath(filePath),
          });
        });
      }

      const prompt = promptOverride ?? appendSelectionContexts(appendSessionReferences(
        request.input
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n\n'),
        request.context?.sessionReferences,
        path => this.#mapRequiredHostPath(path),
      ), request.context);
      if (prompt) {
        input.push({ type: 'text', text: prompt, text_elements: [] });
      }
      return { input, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  #cleanupInputBundles(): void {
    for (const bundle of this.activeInputBundles) bundle.cleanup();
    this.activeInputBundles.clear();
  }

  #resolveTargetWorkingDirectory(): string {
    if (!this.launchSpec) return this.config.vaultWorkingDirectory;
    const mapped = this.launchSpec.pathMapper.toTargetPath(
      this.config.vaultWorkingDirectory,
    );
    return mapped ?? this.launchSpec.targetCwd;
  }

  #mapRequiredHostPath(hostPath: string): string {
    const targetPath = this.#mapHostPathToTarget(hostPath);
    if (!targetPath) {
      throw new Error(
        `Codex CLI cannot access path from the selected target: ${hostPath}`,
      );
    }
    return targetPath;
  }

  #mapHostPathToTarget(hostPath: string | null): string | null {
    if (!hostPath) return null;
    return this.launchSpec?.pathMapper.toTargetPath(hostPath) ?? hostPath;
  }

  #toHostSessionPath(targetPath: string | null | undefined): string | null {
    if (!targetPath) return null;
    return this.launchSpec?.pathMapper.toHostPath(targetPath) ?? targetPath;
  }

  #resolveTranscriptRootHost(): string | null {
    return this.runtimeContext?.sessionsDirHost
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
    const currentSnapshot = this.snapshot;
    if (currentSnapshot.status === 'invalidated') {
      this.#updateSnapshot('invalidated', currentSnapshot.invalidation);
    } else {
      this.#updateSnapshot(currentSnapshot.status);
    }
    const run = this.activeRun;
    if (run && !run.isTerminal) {
      this.#emitSnapshot(run);
    } else {
      this.#emitSessionState();
    }
  }

  #isRunCurrent(
    run: CodexExecutionRun,
    generation: number,
  ): boolean {
    return (
      !this.disposed
      && generation === this.lifecycleGeneration
      && this.activeRun === run
      && !run.isTerminal
      && !run.isCancellationRequested
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

function readProviderProjection(
  settings: Record<string, unknown>,
  key: string,
): unknown {
  const map = settings[key];
  return map && typeof map === 'object' && !Array.isArray(map)
    ? (map as Record<string, unknown>).codex
    : undefined;
}

function resolveCodexSandboxConfig(
  permissionMode: string,
  safeMode: CodexSafeMode,
): Pick<CodexPolicy, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'> {
  if (permissionMode === 'yolo') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' };
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: permissionMode === 'auto-review' ? 'auto_review' : 'user',
    sandbox: safeMode,
  };
}

function sandboxModeOf(policy: SandboxPolicy | undefined): string | null {
  switch (policy?.type) {
    case 'dangerFullAccess': return 'danger-full-access';
    case 'workspaceWrite': return 'workspace-write';
    case 'readOnly': return 'read-only';
    default: return null;
  }
}

function strictReadOnlySandbox(): SandboxPolicy {
  return {
    type: 'readOnly',
    access: { type: 'fullAccess' },
    networkAccess: false,
  };
}

function resolveCodexServiceTier(
  serviceTier: unknown,
  modelId: string,
  settings: Record<string, unknown>,
): string | null {
  const model = findCodexModel(
    getCodexProviderSettings(settings).discoveredModels,
    modelId,
  );
  return resolveCodexModelServiceTier(model, serviceTier);
}

function shouldExposeDynamicTools(policy: ProviderToolPolicy): boolean {
  return (
    policy.kind === 'provider-default'
    || policy.kind === 'unrestricted'
    || policy.kind === 'allow-list'
  );
}

function isThreadStartToolAllowed(
  policy: ProviderToolPolicy,
  namespace: string | null | undefined,
  name: string,
): boolean {
  if (policy.kind === 'provider-default' || policy.kind === 'unrestricted') {
    return true;
  }
  if (policy.kind !== 'allow-list') return false;
  const qualified = namespace ? `${namespace}.${name}` : name;
  return policy.names.includes(name) || policy.names.includes(qualified);
}

function isCompactRequest(request: ProviderExecutionRequest): boolean {
  const text = request.input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
  return text.toLowerCase() === '/compact';
}

function startsWithCompactCommand(request: ProviderExecutionRequest): boolean {
  const text = request.input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
  return /^\/compact\s+/i.test(text);
}

function extractNotificationScope(
  method: string,
  params: unknown,
): { threadId: string; turnId: string } | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }
  const notification = params as Record<string, unknown>;
  const threadId = normalizeString(notification.threadId);
  if (!threadId) return null;
  if (method === 'turn/completed' || method === 'turn/started') {
    const turn = notification.turn;
    const turnId = turn && typeof turn === 'object' && !Array.isArray(turn)
      ? normalizeString((turn as Record<string, unknown>).id)
      : null;
    return turnId ? { threadId, turnId } : null;
  }
  const turnId = normalizeString(notification.turnId)
    ?? normalizeString(notification.turn_id);
  return turnId ? { threadId, turnId } : null;
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

function toAttachmentFilename(
  attachment: ImageAttachment,
  index: number,
): string {
  const sourceName = attachment.name.trim();
  const base = sourceName.replace(/[^A-Za-z0-9._-]/g, '_')
    || `image-${index + 1}`;
  if (base.includes('.')) return base;
  const subtype = attachment.mediaType.split('/')[1] ?? 'img';
  return `${base}.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}
