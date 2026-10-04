import type {
  ChatRewindMode,
  ChatRewindPreview,
  ChatRewindResult,
  ConversationBranchRecoveryRequest,
  ConversationBranchRequest,
  ConversationBranchResult,
  ConversationBranchState,
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
  isBranchableExecutionSession,
  isRewindableExecutionSession,
  isSteerableExecutionSession,
} from '@/core/execution';
import type {
  ChatMessage,
  ForkSource,
  ImageAttachment,
  ProviderId,
} from '@/core/types';
import { throwIfAborted } from '@/utils/abort';
import { toError } from '@/utils/error';

import { consumeExecutionEvents, isExecutionTerminalEvent } from './consumeExecutionEvents';
import { ExecutionInteractions } from './ExecutionInteractions';
import {
  ExecutionSessionSupervisor,
} from './ExecutionSessionSupervisor';
import { SessionEventStream } from './SessionEventStream';

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
  /** Revalidate transient interaction ownership after asynchronous preparation. */
  assertBeforeHandoff?: () => void;
  readonly submissionId: string;
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
  assertConversationExecutionAuthority(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
  ): Promise<void>;
  recordConversationActivity(conversationId: string, timestamp: number): Promise<void>;
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
  readonly submissionId?: string;
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
  readonly onBackgroundWorkChanged?: (isWorking: boolean) => void;
  readonly resolveMissingProviderSession: (
    conversationId: string,
    missingProviderSessionId?: string,
  ) => Promise<MissingProviderSessionResolution>;
  readonly onError?: (error: unknown) => void;
  /** Releases an idle provider session after this long; omitted keeps it until disposal. */
  readonly idleReleaseMs?: number;
  /** Owner work invisible to the coordinator; an idle session is released only while this holds. */
  readonly isOwnerIdle?: () => boolean;
  readonly onIdleRelease?: () => void;
}

export interface ChatExecutionResult {
  readonly status:
    | 'completed'
    | 'cancelled'
    | 'error'
    | 'missing-session'
    | 'invalidated';
  readonly accepted: boolean;
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
  readonly events: SessionEventStream;
  model?: string;
}

interface ActiveExecution {
  readonly binding: SessionBinding;
  readonly run: ProviderExecutionRun;
  readonly submission: ChatTurnSubmission;
  readonly requestController: AbortController;
  terminationOverride: 'cancelled' | 'invalidated' | null;
}

interface PendingSteerAttempt {
  readonly conversationId: string;
  acceptedByProviderEvent: boolean;
  acceptancePromise: Promise<void> | null;
  readonly submission: ChatTurnSubmission;
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
  readonly #supervisor: ExecutionSessionSupervisor;
  readonly #interactions: ExecutionInteractions;
  #conversation: ChatExecutionConversationBinding | null = null;
  #sessionBinding: SessionBinding | null = null;
  #activeExecution: ActiveExecution | null = null;
  #requestController: AbortController | null = null;
  #branchRecoveryRequired = false;
  readonly #pendingSteerAttempts = new Map<string, PendingSteerAttempt>();
  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #stale = false;
  #publishedBackgroundWork = false;
  #protectedOperationCount = 0;
  #preparationTail: Promise<void> = Promise.resolve();
  #idleTimer: number | null = null;
  #idleTimerGeneration = 0;

  constructor(private readonly deps: ChatExecutionCoordinatorDeps) {
    this.#supervisor = new ExecutionSessionSupervisor(deps.lifecycleRegistry);
    this.#interactions = new ExecutionInteractions({
      port: deps.interactionPort,
      isCurrent: request => this.#isInteractionCurrent(request),
      staleError: id => new ChatExecutionInteractionStaleError(id),
      onPendingChange: () => this.#restartIdleTimer(),
    });
  }

  get state(): ChatExecutionCoordinatorState {
    if (this.#disposed) return 'disposed';
    if (this.#activeExecution) return 'active';
    if (this.#stale) return 'stale';
    return this.#sessionBinding ? 'idle' : 'absent';
  }

  get snapshot(): ProviderSessionSnapshot | null {
    return this.#sessionBinding?.session.getSnapshot() ?? null;
  }

  getCommandSnapshot(conversationId: string | null, providerId: ProviderId) {
    const binding = this.#sessionBinding;
    if (
      !binding || this.#stale || !this.#isBindingCurrent(binding)
      || binding.conversation.conversationId !== conversationId
      || binding.session.providerId !== providerId
    ) return undefined;
    return binding.session.getCommandSnapshot?.();
  }

  get hasBackgroundWork(): boolean {
    return (this.#sessionBinding?.events.hasBackgroundWork ?? false)
      || (this.#sessionBinding?.session.hasBackgroundWork?.() ?? false);
  }

  /** Work observers recompute from current state, so only transitions are published. */
  #publishBackgroundWork(): void {
    const isWorking = this.hasBackgroundWork;
    if (isWorking === this.#publishedBackgroundWork) return;
    this.#publishedBackgroundWork = isWorking;
    this.deps.onBackgroundWorkChanged?.(isWorking);
  }

  isEventContextCurrent(context: ChatExecutionEventContext): boolean {
    const binding = this.#sessionBinding;
    return Boolean(
      binding
      && binding.conversation.conversationId === context.conversationId
      && binding.bindingId === context.bindingId
      && binding.generation === context.providerGeneration
      && binding.session === context.session
      && this.#isBindingCurrent(binding),
    );
  }

  async bindConversation(
    conversation: ChatExecutionConversationBinding | null,
  ): Promise<void> {
    await this.#runProtectedOperation(() => this.#bindConversationProtected(conversation));
  }

  async #bindConversationProtected(
    conversation: ChatExecutionConversationBinding | null,
  ): Promise<void> {
    this.#assertAvailable();
    if (sameConversationBinding(this.#conversation, conversation)) {
      // Keep the canonical binding so event guards can compare it by identity.
      return;
    }

    this.#invalidateActiveExecution('invalidated', 'conversation-switched');
    this.#pendingSteerAttempts.clear();
    this.#conversation = conversation;
    this.#branchRecoveryRequired = false;
    this.#stale = false;
    await this.#releaseSessionBinding();
  }

  async prepare(): Promise<void> {
    await this.#runProtectedOperation(() => this.#enqueuePreparation());
  }

  #enqueuePreparation(operation: () => Promise<void> = () => this.#prepareSession()): Promise<void> {
    const pending = this.#preparationTail
      .catch(() => undefined)
      .then(operation);
    this.#preparationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #prepareSession(): Promise<void> {
    this.#assertAvailable();
    const conversation = this.#requireConversation();
    if (this.#sessionBinding && this.#isBindingCurrent(this.#sessionBinding)) return;
    const backend = this.deps.resolveBackend(conversation.providerId);
    if (backend.providerId !== conversation.providerId) {
      throw new Error(
        `Execution backend provider mismatch: expected ${conversation.providerId}, got ${backend.providerId}`,
      );
    }

    const supervised = this.#supervisor.acquire(
      backend,
      {
        lifecycle: 'persistent',
        nativePersistence: 'enabled',
        resumeSeed: conversation.resumeSeed,
        vaultWorkingDirectory: this.deps.vaultWorkingDirectory,
        interactionPort: this.#interactions,
      },
      (reason) => this.#handleLeaseInvalidation(reason),
      (event) => this.#handleSessionEvent(event),
    );
    const binding: SessionBinding = {
      conversation,
      bindingId: this.deps.createId(),
      generation: supervised.generation,
      session: supervised.session,
      lastSnapshotRevision: -1,
      pendingWorkCount: 0,
      events: new SessionEventStream(supervised.session.sessionInstanceId),
    };
    this.#sessionBinding = binding;
    this.#stale = false;
    try {
      this.deps.persistence.registerExecutionBinding(
        conversation.conversationId,
        binding.bindingId,
        binding.generation,
      );
      await this.#persistSnapshot(binding, binding.session.getSnapshot());
    } catch (error) {
      await this.#releaseSessionBinding();
      throw error;
    }
  }

  async execute(submission: ChatTurnSubmission, signal?: AbortSignal): Promise<ChatExecutionResult> {
    this.#assertAvailable();
    if (this.#branchRecoveryRequired) throw new ChatExecutionPreHandoffError('Conversation branch recovery must finish before sending.');
    if (this.#requestController) throw new Error('A chat execution is already active');
    const controller = new AbortController();
    this.#requestController = controller;
    const cancel = () => this.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      return await this.#runProtectedOperation(() => this.#executeProtected(submission, controller));
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.#requestController = null;
    }
  }

  async #executeProtected(
    submission: ChatTurnSubmission,
    requestController: AbortController,
  ): Promise<ChatExecutionResult> {
    const conversation = this.#requireConversation();
    let binding: SessionBinding;
    let run: ProviderExecutionRun;
    try {
      throwIfAborted(requestController.signal, 'Turn cancelled before provider handoff');
      await this.prepare();
      throwIfAborted(requestController.signal, 'Turn cancelled before provider handoff');
      if (!sameConversationBinding(conversation, this.#conversation)) {
        throw new Error('Chat execution binding changed before provider handoff');
      }
      binding = this.#requireCurrentSessionBinding();
      await this.deps.persistence.assertConversationExecutionAuthority(
        conversation.conversationId,
        binding.bindingId,
        binding.generation,
      );
      if (!sameConversationBinding(conversation, this.#conversation)) {
        throw new Error('Chat execution binding changed before provider handoff');
      }
      throwIfAborted(requestController.signal, 'Turn cancelled before provider handoff');
      binding = this.#requireCurrentSessionBinding();
      submission.assertBeforeHandoff?.();
      binding.model = submission.configuration.model;
      run = binding.session.execute(
        createExecutionRequest(submission, requestController.signal),
      );
    } catch (error) {
      throw new ChatExecutionPreHandoffError(error);
    }

    const active: ActiveExecution = {
      binding,
      run,
      requestController,
      submission,
      terminationOverride: null,
    };
    this.#activeExecution = active;

    try {
      return await this.#consumeRequestedEvents(active);
    } finally {
      this.#interactions.dismissTurn(active.run.turnId, 'native-rejected');
      if (this.#activeExecution === active) {
        this.#activeExecution = null;
      }
    }
  }

  cancel(): void {
    if (this.#requestController?.signal.aborted) return;
    this.#requestController?.abort();
    const active = this.#activeExecution;
    if (!active) {
      if (this.hasBackgroundWork) this.#sessionBinding?.session.cancel();
      return;
    }
    active.terminationOverride = 'cancelled';
    active.requestController.abort();
    this.#interactions.dismissTurn(active.run.turnId, 'cancelled');
    active.run.cancel();
  }

  async steer(submission: ChatTurnSubmission, signal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const sources = [signal, this.#requestController?.signal];
    const cancel = () => controller.abort();
    for (const source of sources) {
      source?.addEventListener('abort', cancel, { once: true });
      if (source?.aborted) cancel();
    }
    try {
      return await this.#runProtectedOperation(() => this.#steerProtected(submission, controller.signal));
    } finally {
      for (const source of sources) source?.removeEventListener('abort', cancel);
    }
  }

  async #steerProtected(submission: ChatTurnSubmission, signal: AbortSignal): Promise<boolean> {
    if (this.#branchRecoveryRequired || signal.aborted) return false;
    this.#assertAvailable();
    const binding = this.#requireCurrentSessionBinding();
    const active = this.#activeExecution;
    if (!isSteerableExecutionSession(binding.session)) return false;
    try {
      await this.deps.persistence.assertConversationExecutionAuthority(
        binding.conversation.conversationId, binding.bindingId, binding.generation,
      );
      if (signal.aborted || this.#activeExecution !== active) return false;
      if (!this.#isBindingCurrent(binding)) throw new Error('Conversation binding changed before steering');
    } catch (error) {
      throw new ChatExecutionPreHandoffError(error);
    }
    const attempt: PendingSteerAttempt = {
      acceptedByProviderEvent: false,
      acceptancePromise: null,
      conversationId: binding.conversation.conversationId,
      submission,
    };
    this.#pendingSteerAttempts.set(submission.submissionId, attempt);
    let retainForReconciliation = false;
    try {
      let accepted: boolean;
      try {
        accepted = await binding.session.steer(
          createExecutionRequest(submission, signal),
        );
      } catch (error) {
        if (!attempt.acceptedByProviderEvent) {
          retainForReconciliation = true;
          throw error;
        }
        await this.#acceptPendingSteerAttempt(attempt);
        return true;
      }

      if (attempt.acceptedByProviderEvent) {
        await this.#acceptPendingSteerAttempt(attempt);
        return true;
      }
      if (!accepted) return false;
      retainForReconciliation = true;
      await this.#acceptPendingSteerAttempt(attempt);
      return true;
    } finally {
      if (
        !retainForReconciliation
        && this.#pendingSteerAttempts.get(submission.submissionId) === attempt
      ) {
        this.#pendingSteerAttempts.delete(submission.submissionId);
      }
    }
  }

  async acceptSteerFromProviderEvent(
    submissionId: string,
    nativeUserMessageId?: string,
  ): Promise<boolean> {
    const attempt = this.#pendingSteerAttempts.get(submissionId);
    if (!attempt) return false;

    attempt.acceptedByProviderEvent = true;
    try {
      await this.#acceptPendingSteerAttempt(attempt, nativeUserMessageId);
      return true;
    } finally {
      if (this.#pendingSteerAttempts.get(submissionId) === attempt) {
        this.#pendingSteerAttempts.delete(submissionId);
        this.#restartIdleTimer();
      }
    }
  }

  releaseSteerCorrelation(submissionId: string): void {
    this.#pendingSteerAttempts.delete(submissionId);
    this.#restartIdleTimer();
  }

  async previewRewind(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindPreview> {
    return this.#runProtectedOperation(() => this.#previewRewindProtected(
      userMessageId,
      assistantMessageId,
      mode,
    ));
  }

  async getConversationBranches(messages: readonly ChatMessage[] = []): Promise<ConversationBranchState> {
    const binding = this.#sessionBinding;
    if (!binding || !this.#isBindingCurrent(binding) || !isBranchableExecutionSession(binding.session)) return { branches: {}, userMessageIds: {} };
    const result = await binding.session.getConversationBranches(messages);
    return this.#isBindingCurrent(binding) ? result : { branches: {}, userMessageIds: {} };
  }

  get supportsConversationBranches(): boolean {
    const binding = this.#sessionBinding;
    return !!binding && this.#isBindingCurrent(binding) && isBranchableExecutionSession(binding.session);
  }

  navigateConversationBranch(request: ConversationBranchRequest): Promise<ConversationBranchResult> {
    return this.#changeConversationBranch(request);
  }

  reconcileConversationBranch(request: ConversationBranchRecoveryRequest): Promise<ConversationBranchResult> {
    return this.#changeConversationBranch(request);
  }

  async #changeConversationBranch(request: ConversationBranchRequest | ConversationBranchRecoveryRequest): Promise<ConversationBranchResult> {
    if (this.#branchRecoveryRequired && 'userMessageId' in request) {
      return { status: 'recovery-required', error: 'Reconcile the current branch before navigating again.' };
    }
    if (this.#requestController || this.#protectedOperationCount > 0 || this.hasBackgroundWork || this.#interactions.hasPending) {
      return { status: 'failed', error: 'Conversation is busy.' };
    }
    const controller = new AbortController();
    this.#requestController = controller;
    const conversation = this.#conversation;
    const abort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    try {
      return await this.#runProtectedOperation<ConversationBranchResult>(async () => {
        await this.prepare();
        const binding = this.#requireCurrentSessionBinding();
        if (conversation !== this.#conversation || !isBranchableExecutionSession(binding.session)) {
          return { status: 'failed', error: 'Conversation branching is unavailable.' };
        }
        await this.deps.persistence.assertConversationExecutionAuthority(
          binding.conversation.conversationId, binding.bindingId, binding.generation,
        );
        if (!this.#isBindingCurrent(binding) || controller.signal.aborted) return { status: 'cancelled' };
        const result = 'userMessageId' in request
          ? await binding.session.navigateConversationBranch({ ...request, signal: controller.signal })
          : await binding.session.reconcileConversationBranch({ ...request, signal: controller.signal });
        if (!this.#isBindingCurrent(binding)) return { status: 'failed', error: 'Conversation changed during branching.' };
        try {
          await this.#persistSnapshot(binding, binding.session.getSnapshot(), true);
          if (result.status !== 'failed') this.#branchRecoveryRequired = result.status === 'recovery-required';
          return result;
        } catch (error) {
          this.#branchRecoveryRequired = true;
          return { status: 'recovery-required', error: String(error),
            ...('messages' in result ? { messages: result.messages } : {}) };
        }
      });
    } catch (error) {
      return { status: 'failed', error: String(error) };
    } finally {
      request.signal?.removeEventListener('abort', abort);
      this.#requestController = null;
    }
  }

  async #previewRewindProtected(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindPreview> {
    await this.prepare();
    const session = this.#requireCurrentSessionBinding().session;
    if (!isRewindableExecutionSession(session)) {
      return { canRewind: false, error: 'Rewind is not supported by this provider.' };
    }
    return session.previewRewind(userMessageId, assistantMessageId, mode);
  }

  async rewind(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return this.#runProtectedOperation(() => this.#rewindProtected(
      userMessageId,
      assistantMessageId,
      mode,
    ));
  }

  async #rewindProtected(
    userMessageId: string,
    assistantMessageId: string | undefined,
    mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    await this.prepare();
    const binding = this.#requireCurrentSessionBinding();
    if (!isRewindableExecutionSession(binding.session)) {
      return { canRewind: false, error: 'Rewind is not supported by this provider.' };
    }
    const result = await binding.session.rewind(
      userMessageId,
      assistantMessageId,
      mode,
    );
    if (!result.canRewind) return result;
    if (!this.#isBindingCurrent(binding)) return result;
    if (result.sessionStrategy === 'checkpoint-resume') {
      await this.#releaseSessionBinding();
    } else {
      await this.#persistSnapshot(binding, binding.session.getSnapshot());
    }
    return result;
  }

  async resolveForkSource(
    assistantCheckpointId: string,
    resolveFallbackSessionId: () => Promise<string | null>,
  ): Promise<ForkSource | null> {
    const currentSessionId = this.#sessionBinding
      && this.#isBindingCurrent(this.#sessionBinding)
      ? this.#sessionBinding.session.getSnapshot().providerSessionId
      : undefined;
    const sessionId = currentSessionId ?? await resolveFallbackSessionId();
    return sessionId
      ? { sessionId, resumeAt: assistantCheckpointId }
      : null;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#invalidateActiveExecution('invalidated', 'session-disposed');
    this.#pendingSteerAttempts.clear();
    this.#disposePromise = this.#preparationTail
      .catch(() => undefined)
      .then(() => this.#releaseSessionBinding());
    return this.#disposePromise;
  }

  #isIdle(): boolean {
    const binding = this.#sessionBinding;
    return Boolean(
      binding
      && !this.#disposed
      && !this.#branchRecoveryRequired
      && this.#protectedOperationCount === 0
      && this.#activeExecution === null
      && !this.#interactions.hasPending
      && this.#pendingSteerAttempts.size === 0
      && !binding.session.hasBackgroundWork?.()
      && !binding.events.hasBackgroundWork
      && binding.pendingWorkCount === 0
      && (this.deps.isOwnerIdle?.() ?? true),
    );
  }

  #restartIdleTimer(): void {
    this.#clearIdleTimer();
    const idleReleaseMs = this.deps.idleReleaseMs;
    if (idleReleaseMs === undefined || this.#disposed || !this.#sessionBinding) return;
    const generation = this.#idleTimerGeneration;
    this.#idleTimer = window.setTimeout(() => {
      this.#idleTimer = null;
      this.#fireAndReport(this.#enqueuePreparation(() => this.#releaseIdleSession(generation)));
    }, idleReleaseMs);
  }

  #clearIdleTimer(): void {
    this.#idleTimerGeneration += 1;
    if (this.#idleTimer === null) return;
    window.clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  async #releaseIdleSession(generation: number): Promise<void> {
    const binding = this.#sessionBinding;
    if (!binding || generation !== this.#idleTimerGeneration) return;
    try {
      if (!this.#isIdle()) return;
      await this.#persistSnapshot(binding, binding.session.getSnapshot());
      if (this.#sessionBinding === binding && generation === this.#idleTimerGeneration && this.#isIdle()) {
        await this.#releaseSessionBinding();
        this.deps.onIdleRelease?.();
      }
    } finally {
      // Retry busy or failed releases without replacing a newer activity timer.
      if (this.#sessionBinding === binding && generation === this.#idleTimerGeneration) {
        this.#restartIdleTimer();
      }
    }
  }

  async #consumeRequestedEvents(
    active: ActiveExecution,
  ): Promise<ChatExecutionResult> {
    let accepted = false;
    let nativeUserMessageId: string | undefined;
    let nativeAssistantMessageId: string | undefined;
    let nativeCheckpointId: string | undefined;
    let sawSubmittedUserMessage = false;
    // Messages after a steer boundary belong to the steered exchange, not this submission's pair.
    let submittedMessages = active.submission.messages;
    const sinkFailure: { value?: { error: unknown } } = {};

    const terminal = await consumeExecutionEvents(
      active.run, active.binding.session.sessionInstanceId, active.submission.configuration.model,
      () => this.#isActiveExecutionCurrent(active),
      async event => {
        if (event.type === 'turn_started' && event.accepted) {
          accepted = true;
          attachSubmittedContent(active.submission);
          nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
          attachUserMessageId(submittedMessages, nativeUserMessageId);
          await this.deps.persistence.recordConversationActivity(
            active.binding.conversation.conversationId, active.submission.timestamp,
          );
        } else if (event.type === 'user_message_started' && accepted) {
          if (sawSubmittedUserMessage) {
            submittedMessages = undefined;
          } else {
            sawSubmittedUserMessage = true;
            nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
            attachUserMessageId(submittedMessages, nativeUserMessageId);
          }
        } else if (event.type === 'assistant_message_started') {
          nativeAssistantMessageId =
            event.nativeAssistantId ?? nativeAssistantMessageId;
          attachAssistantMessageId(submittedMessages, nativeAssistantMessageId);
        } else if (event.type === 'session_state_changed' || event.type === 'permission_mode_changed') {
          await this.#persistSnapshot(active.binding, event.snapshot);
        } else if (event.type === 'turn_completed') {
          if (submittedMessages) {
            nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
            attachUserMessageId(submittedMessages, nativeUserMessageId);
          }
          nativeAssistantMessageId =
            event.nativeAssistantId ?? nativeAssistantMessageId;
          nativeCheckpointId =
            event.nativeCheckpointId ?? nativeCheckpointId;
          attachAssistantMessageId(
            submittedMessages,
            nativeAssistantMessageId ?? nativeCheckpointId,
          );
        }

        try {
          await this.deps.onRequestedEvent?.(
            event,
            this.#createEventContext(active.binding, active.submission.submissionId),
          );
        } catch (error) {
          if (!isExecutionTerminalEvent(event)) throw error;
          sinkFailure.value = { error };
        }
      },
    );

    if (isDefinitePreHandoffRejection(terminal, accepted)) {
      throw new ChatExecutionPreHandoffError(
        sinkFailure.value?.error ?? terminal,
      );
    }
    const unacceptedMissingSession = isUnacceptedMissingSession(terminal, accepted);
    const missingSessionTerminal = terminal?.type === 'execution_error'
      && terminal.category === 'provider-session-missing';
    if (sinkFailure.value && !missingSessionTerminal) {
      throw sinkFailure.value.error;
    }

    if (active.terminationOverride
      && !(active.terminationOverride === 'cancelled' && terminal?.type === 'turn_completed')) {
      return createInterruptedResult(active.terminationOverride, accepted);
    }
    if (!this.#isBindingCurrent(active.binding)) {
      return createInterruptedResult('invalidated', accepted);
    }
    if (!terminal) {
      return createInterruptedResult('cancelled', accepted);
    }
    if (terminal.type === 'turn_completed') {
      return {
        status: 'completed',
        accepted,
        nativeUserMessageId,
        nativeAssistantMessageId,
        nativeCheckpointId,
      };
    }
    if (terminal.type === 'cancelled') {
      return {
        status: 'cancelled',
        accepted,
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
        this.#conversation?.conversationId
          !== active.binding.conversation.conversationId
      ) {
        if (sinkFailure.value) throw sinkFailure.value.error;
        return createInterruptedResult('invalidated', accepted);
      }
      try {
        if (this.#sessionBinding === active.binding) {
          await this.#releaseSessionBinding();
        }
        if (resolution === 'deleted' || resolution === 'not_found') {
          this.#conversation = null;
        } else if (resolution === 'reset' && this.#conversation) {
          this.#conversation = {
            ...this.#conversation,
            resumeSeed: undefined,
          };
        }
        this.#stale = resolution !== 'deleted' && resolution !== 'not_found';
      } catch (error) {
        if (unacceptedMissingSession) {
          throw new ChatExecutionPreHandoffError(error);
        }
        throw error;
      }
      if (sinkFailure.value) {
        if (unacceptedMissingSession) {
          throw new ChatExecutionPreHandoffError(sinkFailure.value.error);
        }
        throw sinkFailure.value.error;
      }
      return {
        status: 'missing-session',
        accepted,
        nativeUserMessageId,
        nativeAssistantMessageId,
        error: terminal,
        missingSessionResolution: resolution,
      };
    }
    return {
      status: 'error',
      accepted,
      nativeUserMessageId,
      nativeAssistantMessageId,
      error: terminal,
    };
  }

  #handleSessionEvent(event: ProviderSessionEvent): void {
    const binding = this.#sessionBinding;
    if (!binding || !this.#isBindingCurrent(binding)) return;
    const admitted = binding.events.accept(event, binding.model);
    if (!admitted) return;
    if (event.type === 'background_turn_started') {
      this.#publishBackgroundWork();
    }
    if (event.type === 'subagent_updated') this.#publishBackgroundWork();
    const eventWork: Promise<unknown>[] = [];
    if (event.type === 'session_state_changed' || event.type === 'permission_mode_changed') {
      eventWork.push(this.#persistSnapshot(binding, event.snapshot));
    }
    try {
      eventWork.push(Promise.resolve(
        this.deps.onSessionEvent?.(
          admitted,
          this.#createEventContext(binding),
        ),
      ));
    } catch (error) {
      eventWork.push(Promise.reject(toError(error, 'Session event handler failed')));
    }
    this.#trackBindingWork(binding, Promise.all(eventWork));
    if (event.type === 'background_turn_completed') {
      this.#publishBackgroundWork();
      this.#restartIdleTimer();
    }
  }

  async #persistSnapshot(
    binding: SessionBinding,
    snapshot: ProviderSessionSnapshot,
    requirePersistence = false,
  ): Promise<void> {
    if (
      !this.#isBindingCurrent(binding)
      || snapshot.providerId !== binding.conversation.providerId
      || snapshot.revision <= binding.lastSnapshotRevision
    ) {
      return;
    }
    const persisted = await this.deps.persistence.persistExecutionSnapshot(
      binding.conversation.conversationId,
      binding.bindingId,
      binding.generation,
      snapshot,
    );
    if (!persisted && requirePersistence) throw new Error('Branch snapshot was not persisted.');
    if (persisted) {
      binding.lastSnapshotRevision = Math.max(binding.lastSnapshotRevision, snapshot.revision);
    }
  }

  #trackBindingWork(
    binding: SessionBinding,
    work: Promise<unknown>,
  ): void {
    binding.pendingWorkCount += 1;
    void work
      .catch((error) => this.deps.onError?.(error))
      .finally(() => {
        binding.pendingWorkCount = Math.max(0, binding.pendingWorkCount - 1);
        if (this.#sessionBinding === binding && binding.pendingWorkCount === 0) {
          this.#restartIdleTimer();
        }
      });
  }

  #handleLeaseInvalidation(
    _reason: ProviderExecutionInvalidationReason,
  ): void {
    const binding = this.#sessionBinding;
    if (!binding) return;
    this.#sessionBinding = null;
    this.#publishBackgroundWork();
    this.#stale = true;
    this.#pendingSteerAttempts.clear();
    this.#invalidateActiveExecution('invalidated', 'provider-transition');
    this.deps.persistence.releaseExecutionBinding(
      binding.conversation.conversationId,
      binding.bindingId,
    );
    this.#clearIdleTimer();
  }

  async #releaseSessionBinding(): Promise<void> {
    const binding = this.#sessionBinding;
    this.#sessionBinding = null;
    this.#clearIdleTimer();
    this.#publishBackgroundWork();
    try {
      await this.#supervisor.release();
    } finally {
      // Keep the claim until the previous native session has finished disposal.
      if (binding) {
        this.deps.persistence.releaseExecutionBinding(
          binding.conversation.conversationId,
          binding.bindingId,
        );
      }
    }
  }

  async #runProtectedOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.#protectedOperationCount += 1;
    try {
      return await operation();
    } finally {
      this.#protectedOperationCount -= 1;
      if (this.#protectedOperationCount === 0) {
        this.#restartIdleTimer();
      }
    }
  }

  #invalidateActiveExecution(
    status: 'cancelled' | 'invalidated',
    dismissReason: ProviderInteractionDismissReason,
  ): void {
    const active = this.#activeExecution;
    if (active) {
      active.terminationOverride = status;
      active.requestController.abort();
      active.run.cancel();
    }
    this.#interactions.dismissAll(dismissReason);
  }

  #isActiveExecutionCurrent(active: ActiveExecution): boolean {
    return (
      this.#activeExecution === active
      && this.#isBindingCurrent(active.binding)
    );
  }

  #isBindingCurrent(binding: SessionBinding): boolean {
    return (
      !this.#disposed
      && this.#sessionBinding === binding
      && sameConversationBinding(binding.conversation, this.#conversation)
      && this.#supervisor.isCurrent(binding.session, binding.generation)
    );
  }

  #acceptPendingSteerAttempt(
    attempt: PendingSteerAttempt,
    nativeUserMessageId?: string,
  ): Promise<void> {
    attachSubmittedContent(attempt.submission);
    attachUserMessageId(attempt.submission.messages, nativeUserMessageId);
    attempt.acceptancePromise ??= this.deps.persistence.recordConversationActivity(
      attempt.conversationId, attempt.submission.timestamp,
    );
    return attempt.acceptancePromise;
  }

  #requireCurrentSessionBinding(): SessionBinding {
    const binding = this.#sessionBinding;
    if (!binding || !this.#isBindingCurrent(binding)) {
      throw new Error('No current chat execution session');
    }
    return binding;
  }

  #requireConversation(): ChatExecutionConversationBinding {
    if (!this.#conversation) {
      throw new Error('No conversation is bound for chat execution');
    }
    return this.#conversation;
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw new Error('Chat execution coordinator is disposed');
    }
  }

  #createEventContext(
    binding: SessionBinding,
    submissionId?: string,
  ): ChatExecutionEventContext {
    return {
      conversationId: binding.conversation.conversationId,
      bindingId: binding.bindingId,
      providerGeneration: binding.generation,
      session: binding.session,
      submissionId,
    };
  }

  #isInteractionCurrent(request: {
    sessionInstanceId: string;
    turnId: string;
  }): boolean {
    const binding = this.#sessionBinding;
    if (
      !binding
      || !this.#isBindingCurrent(binding)
      || request.sessionInstanceId !== binding.session.sessionInstanceId
    ) {
      return false;
    }
    if (this.#activeExecution?.run.turnId === request.turnId) return true;
    return binding.events.hasBackgroundTurn(request.turnId);
  }

  #fireAndReport(promise: Promise<unknown>): void {
    void promise.catch((error) => this.deps.onError?.(error));
  }
}

function attachSubmittedContent(submission: ChatTurnSubmission): void {
  const user = submission.messages?.user;
  if (!user) return;
  user.displayContent = submission.rawDisplayText;
  user.images = [...submission.images];
  user.executionInput = {
    schemaVersion: 1,
    canonicalText: submission.canonicalText,
    ...(submission.context ? { context: submission.context } : {}),
  };
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

function sameConversationBinding(
  left: ChatExecutionConversationBinding | null,
  right: ChatExecutionConversationBinding | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
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
