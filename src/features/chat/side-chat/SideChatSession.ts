import type {
  ProviderExecutionBackend,
  ProviderExecutionConfiguration,
  ProviderExecutionContext,
  ProviderExecutionEvent,
  ProviderExecutionInvalidationReason,
  ProviderExecutionLifecycleRegistry,
  ProviderExecutionRun,
  ProviderExecutionSession,
  ProviderInteractionPort,
  ProviderNativeResumeSeed,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
  ProviderToolPolicy,
} from '@/core/execution';
import { isSteerableExecutionSession } from '@/core/execution';
import type { ChatMessage, ImageAttachment, ProviderId } from '@/core/types';
import { consumeExecutionEvents } from '@/features/chat/execution/consumeExecutionEvents';
import { ExecutionInteractions } from '@/features/chat/execution/ExecutionInteractions';
import { ExecutionSessionSupervisor } from '@/features/chat/execution/ExecutionSessionSupervisor';
import { SessionEventStream } from '@/features/chat/execution/SessionEventStream';
import { toError } from '@/utils/error';

export type SideChatTurnStatus =
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'invalidated'
  | 'missing-session';

export interface SideChatTurnRequest {
  /** Revalidate transient interaction ownership after asynchronous preparation. */
  readonly assertBeforeHandoff?: () => void;
  readonly text: string;
  readonly images: readonly ImageAttachment[];
  readonly context?: ProviderExecutionContext;
  readonly conversationHistory?: readonly ChatMessage[];
  readonly configuration: ProviderExecutionConfiguration;
  readonly toolPolicy?: ProviderToolPolicy;
}

export interface SideChatTurnResult {
  readonly status: SideChatTurnStatus;
  readonly accepted: boolean;
  readonly checkpointId?: string;
  readonly nativeUserMessageId?: string;
  readonly error?: Extract<ProviderExecutionEvent, { type: 'execution_error' }>;
}

export interface SideChatSessionDeps {
  readonly providerId: ProviderId;
  readonly ephemeral: boolean;
  readonly lifecycleRegistry: ProviderExecutionLifecycleRegistry;
  readonly resolveBackend: (providerId: ProviderId) => ProviderExecutionBackend;
  /**
   * Produces the captured fork state once; the provider owns how it is materialized.
   * Retries reuse it instead of refolding a newer source checkpoint.
   */
  readonly buildChildResumeState: () => Promise<Readonly<Record<string, unknown>>>;
  readonly vaultWorkingDirectory: string;
  readonly interactionPort: ProviderInteractionPort;
  readonly onRequestedEvent?: (event: ProviderExecutionEvent) => void | Promise<void>;
  readonly onSessionEvent?: (event: ProviderSessionEvent, isCurrent: () => boolean) => void | Promise<void>;
  readonly onBackgroundWorkChanged?: () => void;
  readonly onInvalidated?: (reason: ProviderExecutionInvalidationReason) => void;
  readonly onError?: (error: unknown) => void;
}

interface ActiveSideExecution {
  readonly request: SideChatTurnRequest;
  readonly session: ProviderExecutionSession;
  readonly generation: number;
  readonly run: ProviderExecutionRun;
  readonly model: string | undefined;
  readonly controller: AbortController;
  terminationOverride: 'cancelled' | 'invalidated' | null;
}

/**
 * Memory-owned multi-turn execution for one side chat.
 *
 * It holds a lifecycle lease of its own until disposal, and keeps the
 * child's normalized resume state in memory. Nothing here reaches conversation
 * persistence, the accepted-input ledger, or the parent's execution owner.
 */
export class SideChatSession {
  readonly #supervisor: ExecutionSessionSupervisor;
  readonly #interactions: ExecutionInteractions;
  #events: SessionEventStream | null = null;
  #model: string | undefined;
  #childResumeStatePromise: Promise<Readonly<Record<string, unknown>>> | null = null;
  #seed: ProviderNativeResumeSeed | null = null;
  #providerSessionId: string | undefined;
  #active: ActiveSideExecution | null = null;
  #executionController: AbortController | null = null;
  #pendingWorkCount = 0;
  #disposed = false;
  #invalidated = false;
  #disposePromise: Promise<void> | null = null;
  #lastSnapshotRevision = -1;

  constructor(private readonly deps: SideChatSessionDeps) {
    this.#supervisor = new ExecutionSessionSupervisor(deps.lifecycleRegistry);
    this.#interactions = new ExecutionInteractions({
      port: deps.interactionPort,
      isCurrent: request => this.#isInteractionCurrent(request),
      staleError: id => new SideChatInteractionStaleError(id),
    });
  }

  get providerId(): ProviderId {
    return this.deps.providerId;
  }

  /** Native child identity once the provider established one; undefined before that. */
  get providerSessionId(): string | undefined {
    return this.#providerSessionId;
  }

  get hasBackgroundWork(): boolean {
    return this.#events?.hasBackgroundWork || this.#pendingWorkCount > 0
      || (this.#supervisor.current?.session.hasBackgroundWork?.() ?? false);
  }

  get hasPendingInteractions(): boolean {
    return this.#interactions.hasPending;
  }

  async execute(request: SideChatTurnRequest): Promise<SideChatTurnResult> {
    this.#assertAvailable();
    if (this.#executionController) {
      throw new Error('A side chat execution is already active');
    }
    const controller = new AbortController();
    this.#executionController = controller;
    try {
      return await this.#executeRequest(request, controller);
    } finally {
      if (this.#executionController === controller) this.#executionController = null;
    }
  }

  async #executeRequest(
    request: SideChatTurnRequest,
    controller: AbortController,
  ): Promise<SideChatTurnResult> {
    let session: ProviderExecutionSession;
    try {
      session = await this.#prepare(controller.signal);
      controller.signal.throwIfAborted();
    } catch (error) {
      if (controller.signal.aborted) {
        return { accepted: false, status: this.#disposed ? 'invalidated' : 'cancelled' };
      }
      throw error;
    }
    const supervised = this.#supervisor.current;
    if (!supervised || supervised.session !== session) {
      throw new Error('Side chat execution session became stale before handoff');
    }

    request.assertBeforeHandoff?.();
    this.#model = request.configuration.model;
    const run = session.execute({
      configuration: request.configuration,
      ...(request.context ? { context: request.context } : {}),
      ...(request.conversationHistory
        ? { conversationHistory: request.conversationHistory }
        : {}),
      input: [
        ...(request.text ? [{ text: request.text, type: 'text' as const }] : []),
        ...request.images.map(image => ({ image, type: 'image' as const })),
      ],
      signal: controller.signal,
      toolPolicy: request.toolPolicy ?? { kind: 'provider-default' },
    });
    const active: ActiveSideExecution = {
      request,
      controller,
      generation: supervised.generation,
      run,
      model: request.configuration.model,
      session,
      terminationOverride: null,
    };
    this.#active = active;
    try {
      return await this.#consumeRun(active);
    } finally {
      this.#interactions.dismissTurn(active.run.turnId, 'native-rejected');
      if (this.#active === active) this.#active = null;
      this.#captureSnapshot();
    }
  }

  /** Deliver an answer to the current child turn without preparing or replacing its session. */
  async steer(text: string): Promise<boolean> {
    const active = this.#active;
    if (this.#disposed || this.#invalidated || !active || active.controller.signal.aborted
      || !this.#supervisor.isCurrent(active.session, active.generation)
      || !isSteerableExecutionSession(active.session)) return false;
    return active.session.steer({
      configuration: active.request.configuration,
      input: [{ type: 'text', text }],
      signal: active.controller.signal,
      toolPolicy: active.request.toolPolicy ?? { kind: 'provider-default' },
    });
  }

  cancel(): void {
    this.#executionController?.abort();
    const active = this.#active;
    if (!active) {
      if (this.#events?.hasBackgroundWork) this.#supervisor.current?.session.cancel();
      return;
    }
    active.terminationOverride = 'cancelled';
    active.controller.abort();
    this.#interactions.dismissTurn(active.run.turnId, 'cancelled');
    active.run.cancel();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#executionController?.abort();
    const active = this.#active;
    if (active) {
      active.terminationOverride = 'invalidated';
      active.controller.abort();
      active.run.cancel();
    }
    this.#interactions.dismissAll('session-disposed');
    this.#disposePromise = this.#releaseSession();
    return this.#disposePromise;
  }

  async #prepare(signal: AbortSignal): Promise<ProviderExecutionSession> {
    signal.throwIfAborted();
    const existing = this.#supervisor.current;
    if (existing && this.#supervisor.isCurrent(existing.session, existing.generation)) {
      return existing.session;
    }

    const seed = await this.#resolveSeed();
    signal.throwIfAborted();
    this.#assertAvailable();
    const backend = this.deps.resolveBackend(this.deps.providerId);
    if (backend.providerId !== this.deps.providerId) {
      throw new Error(
        `Side chat backend provider mismatch: expected ${this.deps.providerId}, got ${backend.providerId}`,
      );
    }
    this.#lastSnapshotRevision = -1;
    const supervised = this.#supervisor.acquire(
      backend,
      {
        interactionPort: this.#interactions,
        lifecycle: this.deps.ephemeral ? 'ephemeral' : 'persistent',
        nativePersistence: this.deps.ephemeral ? 'disabled-if-supported' : 'enabled',
        ...(seed ? { resumeSeed: seed } : {}),
        vaultWorkingDirectory: this.deps.vaultWorkingDirectory,
      },
      reason => this.#handleInvalidation(reason),
      event => this.#handleSessionEvent(event),
    );
    this.#events = new SessionEventStream(supervised.session.sessionInstanceId);
    return supervised.session;
  }

  async #resolveSeed(): Promise<ProviderNativeResumeSeed> {
    if (this.#seed) return this.#seed;
    if (!this.#childResumeStatePromise) {
      this.#childResumeStatePromise = Promise.resolve()
        .then(() => this.deps.buildChildResumeState());
    }
    let providerState: Readonly<Record<string, unknown>>;
    try {
      providerState = await this.#childResumeStatePromise;
    } catch (error) {
      // Allow an explicit retry to rebuild against the same captured source.
      this.#childResumeStatePromise = null;
      throw error;
    }
    // The parent's provider session id is deliberately absent: seeding it would
    // bypass pending-fork handling and risk resuming the source conversation.
    this.#seed = { providerState };
    return this.#seed;
  }

  async #consumeRun(active: ActiveSideExecution): Promise<SideChatTurnResult> {
    let accepted = false;
    let nativeUserMessageId: string | undefined;
    let checkpointId: string | undefined;

    const terminal = await consumeExecutionEvents(
      active.run, active.session.sessionInstanceId, active.model, () => this.#active === active,
      async event => {
        if (event.type === 'turn_started' && event.accepted) {
          accepted = true;
          nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
        } else if (event.type === 'user_message_started') {
          nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
        } else if (event.type === 'session_state_changed' || event.type === 'permission_mode_changed') {
          this.#applySnapshot(event.snapshot);
        } else if (event.type === 'turn_completed') {
          checkpointId = event.nativeAssistantId ?? event.nativeCheckpointId ?? checkpointId;
        }

        await this.#deliverRequestedEvent(event);
      },
    );
    if (active.terminationOverride
      && !(active.terminationOverride === 'cancelled' && terminal?.type === 'turn_completed')) {
      return { accepted, status: active.terminationOverride };
    }
    if (!terminal) {
      return { accepted, status: 'cancelled' };
    }
    if (terminal.type === 'turn_completed') {
      return { accepted, checkpointId, nativeUserMessageId, status: 'completed' };
    }
    if (terminal.type === 'cancelled') {
      return { accepted, nativeUserMessageId, status: 'cancelled' };
    }
    return {
      accepted,
      error: terminal,
      nativeUserMessageId,
      status: terminal.category === 'provider-session-missing'
        ? 'missing-session'
        : 'error',
    };
  }

  async #deliverRequestedEvent(event: ProviderExecutionEvent): Promise<void> {
    try {
      await this.deps.onRequestedEvent?.(event);
    } catch (error) {
      this.deps.onError?.(toError(error, 'Side chat event handler failed'));
    }
  }

  #handleSessionEvent(event: ProviderSessionEvent): void {
    if (this.#disposed) return;
    const current = this.#supervisor.current;
    if (!current) return;
    const admitted = this.#events?.accept(event, this.#model);
    if (!admitted) return;
    if (event.type === 'background_turn_completed') {
      this.#interactions.dismissTurn(event.scope.turnId, 'native-rejected');
    } else if (event.type === 'session_error') {
      this.#events?.endBackgroundTurns();
      this.#model = undefined;
      this.#interactions.dismissAll('native-rejected');
    }
    if (event.type === 'session_state_changed' || event.type === 'permission_mode_changed') {
      this.#applySnapshot(event.snapshot);
    }
    const isCurrent = () => !this.#disposed && this.#supervisor.current === current;
    const deliver = async () => {
      if (isCurrent()) await this.deps.onSessionEvent?.(admitted, isCurrent);
    };
    // The renderer admits events synchronously, then owns its rendering queue.
    this.#trackWork(deliver());
  }

  #handleInvalidation(reason: ProviderExecutionInvalidationReason): void {
    this.#invalidated = this.deps.ephemeral;
    this.#events = null;
    this.#model = undefined;
    const active = this.#active;
    if (active) {
      active.terminationOverride = 'invalidated';
      active.controller.abort();
      active.run.cancel();
    }
    this.#interactions.dismissAll('provider-transition');
    this.deps.onInvalidated?.(reason);
    this.deps.onBackgroundWorkChanged?.();
  }

  #captureSnapshot(): void {
    const current = this.#supervisor.current;
    if (!current) return;
    this.#applySnapshot(current.session.getSnapshot());
  }

  /** Keeps the child's normalized resume state in memory only. */
  #applySnapshot(snapshot: ProviderSessionSnapshot): void {
    if (
      snapshot.providerId !== this.deps.providerId
      || snapshot.revision <= this.#lastSnapshotRevision
    ) {
      return;
    }
    this.#lastSnapshotRevision = snapshot.revision;
    if (snapshot.providerSessionId !== undefined) {
      this.#providerSessionId = snapshot.providerSessionId;
    }
    const retained = { ...(this.#seed?.providerState ?? {}) };
    for (const key of snapshot.providerStateDeletes ?? []) delete retained[key];
    const providerState = { ...retained, ...snapshot.providerState };
    this.#seed = {
      ...(this.#providerSessionId ? { providerSessionId: this.#providerSessionId } : {}),
      ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
    };
  }

  #trackWork(work: Promise<unknown>): void {
    this.#pendingWorkCount += 1;
    this.deps.onBackgroundWorkChanged?.();
    void work
      .catch(error => this.deps.onError?.(toError(error, 'Side chat session event failed')))
      .finally(() => {
        this.#pendingWorkCount = Math.max(0, this.#pendingWorkCount - 1);
        this.deps.onBackgroundWorkChanged?.();
      });
  }

  async #releaseSession(): Promise<void> {
    this.#events = null;
    this.#model = undefined;
    await this.#supervisor.release();
  }

  #isInteractionCurrent(request: {
    sessionInstanceId: string;
    turnId: string;
  }): boolean {
    const current = this.#supervisor.current;
    if (
      this.#disposed
      || !current
      || request.sessionInstanceId !== current.session.sessionInstanceId
    ) {
      return false;
    }
    return this.#active?.run.turnId === request.turnId
      || (this.#events?.hasBackgroundTurn(request.turnId) ?? false);
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw new Error('Side chat session is disposed');
    }
    if (this.#invalidated) {
      throw new Error('This side chat has ended. Discard it and start a new side chat.');
    }
  }
}

export class SideChatInteractionStaleError extends Error {
  constructor(readonly interactionId: string) {
    super(`Side chat interaction is stale: ${interactionId}`);
    this.name = 'SideChatInteractionStaleError';
  }
}
