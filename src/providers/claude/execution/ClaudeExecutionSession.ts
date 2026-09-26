import type {
  Query,
  SDKMessage,
  SlashCommand as SDKSlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';

import {
  type ChatRewindMode,
  type ChatRewindPreview,
  type ChatRewindResult,
  ExecutionEventQueue,
  type ProviderBackgroundEventScope,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderRequestedEventScope,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionEventScope,
  type ProviderSessionInvalidation,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  type RewindableExecutionSession,
} from '../../../core/execution';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { PermissionMode, SlashCommand, TurnStats } from '../../../core/types';
import {
  getMissingSessionId,
  isSessionMissingError,
} from '../../../utils/session';
import { loadClaudeTurnStats } from '../history/ClaudeTurnStats';
import { assertClaudeModelAvailable } from '../runtime/ClaudeModelAvailability';
import { executeClaudeRewind } from '../runtime/ClaudeRewindService';
import { getClaudeState } from '../types/providerState';
import { ClaudeExecutionEventNormalizer } from './ClaudeExecutionEventNormalizer';
import {
  type ClaudeEncodedExecutionRequest,
  ClaudeExecutionRequestEncoder,
  type ClaudeNativeResume,
} from './ClaudeExecutionRequestEncoder';
import {
  ClaudeEphemeralExecutionStrategy,
  type ClaudeExecutionStrategy,
  type ClaudeExecutionStrategySink,
  ClaudePersistentExecutionStrategy,
} from './ClaudeExecutionStrategies';
import { ClaudeInteractionHandler } from './ClaudeInteractionHandler';
import { ClaudeResponseOwnership, getClaudeInputMatch } from './ClaudeResponseOwnership';

interface ActiveRequestedRun {
  readonly executionId: string;
  readonly turnId: string;
  readonly events: ExecutionEventQueue<ProviderExecutionEvent>;
  readonly abortController: AbortController;
  readonly requestSignal: AbortSignal;
  readonly onRequestAbort: () => void;
  readonly queryToken: number;
  sequence: number;
  accepted: boolean;
  nativeFork: boolean;
  nativeHandedOff: boolean;
  nativeCompleted?: boolean;
  historyReplayGeneration: number | null;
  nativeUserMessageId?: string;
  nativeAssistantId?: string;
  terminal: boolean;
}

interface BackgroundTurn {
  nativeAssistantId?: string;
  readonly queryToken: number;
  readonly turnId: string;
  sequence: number;
}

export class ClaudeExecutionSession
implements
ProviderExecutionSession,
RewindableExecutionSession,
ClaudeExecutionStrategySink {
  readonly providerId = 'claude' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly encoder: ClaudeExecutionRequestEncoder;
  private readonly strategy: ClaudeExecutionStrategy;
  private readonly usesPersistentQuery: boolean;
  private readonly interactionHandler: ClaudeInteractionHandler;
  private readonly sessionListeners = new Set<
    (event: ProviderSessionEvent) => void
  >();
  private readonly initialProviderSessionId: string | null;
  private providerState: Record<string, unknown>;
  private providerSessionId: string | null;
  private resumeAt: string | undefined;
  private pendingFork: boolean;
  private replayHistoryOnNextTurn: boolean;
  private replayHistoryGeneration: number;
  private status: ProviderSessionStatus = 'idle';
  private revision = 0;
  private snapshotInvalidation: ProviderSessionInvalidation | null = null;
  private activeRun: ActiveRequestedRun | null = null;
  // Native settlement can precede consumption of the requested event queue.
  private lastRequestedEventScope: ProviderRequestedEventScope | undefined;
  private lastBackgroundEventScope: ProviderBackgroundEventScope | undefined;
  private backgroundTurn: BackgroundTurn | null = null;
  private nativeQueryToken = 0;
  private cancelledBackgroundQueryToken: number | null = null;
  private backgroundCounter = 0;
  private sessionSequence = 0;
  private queryToken = 0;
  private commandPublication = 0;
  private commandSnapshot: SlashCommand[] | undefined;
  private disposed = false;
  private readonly suppressedPersistentQueryTokens = new Set<number>();
  private readonly suppressedEphemeralQueryTokens = new Set<number>();
  private readonly pendingProviderStateDeletes = new Set<string>();
  private lastEncodedRequest: ClaudeEncodedExecutionRequest | null = null;
  private lastAllowedTools: ReadonlySet<string> | null = null;
  private readonly eventNormalizer = new ClaudeExecutionEventNormalizer();
  private readonly responseOwnership = new ClaudeResponseOwnership();
  private nativeQuery: Query | null = null;
  private authoritativeContextWindow: {
    readonly model: string;
    readonly contextWindow: number;
  } | null = null;

  constructor(
    private readonly host: ProviderHost,
    private readonly config: ProviderSessionConfig,
  ) {
    const state = {
      ...getClaudeState(
        config.resumeSeed?.providerState,
      ),
      ...(config.resumeSeed?.providerState ?? {}),
    };
    const forkSource = getValidForkSource(state.forkSource);
    const establishedSessionId = config.resumeSeed?.providerSessionId
      ?? (typeof state.providerSessionId === 'string'
        ? state.providerSessionId
        : undefined);
    this.pendingFork = Boolean(forkSource && !establishedSessionId);
    const seedSessionId = establishedSessionId ?? forkSource?.sessionId;
    this.initialProviderSessionId = seedSessionId ?? null;
    this.providerSessionId = this.pendingFork
      ? null
      : this.initialProviderSessionId;
    // Subagent history belongs to the conversation projection, not native resume state.
    // Snapshots merge their keys into that projection without deleting omitted history.
    delete state.subagentData;
    this.providerState = state;
    this.replayHistoryOnNextTurn = state.historyReplayPending === true;
    this.replayHistoryGeneration = this.replayHistoryOnNextTurn ? 1 : 0;
    this.resumeAt = config.resumeSeed?.resumeCheckpoint
      ?? forkSource?.resumeAt;
    this.encoder = new ClaudeExecutionRequestEncoder({
      host,
    });
    this.interactionHandler = new ClaudeInteractionHandler({
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
      getTurnId: toolId => this.#getInteractionTurnId(toolId),
      isToolAllowed: (toolName) => (
        this.lastAllowedTools === null
        || this.lastAllowedTools.has(toolName)
      ),
      onToolBlocked: (toolUseId) => {
        this.eventNormalizer.markToolBlocked(
          toolUseId,
          this.responseOwnership.toolChannel(toolUseId) ?? this.#currentOutputChannel(),
        );
      },
    });
    this.usesPersistentQuery = config.lifecycle === 'persistent'
      || config.nativePersistence === 'disabled-if-supported';
    this.strategy = this.usesPersistentQuery
      ? new ClaudePersistentExecutionStrategy(this)
      : new ClaudeEphemeralExecutionStrategy(this);
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) {
      throw new Error('Claude execution session is disposed');
    }
    if (this.activeRun) {
      throw new Error('Claude execution session already has an active run');
    }

    const executionId = randomUUID();
    const turnId = randomUUID();
    const abortController = new AbortController();
    const queryToken = ++this.queryToken;
    const onRequestAbort = (): void => this.cancel();
    const events = new ExecutionEventQueue<ProviderExecutionEvent>(() => {
      this.cancel();
    });
    const active: ActiveRequestedRun = {
      executionId,
      turnId,
      events,
      abortController,
      requestSignal: request.signal,
      onRequestAbort,
      queryToken,
      sequence: 0,
      accepted: false,
      nativeFork: false,
      nativeHandedOff: false,
      historyReplayGeneration: null,
      terminal: false,
    };
    this.activeRun = active;
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
    this.#setStatus('executing');
    this.#emitRequestedState(active);
    if (request.signal.aborted) {
      this.cancel();
    } else {
      void this.#startExecution(active, request);
    }

    return {
      executionId,
      turnId,
      events,
      cancel: () => {
        if (this.activeRun === active) {
          this.cancel();
        }
      },
    };
  }

  cancel(): void {
    const active = this.activeRun;
    if (active?.nativeCompleted) return;
    if (!active || active.terminal) {
      if (!this.backgroundTurn || this.cancelledBackgroundQueryToken !== null) return;
      this.cancelledBackgroundQueryToken = this.backgroundTurn.queryToken;
      this.#setStatus('cancelling');
      this.#emitBackground(this.backgroundTurn, {
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
      this.interactionHandler.dismissAll('cancelled');
      this.strategy.cancel(null, true);
      return;
    }
    this.#setStatus('cancelling');
    this.#emitRequestedState(active);
    active.abortController.abort();
    this.interactionHandler.dismissAll('cancelled');
    if (active.nativeHandedOff) {
      if (this.usesPersistentQuery) {
        this.suppressedPersistentQueryTokens.add(active.queryToken);
      } else {
        this.suppressedEphemeralQueryTokens.add(active.queryToken);
      }
    }
    this.strategy.cancel(active.queryToken, active.nativeHandedOff);
    if (active.nativeHandedOff) this.#finishBackgroundTurn('provider-ended');
    this.#setStatus(this.backgroundTurn ? 'executing' : 'idle');
    this.#emitRequestedState(active);
    this.#emitRequested(active, {
      type: 'cancelled',
      reason: 'Cancelled',
    });
    this.#endActiveRun(active);
  }

  getSnapshot(): ProviderSessionSnapshot {
    const providerStateDeletes = [
      ...this.pendingProviderStateDeletes,
    ];
    const base = {
      providerId: this.providerId,
      revision: this.revision,
      ...(this.providerSessionId
        ? { providerSessionId: this.providerSessionId }
        : {}),
      ...(Object.keys(this.providerState).length > 0
        ? { providerState: Object.freeze(cloneRecord(this.providerState)) }
        : {}),
      ...(providerStateDeletes.length > 0
        ? { providerStateDeletes: Object.freeze(providerStateDeletes) }
        : {}),
    };
    return Object.freeze(this.status === 'invalidated'
      ? {
        ...base,
        status: 'invalidated' as const,
        invalidation: Object.freeze({
          ...(this.snapshotInvalidation ?? {
            reason: 'provider-error' as const,
            recoverable: true,
          }),
        }),
      }
      : {
        ...base,
        status: this.status,
      });
  }

  getStatus(): ProviderSessionStatus {
    return this.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.activeRun?.nativeCompleted) {
      this.#finishCompleted(this.activeRun, 'completed');
    } else if (this.activeRun) {
      this.cancel();
    }
    this.#finishBackgroundTurn('provider-ended');
    this.disposed = true;
    this.interactionHandler.dismissAll('session-disposed');
    await this.strategy.dispose();
    this.#setStatus('disposed');
    this.#emitSession({
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.sessionListeners.clear();
    this.backgroundTurn = null;
    this.suppressedPersistentQueryTokens.clear();
    this.suppressedEphemeralQueryTokens.clear();
  }

  async previewRewind(
    userMessageId: string,
    _assistantMessageId: string | undefined,
    mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<ChatRewindPreview> {
    if (!this.#hasRewindSeed()) {
      return {
        canRewind: false,
        error: 'No Claude session is available to rewind.',
      };
    }
    if (mode === 'conversation') {
      return {
        canRewind: true,
        filesChanged: [],
      };
    }
    const query = await this.#getOrPrepareRewindQuery();
    if (!query) {
      return {
        canRewind: false,
        error: 'Claude rewind requires a persistent resumed session.',
      };
    }
    const result = await query.rewindFiles(userMessageId, { dryRun: true });
    return {
      canRewind: result.canRewind,
      error: result.error,
      filesChanged: result.filesChanged,
    };
  }

  async rewind(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<ChatRewindResult> {
    if (!this.#hasRewindSeed()) {
      return {
        canRewind: false,
        error: 'No Claude session is available to rewind.',
      };
    }
    const query = mode === 'conversation'
      ? this.strategy.getRewindQuery()
      : await this.#getOrPrepareRewindQuery();
    if (mode !== 'conversation' && !query) {
      return {
        canRewind: false,
        error: 'Claude rewind requires a persistent resumed session.',
      };
    }
    const result = await executeClaudeRewind(userMessageId, {
      assistantMessageId,
      mode,
      rewindFiles: async (id, dryRun) => {
        if (!query) {
          return {
            canRewind: false,
            error: 'Claude rewind query is unavailable.',
          };
        }
        return await query.rewindFiles(id, { dryRun });
      },
      closePersistentQuery: () => this.strategy.cancel(null, true),
      setPendingResumeAt: () => undefined,
      resetSession: () => undefined,
      vaultPath: this.config.vaultWorkingDirectory,
    });
    return result.canRewind
      ? {
        ...result,
        sessionStrategy: 'checkpoint-resume',
      }
      : result;
  }

  assertModelAvailable(model: string): void {
    assertClaudeModelAvailable(this.host.settings, model);
  }

  getProviderSessionId(): string | null {
    return this.#getNativeResumeSessionId();
  }

  setPendingNativeUserMessageId(
    nativeUserMessageId: string,
    queryToken: number,
  ): void {
    if (this.activeRun?.queryToken === queryToken) {
      this.activeRun.nativeUserMessageId = nativeUserMessageId;
    }
  }

  markNativeTurnHandedOff(queryToken: number): void {
    const active = this.activeRun;
    if (
      active
      && active.queryToken === queryToken
      && !active.terminal
    ) {
      active.nativeHandedOff = true;
    }
  }

  async handleNativeMessage(
    message: SDKMessage,
    queryToken: number,
  ): Promise<void> {
    if (this.disposed) return;
    this.nativeQueryToken = queryToken;
    if (this.cancelledBackgroundQueryToken === queryToken) {
      if (message.type === 'result') this.#finishCancelledBackground(queryToken);
      return;
    }
    if (this.suppressedEphemeralQueryTokens.has(queryToken)) {
      if (message.type === 'result') {
        this.suppressedEphemeralQueryTokens.delete(queryToken);
      }
      return;
    }
    if (this.suppressedPersistentQueryTokens.has(queryToken)) {
      if (message.type === 'result') {
        this.suppressedPersistentQueryTokens.delete(queryToken);
      }
      return;
    }

    const active = this.activeRun;
    const intendedModel = this.lastEncodedRequest?.model;
    const reportedContextWindow = intendedModel
      && this.authoritativeContextWindow?.model === intendedModel
      ? this.authoritativeContextWindow.contextWindow
      : undefined;
    const inputMatch = getClaudeInputMatch(message, active?.nativeUserMessageId);
    const channel = this.responseOwnership.resolve(message, active?.nativeHandedOff === true, active?.nativeUserMessageId);
    if (channel === 'requested' && isRequestedTurnEvidence(message)
      && !this.responseOwnership.hasPending('background')) {
      this.#finishBackgroundTurn('provider-ended');
    }
    const normalizedEvents = this.eventNormalizer.normalize(
      message,
      channel,
      {
        intendedModel: this.lastEncodedRequest?.model,
        reportedContextWindow,
      },
    );
    this.responseOwnership.observe(message, channel, normalizedEvents);
    if (message.type === 'stream_event' && message.event.type === 'message_start'
      && message.parent_tool_use_id == null) {
      this.#getOutputTarget(channel);
    }
    if (
      active?.nativeHandedOff
      && inputMatch !== false
      && (channel === 'requested' || inputMatch === true || message.type === 'result')
      && isRequestedTurnEvidence(message)
    ) {
      this.#ensureRequestedAccepted(active);
    }
    for (const normalized of normalizedEvents) {
      if (normalized.type === 'session_init') {
        const event = normalized.event;
        this.#captureProviderSession(event.sessionId);
        this.#emitStateForCurrentTurn();
        if (event.permissionMode !== undefined) {
          this.#emitPermissionModeForCurrentTurn(
            event.permissionMode === 'bypassPermissions' ? 'yolo' : 'normal',
          );
        }
        continue;
      }
      if (normalized.type === 'async_subagent_completion') {
        const event = normalized.event;
        this.#emitSession({
          type: 'async_subagent_completed',
          originatingTurnId: event.toolUseId
            ?? active?.turnId
            ?? this.backgroundTurn?.turnId
            ?? event.taskId,
          subagentId: event.taskId,
          status: event.status,
          result: event.result,
          providerSessionId: event.providerSessionId,
          snapshotRevision: this.revision,
          providerPayload: event,
        });
        continue;
      }
      if (normalized.type === 'output') {
        // Task completion is independent of the currently running model response.
        if (normalized.event.type === 'task_notification') {
          this.#emitSession({
            ...normalized.event,
            afterRequestedEvent: this.lastRequestedEventScope,
            afterBackgroundEvent: this.lastBackgroundEventScope,
          });
          continue;
        }
        const target = this.#getOutputTarget(channel);
        if (target) {
          this.#emitTurnOutput(target, normalized.event);
        }
        continue;
      }
      if (normalized.type === 'assistant_checkpoint') {
        const target = channel === 'requested' ? this.activeRun : this.backgroundTurn;
        if (target) target.nativeAssistantId = normalized.nativeAssistantId;
        continue;
      }
      if (normalized.type === 'native_error') {
        this.#finishBackgroundTurn('provider-ended');
        if (this.activeRun && inputMatch !== false) {
          this.#finishError(
            this.activeRun,
            new Error(normalized.message),
            normalized.code === 'provider_session_missing'
              ? normalized.providerSessionId
              : undefined,
          );
        } else {
          this.#emitSession({
            type: 'session_error',
            category: normalized.code === 'provider_session_missing'
              ? 'provider-session-missing'
              : 'provider',
            message: normalized.message,
            recoverable: true,
          });
          this.#finishBackgroundTurn('provider-ended');
        }
        return;
      }
      if (normalized.type === 'context_window') {
        this.authoritativeContextWindow = {
          model: normalized.model,
          contextWindow: normalized.contextWindow,
        };
        continue;
      }
      if (normalized.type === 'result') {
        this.#finishBackgroundTurn('completed');
        const active = this.activeRun;
        if (active?.nativeHandedOff && inputMatch !== false) {
          active.nativeCompleted = true;
          let turnStats = normalized.turnStats;
          if (turnStats && this.lastEncodedRequest?.options.persistSession !== false) {
            // Persisted timestamps define the rate both now and on replay. SDK result
            // duration ends later and cannot be reconstructed from every JSONL version.
            turnStats = undefined;
            const sessionId = this.providerSessionId;
            if (sessionId && active.nativeAssistantId) {
              turnStats = await loadClaudeTurnStats(
                this.config.vaultWorkingDirectory, sessionId, active.nativeAssistantId,
                { environment: this.lastEncodedRequest?.options.env ?? process.env },
              ).catch(() => undefined);
            }
          }
          if (this.activeRun === active && !active.terminal) this.#finishCompleted(active, 'completed', turnStats);
        }
      }
    }
  }

  handleNativeFailure(error: unknown, queryToken: number): void {
    if (this.disposed) return;
    if (this.#finishCancelledBackground(queryToken)) return;
    if (this.suppressedEphemeralQueryTokens.delete(queryToken)) return;
    if (this.suppressedPersistentQueryTokens.delete(queryToken)) {
      const replacement = this.activeRun;
      if (replacement && replacement.queryToken !== queryToken) {
        this.#finishError(replacement, error);
      }
      return;
    }
    this.#finishBackgroundTurn('provider-ended');
    const active = this.activeRun;
    if (active) {
      this.#finishError(active, error);
      return;
    }
    const details = classifyClaudeError(error, this.providerSessionId);
    if (details.category !== 'provider-session-missing') {
      this.#clearProviderSession();
    }
    this.#setInvalidated({
      reason: details.category === 'provider-session-missing'
        ? 'provider-session-missing'
        : details.category === 'process-exited'
          ? 'process-exited'
          : details.category === 'transport'
            ? 'transport-closed'
            : 'provider-error',
      recoverable: details.recoverable,
      message: details.message,
    });
    this.#emitSession({
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.#emitSession({
      type: 'session_error',
      ...details,
    });
  }

  handleNativeEnd(queryToken: number): void {
    if (this.disposed) return;
    if (this.#finishCancelledBackground(queryToken)) return;
    if (this.suppressedEphemeralQueryTokens.delete(queryToken)) return;
    if (this.suppressedPersistentQueryTokens.delete(queryToken)) {
      const replacement = this.activeRun;
      if (replacement && replacement.queryToken !== queryToken) {
        this.#finishError(
          replacement,
          new Error('Claude persistent query ended unexpectedly.'),
        );
      }
      return;
    }
    const hadBackground = this.backgroundTurn !== null;
    this.#finishBackgroundTurn('provider-ended');
    const active = this.activeRun;
    if (active) {
      if (active.accepted) {
        this.#finishCompleted(active, 'provider-ended');
      } else {
        this.#finishError(
          active,
          new Error('Claude ended before accepting the request.'),
        );
      }
    } else if (!hadBackground) {
      this.#clearProviderSession();
      this.#setInvalidated({
        reason: 'transport-closed',
        recoverable: true,
        message: 'Claude query ended unexpectedly.',
      });
      this.#emitSession({
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
      this.#emitSession({
        type: 'session_error',
        category: 'transport',
        message: 'Claude query ended unexpectedly.',
        recoverable: true,
      });
    }
  }

  getCommandSnapshot(): readonly SlashCommand[] | undefined {
    return this.commandSnapshot?.map(command => ({ ...command }));
  }

  publishCommands(query: Query, commands?: Awaited<ReturnType<Query['supportedCommands']>>): void {
    if (this.disposed || this.nativeQuery !== query) return;
    const publication = ++this.commandPublication;
    const publish = (snapshot: Awaited<ReturnType<Query['supportedCommands']>>) => {
      if (
        this.disposed
        || this.nativeQuery !== query
        || this.commandPublication !== publication
      ) return;
      this.commandSnapshot = snapshot.map(mapSDKCommand);
      this.#emitSession({ type: 'commands_changed' });
    };
    if (commands !== undefined) {
      publish(commands);
    } else {
      void query.supportedCommands().then(publish).catch(() => undefined);
    }
  }

  releaseNativeTurnFence(queryToken: number): void {
    this.suppressedEphemeralQueryTokens.delete(queryToken);
  }

  handleNativeQueryOpened(query: Query): void {
    if (this.nativeQuery === query) return;
    this.nativeQuery = query;
    this.commandSnapshot = undefined;
    this.authoritativeContextWindow = null;
  }

  handleNativeQueryClosed(query: Query): void {
    if (this.nativeQuery !== query) return;
    this.nativeQuery = null;
    this.commandSnapshot = undefined;
    this.#emitSession({ type: 'commands_changed' });
    this.authoritativeContextWindow = null;
  }

  handleAuthoritativeContextWindow(
    query: Query,
    model: string,
    contextWindow: number,
  ): void {
    if (
      this.nativeQuery !== query
      || !Number.isFinite(contextWindow)
      || contextWindow <= 0
    ) {
      return;
    }
    this.authoritativeContextWindow = { model, contextWindow };
    if (!this.activeRun && !this.backgroundTurn) return;
    const channel = this.#currentOutputChannel();
    const correctedUsage = this.eventNormalizer.updateContextWindow(
      channel,
      model,
      contextWindow,
    );
    const target = channel === 'requested' ? this.activeRun : this.backgroundTurn;
    if (correctedUsage && target) {
      this.#emitTurnOutput(target, {
        type: 'usage_updated',
        usage: correctedUsage,
      });
    }
  }

  async #startExecution(
    active: ActiveRequestedRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    try {
      const nativeResume = this.#getNativeResume();
      active.nativeFork = nativeResume.fork === true;
      const replayConversationHistory = this.#shouldReplayConversationHistory(
        request,
      );
      active.historyReplayGeneration = replayConversationHistory
        && this.replayHistoryOnNextTurn
        ? this.replayHistoryGeneration
        : null;
      const encoded = await this.encoder.encode(
        request,
        this.config,
        active.abortController,
        this.interactionHandler.canUseTool,
        nativeResume,
        replayConversationHistory,
      );
      if (this.activeRun !== active || active.terminal) return;
      this.lastEncodedRequest = encoded;
      this.lastAllowedTools = encoded.allowedTools;
      assertClaudeModelAvailable(this.host.settings, request.configuration.model);
      await this.strategy.startTurn(encoded, active.queryToken);
    } catch (error) {
      if (this.activeRun === active && !active.terminal) {
        if (active.abortController.signal.aborted) {
          this.cancel();
        } else {
          this.#finishError(active, error);
        }
      }
    }
  }

  #getNativeResume(): ClaudeNativeResume {
    if (this.config.nativePersistence === 'disabled-if-supported' && !this.pendingFork) {
      return {};
    }
    const nativeResumeSessionId = this.#getNativeResumeSessionId();
    return {
      ...(nativeResumeSessionId
        ? { sessionId: nativeResumeSessionId }
        : {}),
      ...(this.resumeAt ? { resumeAt: this.resumeAt } : {}),
      ...(this.pendingFork ? { fork: true } : {}),
    };
  }

  #getNativeResumeSessionId(): string | null {
    return this.providerSessionId
      ?? (this.pendingFork ? this.initialProviderSessionId : null);
  }

  #shouldReplayConversationHistory(
    request: ProviderExecutionRequest,
  ): boolean {
    if (!request.conversationHistory?.length) return false;
    if (this.config.nativePersistence === 'disabled-if-supported') {
      return !this.pendingFork && this.nativeQuery === null;
    }
    return !this.#getNativeResumeSessionId()
      || this.replayHistoryOnNextTurn;
  }

  #captureProviderSession(sessionId: string): void {
    this.#bumpRevision();
    if (this.config.nativePersistence === 'disabled-if-supported') {
      this.pendingFork = false;
      this.resumeAt = undefined;
      this.#deleteProviderStateValue('forkSource');
      return;
    }
    const liveProviderSessionId = this.providerSessionId;
    const previousProviderSessionId = liveProviderSessionId
      ?? this.initialProviderSessionId;
    const nativeFork = this.activeRun?.nativeFork ?? this.pendingFork;
    if (
      previousProviderSessionId
      && previousProviderSessionId !== sessionId
      && !nativeFork
    ) {
      if (liveProviderSessionId) {
        this.#markHistoryReplayPending();
      }
      const priorIds = Array.isArray(
        this.providerState.previousProviderSessionIds,
      )
        ? this.providerState.previousProviderSessionIds.filter(
          (value): value is string => typeof value === 'string',
        )
        : [];
      this.providerState.previousProviderSessionIds = [
        ...new Set([...priorIds, previousProviderSessionId]),
      ];
    }
    this.providerSessionId = sessionId;
    this.#setProviderStateValue('providerSessionId', sessionId);
    this.resumeAt = undefined;
    this.pendingFork = false;
    if (Object.prototype.hasOwnProperty.call(
      this.providerState,
      'forkSource',
    )) {
      this.#deleteProviderStateValue('forkSource');
    }
  }

  #markHistoryReplayPending(): void {
    this.replayHistoryOnNextTurn = true;
    this.replayHistoryGeneration += 1;
    this.#setProviderStateValue('historyReplayPending', true);
  }

  #clearHistoryReplayPending(expectedGeneration: number): void {
    if (
      !this.replayHistoryOnNextTurn
      || this.replayHistoryGeneration !== expectedGeneration
    ) {
      return;
    }
    this.replayHistoryOnNextTurn = false;
    this.#deleteProviderStateValue('historyReplayPending');
    this.#bumpRevision();
    this.#emitStateForCurrentTurn();
  }

  #currentOutputChannel(): 'requested' | 'background' {
    return this.responseOwnership.current(this.activeRun?.nativeHandedOff === true);
  }

  #getOutputTarget(channel = this.#currentOutputChannel()): ActiveRequestedRun | BackgroundTurn | null {
    if (channel === 'requested') return this.activeRun;
    if (!this.backgroundTurn) {
      const background: BackgroundTurn = {
        queryToken: this.nativeQueryToken,
        turnId: `claude-background-${++this.backgroundCounter}`,
        sequence: 0,
      };
      this.backgroundTurn = background;
      this.#setStatus('executing');
      this.#emitBackground(background, {
        type: 'background_turn_started',
        providerSessionId: this.providerSessionId ?? undefined,
        snapshotRevision: this.revision,
      });
      this.#emitBackground(background, {
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
    }
    return this.backgroundTurn;
  }

  #getInteractionTurnId(toolId: string): string | null {
    const channel = this.responseOwnership.toolChannel(toolId) ?? this.#currentOutputChannel();
    if (channel === 'requested' && this.activeRun) {
      this.#ensureRequestedAccepted(this.activeRun);
    } else if (this.activeRun && !this.activeRun.nativeHandedOff && !this.backgroundTurn) {
      return null;
    }
    return this.#getOutputTarget(channel)?.turnId ?? null;
  }

  #ensureRequestedAccepted(active: ActiveRequestedRun): void {
    if (active.accepted || active.terminal) return;
    active.accepted = true;
    this.#emitRequested(active, {
      type: 'turn_started',
      accepted: true,
      nativeUserMessageId: active.nativeUserMessageId,
    });
    this.#emitRequested(active, {
      type: 'user_message_started',
      nativeUserMessageId: active.nativeUserMessageId,
    });
    const historyReplayGeneration = active.historyReplayGeneration;
    active.historyReplayGeneration = null;
    if (historyReplayGeneration !== null) {
      this.#clearHistoryReplayPending(historyReplayGeneration);
    }
  }

  #emitTurnOutput(
    target: ActiveRequestedRun | BackgroundTurn,
    event: WithoutScope<
      ProviderExecutionEvent | ProviderSessionEvent
    >,
  ): void {
    if ('executionId' in target) {
      this.#emitRequested(
        target,
        event as WithoutScope<ProviderExecutionEvent>,
      );
    } else {
      this.#emitBackground(
        target,
        event as WithoutScope<ProviderSessionEvent>,
      );
    }
  }

  #emitRequested(
    active: ActiveRequestedRun,
    event: WithoutScope<ProviderExecutionEvent>,
  ): void {
    if (active.terminal) return;
    const scope = this.#nextRequestedScope(active);
    this.lastRequestedEventScope = scope;
    active.events.push({
      ...event,
      scope,
    });
  }

  #emitBackground(
    background: BackgroundTurn,
    event: WithoutScope<ProviderSessionEvent>,
  ): void {
    const scope: ProviderBackgroundEventScope = {
      kind: 'background', sessionInstanceId: this.sessionInstanceId,
      turnId: background.turnId, sequence: ++background.sequence,
    };
    this.lastBackgroundEventScope = scope;
    this.#notifySessionListeners({
      ...event,
      scope,
    } as ProviderSessionEvent);
  }

  #emitSession(
    event: WithoutScope<ProviderSessionEvent>,
  ): void {
    this.#notifySessionListeners({
      ...event,
      scope: this.#nextSessionScope(),
    } as ProviderSessionEvent);
  }

  #notifySessionListeners(event: ProviderSessionEvent): void {
    for (const listener of this.sessionListeners) {
      try {
        listener(event);
      } catch {
        // Listener failures cannot affect the native Claude lifecycle.
      }
    }
  }

  #emitRequestedState(active: ActiveRequestedRun): void {
    this.#emitRequested(active, {
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
  }

  #emitStateForCurrentTurn(): void {
    if (this.activeRun) {
      this.#emitRequestedState(this.activeRun);
    } else if (this.backgroundTurn) {
      this.#emitBackground(this.backgroundTurn, {
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
    } else {
      this.#emitSession({
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
    }
  }

  #emitPermissionModeForCurrentTurn(permissionMode: PermissionMode): void {
    this.#bumpRevision();
    const event = {
      type: 'permission_mode_changed' as const,
      permissionMode,
      snapshot: this.getSnapshot(),
    };
    if (this.activeRun) {
      this.#emitRequested(this.activeRun, event);
    } else if (this.backgroundTurn) {
      this.#emitBackground(this.backgroundTurn, event);
    } else {
      this.#emitSession(event);
    }
  }

  #finishCompleted(
    active: ActiveRequestedRun,
    reason: 'completed' | 'provider-ended',
    turnStats?: TurnStats,
  ): void {
    if (active.terminal) return;
    this.#setStatus('idle');
    this.#emitRequestedState(active);
    this.#emitRequested(active, {
      type: 'turn_completed',
      nativeAssistantId: active.nativeAssistantId,
      ...(turnStats ? { turnStats } : {}),
      reason,
    });
    this.#endActiveRun(active);
  }

  #finishError(
    active: ActiveRequestedRun,
    error: unknown,
    missingProviderSessionId?: string,
  ): void {
    if (active.terminal) return;
    const details = classifyClaudeError(
      error,
      this.providerSessionId,
      missingProviderSessionId,
    );
    if (
      details.category === 'configuration'
      || details.category === 'authentication'
    ) {
      this.#setStatus('idle');
    } else {
      if (details.category !== 'provider-session-missing') {
        this.#clearProviderSession();
      }
      this.#setInvalidated({
        reason: details.category === 'provider-session-missing'
          ? 'provider-session-missing'
          : details.category === 'process-exited'
            ? 'process-exited'
            : details.category === 'transport'
              ? 'transport-closed'
              : 'provider-error',
        recoverable: details.recoverable,
        message: details.message,
      });
    }
    this.#emitRequestedState(active);
    this.#emitRequested(active, {
      type: 'execution_error',
      ...details,
    });
    this.#endActiveRun(active);
  }

  #finishCancelledBackground(queryToken: number): boolean {
    if (this.cancelledBackgroundQueryToken !== queryToken) return false;
    this.cancelledBackgroundQueryToken = null;
    this.#finishBackgroundTurn('provider-ended');
    return true;
  }

  #finishBackgroundTurn(
    reason: 'completed' | 'provider-ended',
  ): void {
    const background = this.backgroundTurn;
    if (!background) return;
    this.#setStatus(this.activeRun ? 'executing' : 'idle');
    this.#emitBackground(background, {
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.#emitBackground(background, {
      type: 'background_turn_completed',
      nativeAssistantId: background.nativeAssistantId,
      providerSessionId: this.providerSessionId ?? undefined,
      snapshotRevision: this.revision,
      reason,
    });
    this.backgroundTurn = null;
    this.eventNormalizer.reset('background');
    this.responseOwnership.reset('background');
  }

  #endActiveRun(active: ActiveRequestedRun): void {
    if (active.terminal) return;
    active.terminal = true;
    active.requestSignal.removeEventListener(
      'abort',
      active.onRequestAbort,
    );
    active.events.close();
    if (this.activeRun === active) {
      this.activeRun = null;
    }
    this.eventNormalizer.reset('requested');
    this.responseOwnership.reset('requested');
  }

  #setStatus(status: Exclude<ProviderSessionStatus, 'invalidated'>): void {
    this.status = status;
    this.snapshotInvalidation = null;
    this.#bumpRevision();
  }

  #setInvalidated(
    invalidation: ProviderSessionInvalidation,
  ): void {
    this.status = 'invalidated';
    this.snapshotInvalidation = invalidation;
    this.#bumpRevision();
  }

  #setProviderStateValue(key: string, value: unknown): void {
    this.providerState[key] = value;
    this.pendingProviderStateDeletes.delete(key);
  }

  #deleteProviderStateValue(key: string): void {
    delete this.providerState[key];
    this.pendingProviderStateDeletes.add(key);
  }

  #clearProviderSession(): void {
    this.providerSessionId = null;
    this.#deleteProviderStateValue('providerSessionId');
  }

  #bumpRevision(): void {
    this.revision += 1;
  }

  #nextRequestedScope(
    active: ActiveRequestedRun,
  ): ProviderRequestedEventScope {
    return {
      kind: 'requested',
      sessionInstanceId: this.sessionInstanceId,
      executionId: active.executionId,
      turnId: active.turnId,
      sequence: ++active.sequence,
    };
  }

  #nextSessionScope(): ProviderSessionEventScope {
    return {
      kind: 'session',
      sessionInstanceId: this.sessionInstanceId,
      sequence: ++this.sessionSequence,
    };
  }

  #hasRewindSeed(): boolean {
    return this.config.lifecycle === 'persistent'
      && Boolean(this.providerSessionId);
  }

  async #getOrPrepareRewindQuery(): Promise<Query | null> {
    const ready = this.strategy.getRewindQuery();
    if (ready) return ready;
    if (!this.providerSessionId || this.activeRun || this.disposed) {
      return null;
    }
    const request = createRewindPreparationRequest();
    const abortController = new AbortController();
    const queryToken = ++this.queryToken;
    const encoded = await this.encoder.encode(
      request,
      this.config,
      abortController,
      this.interactionHandler.canUseTool,
      this.#getNativeResume(),
      false,
    );
    this.lastEncodedRequest = encoded;
    this.lastAllowedTools = encoded.allowedTools;
    return await this.strategy.ensureReadyForRewind(encoded, queryToken);
  }
}

type WithoutScope<T> = T extends unknown ? Omit<T, 'scope'> : never;

function isRequestedTurnEvidence(message: SDKMessage): boolean {
  return message.type === 'user'
    || message.type === 'assistant'
    || message.type === 'stream_event'
    || message.type === 'result';
}

function classifyClaudeError(
  error: unknown,
  expectedSessionId: string | null,
  explicitMissingSessionId?: string,
): {
  category:
    | 'provider-session-missing'
    | 'authentication'
    | 'configuration'
    | 'transport'
    | 'process-exited'
    | 'provider'
    | 'unknown';
  message: string;
  recoverable: boolean;
  missingProviderSessionId?: string;
} {
  const message = error instanceof Error
    ? error.message
    : String(error);
  const missingSessionId = explicitMissingSessionId
    ?? getMissingSessionId(error)
    ?? undefined;
  if (
    explicitMissingSessionId
    || isSessionMissingError(error, expectedSessionId ?? undefined)
  ) {
    return {
      category: 'provider-session-missing',
      message,
      recoverable: true,
      missingProviderSessionId: missingSessionId,
    };
  }
  const normalized = message.toLowerCase();
  if (
    normalized.includes('authentication')
    || normalized.includes('unauthorized')
    || normalized.includes('api key')
  ) {
    return {
      category: 'authentication',
      message,
      recoverable: true,
    };
  }
  if (
    error instanceof ProviderModelUnavailableError
    || normalized.includes('cli not found')
    || normalized.includes('node.js')
    || normalized.includes('could not determine')
  ) {
    return {
      category: 'configuration',
      message,
      recoverable: true,
    };
  }
  if (
    normalized.includes('process exited')
    || normalized.includes('epipe')
  ) {
    return {
      category: 'process-exited',
      message,
      recoverable: true,
    };
  }
  if (
    normalized.includes('transport')
    || normalized.includes('connection')
  ) {
    return {
      category: 'transport',
      message,
      recoverable: true,
    };
  }
  return {
    category: 'provider',
    message,
    recoverable: true,
  };
}

function getValidForkSource(value: unknown): {
  sessionId: string;
  resumeAt: string;
} | null {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === 'string'
    && typeof record.resumeAt === 'string'
    ? {
      sessionId: record.sessionId,
      resumeAt: record.resumeAt,
    }
    : null;
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function mapSDKCommand(command: SDKSlashCommand): SlashCommand {
  return {
    id: `sdk:${command.name}`,
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    content: '',
    source: 'sdk',
  };
}

function createRewindPreparationRequest(): ProviderExecutionRequest {
  return {
    input: [],
    configuration: {
      systemInstructions: { kind: 'provider-default' },
    },
    toolPolicy: { kind: 'provider-default' },
    signal: new AbortController().signal,
  };
}
