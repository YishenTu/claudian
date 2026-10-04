import type {
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';

import {
  type ChatRewindMode,
  type ChatRewindPreview,
  type ChatRewindResult,
  type ProviderBackgroundEventScope,
  type ProviderExecutionEvent,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderRequestedEventScope,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  RequestedRunChannel,
  type RequestedRunEvent,
  type RequestedRunTerminalEvent,
  type RewindableExecutionSession,
  SessionSnapshotState,
  type SteerableExecutionSession,
  type WithoutEventScope,
} from '../../../core/execution';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand, TurnStats } from '../../../core/types';
import { mapSDKCommands } from '../commands/probeRuntimeCommands';
import { loadClaudeTurnStats } from '../history/ClaudeTurnStats';
import { type ClaudePermissionMode, fromClaudeSDKPermissionMode } from '../permissionModes';
import { assertClaudeModelAvailable } from '../runtime/ClaudeModelAvailability';
import { executeClaudeRewind } from '../runtime/ClaudeRewindService';
import { buildClaudeSDKUserMessage } from '../runtime/ClaudeUserMessageFactory';
import { type ClaudeRuntimeCatalog, toClaudeRuntimeCatalog } from '../runtime/probeClaudeModels';
import { getClaudeProviderSettings } from '../settings';
import { classifyClaudeError, getClaudeInvalidationReason } from './classifyClaudeError';
import { ClaudeExecutionEventNormalizer } from './ClaudeExecutionEventNormalizer';
import {
  type ClaudeEncodedExecutionRequest,
  ClaudeExecutionRequestEncoder,
  getRequestInputText,
} from './ClaudeExecutionRequestEncoder';
import {
  ClaudeEphemeralExecutionStrategy,
  type ClaudeExecutionStrategy,
  type ClaudeExecutionStrategySink,
  ClaudePersistentExecutionStrategy,
} from './ClaudeExecutionStrategies';
import { ClaudeInteractionHandler } from './ClaudeInteractionHandler';
import { ClaudeResponseOwnership } from './ClaudeResponseOwnership';
import { ClaudeResumeState } from './ClaudeResumeState';
import { ClaudeTaskNotificationQueue } from './ClaudeTaskNotificationQueue';
import { type ClaudeTurnInputs, getReplayedUserMessageId } from './ClaudeTurnInputs';

export interface ClaudeExecutionSessionOptions {
  /** Receives the catalog each native query reports at init; persistence stays with the catalog owner. */
  readonly publishSessionCatalog?: (catalog: ClaudeRuntimeCatalog) => Promise<void> | void;
}

interface ActiveRequestedRun {
  readonly run: RequestedRunChannel;
  readonly abortController: AbortController;
  readonly queryToken: number;
  accepted: boolean;
  nativeFork: boolean;
  nativeHandedOff: boolean;
  nativeCompleted?: boolean;
  historyReplayGeneration: number | null;
  inputs: ClaudeTurnInputs | null;
  readonly steers: Map<string, PendingClaudeSteer>;
  nativeAssistantId?: string;
}

/** A steer handed to native input whose delivery into the run is not yet known. */
interface PendingClaudeSteer {
  readonly content: string;
  resolve(accepted: boolean): void;
  reject(error: Error): void;
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
SteerableExecutionSession,
ClaudeExecutionStrategySink {
  readonly providerId = 'claude' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly encoder: ClaudeExecutionRequestEncoder;
  private readonly strategy: ClaudeExecutionStrategy;
  private readonly usesPersistentQuery: boolean;
  private readonly interactionHandler: ClaudeInteractionHandler;
  private readonly state: SessionSnapshotState;
  private readonly resume: ClaudeResumeState;
  private activeRun: ActiveRequestedRun | null = null;
  /** Native predictions trail result and have no turn ID; only the latest successful requested turn can own one. */
  private suggestionTurnId: string | null = null;
  // Native settlement can precede consumption of the requested event queue.
  private lastRequestedEventScope: ProviderRequestedEventScope | undefined;
  private lastBackgroundEventScope: ProviderBackgroundEventScope | undefined;
  private backgroundTurn: BackgroundTurn | null = null;
  private nativeQueryToken = 0;
  private cancelledBackgroundQueryToken: number | null = null;
  private backgroundCounter = 0;
  private queryToken = 0;
  private commandPublication = 0;
  private commandSnapshot: SlashCommand[] | undefined;
  private disposed = false;
  private readonly suppressedPersistentQueryTokens = new Set<number>();
  private readonly suppressedEphemeralQueryTokens = new Set<number>();
  private lastEncodedRequest: ClaudeEncodedExecutionRequest | null = null;
  private lastAllowedTools: ReadonlySet<string> | null = null;
  private readonly eventNormalizer = new ClaudeExecutionEventNormalizer();
  private readonly responseOwnership = new ClaudeResponseOwnership();
  private readonly taskNotifications = new ClaudeTaskNotificationQueue();
  private nativeQuery: Query | null = null;
  /** The most recent model window reported by result metadata. */
  private knownContextWindow: {
    readonly model: string;
    readonly contextWindow: number;
  } | null = null;

  constructor(
    private readonly host: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: ClaudeExecutionSessionOptions = {},
  ) {
    const state = { ...(config.resumeSeed?.providerState ?? {}) };
    // Subagent history belongs to the conversation projection, not native resume state.
    // Snapshots merge their keys into that projection without deleting omitted history.
    delete state.subagentData;
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      providerState: state,
      readProviderSessionId: () => this.resume.providerSessionId,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.resume = new ClaudeResumeState(
      config.resumeSeed,
      {
        get: key => this.state.providerState[key],
        has: key => this.state.hasProviderStateValue(key),
        set: (key, value) => this.state.setProviderStateValue(key, value),
        delete: key => this.state.deleteProviderStateValue(key),
      },
      config.nativePersistence === 'disabled-if-supported',
    );
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
      throw new Error('Claude Code execution session is disposed');
    }
    if (this.activeRun) {
      throw new Error('Claude Code execution session already has an active run');
    }
    this.suggestionTurnId = null;

    const run = new RequestedRunChannel({
      onCancel: () => {
        if (this.activeRun === active) this.cancel();
      },
      sessionInstanceId: this.sessionInstanceId,
    });
    const active: ActiveRequestedRun = {
      run,
      abortController: new AbortController(),
      queryToken: ++this.queryToken,
      accepted: false,
      nativeFork: false,
      nativeHandedOff: false,
      historyReplayGeneration: null,
      inputs: null,
      steers: new Map(),
    };
    this.activeRun = active;
    this.state.setStatus('executing');
    this.#emitRequestedState(active);
    run.attachAbortSignal(request.signal);
    if (!run.isTerminal) void this.#startExecution(active, request);
    return run;
  }

  cancel(): void {
    this.suggestionTurnId = null;
    const active = this.activeRun;
    if (active?.nativeCompleted) return;
    if (!active || active.run.isTerminal) {
      if (!this.backgroundTurn || this.cancelledBackgroundQueryToken !== null) return;
      this.cancelledBackgroundQueryToken = this.backgroundTurn.queryToken;
      this.state.setStatus('cancelling');
      this.#emitBackground(this.backgroundTurn, {
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
      this.interactionHandler.dismissAll('cancelled');
      this.strategy.cancel(null, true);
      return;
    }
    this.state.setStatus('cancelling');
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
    this.state.setStatus(this.backgroundTurn ? 'executing' : 'idle');
    this.#emitRequestedState(active);
    this.#endActiveRun(active, {
      type: 'cancelled',
      reason: 'Cancelled',
    });
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    try {
      assertClaudeModelAvailable(this.host.settings, request.configuration.model);
    } catch (error) {
      if (error instanceof ProviderModelUnavailableError) return false;
      throw error;
    }
    const active = this.activeRun;
    if (
      this.disposed
      || !active
      || active.run.isTerminal
      || !active.nativeHandedOff
      || active.nativeCompleted
      || !active.inputs
      || active.abortController.signal.aborted
      || request.signal.aborted
    ) {
      return false;
    }
    const encoded = this.encoder.encodeSteer(request);
    const message = buildClaudeSDKUserMessage(
      encoded.prompt,
      this.resume.providerSessionId ?? '',
      encoded.images,
    );
    const acceptance = new Promise<boolean>((resolve, reject) => {
      active.steers.set(message.uuid, {
        content: getRequestInputText(request),
        resolve,
        reject,
      });
    });
    if (!this.strategy.steerTurn(message, active.queryToken)) {
      active.steers.delete(message.uuid);
      return false;
    }
    return acceptance;
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    return this.state.onEvent(listener);
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
    this.state.setStatus('disposed');
    this.#emitSession({
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.state.clearListeners();
    this.taskNotifications.reset();
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
        error: 'No Claude Code session is available to rewind.',
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
        error: 'Claude Code rewind requires a persistent resumed session.',
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
        error: 'No Claude Code session is available to rewind.',
      };
    }
    const query = mode === 'conversation'
      ? this.strategy.getRewindQuery()
      : await this.#getOrPrepareRewindQuery();
    if (mode !== 'conversation' && !query) {
      return {
        canRewind: false,
        error: 'Claude Code rewind requires a persistent resumed session.',
      };
    }
    const result = await executeClaudeRewind(userMessageId, {
      assistantMessageId,
      mode,
      rewindFiles: async (id, dryRun) => {
        if (!query) {
          return {
            canRewind: false,
            error: 'Claude Code rewind query is unavailable.',
          };
        }
        return await query.rewindFiles(id, { dryRun });
      },
      closePersistentQuery: () => this.strategy.cancel(null, true),
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
    return this.resume.getNativeResumeSessionId();
  }

  bindNativeTurnInputs(inputs: ClaudeTurnInputs, queryToken: number): void {
    if (this.activeRun?.queryToken === queryToken) {
      this.activeRun.inputs = inputs;
    }
  }

  markNativeTurnHandedOff(queryToken: number): void {
    const active = this.activeRun;
    if (
      active
      && active.queryToken === queryToken
      && !active.run.isTerminal
    ) {
      active.nativeHandedOff = true;
    }
  }

  async handleNativeMessage(
    message: SDKMessage,
    queryToken: number,
  ): Promise<void> {
    if (this.disposed) return;
    if (message.type === 'prompt_suggestion') {
      const originatingTurnId = this.suggestionTurnId;
      this.suggestionTurnId = null;
      if (originatingTurnId && !this.activeRun
        && message.session_id === this.resume.providerSessionId
        && this.lastEncodedRequest?.options.promptSuggestions
        && getClaudeProviderSettings(this.host.settings).promptSuggestions
        && message.suggestion.trim()) {
        this.#emitSession({ type: 'prompt_suggestion', originatingTurnId, suggestion: message.suggestion });
      }
      return;
    }
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

    this.nativeQueryToken = queryToken;
    this.taskNotifications.observe(message);
    const active = this.activeRun;
    const intendedModel = this.lastEncodedRequest?.model;
    const reportedContextWindow = intendedModel
      && this.knownContextWindow?.model === intendedModel
      ? this.knownContextWindow.contextWindow
      : undefined;
    // Completion settles the card; the native user echo marks where the model
    // actually consumed the notification (including folded queued commands).
    if (message.type === 'user' && message.parent_tool_use_id == null
      && (!message.uuid || !active?.inputs?.ids.includes(message.uuid))) {
      const notification = this.taskNotifications.consume(message.message.content);
      if (notification !== null) {
        this.#emitTaskNotification(notification);
        return;
      }
    }
    const replayedInputId = getReplayedUserMessageId(message);
    if (replayedInputId !== undefined) {
      // Replays acknowledge input only; they carry no output of their own.
      if (active?.nativeHandedOff && active.inputs?.ids.includes(replayedInputId)) {
        this.#ensureRequestedAccepted(active);
        this.#acceptDeliveredSteer(active, replayedInputId);
      }
      return;
    }
    const inputMatch = active?.inputs?.matches(message);
    const channel = this.responseOwnership.resolve(message, active?.nativeHandedOff === true, active?.inputs?.ids);
    if (channel === 'requested' && isRequestedTurnEvidence(message)
      && !this.responseOwnership.hasPending('background')) {
      this.#finishBackgroundTurn('provider-ended');
    }
    // SDK 0.3.283 echoes folded notifications, but omits the synthetic user
    // message that starts an automatic turn. Publish the completions selected
    // at native init before reserving that response's transcript position.
    if (channel === 'background'
      && ((message.type === 'stream_event' && message.event.type === 'message_start')
        || message.type === 'assistant') && message.parent_tool_use_id == null) {
      for (const content of this.taskNotifications.takeTurnNotifications()) this.#emitTaskNotification(content);
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
        this.state.bumpRevision();
        this.resume.capture(event.sessionId, this.activeRun?.nativeFork);
        this.#emitStateForCurrentTurn();
        const permissionMode = fromClaudeSDKPermissionMode(event.permissionMode);
        if (permissionMode) {
          this.#emitPermissionModeForCurrentTurn(permissionMode);
        }
        continue;
      }
      if (normalized.type === 'async_subagent_completion') {
        const event = normalized.event;
        this.taskNotifications.complete(message, event.result);
        this.#emitSession({
          type: 'async_subagent_completed',
          originatingTurnId: event.toolUseId
            ?? active?.run.turnId
            ?? this.backgroundTurn?.turnId
            ?? event.taskId,
          subagentId: event.taskId,
          status: event.status,
          result: event.result,
          providerSessionId: event.providerSessionId,
          snapshotRevision: this.state.revision,
          providerPayload: event,
        });
        continue;
      }
      if (normalized.type === 'subagent_progress') {
        this.#emitSession({ type: 'subagent_progress', progress: normalized.event.progress });
        continue;
      }
      if (normalized.type === 'output') {
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
        this.knownContextWindow = {
          model: normalized.model,
          contextWindow: normalized.contextWindow,
        };
        continue;
      }
      if (normalized.type === 'result') {
        this.#finishBackgroundTurn('completed');
        const active = this.activeRun;
        if (active?.nativeHandedOff && inputMatch !== false) {
          // A steer Claude queued behind this result keeps the run open.
          if (active.inputs && !active.inputs.settled) continue;
          this.#settleConsumedSteers(active);
          active.nativeCompleted = true;
          let turnStats = normalized.turnStats;
          if (turnStats && this.lastEncodedRequest?.options.persistSession !== false) {
            // Persisted timestamps define the rate both now and on replay. SDK result
            // duration ends later and cannot be reconstructed from every JSONL version.
            turnStats = undefined;
            const sessionId = this.resume.providerSessionId;
            if (sessionId && active.nativeAssistantId) {
              turnStats = await loadClaudeTurnStats(
                this.config.vaultWorkingDirectory, sessionId, active.nativeAssistantId,
                { environment: this.lastEncodedRequest?.options.env ?? process.env },
              ).catch(() => undefined);
            }
          }
          if (this.activeRun === active && !active.run.isTerminal) {
            this.suggestionTurnId = message.type === 'result' && message.subtype === 'success'
              && !message.is_error && this.lastEncodedRequest?.options.promptSuggestions
              ? active.run.turnId : null;
            this.#finishCompleted(active, 'completed', turnStats);
          }
        }
      }
    }
  }

  handleNativeFailure(error: unknown, queryToken: number): void {
    this.suggestionTurnId = null;
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
    const details = classifyClaudeError(error, this.resume.providerSessionId);
    if (details.category !== 'provider-session-missing') {
      this.resume.clearProviderSession();
    }
    this.state.invalidate({
      reason: getClaudeInvalidationReason(details.category),
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
          new Error('Claude Code persistent query ended unexpectedly.'),
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
          new Error('Claude Code ended before accepting the request.'),
        );
      }
    } else if (!hadBackground) {
      this.resume.clearProviderSession();
      this.state.invalidate({
        reason: 'transport-closed',
        recoverable: true,
        message: 'Claude Code query ended unexpectedly.',
      });
      this.#emitSession({
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
      this.#emitSession({
        type: 'session_error',
        category: 'transport',
        message: 'Claude Code query ended unexpectedly.',
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
      this.commandSnapshot = mapSDKCommands(snapshot);
      this.#emitSession({ type: 'commands_changed' });
    };
    if (commands !== undefined) {
      publish(commands);
    } else {
      void query.supportedCommands().then(publish).catch(() => undefined);
    }
  }

  publishCatalog(query: Query): void {
    const publish = this.options.publishSessionCatalog;
    if (!publish || this.disposed || this.nativeQuery !== query) return;
    void query.initializationResult()
      .then((initialization) => {
        if (this.disposed || this.nativeQuery !== query) return;
        return publish(toClaudeRuntimeCatalog(initialization));
      })
      // Catalog write-back is best-effort and cannot disrupt execution.
      .catch(() => undefined);
  }

  releaseNativeTurnFence(queryToken: number): void {
    this.suppressedEphemeralQueryTokens.delete(queryToken);
  }

  handleNativeQueryOpened(query: Query): void {
    if (this.nativeQuery === query) return;
    this.suggestionTurnId = null;
    this.nativeQuery = query;
    this.taskNotifications.reset();
    this.commandSnapshot = undefined;
    this.knownContextWindow = null;
  }

  handleNativeQueryClosed(query: Query): void {
    if (this.nativeQuery !== query) return;
    this.suggestionTurnId = null;
    this.nativeQuery = null;
    this.taskNotifications.reset();
    this.commandSnapshot = undefined;
    this.#emitSession({ type: 'commands_changed' });
    this.knownContextWindow = null;
  }

  async #startExecution(
    active: ActiveRequestedRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    try {
      const nativeResume = this.resume.getNativeResume();
      active.nativeFork = nativeResume.fork === true;
      const replayConversationHistory = this.resume.shouldReplayConversationHistory(
        Boolean(request.conversationHistory?.length),
        this.nativeQuery !== null,
      );
      active.historyReplayGeneration = replayConversationHistory
        ? this.resume.pendingReplayGeneration
        : null;
      const encoded = await this.encoder.encode(
        request,
        this.config,
        active.abortController,
        this.interactionHandler.canUseTool,
        nativeResume,
        replayConversationHistory,
      );
      if (this.activeRun !== active || active.run.isTerminal) return;
      this.lastEncodedRequest = encoded;
      this.lastAllowedTools = encoded.allowedTools;
      assertClaudeModelAvailable(this.host.settings, request.configuration.model);
      await this.strategy.startTurn(encoded, active.queryToken);
    } catch (error) {
      if (this.activeRun === active && !active.run.isTerminal) {
        if (active.abortController.signal.aborted) {
          this.cancel();
        } else {
          this.#finishError(active, error);
        }
      }
    }
  }

  #currentOutputChannel(): 'requested' | 'background' {
    return this.responseOwnership.current(this.activeRun?.nativeHandedOff === true);
  }

  #emitTaskNotification(content: string): void {
    this.#emitSession({
      type: 'task_notification', content,
      afterRequestedEvent: this.lastRequestedEventScope,
      afterBackgroundEvent: this.lastBackgroundEventScope,
    });
  }

  #getOutputTarget(channel = this.#currentOutputChannel()): ActiveRequestedRun | BackgroundTurn | null {
    if (channel === 'requested') return this.activeRun;
    if (!this.backgroundTurn) {
      this.suggestionTurnId = null;
      const background: BackgroundTurn = {
        queryToken: this.nativeQueryToken,
        turnId: `claude-background-${++this.backgroundCounter}`,
        sequence: 0,
      };
      this.backgroundTurn = background;
      this.state.setStatus('executing');
      this.#emitBackground(background, {
        type: 'background_turn_started',
        providerSessionId: this.resume.providerSessionId ?? undefined,
        snapshotRevision: this.state.revision,
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
    const target = this.#getOutputTarget(channel);
    if (!target) return null;
    return 'run' in target ? target.run.turnId : target.turnId;
  }

  #ensureRequestedAccepted(active: ActiveRequestedRun): void {
    if (active.accepted || active.run.isTerminal) return;
    active.accepted = true;
    const nativeUserMessageId = active.inputs?.primaryId;
    this.#emitRequested(active, {
      type: 'turn_started',
      accepted: true,
      nativeUserMessageId,
    });
    this.#emitRequested(active, {
      type: 'user_message_started',
      nativeUserMessageId,
    });
    const historyReplayGeneration = active.historyReplayGeneration;
    active.historyReplayGeneration = null;
    if (
      historyReplayGeneration !== null
      && this.resume.clearReplayPending(historyReplayGeneration)
    ) {
      this.state.bumpRevision();
      this.#emitStateForCurrentTurn();
    }
  }

  #acceptDeliveredSteer(active: ActiveRequestedRun, nativeUserMessageId: string): void {
    const steer = active.steers.get(nativeUserMessageId);
    if (!steer || active.run.isTerminal) return;
    active.steers.delete(nativeUserMessageId);
    this.eventNormalizer.beginUserBoundary('requested');
    this.#emitRequested(active, {
      type: 'user_message_started',
      content: steer.content,
      nativeUserMessageId,
    });
    steer.resolve(true);
  }

  /** Consumption without a replay is still definite; history supplies the message. */
  #settleConsumedSteers(active: ActiveRequestedRun): void {
    for (const [id, steer] of active.steers) {
      if (!active.inputs?.wasConsumed(id)) continue;
      active.steers.delete(id);
      steer.resolve(true);
    }
  }

  #emitTurnOutput(
    target: ActiveRequestedRun | BackgroundTurn,
    event: WithoutEventScope<
      ProviderExecutionEvent | ProviderSessionEvent
    >,
  ): void {
    if ('run' in target) {
      this.#emitRequested(
        target,
        event as WithoutEventScope<ProviderExecutionEvent>,
      );
    } else {
      this.#emitBackground(
        target,
        event as WithoutEventScope<ProviderSessionEvent>,
      );
    }
  }

  #emitRequested(
    active: ActiveRequestedRun,
    event: RequestedRunEvent,
  ): void {
    const scope = active.run.emit(event);
    if (scope) this.lastRequestedEventScope = scope;
  }

  #emitBackground(
    background: BackgroundTurn,
    event: WithoutEventScope<ProviderSessionEvent>,
  ): void {
    const scope: ProviderBackgroundEventScope = {
      kind: 'background', sessionInstanceId: this.sessionInstanceId,
      turnId: background.turnId, sequence: ++background.sequence,
    };
    this.lastBackgroundEventScope = scope;
    this.state.notify({
      ...event,
      scope,
    } as ProviderSessionEvent);
  }

  #emitSession(
    event: WithoutEventScope<ProviderSessionEvent>,
  ): void {
    this.state.emit(event);
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

  #emitPermissionModeForCurrentTurn(permissionMode: ClaudePermissionMode): void {
    this.state.bumpRevision();
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
    if (active.run.isTerminal) return;
    this.state.setStatus('idle');
    this.#emitRequestedState(active);
    this.#endActiveRun(active, {
      type: 'turn_completed',
      nativeAssistantId: active.nativeAssistantId,
      ...(turnStats ? { turnStats } : {}),
      reason,
    });
  }

  #finishError(
    active: ActiveRequestedRun,
    error: unknown,
    missingProviderSessionId?: string,
  ): void {
    if (active.run.isTerminal) return;
    const details = classifyClaudeError(
      error,
      this.resume.providerSessionId,
      missingProviderSessionId,
    );
    if (
      details.category === 'configuration'
      || details.category === 'authentication'
    ) {
      this.state.setStatus('idle');
    } else {
      if (details.category !== 'provider-session-missing') {
        this.resume.clearProviderSession();
      }
      this.state.invalidate({
        reason: getClaudeInvalidationReason(details.category),
        recoverable: details.recoverable,
        message: details.message,
      });
    }
    this.#emitRequestedState(active);
    this.#endActiveRun(active, {
      type: 'execution_error',
      ...details,
    });
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
    this.state.setStatus(this.activeRun ? 'executing' : 'idle');
    this.#emitBackground(background, {
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.#emitBackground(background, {
      type: 'background_turn_completed',
      nativeAssistantId: background.nativeAssistantId,
      providerSessionId: this.resume.providerSessionId ?? undefined,
      snapshotRevision: this.state.revision,
      reason,
    });
    this.backgroundTurn = null;
    this.eventNormalizer.reset('background');
    this.responseOwnership.reset('background');
  }

  #endActiveRun(
    active: ActiveRequestedRun,
    event: RequestedRunTerminalEvent,
  ): void {
    const scope = active.run.finish(event);
    if (!scope) return;
    this.lastRequestedEventScope = scope;
    for (const steer of active.steers.values()) {
      // Handed-off input with unknown delivery must not be resent as unsent.
      steer.reject(new Error('Claude Code run ended before the steer was delivered.'));
    }
    active.steers.clear();
    if (this.activeRun === active) {
      this.activeRun = null;
    }
    this.eventNormalizer.reset('requested');
    this.responseOwnership.reset('requested');
  }

  #hasRewindSeed(): boolean {
    return this.config.lifecycle === 'persistent'
      && Boolean(this.resume.providerSessionId);
  }

  async #getOrPrepareRewindQuery(): Promise<Query | null> {
    const ready = this.strategy.getRewindQuery();
    if (ready) return ready;
    if (!this.resume.providerSessionId || this.activeRun || this.disposed) {
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
      this.resume.getNativeResume(),
      false,
    );
    this.lastEncodedRequest = encoded;
    this.lastAllowedTools = encoded.allowedTools;
    return await this.strategy.ensureReadyForRewind(encoded, queryToken);
  }
}

function isRequestedTurnEvidence(message: SDKMessage): boolean {
  return message.type === 'user'
    || message.type === 'assistant'
    || message.type === 'stream_event'
    || message.type === 'result';
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
