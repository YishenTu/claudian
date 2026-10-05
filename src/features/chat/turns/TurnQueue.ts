import { Notice } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { type QueueStripView, renderQueueStrip } from '@/features/chat/composer/QueueStrip';
import type { ChatState } from '@/features/chat/state/ChatState';
import { cloneQueuedMessage, mergeQueuedMessages } from '@/features/chat/state/chatTurnRequest';
import type { QueuedMessage } from '@/features/chat/state/types';
import type { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import type { TurnSteering } from '@/features/chat/turns/TurnSteering';
import { t } from '@/i18n/i18n';

export interface TurnQueueDeps {
  state: ChatState;
  turns: TurnCoordinator;
  drafts: Pick<ComposerDraftController, 'restore'>;
  steering: TurnSteering;
  canStartTurn: () => boolean;
  getTabProviderId: () => ProviderId | null;
  /** Runs an admitted continuation inside the turn the queue opened for it. */
  runQueued: (message: QueuedMessage, signal: AbortSignal) => Promise<void>;
  /** A continuation that could not start or failed settles the review its predecessor deferred. */
  onContinuationFailed: () => void;
}

/**
 * Owns the main follow-up queued behind the running turn: its single message slot, the
 * scheduled continuation that dispatches it, and its return to the composer or a steer.
 */
export class TurnQueue {
  readonly #write: (value: QueuedMessage | null) => void;
  #scheduled: { conversationId: string | null; timer: number } | null = null;

  constructor(private readonly deps: TurnQueueDeps) {
    this.#write = deps.state.claimQueuedMessageWriter();
  }

  get message(): QueuedMessage | null {
    return this.deps.state.queuedMessage;
  }

  enqueue(message: QueuedMessage): void {
    this.#write(mergeQueuedMessages(this.message, message));
    this.updateIndicator();
  }

  clear(): void {
    this.cancelScheduled();
    this.message?.onDelivery?.(false);
    this.#write(null);
    this.updateIndicator();
  }

  withdrawToComposer(): void {
    this.cancelScheduled();
    if (!this.message) return;

    const message = cloneQueuedMessage(this.message);
    this.#write(null);
    this.returnMessageToComposer(message, { merge: true });
    this.updateIndicator();
  }

  restoreToComposer(): void {
    this.cancelScheduled();
    const message = this.message ? cloneQueuedMessage(this.message) : null;
    this.returnMessageToComposer(message, { merge: true });
    this.#write(null);
    this.updateIndicator();
  }

  /** Unsent input goes back to the main composer as its original draft text. */
  returnMessageToComposer(message: QueuedMessage | null, options: { merge?: boolean } = {}): void {
    if (!message) return;
    message.onDelivery?.(false);
    this.deps.drafts.restore('main', {
      content: message.turnRequest.draftContent ?? message.content,
      images: message.turnRequest.images,
    }, { merge: options.merge, focus: true });
  }

  /** Unsent steering rejoins the queue while its turn still runs, otherwise the composer. */
  returnUnsent(message: QueuedMessage): void {
    const { turns } = this.deps;
    if (turns.isInFlight && !turns.cancelRequested) {
      this.#write(this.message ? mergeQueuedMessages(message, this.message) : cloneQueuedMessage(message));
    } else {
      this.returnMessageToComposer(message, { merge: true });
    }
  }

  /** Returns whether a continuation now owns the queued message. */
  scheduleContinuation(): boolean {
    const { state } = this.deps;
    if (!this.message) return false;
    if (this.#scheduled) return true;

    // The visible queue retains ownership until the scheduled callback enters a turn.
    const reservation = { conversationId: state.currentConversationId, timer: 0 };
    this.#scheduled = reservation;
    reservation.timer = window.setTimeout(
      () => {
        if (this.#scheduled !== reservation) return;
        if (state.currentConversationId !== reservation.conversationId
          || state.isRewinding || state.isResettingToNewChat || state.isSwitchingConversation) {
          this.restoreToComposer();
          return;
        }
        if (!this.deps.canStartTurn() || this.deps.turns.isActive) {
          this.cancelScheduled();
          return;
        }
        if (this.deps.getTabProviderId() === null) {
          this.cancelScheduled();
          new Notice(t('chat.selectAvailableModel'));
          return;
        }
        const queuedMessage = this.message;
        if (!queuedMessage) {
          this.cancelScheduled();
          return;
        }
        void this.deps.turns.run(signal => {
          this.cancelScheduled();
          this.#write(null);
          this.updateIndicator();
          return this.deps.runQueued(queuedMessage, signal);
        }).catch(() => {
          if (this.#scheduled === reservation) this.cancelScheduled();
          this.deps.onContinuationFailed();
        })
          .finally(() => queuedMessage.onDelivery?.(false));
      },
      0
    );
    return true;
  }

  cancelScheduled(): void {
    if (!this.#scheduled) return;
    window.clearTimeout(this.#scheduled.timer);
    this.#scheduled = null;
  }

  async steerNow(): Promise<void> {
    const { steering } = this.deps;
    if (!this.message || !steering.canSteer) return;

    const message = cloneQueuedMessage(this.message);
    this.#write(null);
    const pending = await steering.steer(message);
    if (pending.providerDisposition === 'definitely-unsent') steering.restoreIfDefinitelyUnsent(pending);
  }

  /** The queued message, or else the current conversation's visible pending steer. */
  get visible(): QueueStripView | null {
    if (this.message) return { kind: 'queued', message: this.message, canSteer: this.deps.steering.canSteer };
    const pendingSteer = this.deps.steering.current;
    return pendingSteer?.uiState === 'visible' ? { kind: 'steering', message: pendingSteer.message } : null;
  }

  updateIndicator(): void {
    const el = this.deps.state.queueIndicatorEl;
    if (!el) return;
    renderQueueStrip(el, this.visible, {
      steer: () => { void this.steerNow(); },
      edit: () => this.withdrawToComposer(),
      discard: () => this.clear(),
    });
  }
}
