import { Notice } from 'obsidian';

import type { ProviderCapabilities } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import type {
  ChatExecutionCoordinator,
  ChatTurnSubmission,
} from '@/features/chat/execution/ChatExecutionCoordinator';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { ChatTurnRequest, QueuedMessage } from '@/features/chat/state/types';
import type { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';

/** The user message a provider is expected to echo for submitted input. */
export interface PendingProviderUserMessage {
  displayContent: string;
  persistedContent?: string;
  linkedContentPath?: string;
  images?: ChatMessage['images'];
}

type PendingSteerProviderDisposition =
  | 'awaiting-result'
  | 'definitely-unsent'
  | 'accepted-awaiting-correlation'
  | 'ambiguous-awaiting-reconciliation';

export interface PendingSteerState {
  readonly conversationId: string;
  readonly coordinator: ChatExecutionCoordinator;
  readonly submissionId: string;
  readonly message: QueuedMessage;
  readonly expectedProviderMessage: PendingProviderUserMessage;
  providerDisposition: PendingSteerProviderDisposition;
  uiState: 'visible' | 'cleared';
  correlationState: 'pending' | 'settled' | 'awaiting-late-echo';
  retryState: 'blocked' | 'parked' | 'restored';
}

/** A provider-echoed user message, claimed by the steer it confirms when there is one. */
export interface ProviderEchoClaim {
  /** Null when the echo does not confirm a pending steer. */
  readonly expected: PendingProviderUserMessage | null;
  /** Resolves with any persistence error; capturing display input never waits for persistence. */
  readonly acceptance: Promise<unknown>;
  /** Releases a settled steer once its message is rendered. */
  settle(): void;
}

export interface TurnSteeringDeps {
  state: ChatState;
  turns: Pick<TurnCoordinator, 'isResponding'>;
  getExecutionCoordinator: () => ChatExecutionCoordinator | null;
  getCapabilities: () => ProviderCapabilities;
  canStartTurn?: () => boolean;
  toQueuedChatTurn: (message: QueuedMessage) => { displayContent: string; request: ChatTurnRequest };
  createSubmission: (displayContent: string, request: ChatTurnRequest) => ChatTurnSubmission;
  /** The queue strip shows the visible pending steer of the current conversation. */
  onVisibleSteerChanged: () => void;
  /** Returns a definitely unsent steer to the owner of queued and composer input. */
  returnUnsent: (message: QueuedMessage) => void;
}

/**
 * Owns steering follow-up input into the running provider turn: one pending steer per
 * conversation, from submission through provider correlation or its return as unsent input.
 */
export class TurnSteering {
  private readonly pendingSteersByConversation = new Map<string, PendingSteerState>();

  constructor(private readonly deps: TurnSteeringDeps) {}

  /** The current conversation's pending steer. */
  get current(): PendingSteerState | null {
    const conversationId = this.deps.state.currentConversationId;
    if (!conversationId) return null;
    return this.pendingSteersByConversation.get(conversationId) ?? null;
  }

  get canSteer(): boolean {
    return this.deps.turns.isResponding
      && this.deps.state.currentConversationId !== null
      && this.current === null
      && this.deps.getCapabilities().supportsTurnSteer === true
      && this.deps.getExecutionCoordinator() !== null;
  }

  async steer(
    queuedMessage: QueuedMessage,
    reportFailure: (message: string) => void = message => { new Notice(message); },
    signal?: AbortSignal,
  ): Promise<PendingSteerState> {
    const { state } = this.deps;
    const coordinator = this.deps.getExecutionCoordinator()!;
    const conversationId = state.currentConversationId!;
    const { displayContent, request } = this.deps.toQueuedChatTurn(queuedMessage);
    // A steer joins an admitted turn, which already owns any first-turn Linked content.
    delete request.linkedContentPath;
    const submission = this.deps.createSubmission(displayContent, request);
    const pending: PendingSteerState = {
      conversationId,
      coordinator,
      correlationState: 'pending',
      expectedProviderMessage: {
        displayContent,
        persistedContent: request.text,
        images: request.images,
      },
      submissionId: submission.submissionId,
      message: queuedMessage,
      providerDisposition: 'awaiting-result',
      retryState: 'blocked',
      uiState: 'visible',
    };
    this.pendingSteersByConversation.set(conversationId, pending);
    this.deps.onVisibleSteerChanged();

    try {
      if (signal?.aborted || this.deps.canStartTurn?.() === false
        || state.cancelRequested || state.isRewinding) {
        pending.providerDisposition = 'definitely-unsent';
        return pending;
      }
      const outcome = await coordinator.steer(submission, signal);
      if (outcome.delivery === 'accepted') {
        pending.message.onDelivery?.(true);
        pending.providerDisposition = 'accepted-awaiting-correlation';
        this.#clearUi(pending);
        if (pending.correlationState !== 'pending') {
          this.release(pending);
        }
        return pending;
      }
      // A provider event can confirm acceptance while the RPC is awaiting its result.
      if ((pending.providerDisposition) === 'accepted-awaiting-correlation') {
        return pending;
      }
      if (outcome.delivery === 'not-sent') {
        pending.providerDisposition = 'definitely-unsent';
        if (outcome.error) reportFailure('Failed to steer the queued message. It is still available.');
        return pending;
      }
      this.#markUncertain(pending, reportFailure);
    } catch {
      if (pending.providerDisposition === 'accepted-awaiting-correlation') return pending;
      this.#markUncertain(pending, reportFailure);
    }
    return pending;
  }

  #markUncertain(pending: PendingSteerState, reportFailure: (message: string) => void): void {
    pending.providerDisposition = 'ambiguous-awaiting-reconciliation';
    this.#clearUi(pending);
    if (pending.correlationState !== 'pending') {
      this.release(pending);
    }
    reportFailure(
      'Steer delivery could not be confirmed. The message was not requeued to avoid sending it twice.',
    );
  }

  release(pending: PendingSteerState): void {
    if (this.#isRegistered(pending)) {
      this.pendingSteersByConversation.delete(pending.conversationId);
      if (pending.correlationState !== 'awaiting-late-echo') {
        pending.coordinator.releaseSteerCorrelation(pending.submissionId);
      }
    }
  }

  /** Hide the current queue presentation without changing delivery or correlation. */
  clearCurrentUi(): void {
    const pending = this.current;
    if (pending) this.#clearUi(pending);
  }

  /** Free the active lane after its turn; the coordinator retains input for an identified late echo. */
  finishTurn(conversationId: string | null): void {
    if (!conversationId) return;
    const pending = this.pendingSteersByConversation.get(conversationId);
    if (!pending) return;
    if (pending.correlationState === 'pending') pending.correlationState = 'awaiting-late-echo';
    this.#clearUi(pending);
    if (pending.providerDisposition !== 'awaiting-result' || pending.correlationState === 'settled') {
      this.release(pending);
    }
  }

  /** Returns a definitely unsent steer now, or parks it until its conversation is active again. */
  restoreIfDefinitelyUnsent(pending: PendingSteerState): void {
    if (
      pending.retryState === 'restored'
      || pending.providerDisposition === 'accepted-awaiting-correlation'
    ) {
      return;
    }

    pending.providerDisposition = 'definitely-unsent';
    pending.correlationState = 'settled';
    this.#clearUi(pending);
    if (
      pending.conversationId !== this.deps.state.currentConversationId
    ) {
      pending.retryState = 'parked';
      return;
    }

    this.#restoreForActiveConversation(pending);
  }

  /** Restores a steer parked for the newly active conversation; returns whether one was restored. */
  resumeParked(): boolean {
    const pending = this.current;
    if (pending?.providerDisposition !== 'definitely-unsent' || pending.retryState !== 'parked') return false;
    this.#restoreForActiveConversation(pending);
    return true;
  }

  claimProviderEcho(nativeUserMessageId: string | undefined, inputId?: string): ProviderEchoClaim {
    const current = this.current;
    const pending = current?.correlationState !== 'settled'
      && (inputId === undefined || current?.submissionId === inputId) ? current : null;
    const coordinator = pending?.coordinator ?? this.deps.getExecutionCoordinator();
    const submission = !pending && inputId ? coordinator?.getSteerSubmission(inputId) : undefined;
    const settle = () => {
      if (pending?.correlationState === 'settled') this.release(pending);
    };
    if (!pending && !submission) return { expected: null, acceptance: Promise.resolve(), settle };

    if (pending) {
      pending.message.onDelivery?.(true);
      pending.providerDisposition = 'accepted-awaiting-correlation';
      pending.correlationState = 'settled';
      this.#clearUi(pending);
    }
    const expected = pending?.expectedProviderMessage ?? {
      displayContent: submission!.rawDisplayText,
      persistedContent: submission!.canonicalText,
      images: [...submission!.images],
    };
    const acceptance = coordinator!.acceptSteerFromProviderEvent(pending?.submissionId ?? inputId!, nativeUserMessageId)
      .then(() => undefined, (error: unknown) => error);
    return { expected, acceptance, settle };
  }

  #restoreForActiveConversation(pending: PendingSteerState): void {
    if (pending.retryState === 'restored') return;

    pending.retryState = 'restored';
    this.release(pending);
    this.deps.returnUnsent(pending.message);
    this.deps.onVisibleSteerChanged();
  }

  #isRegistered(pending: PendingSteerState): boolean {
    return this.pendingSteersByConversation.get(pending.conversationId) === pending;
  }

  #clearUi(pending: PendingSteerState): void {
    pending.uiState = 'cleared';
    if (pending.conversationId === this.deps.state.currentConversationId) {
      this.deps.onVisibleSteerChanged();
    }
  }
}
