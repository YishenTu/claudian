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
  type ModeConfigurableExecutionSession,
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
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { PermissionMode, SlashCommand } from '../../../core/types';
import {
  getMissingSessionId,
  isSessionMissingError,
} from '../../../utils/session';
import type { ClaudeWorkspaceServices } from '../app/ClaudeWorkspaceServices';
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

interface ActiveRequestedRun {
  readonly executionId: string;
  readonly turnId: string;
  readonly events: AsyncEventStream<ProviderExecutionEvent>;
  readonly abortController: AbortController;
  readonly requestSignal: AbortSignal;
  readonly onRequestAbort: () => void;
  readonly queryToken: number;
  sequence: number;
  accepted: boolean;
  nativeFork: boolean;
  nativeHandedOff: boolean;
  historyReplayGeneration: number | null;
  nativeUserMessageId?: string;
  nativeAssistantId?: string;
  planCompleted: boolean;
  terminal: boolean;
}

interface BackgroundTurn {
  readonly turnId: string;
  sequence: number;
}

type ClaudeExecutionSessionServices = Pick<
  ClaudeWorkspaceServices,
  'agentManager' | 'commandCatalog' | 'mcpManager' | 'pluginManager'
>;

export class ClaudeExecutionSession
implements
ProviderExecutionSession,
ModeConfigurableExecutionSession,
RewindableExecutionSession,
ClaudeExecutionStrategySink {
  readonly providerId = 'claude' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly encoder: ClaudeExecutionRequestEncoder;
  private readonly strategy: ClaudeExecutionStrategy;
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
  private backgroundTurn: BackgroundTurn | null = null;
  private backgroundCounter = 0;
  private sessionSequence = 0;
  private queryToken = 0;
  private latestCommandQueryToken = -1;
  private disposed = false;
  private readonly suppressedPersistentQueryTokens = new Set<number>();
  private readonly suppressedEphemeralQueryTokens = new Set<number>();
  private readonly pendingProviderStateDeletes = new Set<string>();
  private lastEncodedRequest: ClaudeEncodedExecutionRequest | null = null;
  private lastAllowedTools: ReadonlySet<string> | null = null;
  private currentPermissionMode: PermissionMode;
  private readonly eventNormalizer = new ClaudeExecutionEventNormalizer();

  constructor(
    private readonly host: ProviderHost,
    private readonly services: ClaudeExecutionSessionServices,
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
    this.providerState = state;
    this.replayHistoryOnNextTurn = state.historyReplayPending === true;
    this.replayHistoryGeneration = this.replayHistoryOnNextTurn ? 1 : 0;
    this.resumeAt = config.resumeSeed?.resumeCheckpoint
      ?? forkSource?.resumeAt;
    this.currentPermissionMode = normalizePermissionMode(
      host.settings.permissionMode,
    );
    this.encoder = new ClaudeExecutionRequestEncoder({
      host,
      mcpManager: services.mcpManager,
      pluginManager: services.pluginManager,
    });
    this.interactionHandler = new ClaudeInteractionHandler({
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
      getTurnId: () => this.getInteractionTurnId(),
      isToolAllowed: (toolName) => (
        this.lastAllowedTools === null
        || this.lastAllowedTools.has(toolName)
      ),
      getPermissionMode: () => this.currentPermissionMode,
      resolveSdkPermissionMode: (mode) =>
        this.encoder.resolveSdkPermissionMode(mode),
      onToolBlocked: (toolUseId) => {
        this.eventNormalizer.markToolBlocked(
          toolUseId,
          this.activeRun ? 'requested' : 'background',
        );
      },
    });
    this.strategy = config.lifecycle === 'persistent'
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
    const events = new AsyncEventStream<ProviderExecutionEvent>(() => {
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
      planCompleted: false,
      terminal: false,
    };
    this.activeRun = active;
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
    this.setStatus('executing');
    this.emitRequestedState(active);
    if (request.signal.aborted) {
      this.cancel();
    } else {
      void this.startExecution(active, request);
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
    if (!active || active.terminal) return;
    this.setStatus('cancelling');
    this.emitRequestedState(active);
    active.abortController.abort();
    this.interactionHandler.dismissAll('cancelled');
    if (active.nativeHandedOff) {
      if (this.config.lifecycle === 'persistent') {
        this.suppressedPersistentQueryTokens.add(active.queryToken);
      } else {
        this.suppressedEphemeralQueryTokens.add(active.queryToken);
      }
    }
    this.strategy.cancel(active.queryToken, active.nativeHandedOff);
    this.setStatus('idle');
    this.emitRequestedState(active);
    this.emitRequested(active, {
      type: 'cancelled',
      reason: 'Cancelled',
    });
    this.endActiveRun(active);
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
    if (this.activeRun) {
      this.cancel();
    }
    this.disposed = true;
    this.interactionHandler.dismissAll('session-disposed');
    await this.strategy.dispose();
    this.setStatus('disposed');
    this.emitSession({
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.sessionListeners.clear();
    this.backgroundTurn = null;
    this.suppressedPersistentQueryTokens.clear();
    this.suppressedEphemeralQueryTokens.clear();
  }

  async setMode(mode: string): Promise<boolean> {
    if (this.disposed) return false;
    const permissionMode = normalizeRequestedPermissionMode(mode);
    if (!permissionMode) return false;
    const sdkMode = this.encoder.resolveSdkPermissionMode(permissionMode);
    const applied = await this.strategy.setMode(sdkMode);
    if (!applied) return false;
    this.currentPermissionMode = permissionMode;
    this.bumpRevision();
    this.emitSession({
      type: 'mode_changed',
      mode,
      snapshot: this.getSnapshot(),
    });
    return true;
  }

  async previewRewind(
    userMessageId: string,
    _assistantMessageId: string | undefined,
    mode: ChatRewindMode = 'code-and-conversation',
  ): Promise<ChatRewindPreview> {
    if (!this.hasRewindSeed()) {
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
    const query = await this.getOrPrepareRewindQuery();
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
    if (!this.hasRewindSeed()) {
      return {
        canRewind: false,
        error: 'No Claude session is available to rewind.',
      };
    }
    const query = mode === 'conversation'
      ? this.strategy.getRewindQuery()
      : await this.getOrPrepareRewindQuery();
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

  getProviderSessionId(): string | null {
    return this.getNativeResumeSessionId();
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
    const normalizedEvents = this.eventNormalizer.normalize(
      message,
      active ? 'requested' : 'background',
      {
        intendedModel: this.lastEncodedRequest?.model,
        customContextLimits: this.host.settings.customContextLimits,
      },
    );
    if (
      active?.nativeHandedOff
      && isRequestedTurnEvidence(message)
    ) {
      this.ensureRequestedAccepted(active);
    }
    for (const normalized of normalizedEvents) {
      if (normalized.type === 'session_init') {
        const event = normalized.event;
        this.captureProviderSession(event.sessionId);
        if (event.agents) {
          this.services.agentManager.setBuiltinAgentNames(event.agents);
        }
        this.emitStateForCurrentTurn();
        if (event.permissionMode) {
          const nativeMode = normalizeSdkPermissionMode(event.permissionMode);
          if (nativeMode) {
            this.currentPermissionMode = nativeMode;
          }
          this.emitModeForCurrentTurn(event.permissionMode);
        }
        continue;
      }
      if (normalized.type === 'async_subagent_completion') {
        const event = normalized.event;
        this.emitSession({
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
        const target = this.getOutputTarget();
        if (target) {
          this.emitTurnOutput(target, normalized.event);
        }
        continue;
      }
      if (normalized.type === 'mode_entered') {
        this.currentPermissionMode = normalized.mode;
        this.bumpRevision();
        const target = this.getOutputTarget();
        if (target) {
          this.emitTurnOutput(target, {
            type: 'mode_changed',
            mode: normalized.mode,
            snapshot: this.getSnapshot(),
          });
        }
        continue;
      }
      if (normalized.type === 'plan_exited') {
        if (this.activeRun) {
          this.activeRun.planCompleted = true;
        }
        continue;
      }
      if (normalized.type === 'assistant_checkpoint') {
        if (this.activeRun) {
          this.activeRun.nativeAssistantId = normalized.nativeAssistantId;
        }
        continue;
      }
      if (normalized.type === 'native_error') {
        if (this.activeRun) {
          this.finishError(
            this.activeRun,
            new Error(normalized.message),
            normalized.code === 'provider_session_missing'
              ? normalized.providerSessionId
              : undefined,
          );
        } else {
          this.emitSession({
            type: 'session_error',
            category: normalized.code === 'provider_session_missing'
              ? 'provider-session-missing'
              : 'provider',
            message: normalized.message,
            recoverable: true,
          });
          this.finishBackgroundTurn('provider-ended');
        }
        return;
      }
      if (normalized.type === 'result') {
        if (this.activeRun) {
          this.finishCompleted(this.activeRun, 'completed');
        } else if (this.backgroundTurn) {
          this.finishBackgroundTurn('completed');
        }
      }
    }
  }

  handleNativeFailure(error: unknown, queryToken: number): void {
    if (this.disposed) return;
    if (this.suppressedEphemeralQueryTokens.delete(queryToken)) return;
    if (this.suppressedPersistentQueryTokens.delete(queryToken)) {
      const replacement = this.activeRun;
      if (replacement && replacement.queryToken !== queryToken) {
        this.finishError(replacement, error);
      }
      return;
    }
    const active = this.activeRun;
    if (active) {
      this.finishError(active, error);
      return;
    }
    const details = classifyClaudeError(error, this.providerSessionId);
    if (details.category !== 'provider-session-missing') {
      this.clearProviderSession();
    }
    this.setInvalidated({
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
    this.emitSession({
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.emitSession({
      type: 'session_error',
      ...details,
    });
  }

  handleNativeEnd(queryToken: number): void {
    if (this.disposed) return;
    if (this.suppressedEphemeralQueryTokens.delete(queryToken)) return;
    if (this.suppressedPersistentQueryTokens.delete(queryToken)) {
      const replacement = this.activeRun;
      if (replacement && replacement.queryToken !== queryToken) {
        this.finishError(
          replacement,
          new Error('Claude persistent query ended unexpectedly.'),
        );
      }
      return;
    }
    const active = this.activeRun;
    if (active) {
      if (active.accepted) {
        this.finishCompleted(active, 'provider-ended');
      } else {
        this.finishError(
          active,
          new Error('Claude ended before accepting the request.'),
        );
      }
    } else if (this.backgroundTurn) {
      this.finishBackgroundTurn('provider-ended');
    } else {
      this.clearProviderSession();
      this.setInvalidated({
        reason: 'transport-closed',
        recoverable: true,
        message: 'Claude query ended unexpectedly.',
      });
      this.emitSession({
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
      this.emitSession({
        type: 'session_error',
        category: 'transport',
        message: 'Claude query ended unexpectedly.',
        recoverable: true,
      });
    }
  }

  publishCommands(query: Query, queryToken: number): void {
    this.latestCommandQueryToken = queryToken;
    void query.supportedCommands()
      .then((commands) => {
        if (
          this.disposed
          || this.latestCommandQueryToken !== queryToken
        ) {
          return;
        }
        this.services.commandCatalog.setCommandSnapshot(
          commands.map(mapSdkCommand),
        );
      })
      .catch(() => undefined);
  }

  releaseNativeTurnFence(queryToken: number): void {
    this.suppressedEphemeralQueryTokens.delete(queryToken);
  }

  private async startExecution(
    active: ActiveRequestedRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    try {
      this.currentPermissionMode = normalizePermissionMode(
        request.configuration.mode
          ?? request.configuration.permissionMode
          ?? this.host.settings.permissionMode,
      );
      const nativeResume = this.getNativeResume();
      active.nativeFork = nativeResume.fork === true;
      const replayConversationHistory = this.shouldReplayConversationHistory(
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
      await this.strategy.startTurn(encoded, active.queryToken);
    } catch (error) {
      if (this.activeRun === active && !active.terminal) {
        if (active.abortController.signal.aborted) {
          this.cancel();
        } else {
          this.finishError(active, error);
        }
      }
    }
  }

  private getNativeResume(): ClaudeNativeResume {
    if (this.config.nativePersistence === 'disabled-if-supported') {
      return {};
    }
    const nativeResumeSessionId = this.getNativeResumeSessionId();
    return {
      ...(nativeResumeSessionId
        ? { sessionId: nativeResumeSessionId }
        : {}),
      ...(this.resumeAt ? { resumeAt: this.resumeAt } : {}),
      ...(this.pendingFork ? { fork: true } : {}),
    };
  }

  private getNativeResumeSessionId(): string | null {
    return this.providerSessionId
      ?? (this.pendingFork ? this.initialProviderSessionId : null);
  }

  private shouldReplayConversationHistory(
    request: ProviderExecutionRequest,
  ): boolean {
    if (!request.conversationHistory?.length) return false;
    if (this.config.nativePersistence === 'disabled-if-supported') {
      return true;
    }
    return !this.getNativeResumeSessionId()
      || this.replayHistoryOnNextTurn;
  }

  private captureProviderSession(sessionId: string): void {
    this.bumpRevision();
    if (this.config.nativePersistence === 'disabled-if-supported') {
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
        this.markHistoryReplayPending();
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
    this.setProviderStateValue('providerSessionId', sessionId);
    this.resumeAt = undefined;
    this.pendingFork = false;
    if (Object.prototype.hasOwnProperty.call(
      this.providerState,
      'forkSource',
    )) {
      this.deleteProviderStateValue('forkSource');
    }
  }

  private markHistoryReplayPending(): void {
    this.replayHistoryOnNextTurn = true;
    this.replayHistoryGeneration += 1;
    this.setProviderStateValue('historyReplayPending', true);
  }

  private clearHistoryReplayPending(expectedGeneration: number): void {
    if (
      !this.replayHistoryOnNextTurn
      || this.replayHistoryGeneration !== expectedGeneration
    ) {
      return;
    }
    this.replayHistoryOnNextTurn = false;
    this.deleteProviderStateValue('historyReplayPending');
    this.bumpRevision();
    this.emitStateForCurrentTurn();
  }

  private getOutputTarget(): ActiveRequestedRun | BackgroundTurn | null {
    if (this.activeRun) return this.activeRun;
    if (!this.backgroundTurn) {
      const background: BackgroundTurn = {
        turnId: `claude-background-${++this.backgroundCounter}`,
        sequence: 0,
      };
      this.backgroundTurn = background;
      this.setStatus('executing');
      this.emitBackground(background, {
        type: 'background_turn_started',
        providerSessionId: this.providerSessionId ?? undefined,
        snapshotRevision: this.revision,
      });
      this.emitBackground(background, {
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
    }
    return this.backgroundTurn;
  }

  private getInteractionTurnId(): string | null {
    if (this.activeRun) {
      if (!this.activeRun.nativeHandedOff) {
        return null;
      }
      this.ensureRequestedAccepted(this.activeRun);
      return this.activeRun.turnId;
    }
    return this.getOutputTarget()?.turnId ?? null;
  }

  private ensureRequestedAccepted(active: ActiveRequestedRun): void {
    if (active.accepted || active.terminal) return;
    active.accepted = true;
    this.emitRequested(active, {
      type: 'turn_started',
      accepted: true,
      nativeUserMessageId: active.nativeUserMessageId,
    });
    this.emitRequested(active, {
      type: 'user_message_started',
      nativeUserMessageId: active.nativeUserMessageId,
    });
    const historyReplayGeneration = active.historyReplayGeneration;
    active.historyReplayGeneration = null;
    if (historyReplayGeneration !== null) {
      this.clearHistoryReplayPending(historyReplayGeneration);
    }
  }

  private emitTurnOutput(
    target: ActiveRequestedRun | BackgroundTurn,
    event: WithoutScope<
      ProviderExecutionEvent | ProviderSessionEvent
    >,
  ): void {
    if ('executionId' in target) {
      this.emitRequested(
        target,
        event as WithoutScope<ProviderExecutionEvent>,
      );
    } else {
      this.emitBackground(
        target,
        event as WithoutScope<ProviderSessionEvent>,
      );
    }
  }

  private emitRequested(
    active: ActiveRequestedRun,
    event: WithoutScope<ProviderExecutionEvent>,
  ): void {
    if (active.terminal) return;
    active.events.push({
      ...event,
      scope: this.nextRequestedScope(active),
    });
  }

  private emitBackground(
    background: BackgroundTurn,
    event: WithoutScope<ProviderSessionEvent>,
  ): void {
    this.notifySessionListeners({
      ...event,
      scope: {
        kind: 'background',
        sessionInstanceId: this.sessionInstanceId,
        turnId: background.turnId,
        sequence: ++background.sequence,
      },
    } as ProviderSessionEvent);
  }

  private emitSession(
    event: WithoutScope<ProviderSessionEvent>,
  ): void {
    this.notifySessionListeners({
      ...event,
      scope: this.nextSessionScope(),
    } as ProviderSessionEvent);
  }

  private notifySessionListeners(event: ProviderSessionEvent): void {
    for (const listener of this.sessionListeners) {
      try {
        listener(event);
      } catch {
        // Listener failures cannot affect the native Claude lifecycle.
      }
    }
  }

  private emitRequestedState(active: ActiveRequestedRun): void {
    this.emitRequested(active, {
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
  }

  private emitStateForCurrentTurn(): void {
    if (this.activeRun) {
      this.emitRequestedState(this.activeRun);
    } else if (this.backgroundTurn) {
      this.emitBackground(this.backgroundTurn, {
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
    } else {
      this.emitSession({
        type: 'session_state_changed',
        snapshot: this.getSnapshot(),
      });
    }
  }

  private emitModeForCurrentTurn(mode: string): void {
    this.bumpRevision();
    const event = {
      type: 'mode_changed' as const,
      mode,
      snapshot: this.getSnapshot(),
    };
    if (this.activeRun) {
      this.emitRequested(this.activeRun, event);
    } else if (this.backgroundTurn) {
      this.emitBackground(this.backgroundTurn, event);
    } else {
      this.emitSession(event);
    }
  }

  private finishCompleted(
    active: ActiveRequestedRun,
    reason: 'completed' | 'provider-ended',
  ): void {
    if (active.terminal) return;
    this.setStatus('idle');
    this.emitRequestedState(active);
    this.emitRequested(active, {
      type: 'turn_completed',
      nativeAssistantId: active.nativeAssistantId,
      planCompleted: active.planCompleted || undefined,
      reason,
    });
    this.endActiveRun(active);
  }

  private finishError(
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
      this.setStatus('idle');
    } else {
      if (details.category !== 'provider-session-missing') {
        this.clearProviderSession();
      }
      this.setInvalidated({
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
    this.emitRequestedState(active);
    this.emitRequested(active, {
      type: 'execution_error',
      ...details,
    });
    this.endActiveRun(active);
  }

  private finishBackgroundTurn(
    reason: 'completed' | 'provider-ended',
  ): void {
    const background = this.backgroundTurn;
    if (!background) return;
    this.setStatus('idle');
    this.emitBackground(background, {
      type: 'session_state_changed',
      snapshot: this.getSnapshot(),
    });
    this.emitBackground(background, {
      type: 'background_turn_completed',
      providerSessionId: this.providerSessionId ?? undefined,
      snapshotRevision: this.revision,
      reason,
    });
    this.backgroundTurn = null;
    this.eventNormalizer.reset('background');
  }

  private endActiveRun(active: ActiveRequestedRun): void {
    if (active.terminal) return;
    active.terminal = true;
    active.requestSignal.removeEventListener(
      'abort',
      active.onRequestAbort,
    );
    active.events.end();
    if (this.activeRun === active) {
      this.activeRun = null;
    }
    this.eventNormalizer.reset('requested');
  }

  private setStatus(status: Exclude<ProviderSessionStatus, 'invalidated'>): void {
    this.status = status;
    this.snapshotInvalidation = null;
    this.bumpRevision();
  }

  private setInvalidated(
    invalidation: NonNullable<typeof this.snapshotInvalidation>,
  ): void {
    this.status = 'invalidated';
    this.snapshotInvalidation = invalidation;
    this.bumpRevision();
  }

  private setProviderStateValue(key: string, value: unknown): void {
    this.providerState[key] = value;
    this.pendingProviderStateDeletes.delete(key);
  }

  private deleteProviderStateValue(key: string): void {
    delete this.providerState[key];
    this.pendingProviderStateDeletes.add(key);
  }

  private clearProviderSession(): void {
    this.providerSessionId = null;
    this.deleteProviderStateValue('providerSessionId');
  }

  private bumpRevision(): void {
    this.revision += 1;
  }

  private nextRequestedScope(
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

  private nextSessionScope(): ProviderSessionEventScope {
    return {
      kind: 'session',
      sessionInstanceId: this.sessionInstanceId,
      sequence: ++this.sessionSequence,
    };
  }

  private hasRewindSeed(): boolean {
    return this.config.lifecycle === 'persistent'
      && Boolean(this.providerSessionId);
  }

  private async getOrPrepareRewindQuery(): Promise<Query | null> {
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
      this.getNativeResume(),
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

class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<T>) => void
  > = [];
  private done = false;

  constructor(private readonly onReturn: () => void) {}

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: () => {
        this.onReturn();
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
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
    normalized.includes('cli not found')
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

function normalizePermissionMode(value: unknown): PermissionMode {
  return normalizeRequestedPermissionMode(value) ?? 'normal';
}

function normalizeRequestedPermissionMode(
  value: unknown,
): PermissionMode | null {
  return value === 'normal' || value === 'plan' || value === 'yolo'
    ? value
    : null;
}

function normalizeSdkPermissionMode(
  value: unknown,
): PermissionMode | null {
  if (value === 'plan') return 'plan';
  if (value === 'bypassPermissions') return 'yolo';
  if (
    value === 'acceptEdits'
    || value === 'auto'
    || value === 'default'
    || value === 'delegate'
    || value === 'dontAsk'
  ) {
    return 'normal';
  }
  return null;
}

function mapSdkCommand(command: SDKSlashCommand): SlashCommand {
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
