import type { SessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { SessionToolDeliveryStatus } from '@/core/session-tools/sessionToolSpecs';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { TurnCancelReason } from '@/features/chat/turns/TurnCoordinator';

export type SessionMessageUnsentReason = TurnCancelReason | 'failed' | 'deferred' | 'deleted' | 'archived';

export class SessionMessageDeferredError extends Error {}

/** Session-owned FIFO; user input and existing execution owners decide when it can dispatch. */
export class SessionMailbox {
  private readonly pending: SessionMessage[] = [];
  private generation = 0;
  private dispatching = false;

  constructor(private readonly deps: {
    runtime: ChatSessionRuntime;
    isTargetAvailable(): boolean;
    onDiscard(messages: readonly SessionMessage[]): void;
  }) {}

  get hasPending(): boolean { return this.pending.length > 0; }

  admit(message: SessionMessage): SessionToolDeliveryStatus {
    if (!this.deps.runtime.acceptsIntents || !this.deps.isTargetAvailable()) {
      throw new Error('The target session is unavailable');
    }
    const starts = !this.hasPending && !this.dispatching && this.canDispatch;
    this.pending.push(message);
    this.wake();
    this.deps.runtime.publish('work');
    return starts ? 'started' : 'queued';
  }

  clear(): void {
    this.generation++;
    const discarded = this.pending.splice(0);
    if (discarded.length) {
      this.deps.onDiscard(discarded);
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
    if (this.dispatching || !this.canDispatch) return;
    this.dispatching = true;
    const generation = this.generation;
    const message = this.pending[0];
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
            this.pending.unshift(message);
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
