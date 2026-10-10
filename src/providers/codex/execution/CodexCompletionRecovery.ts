import type { ThreadReadResult } from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';

import type { CodexActiveRun } from './CodexActiveRun';

const MISSED_TURN_COMPLETION_GRACE_MS = 1_000;
const MISSED_TURN_COMPLETION_MAX_ATTEMPTS = 3;
const MISSED_TURN_COMPLETION_RETRY_BASE_MS = 500;
const THREAD_READ_RECOVERY_TIMEOUT_MS = 5_000;

interface RecoveryAttempt {
  readonly active: CodexActiveRun;
  readonly generation: number;
  attempt: number;
  inFlight: boolean;
  timer: number | null;
}

export interface CodexCompletionRecoveryHost {
  /** A newer lifecycle generation invalidates a pending recovery. */
  lifecycleGeneration(): number;
  activeRun(): CodexActiveRun | null;
  transport(): CodexRPCTransport | null;
  /** Delivers a recovered notification through normal notification handling. */
  replayNotification(method: string, params: unknown): void;
  /** Recovery gave up; the run cannot complete normally. */
  fail(active: CodexActiveRun, message: string): void;
}

/**
 * Recovers a turn completion that never arrived although the thread went idle,
 * by reading the thread and replaying the completed turn's items and completion.
 */
export class CodexCompletionRecovery {
  #recovery: RecoveryAttempt | null = null;

  constructor(private readonly host: CodexCompletionRecoveryHost) {}

  /** The run's thread became idle; its turn completion should follow within a grace period. */
  observeIdle(active: CodexActiveRun): void {
    let recovery = this.#recovery;
    const generation = this.host.lifecycleGeneration();
    if (!recovery || recovery.active !== active || recovery.generation !== generation) {
      this.cancel();
      recovery = { active, generation, attempt: 0, inFlight: false, timer: null };
      this.#recovery = recovery;
    }
    this.#schedule(recovery, MISSED_TURN_COMPLETION_GRACE_MS);
  }

  /** Recovery reads the native turn; a recovery that waited for its ID can now be scheduled. */
  turnObserved(active: CodexActiveRun): void {
    const recovery = this.#recovery;
    if (recovery?.active === active) {
      this.#schedule(recovery, MISSED_TURN_COMPLETION_GRACE_MS);
    }
  }

  cancel(): void {
    const recovery = this.#recovery;
    if (recovery && recovery.timer !== null) {
      window.clearTimeout(recovery.timer);
    }
    this.#recovery = null;
  }

  #schedule(recovery: RecoveryAttempt, delayMs: number): void {
    if (
      this.#recovery !== recovery
      || recovery.timer !== null
      || recovery.inFlight
      || !this.#isCurrent(recovery)
      || !recovery.active.nativeTurnId
    ) {
      return;
    }
    recovery.timer = window.setTimeout(() => {
      recovery.timer = null;
      void this.#recover(recovery);
    }, delayMs);
  }

  async #recover(recovery: RecoveryAttempt): Promise<void> {
    const { active } = recovery;
    const transport = this.host.transport();
    const threadId = active.nativeThreadId;
    const turnId = active.nativeTurnId;
    if (!transport || !threadId || !turnId || !this.#isCurrent(recovery)) {
      return;
    }
    recovery.attempt += 1;
    recovery.inFlight = true;

    let result: ThreadReadResult;
    try {
      result = await transport.request<ThreadReadResult>(
        'thread/read',
        { threadId, includeTurns: true },
        THREAD_READ_RECOVERY_TIMEOUT_MS,
      );
    } catch {
      recovery.inFlight = false;
      this.#retryOrFail(recovery);
      return;
    }
    if (!this.#isCurrent(recovery)) return;
    recovery.inFlight = false;
    const turn = result.thread.turns.find(candidate => candidate.id === turnId);
    if (result.thread.id !== threadId || !turn || turn.status === 'inProgress') {
      this.#retryOrFail(recovery);
      return;
    }
    for (const item of turn.items) {
      this.host.replayNotification('item/completed', { threadId, turnId: turn.id, item });
    }
    this.host.replayNotification('turn/completed', { threadId, turn });
  }

  #retryOrFail(recovery: RecoveryAttempt): void {
    if (!this.#isCurrent(recovery)) return;
    if (recovery.attempt < MISSED_TURN_COMPLETION_MAX_ATTEMPTS) {
      const retryDelay = MISSED_TURN_COMPLETION_RETRY_BASE_MS * (2 ** (recovery.attempt - 1));
      this.#schedule(recovery, retryDelay);
      return;
    }

    this.cancel();
    this.host.fail(recovery.active, 'Codex became idle, but its completed turn could not be recovered.');
  }

  #isCurrent(recovery: RecoveryAttempt): boolean {
    const { active, generation } = recovery;
    return (
      this.#recovery === recovery
      && this.host.activeRun() === active
      && !active.run.isTerminal
      && !active.run.isCancellationRequested
      && generation === this.host.lifecycleGeneration()
    );
  }
}
