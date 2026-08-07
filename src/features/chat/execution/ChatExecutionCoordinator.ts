import {
  computeConversationInputDigest,
  CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
  type ConversationInputRecord,
} from '@/core/bootstrap/ConversationInputLedgerStorage';
import type {
  ChatRewindMode,
  ChatRewindPreview,
  ChatRewindResult,
  ProviderExecutionBackend,
  ProviderExecutionConfiguration,
  ProviderExecutionEvent,
  ProviderExecutionInvalidationReason,
  ProviderExecutionLifecycleRegistry,
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderExecutionSession,
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
  ProviderNativeResumeSeed,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
  ProviderToolPolicy,
} from '@/core/execution';
import {
  isModeConfigurableExecutionSession,
  isRewindableExecutionSession,
  isSteerableExecutionSession,
} from '@/core/execution';
import type {
  ChatMessage,
  ForkSource,
  ImageAttachment,
  ProviderId,
} from '@/core/types';
import { toError } from '@/utils/error';

import {
  ExecutionSessionSupervisor,
} from './ExecutionSessionSupervisor';
import type { WarmExecutionPool } from './WarmExecutionPool';

export type ChatExecutionCoordinatorState =
  | 'absent'
  | 'idle'
  | 'active'
  | 'stale'
  | 'disposed';

export interface ChatExecutionConversationBinding {
  readonly conversationId: string;
  readonly providerId: ProviderId;
  readonly resumeSeed?: ProviderNativeResumeSeed;
}

export interface ChatTurnMessageBinding {
  readonly user: ChatMessage;
  readonly assistant: ChatMessage;
}

export interface ChatTurnSubmission {
  readonly inputRecordId: string;
  readonly localMessageId?: string;
  readonly userTurnOrdinal: number;
  readonly timestamp: number;
  readonly rawDisplayText: string;
  readonly canonicalText: string;
  readonly images: readonly ImageAttachment[];
  readonly context?: ProviderExecutionRequest['context'];
  readonly conversationHistory?: readonly ChatMessage[];
  readonly configuration: ProviderExecutionConfiguration;
  readonly toolPolicy: ProviderToolPolicy;
  readonly messages?: ChatTurnMessageBinding;
}

export interface ChatExecutionPersistence {
  registerExecutionBinding(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
  ): void;
  persistExecutionSnapshot(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
    snapshot: ProviderSessionSnapshot,
  ): Promise<boolean>;
  releaseExecutionBinding(conversationId: string, bindingId: string): void;
  stageConversationInput(
    conversationId: string,
    record: ConversationInputRecord,
  ): Promise<void>;
  acceptConversationInput(
    conversationId: string,
    recordId: string,
    nativeIds?: {
      providerUserMessageId?: string;
      providerAssistantMessageId?: string;
    },
  ): Promise<void>;
  discardStagedConversationInput(
    conversationId: string,
    recordId: string,
  ): Promise<void>;
  copyConversationInputsForFork(
    sourceConversationId: string,
    targetConversationId: string,
    throughAssistantCheckpointId?: string,
  ): Promise<void>;
  truncateConversationInputsFrom(
    conversationId: string,
    inputIdentity: string,
  ): Promise<void>;
}

export type MissingProviderSessionResolution =
  | 'deleted'
  | 'reset'
  | 'preserved'
  | 'not_found';

export interface ChatExecutionEventContext {
  readonly conversationId: string;
  readonly bindingId: string;
  readonly providerGeneration: number;
  readonly session: ProviderExecutionSession;
  readonly inputRecordId?: string;
}

export interface ChatExecutionCoordinatorDeps {
  readonly lifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly resolveBackend: (providerId: ProviderId) => ProviderExecutionBackend;
  readonly persistence: ChatExecutionPersistence;
  readonly interactionPort: ProviderInteractionPort;
  readonly vaultWorkingDirectory: string;
  readonly createId: () => string;
  readonly onRequestedEvent?: (
    event: ProviderExecutionEvent,
    context: ChatExecutionEventContext,
  ) => void | Promise<void>;
  readonly onSessionEvent?: (
    event: ProviderSessionEvent,
    context: ChatExecutionEventContext,
  ) => void | Promise<void>;
  readonly resolveMissingProviderSession: (
    conversationId: string,
    missingProviderSessionId?: string,
  ) => Promise<MissingProviderSessionResolution>;
  readonly onError?: (error: unknown) => void;
  readonly warmExecution?: {
    readonly ownerId: string;
    readonly pool: WarmExecutionPool;
    readonly canCool: () => boolean;
    readonly onWarmStateChanged?: (isWarm: boolean) => void;
  };
}

export interface ChatExecutionResult {
  readonly status:
    | 'completed'
    | 'cancelled'
    | 'error'
    | 'missing-session'
    | 'invalidated';
  readonly accepted: boolean;
  readonly planCompleted: boolean;
  readonly nativeUserMessageId?: string;
  readonly nativeAssistantMessageId?: string;
  readonly nativeCheckpointId?: string;
  readonly error?: Extract<ProviderExecutionEvent, { type: 'execution_error' }>;
  readonly missingSessionResolution?: MissingProviderSessionResolution;
}

interface SessionBinding {
  readonly conversation: ChatExecutionConversationBinding;
  readonly bindingId: string;
  readonly generation: number;
  readonly session: ProviderExecutionSession;
  lastSnapshotRevision: number;
  pendingWorkCount: number;
  sessionSequence: number;
  readonly backgroundSequences: Map<string, number>;
  readonly completedBackgroundTurns: Set<string>;
}

interface ActiveExecution {
  readonly binding: SessionBinding;
  readonly run: ProviderExecutionRun;
  readonly requestController: AbortController;
  readonly inputRecordId: string;
  readonly messages?: ChatTurnMessageBinding;
  terminationOverride: 'cancelled' | 'invalidated' | null;
}

interface PendingInteraction {
  readonly sessionInstanceId: string;
  readonly turnId: string;
}

interface PendingSteerAttempt {
  readonly conversationId: string;
  readonly inputRecordId: string;
  acceptedByProviderEvent: boolean;
  acceptancePromise: Promise<void> | null;
  nativeUserMessageAcceptancePromise: Promise<void> | null;
}

export class ChatExecutionInteractionStaleError extends Error {
  constructor(readonly interactionId: string) {
    super(`Provider interaction is stale: ${interactionId}`);
    this.name = 'ChatExecutionInteractionStaleError';
  }
}

export class ChatExecutionPreHandoffError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ChatExecutionPreHandoffError';
    this.cause = cause;
  }
}

export class ChatExecutionCoordinator {
  private readonly supervisor: ExecutionSessionSupervisor;
  private readonly fencedInteractionPort: ProviderInteractionPort;
  private conversation: ChatExecutionConversationBinding | null = null;
  private sessionBinding: SessionBinding | null = null;
  private activeExecution: ActiveExecution | null = null;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly pendingSteerAttempts = new Map<string, PendingSteerAttempt>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private stale = false;
  private protectedOperationCount = 0;
  private conversationBindingGeneration = 0;
  private preparationTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ChatExecutionCoordinatorDeps) {
    this.supervisor = new ExecutionSessionSupervisor(deps.lifecycleRegistry);
    this.fencedInteractionPort = this.createInteractionPort();
  }

  get state(): ChatExecutionCoordinatorState {
    if (this.disposed) return 'disposed';
    if (this.activeExecution) return 'active';
    if (this.stale) return 'stale';
    return this.sessionBinding ? 'idle' : 'absent';
  }

  get snapshot(): ProviderSessionSnapshot | null {
    return this.sessionBinding?.session.getSnapshot() ?? null;
  }

  isEventContextCurrent(context: ChatExecutionEventContext): boolean {
    const binding = this.sessionBinding;
    return Boolean(
      binding
      && binding.conversation.conversationId === context.conversationId
      && binding.bindingId === context.bindingId
      && binding.generation === context.providerGeneration
      && binding.session === context.session
      && this.isBindingCurrent(binding),
    );
  }

  async bindConversation(
    conversation: ChatExecutionConversationBinding | null,
  ): Promise<void> {
    await this.runProtectedOperation(() => this.bindConversationProtected(conversation));
  }

  private async bindConversationProtected(
    conversation: ChatExecutionConversationBinding | null,
  ): Promise<void> {
    this.assertAvailable();
    if (sameConversationBinding(this.conversation, conversation)) {
      this.conversation = conversation;
      return;
    }

    this.conversationBindingGeneration += 1;
    this.invalidateActiveExecution('invalidated', 'conversation-switched');
    this.pendingSteerAttempts.clear();
    this.conversation = conversation;
    this.stale = false;
    await this.releaseSessionBinding();
  }

  async prepare(): Promise<void> {
    await this.runProtectedOperation(() => this.enqueuePreparation());
  }

  private enqueuePreparation(): Promise<void> {
    const pending = this.preparationTail
      .catch(() => undefined)
      .then(() => this.prepareSession());
    this.preparationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async prepareSession(): Promise<void> {
    this.assertAvailable();
    const conversation = this.requireConversation();
    const bindingGeneration = this.conversationBindingGeneration;
    await this.acquireWarmSlot();
    if (!this.isPreparationCurrent(conversation, bindingGeneration)) {
      this.releaseWarmSlot();
      return;
    }
    if (this.sessionBinding && this.isBindingCurrent(this.sessionBinding)) return;
    try {
      const backend = this.deps.resolveBackend(conversation.providerId);
      if (backend.providerId !== conversation.providerId) {
        throw new Error(
          `Execution backend provider mismatch: expected ${conversation.providerId}, got ${backend.providerId}`,
        );
      }

      const supervised = this.supervisor.acquire(
        backend,
        {
          lifecycle: 'persistent',
          nativePersistence: 'enabled',
          resumeSeed: conversation.resumeSeed,
          vaultWorkingDirectory: this.deps.vaultWorkingDirectory,
          interactionPort: this.fencedInteractionPort,
        },
        (reason) => this.handleLeaseInvalidation(reason),
        (event) => this.handleSessionEvent(event),
      );
      const binding: SessionBinding = {
        conversation,
        bindingId: this.deps.createId(),
        generation: supervised.generation,
        session: supervised.session,
        lastSnapshotRevision: -1,
        pendingWorkCount: 0,
        sessionSequence: 0,
        backgroundSequences: new Map(),
        completedBackgroundTurns: new Set(),
      };
      this.sessionBinding = binding;
      this.stale = false;
      this.deps.persistence.registerExecutionBinding(
        conversation.conversationId,
        binding.bindingId,
        binding.generation,
      );
      try {
        await this.persistSnapshot(binding, binding.session.getSnapshot());
        if (
          this.isBindingCurrent(binding)
          && this.isPreparationCurrent(conversation, bindingGeneration)
        ) {
          this.deps.warmExecution?.onWarmStateChanged?.(true);
        }
      } catch (error) {
        await this.releaseSessionBinding();
        throw error;
      }
    } catch (error) {
      if (!this.sessionBinding) {
        this.releaseWarmSlot();
      }
      throw error;
    }
  }

  async execute(submission: ChatTurnSubmission): Promise<ChatExecutionResult> {
    return this.runProtectedOperation(() => this.executeProtected(submission));
  }

  private async executeProtected(
    submission: ChatTurnSubmission,
  ): Promise<ChatExecutionResult> {
    this.assertAvailable();
    if (this.activeExecution) {
      throw new Error('A chat execution is already active');
    }
    const conversation = this.requireConversation();
    const record = createInputRecord(submission);
    try {
      await this.deps.persistence.stageConversationInput(
        conversation.conversationId,
        record,
      );
    } catch (error) {
      throw new ChatExecutionPreHandoffError(error);
    }

    const requestController = new AbortController();
    let binding: SessionBinding;
    let run: ProviderExecutionRun;
    try {
      if (!sameConversationBinding(conversation, this.conversation)) {
        throw new Error('Chat execution binding changed before provider handoff');
      }
      await this.prepare();
      if (!sameConversationBinding(conversation, this.conversation)) {
        throw new Error('Chat execution binding changed before provider handoff');
      }
      binding = this.requireCurrentSessionBinding();
      run = binding.session.execute(
        createExecutionRequest(submission, requestController.signal),
      );
    } catch (error) {
      try {
        await this.discardPreSendRecord(conversation.conversationId, record.id);
      } catch (discardError) {
        throw new ChatExecutionPreHandoffError(discardError);
      }
      throw new ChatExecutionPreHandoffError(error);
    }

    const active: ActiveExecution = {
      binding,
      run,
      requestController,
      inputRecordId: record.id,
      messages: submission.messages,
      terminationOverride: null,
    };
    this.activeExecution = active;

    try {
      return await this.consumeRequestedEvents(active);
    } finally {
      this.dismissInteractionsForTurn(active.run.turnId, 'native-rejected');
      if (this.activeExecution === active) {
        this.activeExecution = null;
      }
    }
  }

  cancel(): void {
    const active = this.activeExecution;
    if (!active) return;
    active.terminationOverride = 'cancelled';
    active.requestController.abort();
    this.dismissInteractionsForTurn(active.run.turnId, 'cancelled');
    active.run.cancel();
  }

  async steer(submission: ChatTurnSubmission): Promise<boolean> {
    return this.runProtectedOperation(() => this.steerProtected(submission));
  }

  private async steerProtected(submission: ChatTurnSubmission): Promise<boolean> {
    this.assertAvailable();
    await this.touchWarmSlot();
    const binding = this.requireCurrentSessionBinding();
    if (!isSteerableExecutionSession(binding.session)) return false;
    const record = createInputRecord(submission);
    try {
      await this.deps.persistence.stageConversationInput(
        binding.conversation.conversationId,
        record,
      );
    } catch (error) {
      throw new ChatExecutionPreHandoffError(error);
    }
    const attempt: PendingSteerAttempt = {
      acceptedByProviderEvent: false,
      acceptancePromise: null,
      conversationId: binding.conversation.conversationId,
      inputRecordId: record.id,
      nativeUserMessageAcceptancePromise: null,
    };
    this.pendingSteerAttempts.set(record.id, attempt);
    const controller = new AbortController();
    let retainForReconciliation = false;
    try {
      let accepted: boolean;
      try {
        accepted = await binding.session.steer(
          createExecutionRequest(submission, controller.signal),
        );
      } catch (error) {
        if (!attempt.acceptedByProviderEvent) {
          retainForReconciliation = true;
          throw error;
        }
        await this.acceptPendingSteerAttempt(attempt);
        return true;
      }

      if (attempt.acceptedByProviderEvent) {
        await this.acceptPendingSteerAttempt(attempt);
        return true;
      }
      if (!accepted) {
        try {
          await this.deps.persistence.discardStagedConversationInput(
            binding.conversation.conversationId,
            record.id,
          );
        } catch (error) {
          throw new ChatExecutionPreHandoffError(error);
        }
        return false;
      }
      retainForReconciliation = true;
      await this.acceptPendingSteerAttempt(attempt);
      return true;
    } finally {
      if (
        !retainForReconciliation
        && this.pendingSteerAttempts.get(record.id) === attempt
      ) {
        this.pendingSteerAttempts.delete(record.id);
      }
    }
  }

  async acceptSteerFromProviderEvent(
    inputRecordId: string,
    nativeUserMessageId?: string,
  ): Promise<boolean> {
    const attempt = this.pendingSteerAttempts.get(inputRecordId);
    if (!attempt) return false;

    attempt.acceptedByProviderEvent = true;
    try {
      await this.acceptPendingSteerAttempt(attempt, nativeUserMessageId);
      return true;
    } finally {
      if (this.pendingSteerAttempts.get(inputRecordId) === attempt) {
        this.pendingSteerAttempts.delete(inputRecordId);
        this.notifyMayCool();
      }
    }
  }

  releaseSteerCorrelation(inputRecordId: string): void {
    this.pendingSteerAttempts.delete(inputRecordId);
    this.notifyMayCool();
  }

  async previewRewind(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindPreview> {
    return this.runProtectedOperation(() => this.previewRewindProtected(
      userMessageId,
      assistantMessageId,
      mode,
    ));
  }

  private async previewRewindProtected(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindPreview> {
    await this.prepare();
    const session = this.requireCurrentSessionBinding().session;
    if (!isRewindableExecutionSession(session)) {
      return { canRewind: false, error: 'Rewind is not supported by this provider.' };
    }
    return session.previewRewind(userMessageId, assistantMessageId, mode);
  }

  async setMode(mode: string): Promise<boolean> {
    return this.runProtectedOperation(() => this.setModeProtected(mode));
  }

  private async setModeProtected(mode: string): Promise<boolean> {
    await this.prepare();
    const binding = this.requireCurrentSessionBinding();
    if (!isModeConfigurableExecutionSession(binding.session)) return false;
    const applied = await binding.session.setMode(mode);
    if (!applied || !this.isBindingCurrent(binding)) return false;
    await this.persistSnapshot(binding, binding.session.getSnapshot());
    return true;
  }

  async rewind(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return this.runProtectedOperation(() => this.rewindProtected(
      userMessageId,
      assistantMessageId,
      mode,
    ));
  }

  private async rewindProtected(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    await this.prepare();
    const binding = this.requireCurrentSessionBinding();
    if (!isRewindableExecutionSession(binding.session)) {
      return { canRewind: false, error: 'Rewind is not supported by this provider.' };
    }
    const result = await binding.session.rewind(
      userMessageId,
      assistantMessageId,
      mode,
    );
    if (!result.canRewind) return result;
    await this.deps.persistence.truncateConversationInputsFrom(
      binding.conversation.conversationId,
      userMessageId,
    );
    if (!this.isBindingCurrent(binding)) return result;
    if (result.sessionStrategy === 'checkpoint-resume') {
      await this.releaseSessionBinding();
    } else {
      await this.persistSnapshot(binding, binding.session.getSnapshot());
    }
    return result;
  }

  async resolveForkSource(
    assistantCheckpointId: string,
    resolveFallbackSessionId: () => Promise<string | null>,
  ): Promise<ForkSource | null> {
    const currentSessionId = this.sessionBinding
      && this.isBindingCurrent(this.sessionBinding)
      ? this.sessionBinding.session.getSnapshot().providerSessionId
      : undefined;
    const sessionId = currentSessionId ?? await resolveFallbackSessionId();
    return sessionId
      ? { sessionId, resumeAt: assistantCheckpointId }
      : null;
  }

  async copyInputsForFork(
    sourceConversationId: string,
    targetConversationId: string,
    throughAssistantCheckpointId?: string,
  ): Promise<void> {
    const conversation = this.requireConversation();
    if (conversation.conversationId !== sourceConversationId) {
      throw new Error('Fork source conversation binding is stale');
    }
    await this.deps.persistence.copyConversationInputsForFork(
      sourceConversationId,
      targetConversationId,
      throughAssistantCheckpointId,
    );
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.conversationBindingGeneration += 1;
    this.invalidateActiveExecution('invalidated', 'session-disposed');
    this.pendingSteerAttempts.clear();
    this.disposePromise = this.preparationTail
      .catch(() => undefined)
      .then(() => this.releaseSessionBinding());
    return this.disposePromise;
  }

  canCool(): boolean {
    const binding = this.sessionBinding;
    return Boolean(
      binding
      && !this.disposed
      && this.protectedOperationCount === 0
      && this.activeExecution === null
      && this.pendingInteractions.size === 0
      && this.pendingSteerAttempts.size === 0
      && binding.backgroundSequences.size === 0
      && binding.pendingWorkCount === 0
      && (this.deps.warmExecution?.canCool() ?? true),
    );
  }

  notifyMayCool(): void {
    const warmExecution = this.deps.warmExecution;
    if (!warmExecution) return;
    this.fireAndReport(
      warmExecution.pool.notifyOwnerMayCool(warmExecution.ownerId),
    );
  }

  async cool(): Promise<void> {
    this.assertAvailable();
    if (!this.sessionBinding) {
      this.releaseWarmSlot();
      return;
    }
    if (!this.canCool()) {
      throw new Error('Chat execution is busy and cannot be cooled');
    }

    const binding = this.sessionBinding;
    await this.persistSnapshot(binding, binding.session.getSnapshot());
    if (this.sessionBinding !== binding || !this.canCool()) {
      throw new Error('Chat execution became busy while cooling');
    }
    await this.releaseSessionBinding();
  }

  private async consumeRequestedEvents(
    active: ActiveExecution,
  ): Promise<ChatExecutionResult> {
    let lastSequence = 0;
    let accepted = false;
    let planCompleted = false;
    let nativeUserMessageId: string | undefined;
    let nativeAssistantMessageId: string | undefined;
    let nativeCheckpointId: string | undefined;
    let terminalSinkFailure: { readonly error: unknown } | undefined;
    let terminal:
      | Extract<
          ProviderExecutionEvent,
          { type: 'turn_completed' | 'cancelled' | 'execution_error' }
        >
      | undefined;

    for await (const event of active.run.events) {
      if (!this.isActiveExecutionCurrent(active)) break;
      if (
        event.scope.sessionInstanceId !== active.binding.session.sessionInstanceId
        || event.scope.executionId !== active.run.executionId
        || event.scope.turnId !== active.run.turnId
        || event.scope.sequence <= lastSequence
      ) {
        continue;
      }
      lastSequence = event.scope.sequence;

      if (event.type === 'turn_started' && event.accepted) {
        accepted = true;
        nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
        attachUserMessageId(active.messages, nativeUserMessageId);
        await this.deps.persistence.acceptConversationInput(
          active.binding.conversation.conversationId,
          active.inputRecordId,
          { providerUserMessageId: nativeUserMessageId },
        );
      } else if (event.type === 'user_message_started' && accepted) {
        nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
        attachUserMessageId(active.messages, nativeUserMessageId);
        await this.deps.persistence.acceptConversationInput(
          active.binding.conversation.conversationId,
          active.inputRecordId,
          { providerUserMessageId: nativeUserMessageId },
        );
      } else if (event.type === 'assistant_message_started') {
        nativeAssistantMessageId =
          event.nativeAssistantId ?? nativeAssistantMessageId;
        attachAssistantMessageId(active.messages, nativeAssistantMessageId);
      } else if (event.type === 'session_state_changed' || event.type === 'mode_changed') {
        await this.persistSnapshot(active.binding, event.snapshot);
      } else if (event.type === 'turn_completed') {
        terminal = event;
        planCompleted = event.planCompleted === true;
        nativeAssistantMessageId =
          event.nativeAssistantId ?? nativeAssistantMessageId;
        nativeCheckpointId =
          event.nativeCheckpointId ?? nativeCheckpointId;
        attachAssistantMessageId(
          active.messages,
          nativeAssistantMessageId ?? nativeCheckpointId,
        );
        if (accepted) {
          await this.deps.persistence.acceptConversationInput(
            active.binding.conversation.conversationId,
            active.inputRecordId,
            {
              providerUserMessageId: nativeUserMessageId,
              providerAssistantMessageId:
                nativeAssistantMessageId ?? nativeCheckpointId,
            },
          );
        }
      } else if (event.type === 'cancelled' || event.type === 'execution_error') {
        terminal = event;
      }

      try {
        await this.deps.onRequestedEvent?.(
          event,
          this.createEventContext(active.binding, active.inputRecordId),
        );
      } catch (error) {
        if (!terminal) throw error;
        terminalSinkFailure = { error };
      }
      if (terminal) break;
    }

    if (isDefinitePreHandoffRejection(terminal, accepted)) {
      await this.discardPreSendRecord(
        active.binding.conversation.conversationId,
        active.inputRecordId,
      );
      throw new ChatExecutionPreHandoffError(
        terminalSinkFailure?.error ?? terminal,
      );
    }
    const unacceptedMissingSession = isUnacceptedMissingSession(terminal, accepted);
    const missingSessionTerminal = terminal?.type === 'execution_error'
      && terminal.category === 'provider-session-missing';
    if (unacceptedMissingSession) {
      try {
        await this.discardPreSendRecord(
          active.binding.conversation.conversationId,
          active.inputRecordId,
        );
      } catch (error) {
        throw new ChatExecutionPreHandoffError(error);
      }
    }
    if (terminalSinkFailure && !missingSessionTerminal) {
      throw terminalSinkFailure.error;
    }

    if (active.terminationOverride) {
      return createInterruptedResult(active.terminationOverride, accepted);
    }
    if (!this.isBindingCurrent(active.binding)) {
      return createInterruptedResult('invalidated', accepted);
    }
    if (!terminal) {
      return createInterruptedResult('cancelled', accepted);
    }
    if (terminal.type === 'turn_completed') {
      return {
        status: 'completed',
        accepted,
        planCompleted,
        nativeUserMessageId,
        nativeAssistantMessageId,
        nativeCheckpointId,
      };
    }
    if (terminal.type === 'cancelled') {
      return {
        status: 'cancelled',
        accepted,
        planCompleted: false,
        nativeUserMessageId,
        nativeAssistantMessageId,
      };
    }
    if (terminal.category === 'provider-session-missing') {
      let resolution: MissingProviderSessionResolution;
      try {
        resolution = await this.deps.resolveMissingProviderSession(
          active.binding.conversation.conversationId,
          terminal.missingProviderSessionId,
        );
      } catch (error) {
        if (unacceptedMissingSession) {
          throw new ChatExecutionPreHandoffError(error);
        }
        throw error;
      }
      if (
        this.conversation?.conversationId
          !== active.binding.conversation.conversationId
      ) {
        if (terminalSinkFailure) throw terminalSinkFailure.error;
        return createInterruptedResult('invalidated', accepted);
      }
      try {
        if (this.sessionBinding === active.binding) {
          await this.releaseSessionBinding();
        }
        if (resolution === 'deleted' || resolution === 'not_found') {
          this.conversation = null;
        } else if (resolution === 'reset' && this.conversation) {
          this.conversation = {
            ...this.conversation,
            resumeSeed: undefined,
          };
        }
        this.stale = resolution !== 'deleted' && resolution !== 'not_found';
      } catch (error) {
        if (unacceptedMissingSession) {
          throw new ChatExecutionPreHandoffError(error);
        }
        throw error;
      }
      if (terminalSinkFailure) {
        if (unacceptedMissingSession) {
          throw new ChatExecutionPreHandoffError(terminalSinkFailure.error);
        }
        throw terminalSinkFailure.error;
      }
      return {
        status: 'missing-session',
        accepted,
        planCompleted: false,
        nativeUserMessageId,
        nativeAssistantMessageId,
        error: terminal,
        missingSessionResolution: resolution,
      };
    }
    return {
      status: 'error',
      accepted,
      planCompleted: false,
      nativeUserMessageId,
      nativeAssistantMessageId,
      error: terminal,
    };
  }

  private handleSessionEvent(event: ProviderSessionEvent): void {
    const binding = this.sessionBinding;
    if (!binding || !this.isBindingCurrent(binding)) return;
    if (event.scope.sessionInstanceId !== binding.session.sessionInstanceId) return;

    if (event.scope.kind === 'background') {
      const previous = binding.backgroundSequences.get(event.scope.turnId);
      if (event.type === 'background_turn_started') {
        if (
          previous !== undefined
          || binding.completedBackgroundTurns.has(event.scope.turnId)
          || event.scope.sequence <= 0
        ) {
          return;
        }
        binding.backgroundSequences.set(event.scope.turnId, event.scope.sequence);
        this.fireAndReport(this.touchWarmSlot());
      } else {
        if (previous === undefined || event.scope.sequence <= previous) return;
        binding.backgroundSequences.set(event.scope.turnId, event.scope.sequence);
      }
    } else {
      if (event.scope.sequence <= binding.sessionSequence) return;
      binding.sessionSequence = event.scope.sequence;
    }

    const eventWork: Promise<unknown>[] = [];
    if (event.type === 'session_state_changed' || event.type === 'mode_changed') {
      eventWork.push(this.persistSnapshot(binding, event.snapshot));
    }
    try {
      eventWork.push(Promise.resolve(
        this.deps.onSessionEvent?.(event, this.createEventContext(binding)),
      ));
    } catch (error) {
      eventWork.push(Promise.reject(toError(error, 'Session event handler failed')));
    }
    this.trackBindingWork(binding, Promise.all(eventWork));
    if (event.type === 'background_turn_completed') {
      binding.backgroundSequences.delete(event.scope.turnId);
      binding.completedBackgroundTurns.add(event.scope.turnId);
      this.notifyMayCool();
    }
  }

  private async persistSnapshot(
    binding: SessionBinding,
    snapshot: ProviderSessionSnapshot,
  ): Promise<void> {
    if (
      !this.isBindingCurrent(binding)
      || snapshot.providerId !== binding.conversation.providerId
      || snapshot.revision <= binding.lastSnapshotRevision
    ) {
      return;
    }
    await this.deps.persistence.persistExecutionSnapshot(
      binding.conversation.conversationId,
      binding.bindingId,
      binding.generation,
      snapshot,
    );
    binding.lastSnapshotRevision = Math.max(
      binding.lastSnapshotRevision,
      snapshot.revision,
    );
  }

  private trackBindingWork(
    binding: SessionBinding,
    work: Promise<unknown>,
  ): void {
    binding.pendingWorkCount += 1;
    void work
      .catch((error) => this.deps.onError?.(error))
      .finally(() => {
        binding.pendingWorkCount = Math.max(0, binding.pendingWorkCount - 1);
        if (this.sessionBinding === binding && binding.pendingWorkCount === 0) {
          this.notifyMayCool();
        }
      });
  }

  private handleLeaseInvalidation(
    _reason: ProviderExecutionInvalidationReason,
  ): void {
    const binding = this.sessionBinding;
    if (!binding) return;
    this.sessionBinding = null;
    this.stale = true;
    this.pendingSteerAttempts.clear();
    this.invalidateActiveExecution('invalidated', 'provider-transition');
    this.deps.persistence.releaseExecutionBinding(
      binding.conversation.conversationId,
      binding.bindingId,
    );
    this.releaseWarmSlot();
  }

  private async releaseSessionBinding(): Promise<void> {
    const binding = this.sessionBinding;
    this.sessionBinding = null;
    if (binding) {
      this.deps.persistence.releaseExecutionBinding(
        binding.conversation.conversationId,
        binding.bindingId,
      );
    }
    try {
      await this.supervisor.release();
    } finally {
      this.releaseWarmSlot();
    }
  }

  private async acquireWarmSlot(): Promise<void> {
    const warmExecution = this.deps.warmExecution;
    if (!warmExecution) return;

    try {
      await warmExecution.pool.acquire({
        id: warmExecution.ownerId,
        canCool: () => this.canCool(),
        cool: () => this.cool(),
      });
    } catch (error) {
      if (!this.sessionBinding) {
        warmExecution.pool.release(warmExecution.ownerId);
      }
      throw error;
    }
  }

  private releaseWarmSlot(): void {
    const warmExecution = this.deps.warmExecution;
    if (!warmExecution) return;
    const wasWarm = warmExecution.pool.has(warmExecution.ownerId);
    warmExecution.pool.release(warmExecution.ownerId);
    if (wasWarm) {
      warmExecution.onWarmStateChanged?.(false);
    }
  }

  private async touchWarmSlot(): Promise<void> {
    const warmExecution = this.deps.warmExecution;
    if (!warmExecution) return;
    await warmExecution.pool.touch(warmExecution.ownerId);
  }

  private async runProtectedOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.protectedOperationCount += 1;
    try {
      return await operation();
    } finally {
      this.protectedOperationCount -= 1;
      if (this.protectedOperationCount === 0) {
        this.notifyMayCool();
      }
    }
  }

  private invalidateActiveExecution(
    status: 'cancelled' | 'invalidated',
    dismissReason: ProviderInteractionDismissReason,
  ): void {
    const active = this.activeExecution;
    if (active) {
      active.terminationOverride = status;
      active.requestController.abort();
      active.run.cancel();
    }
    this.dismissAllInteractions(dismissReason);
  }

  private isActiveExecutionCurrent(active: ActiveExecution): boolean {
    return (
      this.activeExecution === active
      && this.isBindingCurrent(active.binding)
    );
  }

  private isBindingCurrent(binding: SessionBinding): boolean {
    return (
      !this.disposed
      && this.sessionBinding === binding
      && sameConversationBinding(binding.conversation, this.conversation)
      && this.supervisor.isCurrent(binding.session, binding.generation)
    );
  }

  private isPreparationCurrent(
    conversation: ChatExecutionConversationBinding,
    bindingGeneration: number,
  ): boolean {
    return (
      !this.disposed
      && bindingGeneration === this.conversationBindingGeneration
      && sameConversationBinding(conversation, this.conversation)
    );
  }

  private acceptPendingSteerAttempt(
    attempt: PendingSteerAttempt,
    nativeUserMessageId?: string,
  ): Promise<void> {
    if (!attempt.acceptancePromise) {
      if (nativeUserMessageId) {
        attempt.nativeUserMessageAcceptancePromise =
          this.deps.persistence.acceptConversationInput(
            attempt.conversationId,
            attempt.inputRecordId,
            { providerUserMessageId: nativeUserMessageId },
          );
        attempt.acceptancePromise = attempt.nativeUserMessageAcceptancePromise;
      } else {
        attempt.acceptancePromise = this.deps.persistence.acceptConversationInput(
          attempt.conversationId,
          attempt.inputRecordId,
        );
      }
    }
    if (!nativeUserMessageId) return attempt.acceptancePromise;
    if (attempt.nativeUserMessageAcceptancePromise) {
      return attempt.nativeUserMessageAcceptancePromise;
    }

    const persistNativeUserMessageId = (): Promise<void> => (
      this.deps.persistence.acceptConversationInput(
        attempt.conversationId,
        attempt.inputRecordId,
        { providerUserMessageId: nativeUserMessageId },
      )
    );
    attempt.nativeUserMessageAcceptancePromise = attempt.acceptancePromise.then(
      persistNativeUserMessageId,
      persistNativeUserMessageId,
    );
    return attempt.nativeUserMessageAcceptancePromise;
  }

  private requireCurrentSessionBinding(): SessionBinding {
    const binding = this.sessionBinding;
    if (!binding || !this.isBindingCurrent(binding)) {
      throw new Error('No current chat execution session');
    }
    return binding;
  }

  private requireConversation(): ChatExecutionConversationBinding {
    if (!this.conversation) {
      throw new Error('No conversation is bound for chat execution');
    }
    return this.conversation;
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new Error('Chat execution coordinator is disposed');
    }
  }

  private createEventContext(
    binding: SessionBinding,
    inputRecordId?: string,
  ): ChatExecutionEventContext {
    return {
      conversationId: binding.conversation.conversationId,
      bindingId: binding.bindingId,
      providerGeneration: binding.generation,
      session: binding.session,
      inputRecordId,
    };
  }

  private createInteractionPort(): ProviderInteractionPort {
    return {
      requestApproval: (request, signal) => this.forwardInteraction(
        request,
        signal,
        () => this.deps.interactionPort.requestApproval(request, signal),
      ),
      askUserQuestion: (request, signal) => this.forwardInteraction(
        request,
        signal,
        () => this.deps.interactionPort.askUserQuestion(request, signal),
      ),
      requestPlanDecision: (request, signal) => this.forwardInteraction(
        request,
        signal,
        () => this.deps.interactionPort.requestPlanDecision(request, signal),
      ),
      dismissInteraction: (interactionId, reason) => {
        this.pendingInteractions.delete(interactionId);
        this.deps.interactionPort.dismissInteraction(interactionId, reason);
        this.notifyMayCool();
      },
    };
  }

  private async forwardInteraction<
    TRequest extends {
      interactionId: string;
      sessionInstanceId: string;
      turnId: string;
    },
    TResponse extends { interactionId: string },
  >(
    request: TRequest,
    signal: AbortSignal,
    forward: () => Promise<TResponse>,
  ): Promise<TResponse> {
    if (!this.isInteractionCurrent(request) || signal.aborted) {
      throw new ChatExecutionInteractionStaleError(request.interactionId);
    }
    if (this.pendingInteractions.has(request.interactionId)) {
      throw new Error(`Duplicate provider interaction: ${request.interactionId}`);
    }
    this.pendingInteractions.set(request.interactionId, {
      sessionInstanceId: request.sessionInstanceId,
      turnId: request.turnId,
    });
    const pending = this.pendingInteractions.get(request.interactionId);
    try {
      const response = await forward();
      if (
        response.interactionId !== request.interactionId
        || signal.aborted
        || this.pendingInteractions.get(request.interactionId) !== pending
        || !this.isInteractionCurrent(request)
      ) {
        throw new ChatExecutionInteractionStaleError(request.interactionId);
      }
      return response;
    } finally {
      this.pendingInteractions.delete(request.interactionId);
      this.notifyMayCool();
    }
  }

  private isInteractionCurrent(request: {
    sessionInstanceId: string;
    turnId: string;
  }): boolean {
    const binding = this.sessionBinding;
    if (
      !binding
      || !this.isBindingCurrent(binding)
      || request.sessionInstanceId !== binding.session.sessionInstanceId
    ) {
      return false;
    }
    if (this.activeExecution?.run.turnId === request.turnId) return true;
    return binding.backgroundSequences.has(request.turnId);
  }

  private dismissInteractionsForTurn(
    turnId: string,
    reason: ProviderInteractionDismissReason,
  ): void {
    for (const [interactionId, pending] of this.pendingInteractions) {
      if (pending.turnId !== turnId) continue;
      this.pendingInteractions.delete(interactionId);
      this.deps.interactionPort.dismissInteraction(interactionId, reason);
    }
    this.notifyMayCool();
  }

  private dismissAllInteractions(reason: ProviderInteractionDismissReason): void {
    for (const interactionId of this.pendingInteractions.keys()) {
      this.deps.interactionPort.dismissInteraction(interactionId, reason);
    }
    this.pendingInteractions.clear();
    this.notifyMayCool();
  }

  private async discardPreSendRecord(
    conversationId: string,
    recordId: string,
  ): Promise<void> {
    await this.deps.persistence.discardStagedConversationInput(
      conversationId,
      recordId,
    );
  }

  private fireAndReport(promise: Promise<unknown>): void {
    void promise.catch((error) => this.deps.onError?.(error));
  }
}

function createExecutionRequest(
  submission: ChatTurnSubmission,
  signal: AbortSignal,
): ProviderExecutionRequest {
  return {
    input: [
      ...(submission.canonicalText
        ? [{ type: 'text' as const, text: submission.canonicalText }]
        : []),
      ...submission.images.map((image) => ({
        type: 'image' as const,
        image,
      })),
    ],
    context: submission.context,
    conversationHistory: submission.conversationHistory,
    configuration: submission.configuration,
    toolPolicy: submission.toolPolicy,
    signal,
  };
}

function createInputRecord(
  submission: ChatTurnSubmission,
): ConversationInputRecord {
  const { externalContextPaths: _, ...context } = submission.context ?? {};
  const ledgerContext = Object.keys(context).length > 0 ? context : undefined;
  return {
    schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
    id: submission.inputRecordId,
    userTurnOrdinal: submission.userTurnOrdinal,
    state: 'staged',
    localMessageId: submission.localMessageId,
    timestamp: submission.timestamp,
    rawDisplayText: submission.rawDisplayText,
    canonicalText: submission.canonicalText,
    context: ledgerContext,
    images: [...submission.images],
    contentDigest: computeConversationInputDigest({
      visibleText: submission.rawDisplayText,
      images: submission.images,
    }),
  };
}

function sameConversationBinding(
  left: ChatExecutionConversationBinding | null,
  right: ChatExecutionConversationBinding | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.conversationId === right.conversationId
    && left.providerId === right.providerId
    && JSON.stringify(left.resumeSeed) === JSON.stringify(right.resumeSeed)
  );
}

function createInterruptedResult(
  status: 'cancelled' | 'invalidated',
  accepted: boolean,
): ChatExecutionResult {
  return {
    status,
    accepted,
    planCompleted: false,
  };
}

function isDefinitePreHandoffRejection(
  terminal: Extract<
    ProviderExecutionEvent,
    { type: 'turn_completed' | 'cancelled' | 'execution_error' }
  > | undefined,
  accepted: boolean,
): boolean {
  return (
    !accepted
    && terminal?.type === 'execution_error'
    && terminal.category === 'configuration'
  );
}

function isUnacceptedMissingSession(
  terminal: Extract<
    ProviderExecutionEvent,
    { type: 'turn_completed' | 'cancelled' | 'execution_error' }
  > | undefined,
  accepted: boolean,
): boolean {
  return (
    !accepted
    && terminal?.type === 'execution_error'
    && terminal.category === 'provider-session-missing'
  );
}

function attachUserMessageId(
  messages: ChatTurnMessageBinding | undefined,
  nativeId: string | undefined,
): void {
  if (messages && nativeId) messages.user.userMessageId = nativeId;
}

function attachAssistantMessageId(
  messages: ChatTurnMessageBinding | undefined,
  nativeId: string | undefined,
): void {
  if (messages && nativeId) messages.assistant.assistantMessageId = nativeId;
}
