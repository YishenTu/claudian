import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
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
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ChatMessage, ImageAttachment, StreamChunk } from '../../../core/types';
import { appendCurrentNote } from '../../../utils/context';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '../../../utils/session';
import {
  deriveCodexMemoriesDirFromSessionsRoot,
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFile,
} from '../history/CodexHistoryStore';
import { getCodexModelOptions } from '../modelOptions';
import { findCodexModel } from '../models';
import { toCodexRuntimeModelId } from '../modelSelection';
import { CodexAppServerProcess } from '../runtime/CodexAppServerProcess';
import {
  initializeCodexAppServerTransport,
  resolveCodexAppServerLaunchSpec,
} from '../runtime/codexAppServerSupport';
import type {
  SandboxPolicy,
  ServerRequestResolvedNotification,
  ThreadCompactStartResult,
  ThreadForkResult,
  ThreadResumeResult,
  ThreadRollbackResult,
  ThreadStartResult,
  TurnCompletedNotification,
  TurnStartedNotification,
  TurnStartResult,
  TurnSteerResult,
  UserInput,
} from '../runtime/codexAppServerTypes';
import { CodexDynamicToolRegistry } from '../runtime/CodexDynamicToolRegistry';
import type { CodexLaunchSpec } from '../runtime/codexLaunchTypes';
import { CodexNotificationRouter } from '../runtime/CodexNotificationRouter';
import {
  CodexRpcResponseError,
  CodexRpcTransport,
} from '../runtime/CodexRpcTransport';
import {
  type CodexRuntimeContext,
  createCodexRuntimeContext,
} from '../runtime/CodexRuntimeContext';
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

const PASSIVE_INSTRUCTIONS =
  'Do not invoke tools. Complete the request only from the supplied input and context.';
const LEGACY_WORKSPACE_DEPENDENCY_INSTRUCTIONS =
  'This thread predates Claudian client-hosted workspace dependency tools. Do not emulate load_workspace_dependencies or install replacement dependencies.';
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

interface CodexPolicy {
  readonly approvalPolicy: string;
  readonly sandbox: string;
  readonly sandboxPolicy: SandboxPolicy;
}

interface CodexInputBundle {
  readonly input: UserInput[];
  cleanup(): void;
}

interface TurnCompletion {
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly nativeTurnId: string;
  readonly errorMessage?: string;
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

  private readonly queue = new AsyncEventQueue<ProviderExecutionEvent>(
    () => this.cancel(),
  );
  private sequence = 0;
  private terminal = false;
  private cancelRequested = false;
  private abortListener: (() => void) | null = null;

  nativeThreadId: string | null = null;
  nativeTurnId: string | null = null;
  completion: TurnCompletion | null = null;

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
    this.detachAbortSignal();
    this.queue.push(event);
    this.queue.close();
  }

  cancel(): void {
    if (this.cancelRequested || this.terminal) return;
    this.cancelRequested = true;
    this.cancelRun(this);
  }

  attachAbortSignal(signal: AbortSignal): void {
    const listener = () => this.cancel();
    this.abortListener = () => signal.removeEventListener('abort', listener);
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) this.cancel();
  }

  private detachAbortSignal(): void {
    this.abortListener?.();
    this.abortListener = null;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly onEarlyReturn: () => void) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise(resolve => this.waiters.push(resolve));
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
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
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

  private process: CodexAppServerProcess | null = null;
  private transport: CodexRpcTransport | null = null;
  private launchSpec: CodexLaunchSpec | null = null;
  private runtimeContext: CodexRuntimeContext | null = null;
  private dynamicToolRegistry = new CodexDynamicToolRegistry();
  private notificationRouter: CodexNotificationRouter | null = null;
  private activeRun: CodexExecutionRun | null = null;
  private pendingTurnNotifications: Array<{ method: string; params: unknown }> = [];
  private processExitHandler: (() => void) | null = null;
  private processDisposalPromise: Promise<void> | null = null;
  private forkIdentityPromise: Promise<CodexPendingForkTarget> | null = null;
  private forkSetupPromise: Promise<CodexEnsuredThread> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private lifecycleGeneration = 0;

  private threadId: string | null;
  private loadedThreadId: string | null = null;
  private sessionFilePath: string | null;
  private workspaceDependencyToolVersion: number | null;
  private pendingFork: CodexProviderState['forkSource'];
  private pendingForkTarget: CodexPendingForkTarget | undefined;
  private nativeConversationContextEstablished: boolean;
  private readonly providerStateDeletes = new Set<string>();
  private snapshot: ProviderSessionSnapshot;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
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
    this.snapshot = this.buildSnapshot('idle', 0);
    this.serverRequestRouter = new CodexExecutionServerRequestRouter(
      this.sessionInstanceId,
      config.interactionPort,
      (threadId, turnId) => this.observeNativeTurn(threadId, turnId),
    );
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) {
      throw new Error('Codex execution session has been disposed.');
    }
    if (this.activeRun) {
      throw new Error('Codex execution session already has an active requested run.');
    }

    const run = new CodexExecutionRun(
      this.sessionInstanceId,
      current => this.cancelRun(current),
    );
    this.activeRun = run;
    run.attachAbortSignal(request.signal);
    if (!run.isCancellationRequested) {
      void this.executeRun(run, request);
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
    this.sessionEventListeners.add(listener);
    return () => {
      this.sessionEventListeners.delete(listener);
    };
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
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

    const bundle = this.buildInputBundle(request);
    this.activeInputBundles.add(bundle);
    try {
      const result = await transport.request<TurnSteerResult>('turn/steer', {
        threadId: nativeThreadId,
        input: bundle.input,
        expectedTurnId: nativeTurnId,
      });
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
        error instanceof CodexRpcResponseError
        && JSON_RPC_PRE_HANDOFF_REJECTION_CODES.has(error.code)
      ) {
        return false;
      }
      throw error;
    } finally {
      this.disposeInputBundle(bundle);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.activeRun?.cancel();
    this.serverRequestRouter.abortAll('session-disposed');
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.cleanupInputBundles();
    this.notificationRouter?.endTurn();
    this.notificationRouter = null;
    this.pendingTurnNotifications = [];
    try {
      const processDisposal = this.disposeOwnedProcessAfterForkIdentity();
      const [processResult] = await Promise.allSettled([
        processDisposal,
        this.settleForkSetup(),
      ]);
      if (processResult.status === 'rejected') {
        throw processResult.reason;
      }
    } finally {
      this.updateSnapshot('disposed');
      this.emitSessionState();
      this.sessionEventListeners.clear();
    }
  }

  private async executeRun(
    run: CodexExecutionRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    try {
      const settings = this.resolveProviderSettings();
      const model = this.resolveModel(request, settings);
      if (!model) {
        this.finishError(
          run,
          'configuration',
          'No Codex model is selected. Enable a model in Claudian settings.',
          true,
        );
        return;
      }

      if (
        request.toolPolicy.kind === 'allow-list'
        && !CODEX_SUPPORTS_EXACT_BUILT_IN_TOOL_ALLOW_LIST
      ) {
        this.finishError(
          run,
          'configuration',
          'Codex app-server does not support exact allow-list enforcement for provider built-in tools.',
          false,
        );
        return;
      }

      if (
        isCompactRequest(request)
        && !this.nativeConversationContextEstablished
      ) {
        this.finishError(
          run,
          'configuration',
          'Codex cannot compact before its native context is restored. Send a normal prompt first.',
          true,
        );
        return;
      }

      await this.ensureProcess(generation);
      if (!this.isRunCurrent(run, generation)) return;

      const policy = this.resolvePolicy(request, settings);
      const baseInstructions = this.resolveBaseInstructions(request);
      const nativePersistence = this.resolveNativePersistence();
      const replayConversationHistory = !this.nativeConversationContextEstablished;
      const thread = await this.ensureThread(
        run,
        request,
        model,
        settings,
        policy,
        baseInstructions,
        nativePersistence,
        generation,
      );
      if (!this.isRunCurrent(run, generation)) return;
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
        this.updateSnapshot('executing');
        this.emitSnapshot(run);
      }

      this.notificationRouter = new CodexNotificationRouter(
        chunk => this.handleStreamChunk(run, chunk),
      );
      const isPlanTurn = request.configuration.mode === 'plan'
        || request.configuration.permissionMode === 'plan'
        || settings.permissionMode === 'plan';
      this.notificationRouter.beginTurn({ isPlanTurn });
      this.pendingTurnNotifications = [];

      if (isCompactRequest(request)) {
        await this.transport!.request<ThreadCompactStartResult>(
          'thread/compact/start',
          { threadId: thread.threadId },
        );
        return;
      }
      if (startsWithCompactCommand(request)) {
        this.finishError(
          run,
          'configuration',
          '/compact does not accept arguments',
          true,
        );
        return;
      }

      const turnInput = this.buildTurnPrompt(
        request,
        thread.forkCheckpoint,
        replayConversationHistory,
      );
      const bundle = this.buildInputBundle(request, turnInput);
      this.activeInputBundles.add(bundle);
      const effort = normalizeString(request.configuration.reasoning)
        ?? normalizeString(settings.effortLevel)
        ?? 'medium';
      const serviceTier = resolveCodexServiceTier(
        request.configuration.serviceTier ?? settings.serviceTier,
        model,
        settings,
      );
      const collaborationMode = {
        mode: isPlanTurn ? 'plan' as const : 'default' as const,
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: null,
        },
      };

      const result = await this.transport!.request<TurnStartResult>('turn/start', {
        threadId: thread.threadId,
        input: bundle.input,
        approvalPolicy: policy.approvalPolicy,
        model,
        serviceTier,
        effort,
        summary: getEffectiveCodexReasoningSummary(settings, model),
        sandboxPolicy: this.buildTurnSandboxPolicy(request, policy),
        collaborationMode,
      });
      this.markNativeConversationContextEstablished(run);
      if (!this.isRunCurrent(run, generation)) return;
      this.observeNativeTurn(thread.threadId, result.turn.id);
    } catch (error) {
      if (!this.isRunCurrent(run, generation) || run.isCancellationRequested) {
        return;
      }
      this.handleExecutionFailure(run, error);
    }
  }

  private async ensureProcess(generation: number): Promise<void> {
    await this.processDisposalPromise;
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('Codex execution session has been disposed.');
    }
    if (
      this.process
      && this.transport
      && this.process.isAlive()
    ) {
      return;
    }

    await this.shutdownDeadProcess();
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('Codex execution session has been disposed.');
    }
    const launchSpec = await resolveCodexAppServerLaunchSpec(this.plugin, 'codex');
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error('Codex execution session has been disposed.');
    }

    const process = new CodexAppServerProcess(launchSpec);
    this.launchSpec = launchSpec;
    this.process = process;
    const exitHandler = () => this.handleProcessExit(process);
    this.processExitHandler = exitHandler;
    process.onExit(exitHandler);

    try {
      process.start();
      if (this.disposed || generation !== this.lifecycleGeneration) {
        throw new Error('Codex execution session has been disposed.');
      }
      const transport = new CodexRpcTransport(process);
      this.transport = transport;
      transport.start();
      if (this.disposed || generation !== this.lifecycleGeneration) {
        throw new Error('Codex execution session has been disposed.');
      }
      const initializeResult = await initializeCodexAppServerTransport(transport);
      if (this.disposed || generation !== this.lifecycleGeneration) {
        throw new Error('Codex execution session has been disposed.');
      }

      this.runtimeContext = createCodexRuntimeContext(launchSpec, initializeResult);
      this.dynamicToolRegistry = new CodexDynamicToolRegistry();
      this.dynamicToolRegistry.register(
        createCodexWorkspaceDependencyTool(this.runtimeContext),
      );
      this.serverRequestRouter.setDynamicToolRegistry(this.dynamicToolRegistry);
      this.wireTransportHandlers(transport, generation);
    } catch (error) {
      try {
        await this.disposeOwnedProcess();
      } catch {
        // Preserve the startup failure that caused cleanup.
      }
      throw error;
    }
  }

  private async shutdownDeadProcess(): Promise<void> {
    await this.disposeOwnedProcess();
  }

  private wireTransportHandlers(
    transport: CodexRpcTransport,
    generation: number,
  ): void {
    const notificationMethods = [
      'item/agentMessage/delta',
      'item/started',
      'item/completed',
      'item/plan/delta',
      'item/reasoning/textDelta',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/summaryPartAdded',
      'thread/tokenUsage/updated',
      'turn/plan/updated',
      'turn/completed',
      'error',
      'thread/started',
      'thread/status/changed',
      'turn/started',
      'serverRequest/resolved',
      'item/commandExecution/outputDelta',
      'item/fileChange/outputDelta',
      'item/fileChange/patchUpdated',
      'rawResponseItem/completed',
      'event_msg',
    ];
    for (const method of notificationMethods) {
      transport.onNotification(
        method,
        (params) => {
          if (!this.isTransportCurrent(transport, generation)) return;
          this.handleNotification(method, params);
        },
      );
    }

    const serverRequestMethods = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'item/tool/call',
    ];
    for (const method of serverRequestMethods) {
      transport.onServerRequest(
        method,
        (requestId, params) => {
          if (!this.isTransportCurrent(transport, generation)) {
            return Promise.reject(new Error('Stale Codex app-server transport.'));
          }
          return this.serverRequestRouter.handleServerRequest(
            requestId,
            method,
            params,
          );
        },
      );
    }
  }

  private isTransportCurrent(
    transport: CodexRpcTransport,
    generation: number,
  ): boolean {
    return (
      !this.disposed
      && this.transport === transport
      && generation === this.lifecycleGeneration
    );
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.disposed) return;
    if (method === 'serverRequest/resolved') {
      const resolved = params as ServerRequestResolvedNotification;
      this.serverRequestRouter.resolveNativeRequest(
        resolved.requestId,
        resolved.threadId,
      );
      return;
    }

    const run = this.activeRun;
    if (!run || run.isTerminal || run.isCancellationRequested) return;
    if (method === 'turn/started') {
      const started = params as TurnStartedNotification;
      this.observeNativeTurn(started.threadId, started.turn.id);
      return;
    }

    const scope = extractNotificationScope(method, params);
    if (scope) {
      if (!this.observeNativeTurn(scope.threadId, scope.turnId)) return;
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

    if (method === 'turn/completed') {
      const completed = params as TurnCompletedNotification;
      run.completion = {
        status: completed.turn.status === 'inProgress'
          ? 'failed'
          : completed.turn.status,
        nativeTurnId: completed.turn.id,
        ...(completed.turn.error?.message
          ? { errorMessage: completed.turn.error.message }
          : {}),
      };
    }
    this.notificationRouter?.handleNotification(method, params);
  }

  private observeNativeTurn(threadId: string, nativeTurnId: string): boolean {
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
    this.markNativeConversationContextEstablished(run);
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
      this.flushPendingTurnNotifications(run);
    }
    return true;
  }

  private markNativeConversationContextEstablished(
    run: CodexExecutionRun,
  ): void {
    if (this.nativeConversationContextEstablished) return;
    this.nativeConversationContextEstablished = true;
    this.publishNativeOwnershipSnapshot(run);
  }

  private currentRunToolPolicy: ProviderToolPolicy | null = null;

  private flushPendingTurnNotifications(run: CodexExecutionRun): void {
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
      if (notification.method === 'turn/completed') {
        const completed = notification.params as TurnCompletedNotification;
        run.completion = {
          status: completed.turn.status === 'inProgress'
            ? 'failed'
            : completed.turn.status,
          nativeTurnId: completed.turn.id,
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
      this.finishError(
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
        this.finishError(
          run,
          'provider',
          completion.errorMessage ?? 'Codex turn failed.',
          true,
        );
      } else if (
        completion?.status === 'interrupted'
        || run.isCancellationRequested
      ) {
        this.finishCancelled(run);
      } else {
        this.finishCompleted(run, completion?.nativeTurnId);
      }
      return;
    }

    const event = adaptCodexStreamChunk(chunk, run.createScope());
    if (event) run.emit(event);
  }

  private async ensureThread(
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
    if (
      this.pendingFork
      && (this.pendingForkTarget !== undefined || !this.threadId)
    ) {
      return this.ensureForkThread(
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

    if (this.threadId && this.loadedThreadId !== this.threadId) {
      const result = await this.transport!.request<ThreadResumeResult>(
        'thread/resume',
        {
          threadId: this.threadId,
          model,
          approvalPolicy: policy.approvalPolicy,
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
      this.loadedThreadId = result.thread.id;
      return {
        threadId: result.thread.id,
        sessionFilePath: this.toHostSessionPath(result.thread.path),
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
    const result = await this.transport!.request<ThreadStartResult>(
      'thread/start',
      {
        model,
        cwd: this.resolveTargetWorkingDirectory(),
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        serviceTier: resolveCodexServiceTier(
          request.configuration.serviceTier ?? settings.serviceTier,
          model,
          settings,
        ),
        baseInstructions,
        experimentalRawEvents: true,
        ...(persistExtendedHistory !== undefined
          ? { persistExtendedHistory }
          : {}),
        ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      },
    );
    this.loadedThreadId = result.thread.id;
    this.workspaceDependencyToolVersion = dynamicTools.some(spec =>
      spec.namespace === CODEX_WORKSPACE_DEPENDENCY_TOOL_NAMESPACE
      && spec.name === CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME
    )
      ? CODEX_WORKSPACE_DEPENDENCY_TOOL_VERSION
      : null;
    const sessionFilePath = this.toHostSessionPath(result.thread.path);
    this.threadId = result.thread.id;
    this.sessionFilePath = sessionFilePath;
    this.publishNativeOwnershipSnapshot(run);
    return {
      threadId: result.thread.id,
      sessionFilePath,
    };
  }

  private ensureForkThread(
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
      return Promise.reject(new Error('Codex fork setup is not available.'));
    }

    const setup = this.materializeForkThread(
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
      () => this.clearForkSetup(setup),
      () => this.clearForkSetup(setup),
    );
    return setup;
  }

  private async materializeForkThread(
    run: CodexExecutionRun,
    request: ProviderExecutionRequest,
    model: string,
    settings: Record<string, unknown>,
    policy: CodexPolicy,
    baseInstructions: string,
    persistExtendedHistory: boolean | undefined,
    generation: number,
    transport: CodexRpcTransport,
  ): Promise<CodexEnsuredThread> {
    const fork = this.pendingFork;
    if (!fork) throw new Error('Codex fork source is not available.');

    let target = this.pendingForkTarget;
    if (!target) {
      target = await this.resolveForkIdentity(run, fork, transport);
    }

    if (!this.isRunCurrent(run, generation)) {
      throw new Error('Codex fork setup was interrupted after child adoption.');
    }

    const resumeResult = await transport.request<ThreadResumeResult>(
      'thread/resume',
      {
        threadId: target.threadId,
        model,
        approvalPolicy: policy.approvalPolicy,
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
    if (!this.isRunCurrent(run, generation)) {
      throw new Error('Codex fork setup was interrupted while resuming the child.');
    }
    if (resumeResult.thread.id !== target.threadId) {
      throw new Error('Codex resumed a different thread than the owned fork target.');
    }

    this.loadedThreadId = target.threadId;
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
      if (!this.isRunCurrent(run, generation)) {
        throw new Error('Codex fork setup was interrupted while rolling back the child.');
      }
      if (rollbackResult.thread.id !== target.threadId) {
        throw new Error('Codex rolled back a different thread than the owned fork target.');
      }
    }

    this.consumePendingForkState();
    this.updateSnapshot('idle');
    this.emitSnapshot(run);
    return {
      threadId: target.threadId,
      sessionFilePath: target.sessionFilePath ?? null,
      forkCheckpoint: fork.resumeAt,
    };
  }

  private resolveForkIdentity(
    run: CodexExecutionRun,
    fork: NonNullable<CodexProviderState['forkSource']>,
    transport: CodexRpcTransport,
  ): Promise<CodexPendingForkTarget> {
    if (this.forkIdentityPromise) return this.forkIdentityPromise;

    const pathMapper = this.launchSpec?.pathMapper;
    const identity = transport.request<ThreadForkResult>(
      'thread/fork',
      { threadId: fork.sessionId },
    ).then((forkResult) => {
      const threadId = normalizeString(forkResult.thread.id);
      if (!threadId) {
        throw new Error('Codex fork did not return a child thread ID.');
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
      this.adoptPendingForkTarget(run, target);
      return target;
    });
    this.forkIdentityPromise = identity;
    void identity.then(
      () => this.clearForkIdentity(identity),
      () => this.clearForkIdentity(identity),
    );
    return identity;
  }

  private adoptPendingForkTarget(
    run: CodexExecutionRun,
    target: CodexPendingForkTarget,
  ): void {
    this.pendingForkTarget = target;
    this.threadId = target.threadId;
    this.sessionFilePath = target.sessionFilePath ?? null;
    this.updateSnapshot('idle');
    this.emitSnapshot(run);
  }

  private clearForkSetup(setup: Promise<CodexEnsuredThread>): void {
    if (this.forkSetupPromise === setup) {
      this.forkSetupPromise = null;
    }
  }

  private clearForkIdentity(
    identity: Promise<CodexPendingForkTarget>,
  ): void {
    if (this.forkIdentityPromise === identity) {
      this.forkIdentityPromise = null;
    }
  }

  private async settleForkIdentity(): Promise<void> {
    const identity = this.forkIdentityPromise;
    if (!identity) return;
    try {
      await identity;
    } catch {
      // A rejected fork request exposes no child identity to retain.
    }
  }

  private async settleForkSetup(): Promise<void> {
    const setup = this.forkSetupPromise;
    if (!setup) return;
    try {
      await setup;
    } catch {
      // The active run owns error or cancellation projection.
    }
  }

  private cancelRun(run: CodexExecutionRun): void {
    if (this.activeRun !== run || run.isTerminal) return;
    this.lifecycleGeneration += 1;
    this.serverRequestRouter.abortAll('cancelled');
    const transport = this.transport;
    if (transport && run.nativeThreadId && run.nativeTurnId) {
      void transport.request('turn/interrupt', {
        threadId: run.nativeThreadId,
        turnId: run.nativeTurnId,
      }).catch(() => undefined);
    }
    const processDisposal = this.disposeOwnedProcessAfterForkIdentity();
    void Promise.allSettled([
      processDisposal,
      this.settleForkSetup(),
    ]).then(() => this.finishCancelled(run));
  }

  private finishCompleted(
    run: CodexExecutionRun,
    nativeCheckpointId?: string,
  ): void {
    if (this.activeRun !== run || run.isTerminal) return;
    this.finishRunState(run);
    run.finish({
      type: 'turn_completed',
      scope: run.createScope(),
      reason: 'completed',
      ...(nativeCheckpointId ? { nativeCheckpointId } : {}),
    });
    this.releaseRun(run);
  }

  private finishCancelled(run: CodexExecutionRun): void {
    if (this.activeRun !== run || run.isTerminal) return;
    this.finishRunState(run);
    run.finish({
      type: 'cancelled',
      scope: run.createScope(),
      reason: 'cancelled',
    });
    this.releaseRun(run);
  }

  private finishError(
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
      this.updateSnapshot('invalidated', {
        reason,
        recoverable,
        message,
      });
    } else {
      this.updateSnapshot('idle');
    }
    this.emitSnapshot(run);
    run.finish({
      type: 'execution_error',
      scope: run.createScope(),
      category,
      message,
      recoverable,
      ...(missingProviderSessionId ? { missingProviderSessionId } : {}),
    });
    this.releaseRun(run);
  }

  private finishRunState(run: CodexExecutionRun): void {
    this.updateSnapshot('idle');
    this.emitSnapshot(run);
  }

  private releaseRun(run: CodexExecutionRun): void {
    this.notificationRouter?.endTurn();
    this.notificationRouter = null;
    this.pendingTurnNotifications = [];
    this.serverRequestRouter.abortAll(
      run.isCancellationRequested ? 'cancelled' : 'resolved',
    );
    this.cleanupInputBundles();
    this.currentRunToolPolicy = null;
    if (this.activeRun === run) {
      this.activeRun = null;
    }
    this.discoverSessionFile();
  }

  private handleExecutionFailure(
    run: CodexExecutionRun,
    error: unknown,
  ): void {
    const message = error instanceof Error
      ? error.message
      : 'Unknown Codex error';
    if (isMissingThreadError(message)) {
      this.finishError(
        run,
        'provider-session-missing',
        message,
        true,
        this.threadId ?? undefined,
      );
      return;
    }
    const category = isTransportError(message) ? 'transport' : 'provider';
    this.finishError(run, category, message, category === 'transport');
  }

  private handleProcessExit(process: CodexAppServerProcess): void {
    if (this.process !== process || this.disposed) return;
    this.lifecycleGeneration += 1;
    const run = this.activeRun;
    // The dead transport cannot deliver an unresolved fork identity.
    const processDisposal = this.disposeOwnedProcess();
    if (run && !run.isTerminal && !run.isCancellationRequested) {
      const forkSetup = this.forkSetupPromise;
      if (forkSetup) {
        void Promise.allSettled([
          processDisposal,
          this.settleForkSetup(),
        ]).then(() => {
          this.finishError(
            run,
            'process-exited',
            'Codex app-server process exited unexpectedly.',
            true,
          );
        });
      } else {
        this.finishError(
          run,
          'process-exited',
          'Codex app-server process exited unexpectedly.',
          true,
        );
      }
    } else {
      this.updateSnapshot('invalidated', {
        reason: 'process-exited',
        recoverable: true,
        message: 'Codex app-server process exited unexpectedly.',
      });
      this.emitSessionState();
    }
    void processDisposal.catch(() => undefined);
  }

  private async disposeOwnedProcessAfterForkIdentity(): Promise<void> {
    await this.settleForkIdentity();
    await this.disposeOwnedProcess();
  }

  private disposeOwnedProcess(): Promise<void> {
    if (this.processDisposalPromise) return this.processDisposalPromise;

    const transport = this.transport;
    this.transport = null;
    const process = this.process;
    this.process = null;
    const exitHandler = this.processExitHandler;
    this.processExitHandler = null;
    if (process && exitHandler) process.offExit(exitHandler);

    this.launchSpec = null;
    this.runtimeContext = null;
    this.loadedThreadId = null;
    this.dynamicToolRegistry = new CodexDynamicToolRegistry();
    this.serverRequestRouter.setDynamicToolRegistry(null);

    if (!transport && !process) return Promise.resolve();

    let cleanupError: unknown;
    try {
      transport?.dispose();
    } catch (error) {
      cleanupError = error;
    }
    const pending = (async () => {
      try {
        await process?.shutdown();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError instanceof Error) throw cleanupError;
      if (cleanupError !== undefined) {
        throw new Error(String(cleanupError));
      }
    })();
    this.processDisposalPromise = pending;
    void pending.then(
      () => this.clearProcessDisposal(pending),
      () => this.clearProcessDisposal(pending),
    );
    return pending;
  }

  private clearProcessDisposal(pending: Promise<void>): void {
    if (this.processDisposalPromise === pending) {
      this.processDisposalPromise = null;
    }
  }

  private emitSnapshot(run: CodexExecutionRun): void {
    run.emit({
      type: 'session_state_changed',
      scope: run.createScope(),
      snapshot: this.snapshot,
    });
  }

  private emitSessionState(): void {
    const event: ProviderSessionEvent = {
      type: 'session_state_changed',
      scope: {
        kind: 'session',
        sessionInstanceId: this.sessionInstanceId,
        sequence: this.snapshot.revision,
      },
      snapshot: this.snapshot,
    };
    for (const listener of this.sessionEventListeners) {
      try {
        listener(event);
      } catch {
        // Session listeners cannot interfere with native lifecycle cleanup.
      }
    }
  }

  private publishNativeOwnershipSnapshot(run: CodexExecutionRun): void {
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
      this.updateSnapshot('executing');
    } else if (currentSnapshot.status === 'invalidated') {
      this.updateSnapshot('invalidated', currentSnapshot.invalidation);
    } else {
      this.updateSnapshot(currentSnapshot.status);
    }
    if (this.activeRun === run && !run.isTerminal) {
      this.emitSnapshot(run);
    } else {
      this.emitSessionState();
    }
  }

  private updateSnapshot(
    status: ProviderSessionStatus,
    invalidation?: ProviderSessionInvalidation,
  ): void {
    this.snapshot = status === 'invalidated'
      ? this.buildSnapshot(status, this.snapshot.revision + 1, invalidation)
      : this.buildSnapshot(status, this.snapshot.revision + 1);
  }

  private buildSnapshot(
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
      ...(this.resolveTranscriptRootHost()
        ? { transcriptRootPath: this.resolveTranscriptRootHost()! }
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

  private consumePendingForkState(): void {
    this.pendingFork = undefined;
    this.pendingForkTarget = undefined;
    for (const key of CODEX_CONSUMED_FORK_STATE_KEYS) {
      this.providerStateDeletes.add(key);
    }
  }

  private resolveProviderSettings(): Record<string, unknown> {
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

  private resolveModel(
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

  private resolveBaseInstructions(request: ProviderExecutionRequest): string {
    const base = request.configuration.systemInstructions.kind === 'explicit'
      ? request.configuration.systemInstructions.instructions
      : buildSystemPrompt(this.getSystemPromptSettings());
    return request.toolPolicy.kind === 'passive'
      ? `${base}\n\n${PASSIVE_INSTRUCTIONS}`
      : base;
  }

  private getSystemPromptSettings(): SystemPromptSettings {
    return {
      mediaFolder: this.plugin.settings.mediaFolder,
      customPrompt: this.plugin.settings.systemPrompt,
      vaultPath: this.config.vaultWorkingDirectory,
      userName: this.plugin.settings.userName,
    };
  }

  private resolveNativePersistence(): boolean | undefined {
    if (this.config.nativePersistence === 'enabled') return true;
    if (this.config.nativePersistence === 'disabled-if-supported') return false;
    return this.config.lifecycle === 'persistent';
  }

  private resolvePolicy(
    request: ProviderExecutionRequest,
    settings: Record<string, unknown>,
  ): CodexPolicy {
    const toolPolicy = request.toolPolicy;
    if (toolPolicy.kind === 'passive' || toolPolicy.kind === 'read-only') {
      return {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        sandboxPolicy: strictReadOnlySandbox(),
      };
    }
    if (toolPolicy.kind === 'allow-list') {
      return {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        sandboxPolicy: strictReadOnlySandbox(),
      };
    }
    if (toolPolicy.kind === 'unrestricted') {
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    }

    const permissionMode =
      normalizeString(request.configuration.permissionMode)
      ?? normalizeString(request.configuration.mode)
      ?? normalizeString(settings.permissionMode)
      ?? 'normal';
    const safeMode = getCodexProviderSettings(settings).safeMode;
    const sandboxConfig = resolveCodexSandboxConfig(permissionMode, safeMode);
    return {
      ...sandboxConfig,
      sandboxPolicy: sandboxConfig.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : sandboxConfig.sandbox === 'read-only'
          ? strictReadOnlySandbox()
          : this.buildWorkspaceWriteSandboxPolicy([]),
    };
  }

  private buildTurnSandboxPolicy(
    request: ProviderExecutionRequest,
    policy: CodexPolicy,
  ): SandboxPolicy {
    if (policy.sandbox !== 'workspace-write') return policy.sandboxPolicy;
    const externalPaths = [
      ...(request.context?.externalContextPaths ?? []),
      ...(request.configuration.externalWorkspaceRoots ?? []),
    ];
    return this.buildWorkspaceWriteSandboxPolicy(externalPaths);
  }

  private buildWorkspaceWriteSandboxPolicy(
    externalPaths: readonly string[],
  ): SandboxPolicy {
    const transcriptRoot = this.resolveTranscriptRootTarget();
    const memoriesDir = deriveCodexMemoriesDirFromSessionsRoot(transcriptRoot)
      ?? this.runtimeContext?.memoriesDirTarget
      ?? null;
    const roots = [
      this.resolveTargetWorkingDirectory(),
      ...externalPaths.map(hostPath => this.mapRequiredHostPath(hostPath)),
      memoriesDir,
      this.mapHostPathToTarget(os.tmpdir()),
      this.launchSpec?.target.platformFamily === 'unix' ? '/tmp' : null,
    ].filter((value): value is string => Boolean(value?.trim()));
    return {
      type: 'workspaceWrite',
      writableRoots: [...new Set(roots)],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private buildTurnPrompt(
    request: ProviderExecutionRequest,
    forkCheckpoint?: string,
    replayConversationHistory = false,
  ): string {
    let prompt = request.input
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
    const context = request.context;
    if (context?.currentNote) {
      prompt = appendCurrentNote(prompt, context.currentNote.path);
      if (context.currentNote.content) {
        prompt += `\n\n[Current note content:\n${context.currentNote.content}\n]`;
      }
    }
    if (context?.editorSelection?.selectedText) {
      prompt += `\n\n[Editor selection from ${context.editorSelection.notePath || 'current note'}:\n${context.editorSelection.selectedText}\n]`;
    }
    if (context?.browserSelection?.selectedText) {
      prompt += `\n\n[Browser selection from ${context.browserSelection.url ?? 'unknown page'}:\n${context.browserSelection.selectedText}\n]`;
    }
    if (context?.canvasSelection) {
      const nodes = context.canvasSelection.nodeIds.join(', ');
      if (nodes) {
        prompt += `\n\n[Canvas selection from ${context.canvasSelection.canvasPath}:\n${nodes}\n]`;
      }
    }

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

  private buildInputBundle(
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
            path: this.mapRequiredHostPath(filePath),
          });
        });
      }

      const prompt = promptOverride
        ?? request.input
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n\n');
      if (prompt) {
        input.push({ type: 'text', text: prompt, text_elements: [] });
      }
      return { input, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private disposeInputBundle(bundle: CodexInputBundle): void {
    this.activeInputBundles.delete(bundle);
    bundle.cleanup();
  }

  private cleanupInputBundles(): void {
    for (const bundle of this.activeInputBundles) bundle.cleanup();
    this.activeInputBundles.clear();
  }

  private resolveTargetWorkingDirectory(): string {
    if (!this.launchSpec) return this.config.vaultWorkingDirectory;
    const mapped = this.launchSpec.pathMapper.toTargetPath(
      this.config.vaultWorkingDirectory,
    );
    return mapped ?? this.launchSpec.targetCwd;
  }

  private mapRequiredHostPath(hostPath: string): string {
    const targetPath = this.mapHostPathToTarget(hostPath);
    if (!targetPath) {
      throw new Error(
        `Codex cannot access path from the selected target: ${hostPath}`,
      );
    }
    return targetPath;
  }

  private mapHostPathToTarget(hostPath: string | null): string | null {
    if (!hostPath) return null;
    return this.launchSpec?.pathMapper.toTargetPath(hostPath) ?? hostPath;
  }

  private toHostSessionPath(targetPath: string | null | undefined): string | null {
    if (!targetPath) return null;
    return this.launchSpec?.pathMapper.toHostPath(targetPath) ?? targetPath;
  }

  private resolveTranscriptRootHost(): string | null {
    return this.runtimeContext?.sessionsDirHost
      ?? deriveCodexSessionsRootFromSessionPath(this.sessionFilePath);
  }

  private resolveTranscriptRootTarget(): string | null {
    if (this.runtimeContext?.sessionsDirTarget) {
      return this.runtimeContext.sessionsDirTarget;
    }
    if (!this.sessionFilePath) return null;
    const targetPath = this.mapHostPathToTarget(this.sessionFilePath);
    return deriveCodexSessionsRootFromSessionPath(targetPath);
  }

  private discoverSessionFile(): void {
    if (this.sessionFilePath || !this.threadId) return;
    const found = findCodexSessionFile(
      this.threadId,
      this.resolveTranscriptRootHost() ?? undefined,
    );
    if (found) {
      this.sessionFilePath = found;
      this.updateSnapshot(this.snapshot.status);
    }
  }

  private isRunCurrent(
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
): { approvalPolicy: string; sandbox: string } {
  if (permissionMode === 'yolo') {
    return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
  if (permissionMode === 'plan') {
    return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
  return { approvalPolicy: 'on-request', sandbox: safeMode };
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
  if (!model) return null;
  if (typeof serviceTier === 'string') {
    if (model.serviceTiers.some(tier => tier.id === serviceTier)) {
      return serviceTier;
    }
    if (serviceTier === 'fast') {
      return model.serviceTiers.find(
        tier => tier.name.toLowerCase() === 'fast',
      )?.id ?? null;
    }
  }
  return model.defaultServiceTier;
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
  if (method === 'turn/completed') {
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
