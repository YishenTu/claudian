import type { SessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { SessionToolDeliveryStatus } from '@/core/session-tools/sessionToolSpecs';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { TurnCancelReason } from '@/features/chat/turns/TurnCoordinator';

export type SessionMessageUnsentReason = TurnCancelReason | 'failed' | 'deferred' | 'deleted' | 'archived';

export class SessionMessageDeferredError extends Error {}

interface MailboxEntry {
  readonly message: SessionMessage;
  held: boolean;
}

export interface SessionMessageReservation {
  readonly isCurrent: boolean;
  /** Marks admission without dispatch or presentation callbacks. Caller must first check isCurrent. */
  commit(): void;
  cancel(): void;
  publish(): SessionToolDeliveryStatus;
}

/** Session-owned FIFO; user input and existing execution owners decide when it can dispatch. */
export class SessionMailbox {
  private readonly pending: MailboxEntry[] = [];
  private generation = 0;
  private dispatching = false;

  constructor(private readonly deps: {
    runtime: ChatSessionRuntime;
    isTargetAvailable(): boolean;
    onDiscard(messages: readonly SessionMessage[]): void;
  }) {}

  get hasPending(): boolean { return this.pending.length > 0; }

  admit(message: SessionMessage): SessionToolDeliveryStatus {
    const reservation = this.reserve(message);
    reservation.commit();
    return reservation.publish();
  }

  /** A held entry retains its FIFO position while a selection commit waits for persistence. */
  reserve(message: SessionMessage): SessionMessageReservation {
    if (!this.deps.runtime.acceptsIntents || !this.deps.isTargetAvailable()) {
      throw new Error('The target session is unavailable');
    }
    const entry: MailboxEntry = { message, held: true };
    const generation = this.generation;
    this.pending.push(entry);
    const isCurrent = () => generation === this.generation && this.pending.includes(entry)
      && this.deps.runtime.acceptsIntents && this.deps.isTargetAvailable();
    const publish = (): SessionToolDeliveryStatus => {
      const starts = !entry.held && isCurrent() && this.pending[0] === entry && !this.dispatching && this.canDispatch;
      this.wake();
      // Publication cannot reject an admission that already committed.
      try { this.deps.runtime.publish('work'); } catch { /* The session still owns the entry. */ }
      return starts ? 'started' : 'queued';
    };
    publish();
    return {
      get isCurrent() { return isCurrent(); },
      commit: () => {
        if (!entry.held || !isCurrent()) throw new Error('Session message reservation was discarded');
        entry.held = false;
      },
      cancel: () => {
        if (!entry.held) return;
        const index = this.pending.indexOf(entry);
        if (index !== -1) this.pending.splice(index, 1);
        publish();
      },
      publish,
    };
  }

  clear(): void {
    this.generation++;
    const discarded = this.pending.splice(0);
    if (discarded.length) {
      this.deps.onDiscard(discarded.map(entry => entry.message));
      this.deps.runtime.publish('work');
    }
  }

  private get canDispatch(): boolean {
    const runtime = this.deps.runtime;
    return runtime.admitsConversationOperations && !runtime.turns.isActive
      && !runtime.hasBackgroundWork && !runtime.hasPendingInteraction
      && (!runtime.peekModel || runtime.peekModel.inputController.canStartSessionMessage);
  }

  wake(): void {
    if (!this.hasPending) return;
    if (!this.deps.runtime.acceptsIntents || !this.deps.isTargetAvailable()) {
      this.clear();
      return;
    }
    if (this.dispatching || this.pending[0].held || !this.canDispatch) return;
    this.dispatching = true;
    const generation = this.generation;
    const entry = this.pending[0];
    const { message } = entry;
    let removed = false;
    let dispositionReported = false;
    void this.deps.runtime.withModel(async model => {
      if (generation !== this.generation) return;
      if (!this.deps.isTargetAvailable()) { this.clear(); return; }
      if (!this.canDispatch) return;
      this.pending.shift();
      removed = true;
      await model.inputController.sendSessionMessage(message, {
        assertBeforeHandoff: () => {
          if (generation !== this.generation || !this.deps.runtime.acceptsIntents || !this.deps.isTargetAvailable()) {
            throw new Error('Session message delivery was cancelled');
          }
          const runtime = this.deps.runtime;
          if (!runtime.admitsConversationOperations || runtime.hasBackgroundWork || runtime.hasPendingInteraction
            || model.conversationController.hasBranchDraft) {
            throw new SessionMessageDeferredError('The recipient has competing work');
          }
        },
        onUnsent: reason => {
          if (dispositionReported) return;
          dispositionReported = true;
          if (reason === 'deferred' && generation === this.generation && this.deps.runtime.acceptsIntents && this.deps.isTargetAvailable()) {
            this.pending.unshift(entry);
          } else this.deps.onDiscard([message]);
        },
      });
    }).catch(() => {
      if (generation !== this.generation || dispositionReported) return;
      if (!removed) this.pending.shift();
      this.deps.onDiscard([message]);
    }).finally(() => {
      this.dispatching = false;
      this.deps.runtime.publish('work');
      this.wake();
    });
  }
}
