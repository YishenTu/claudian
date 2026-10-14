import type { SessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { SessionToolSendMode, SessionToolSendStatus } from '@/core/session-tools/sessionToolSpecs';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { SessionModel } from '@/features/chat/sessions/SessionModel';
import type { TurnCancelReason } from '@/features/chat/turns/TurnCoordinator';
import { throwIfAborted } from '@/utils/abort';

export type SessionMessageUnsentReason = TurnCancelReason | 'failed' | 'deferred' | 'deleted' | 'archived';

export class SessionMessageDeferredError extends Error {}

interface MailboxEntry {
  readonly message: SessionMessage;
  /** Holds its place without dispatching until admitted and, for an interrupt, stopped. */
  held: boolean;
  /** Queue order: interrupts first, newest first, then ordinary entries in admission order. */
  readonly rank: number;
}

/** The held entry's side of a selection switch that must commit before the message is admitted. */
export interface SessionMessageAdmission {
  /** False once the entry was discarded or the recipient became unavailable. */
  readonly isCurrent: boolean;
  /** Admits the entry; call it inside the switch's commit. */
  commit(): void;
}

export interface SessionMessageDelivery {
  /** Null only for an interrupt that just stops the recipient. */
  readonly message: SessionMessage | null;
  /** Omitted for a queued message. */
  readonly mode?: SessionToolSendMode;
  readonly signal: AbortSignal;
  /**
   * Commits a sticky selection switch while the message holds its place, calling `commit` inside it.
   * Rejecting withdraws the message: nothing is admitted, stopped or delivered.
   */
  readonly commitSwitch?: (admission: SessionMessageAdmission) => Promise<void>;
}

/**
 * Recipient-owned delivery of session messages: queue order, steering into a running turn, and
 * interrupts. User input and the existing execution owners decide when a queued message can start.
 */
export class SessionMailbox {
  private readonly pending: MailboxEntry[] = [];
  private generation = 0;
  private admissions = 0;
  private dispatching = false;

  constructor(private readonly deps: {
    runtime: ChatSessionRuntime;
    isTargetAvailable(): boolean;
    onDiscard(messages: readonly SessionMessage[]): void;
  }) {}

  get hasPending(): boolean { return this.pending.length > 0; }

  async deliver({ message, mode, signal, commitSwitch }: SessionMessageDelivery): Promise<SessionToolSendStatus> {
    if (mode === 'steer' && message) {
      const model = this.deps.runtime.peekModel;
      const steered = model ? await model.inputController.steerSessionMessage(message, signal) : 'not-sent';
      if (steered === 'accepted') return 'steered';
      if (steered === 'uncertain') return 'uncertain';
      // With no turn to join, the message is queued like a normal send.
      throwIfAborted(signal, 'Session tool call was cancelled');
    }
    if (!message) return this.stop() ? 'interrupted' : 'idle';
    if (!this.isAvailable) throw new Error('The target session is unavailable');

    const admission = ++this.admissions;
    const entry: MailboxEntry = { message, held: true, rank: mode === 'interrupt' ? -admission : admission };
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.pending.includes(entry) && this.isAvailable;
    // Admission and release are separate: the entry stays held until an interrupt's stop has run,
    // so a hydration finishing in between cannot start it only for the stop to cancel it.
    let admitted = false;
    const commit = () => {
      if (admitted || !isCurrent()) throw new Error('Session message reservation was discarded');
      admitted = true;
    };
    this.insert(entry);
    this.notify();
    try {
      if (commitSwitch) await commitSwitch({ get isCurrent() { return isCurrent(); }, commit });
      else commit();
      if (!admitted) throw new Error('The session or its selection changed before message admission');
    } catch (error) {
      if (admitted) entry.held = false;
      else this.remove(entry);
      this.notify();
      throw error;
    }
    // Stopped only once admitted, so a rejected send changes nothing; the entry is already first.
    const interrupted = mode === 'interrupt' && this.stop();
    entry.held = false;
    const starts = isCurrent() && this.pending[0] === entry && !this.dispatching && this.canDispatch;
    this.notify();
    return interrupted ? 'interrupted' : starts ? 'started' : 'queued';
  }

  clear(): void {
    this.generation++;
    const discarded = this.pending.splice(0);
    if (discarded.length) {
      this.deps.onDiscard(discarded.map(entry => entry.message));
      this.deps.runtime.publish('work');
    }
  }

  wake(): void {
    if (!this.hasPending) return;
    if (!this.isAvailable) {
      this.clear();
      return;
    }
    if (this.dispatching || this.pending[0].held || !this.canDispatch) return;
    this.dispatching = true;
    const generation = this.generation;
    let entry: MailboxEntry | undefined;
    let dispositionReported = false;
    void this.deps.runtime.withModel(async model => {
      if (generation !== this.generation) return;
      if (!this.deps.isTargetAvailable()) { this.clear(); return; }
      // Chosen once the model is ready, so nothing admitted while it hydrated is overtaken.
      const head = this.pending[0];
      if (!head || head.held || !this.canDispatch) return;
      entry = head;
      this.remove(head);
      await model.inputController.sendSessionMessage(head.message, {
        assertBeforeHandoff: () => {
          if (generation !== this.generation || !this.isAvailable) {
            throw new Error('Session message delivery was cancelled');
          }
          if (this.hasCompetingWork(model)) throw new SessionMessageDeferredError('The recipient has competing work');
        },
        onUnsent: reason => {
          if (dispositionReported) return;
          dispositionReported = true;
          if (reason === 'deferred' && generation === this.generation && this.isAvailable) {
            this.insert(head);
          } else this.deps.onDiscard([head.message]);
        },
      });
    }).catch(() => {
      if (generation !== this.generation || dispositionReported) return;
      // A model that cannot hydrate fails its head entry rather than retrying it forever.
      const failed = entry ?? (this.pending[0]?.held === false ? this.pending[0] : undefined);
      if (!failed) return;
      this.remove(failed);
      this.deps.onDiscard([failed.message]);
    }).finally(() => {
      this.dispatching = false;
      this.deps.runtime.publish('work');
      this.wake();
    });
  }

  private get isAvailable(): boolean {
    return this.deps.runtime.acceptsIntents && this.deps.isTargetAvailable();
  }

  /** Work that defers a session message: checked when one is picked and again at provider handoff. */
  private hasCompetingWork(model: SessionModel | null): boolean {
    const runtime = this.deps.runtime;
    return !runtime.admitsConversationOperations || runtime.hasBackgroundWork || runtime.hasPendingInteraction
      || !!model?.conversationController.hasBranchDraft;
  }

  private get canDispatch(): boolean {
    const runtime = this.deps.runtime;
    const model = runtime.peekModel;
    return !this.hasCompetingWork(model) && !runtime.turns.isActive
      && (!model || model.inputController.canStartSessionMessage);
  }

  /** Stops the recipient's main work as the user's Stop would, keeping waiting messages; whether anything ran. */
  private stop(): boolean {
    const runtime = this.deps.runtime;
    const model = runtime.peekModel;
    const running = runtime.hasActiveTurn || runtime.hasMainBackgroundWork || !!model?.inputController.isPreparingMainTurn;
    if (model) model.inputController.interruptForSessionMessage();
    else runtime.stopMainBackgroundWork();
    return running;
  }

  /** Also how a deferred entry returns: to its own place, not the front. */
  private insert(entry: MailboxEntry): void {
    const index = this.pending.findIndex(candidate => candidate.rank > entry.rank);
    this.pending.splice(index === -1 ? this.pending.length : index, 0, entry);
  }

  private remove(entry: MailboxEntry): void {
    const index = this.pending.indexOf(entry);
    if (index !== -1) this.pending.splice(index, 1);
  }

  private notify(): void {
    this.wake();
    // Publication cannot reject an admission that already committed.
    try { this.deps.runtime.publish('work'); } catch { /* The session still owns the entry. */ }
  }
}
