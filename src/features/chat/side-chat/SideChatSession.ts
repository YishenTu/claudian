import type {
  ProviderExecutionBackend,
  ProviderExecutionConfiguration,
  ProviderExecutionContext,
  ProviderExecutionEvent,
  ProviderExecutionInvalidationReason,
  ProviderExecutionLifecycleRegistry,
  ProviderExecutionRun,
  ProviderExecutionSession,
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
  ProviderNativeResumeSeed,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
  ProviderToolPolicy,
} from '@/core/execution';
import type { ChatMessage, ImageAttachment, ProviderId } from '@/core/types';
import { toError } from '@/utils/error';

import { ExecutionSessionSupervisor } from '../execution/ExecutionSessionSupervisor';
import type { WarmExecutionPool } from '../execution/WarmExecutionPool';

export type SideChatTurnStatus =
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'invalidated'
  | 'missing-session';

export interface SideChatTurnRequest {
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

export interface SideChatWarmExecution {
  readonly ownerId: string;
  readonly pool: WarmExecutionPool;
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
  readonly warmExecution?: SideChatWarmExecution;
  readonly onRequestedEvent?: (event: ProviderExecutionEvent) => void | Promise<void>;
  readonly onSessionEvent?: (event: ProviderSessionEvent, isCurrent: () => boolean) => void | Promise<void>;
  readonly onBackgroundWorkChanged?: () => void;
  readonly onInvalidated?: (reason: ProviderExecutionInvalidationReason) => void;
  readonly onError?: (error: unknown) => void;
}

interface ActiveSideExecution {
  readonly session: ProviderExecutionSession;
  readonly generation: number;
  readonly run: ProviderExecutionRun;
  readonly controller: AbortController;
  terminationOverride: 'cancelled' | 'invalidated' | null;
}

/**
 * Memory-owned multi-turn execution for one side chat.
 *
 * It holds a lifecycle lease and a warm-pool slot of its own, and keeps the
 * child's normalized resume state in memory. Nothing here reaches conversation
 * persistence, the accepted-input ledger, or the parent's execution owner.
 */
export class SideChatSession {
  readonly #supervisor: ExecutionSessionSupervisor;
  readonly #fencedInteractionPort: ProviderInteractionPort;
  readonly #pendingInteractions = new Map<string, { turnId: string; sessionInstanceId: string }>();
  readonly #backgroundTurnIds = new Set<string>();
  #childResumeStatePromise: Promise<Readonly<Record<string, unknown>>> | null = null;
  #seed: ProviderNativeResumeSeed | null = null;
  #providerSessionId: string | undefined;
  #active: ActiveSideExecution | null = null;
  #executionController: AbortController | null = null;
  #pendingWorkCount = 0;
  #sessionEventWork: Promise<void> = Promise.resolve();
  #preparing = false;
  #disposed = false;
  #invalidated = false;
  #disposePromise: Promise<void> | null = null;
  #lastSnapshotRevision = -1;

  constructor(private readonly deps: SideChatSessionDeps) {
    this.#supervisor = new ExecutionSessionSupervisor(deps.lifecycleRegistry);
    this.#fencedInteractionPort = this.#createInteractionPort();
  }

  get providerId(): ProviderId {
    return this.deps.providerId;
  }

  /** Native child identity once the provider established one; undefined before that. */
  get providerSessionId(): string | undefined {
    return this.#providerSessionId;
  }

  get isExecuting(): boolean {
    return this.#active !== null;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  get hasBackgroundWork(): boolean {
    return this.#backgroundTurnIds.size > 0 || this.#pendingWorkCount > 0;
  }

  get hasPendingInteractions(): boolean {
    return this.#pendingInteractions.size > 0;
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
      this.#notifyMayCool();
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
      controller,
      generation: supervised.generation,
      run,
      session,
      terminationOverride: null,
    };
    this.#active = active;
    try {
      return await this.#consumeRun(active);
    } finally {
      this.#dismissInteractionsForTurn(active.run.turnId, 'native-rejected');
      if (this.#active === active) this.#active = null;
      this.#captureSnapshot();
      this.#notifyMayCool();
    }
  }

  cancel(): void {
    this.#executionController?.abort();
    const active = this.#active;
    if (!active) {
      if (this.#backgroundTurnIds.size > 0) this.#supervisor.current?.session.cancel();
      return;
    }
    active.terminationOverride = 'cancelled';
    active.controller.abort();
    this.#dismissInteractionsForTurn(active.run.turnId, 'cancelled');
    active.run.cancel();
  }

  canCool(): boolean {
    return Boolean(
      !this.#disposed
      && this.#supervisor.current
      // An ephemeral native id cannot survive eviction of its process.
      && !this.deps.ephemeral
      && !this.#preparing
      && this.#executionController === null
      && this.#active === null
      && this.#pendingInteractions.size === 0
      && this.#pendingWorkCount === 0
      && this.#backgroundTurnIds.size === 0
      // A child without a verified native identity cannot be resumed safely.
      && this.#providerSessionId !== undefined,
    );
  }

  async cool(): Promise<void> {
    this.#assertAvailable();
    if (!this.#supervisor.current) return;
    if (!this.canCool()) {
      throw new Error('Side chat execution is busy and cannot be cooled');
    }
    this.#captureSnapshot();
    await this.#releaseSession();
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
    this.#dismissAllInteractions('session-disposed');
    this.#disposePromise = this.#releaseSession();
    return this.#disposePromise;
  }

  async #prepare(signal: AbortSignal): Promise<ProviderExecutionSession> {
    signal.throwIfAborted();
    const existing = this.#supervisor.current;
    if (existing && this.#supervisor.isCurrent(existing.session, existing.generation)) {
      await this.#touchWarmSlot();
      signal.throwIfAborted();
      return existing.session;
    }

    this.#preparing = true;
    try {
      const seed = await this.#resolveSeed();
      signal.throwIfAborted();
      this.#assertAvailable();
      await this.#acquireWarmSlot();
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
          interactionPort: this.#fencedInteractionPort,
          lifecycle: this.deps.ephemeral ? 'ephemeral' : 'persistent',
          nativePersistence: this.deps.ephemeral ? 'disabled-if-supported' : 'enabled',
          ...(seed ? { resumeSeed: seed } : {}),
          vaultWorkingDirectory: this.deps.vaultWorkingDirectory,
        },
        reason => this.#handleInvalidation(reason),
        event => this.#handleSessionEvent(event),
      );
      return supervised.session;
    } catch (error) {
      if (!this.#supervisor.current) this.#releaseWarmSlot();
      throw error;
    } finally {
      this.#preparing = false;
    }
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
    let lastSequence = 0;
    let accepted = false;
    let nativeUserMessageId: string | undefined;
    let checkpointId: string | undefined;
    let terminal: Extract<
      ProviderExecutionEvent,
      { type: 'turn_completed' | 'cancelled' | 'execution_error' }
    > | undefined;

    for await (const event of active.run.events) {
      if (this.#active !== active) break;
      if (
        event.scope.sessionInstanceId !== active.session.sessionInstanceId
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
      } else if (event.type === 'user_message_started') {
        nativeUserMessageId = event.nativeUserMessageId ?? nativeUserMessageId;
      } else if (event.type === 'session_state_changed' || event.type === 'permission_mode_changed') {
        this.#applySnapshot(event.snapshot);
      } else if (event.type === 'turn_completed') {
        terminal = event;
        checkpointId = event.nativeAssistantId ?? event.nativeCheckpointId ?? checkpointId;
      } else if (event.type === 'cancelled' || event.type === 'execution_error') {
        terminal = event;
      }

      await this.#deliverRequestedEvent(event);
      if (terminal) break;
    }
    if (active.terminationOverride) {
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
    if (!current || event.scope.sessionInstanceId !== current.session.sessionInstanceId) return;
    if (event.type === 'background_turn_started') {
      this.#backgroundTurnIds.add(event.scope.turnId);
    } else if (event.type === 'background_turn_completed') {
      this.#backgroundTurnIds.delete(event.scope.turnId);
      this.#dismissInteractionsForTurn(event.scope.turnId, 'native-rejected');
    } else if (event.type === 'session_error') {
      this.#backgroundTurnIds.clear();
      this.#dismissAllInteractions('native-rejected');
    }
    if (event.type === 'session_state_changed' || event.type === 'permission_mode_changed') {
      this.#applySnapshot(event.snapshot);
    }
    const isCurrent = () => !this.#disposed && this.#supervisor.current === current;
    const work = this.#sessionEventWork.then(async () => {
      if (isCurrent()) await this.deps.onSessionEvent?.(event, isCurrent);
    });
    this.#sessionEventWork = work.catch(() => undefined);
    this.#trackWork(work);
  }

  #handleInvalidation(reason: ProviderExecutionInvalidationReason): void {
    this.#invalidated = this.deps.ephemeral;
    this.#backgroundTurnIds.clear();
    const active = this.#active;
    if (active) {
      active.terminationOverride = 'invalidated';
      active.controller.abort();
      active.run.cancel();
    }
    this.#dismissAllInteractions('provider-transition');
    this.#releaseWarmSlot();
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
        if (this.#pendingWorkCount === 0) this.#notifyMayCool();
      });
  }

  async #releaseSession(): Promise<void> {
    this.#backgroundTurnIds.clear();
    try {
      await this.#supervisor.release();
    } finally {
      this.#releaseWarmSlot();
    }
  }

  async #acquireWarmSlot(): Promise<void> {
    const warm = this.deps.warmExecution;
    if (!warm) return;
    try {
      await warm.pool.acquire({
        canCool: () => this.canCool(),
        cool: () => this.cool(),
        id: warm.ownerId,
      });
    } catch (error) {
      if (!this.#supervisor.current) warm.pool.release(warm.ownerId);
      throw error;
    }
  }

  #releaseWarmSlot(): void {
    const warm = this.deps.warmExecution;
    warm?.pool.release(warm.ownerId);
  }

  async #touchWarmSlot(): Promise<void> {
    const warm = this.deps.warmExecution;
    if (!warm) return;
    await warm.pool.touch(warm.ownerId);
  }

  #notifyMayCool(): void {
    const warm = this.deps.warmExecution;
    if (!warm) return;
    void warm.pool.notifyOwnerMayCool(warm.ownerId)
      .catch(error => this.deps.onError?.(error));
  }

  #createInteractionPort(): ProviderInteractionPort {
    return {
      askUserQuestion: (request, signal) => this.#forwardInteraction(
        request,
        signal,
        () => this.deps.interactionPort.askUserQuestion(request, signal),
      ),
      dismissInteraction: (interactionId, reason) => {
        this.#pendingInteractions.delete(interactionId);
        this.deps.interactionPort.dismissInteraction(interactionId, reason);
        this.#notifyMayCool();
      },
      requestApproval: (request, signal) => this.#forwardInteraction(
        request,
        signal,
        () => this.deps.interactionPort.requestApproval(request, signal),
      ),
    };
  }

  async #forwardInteraction<
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
    if (!this.#isInteractionCurrent(request) || signal.aborted) {
      throw new SideChatInteractionStaleError(request.interactionId);
    }
    if (this.#pendingInteractions.has(request.interactionId)) {
      throw new Error(`Duplicate side chat interaction: ${request.interactionId}`);
    }
    this.#pendingInteractions.set(request.interactionId, {
      sessionInstanceId: request.sessionInstanceId,
      turnId: request.turnId,
    });
    const pending = this.#pendingInteractions.get(request.interactionId);
    try {
      const response = await forward();
      if (
        response.interactionId !== request.interactionId
        || signal.aborted
        || this.#pendingInteractions.get(request.interactionId) !== pending
        || !this.#isInteractionCurrent(request)
      ) {
        throw new SideChatInteractionStaleError(request.interactionId);
      }
      return response;
    } finally {
      this.#pendingInteractions.delete(request.interactionId);
      this.#notifyMayCool();
    }
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
      || this.#backgroundTurnIds.has(request.turnId);
  }

  #dismissInteractionsForTurn(
    turnId: string,
    reason: ProviderInteractionDismissReason,
  ): void {
    for (const [interactionId, pending] of this.#pendingInteractions) {
      if (pending.turnId !== turnId) continue;
      this.#pendingInteractions.delete(interactionId);
      this.deps.interactionPort.dismissInteraction(interactionId, reason);
    }
  }

  #dismissAllInteractions(reason: ProviderInteractionDismissReason): void {
    for (const interactionId of this.#pendingInteractions.keys()) {
      this.deps.interactionPort.dismissInteraction(interactionId, reason);
    }
    this.#pendingInteractions.clear();
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
