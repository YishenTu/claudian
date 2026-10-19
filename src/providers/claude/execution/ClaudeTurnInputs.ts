import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { getClaudeInputMatch } from './ClaudeResponseOwnership';

/** Acceptance of one steer handed to native input, settled by its delivery evidence. */
export interface ClaudeSteerDelivery {
  readonly content: string;
  resolve(accepted: boolean): void;
  reject(error: Error): void;
}

/**
 * Native user sends owned by one requested Claude run: the prompt that started
 * it plus any steers handed to the live input stream while it runs.
 *
 * Claude folds a steer into the running native turn, or runs it as the next
 * native turn when the current one is already finishing. Either way the run
 * stays open until a result has consumed every send it owns. Each steer is
 * accepted once Claude replays or consumes it; one still waiting when the run
 * is abandoned has unknown delivery.
 */
export class ClaudeTurnInputs {
  readonly #ids: string[] = [];
  readonly #unconsumed = new Set<string>();
  readonly #undeliveredSteers = new Map<string, ClaudeSteerDelivery>();
  #abandoned = false;
  #reportsSessionState = false;
  #awaitingIdle = false;
  #settled = false;

  constructor(primaryId: string) {
    this.#ids.push(primaryId);
    this.#unconsumed.add(primaryId);
  }

  get primaryId(): string {
    return this.#ids[0];
  }

  get ids(): readonly string[] {
    return this.#ids;
  }

  /** True once a result consumed every owned send, or Claude finished without consuming the rest. */
  get settled(): boolean {
    return this.#settled;
  }

  addSteer(id: string, delivery: ClaudeSteerDelivery): void {
    if (this.#settled) throw new Error('Claude Code turn inputs are already settled');
    this.#ids.push(id);
    this.#unconsumed.add(id);
    this.#undeliveredSteers.set(id, delivery);
  }

  /** Steers still waiting in Claude's command queue can run after an interrupt. */
  hasUndeliveredSteers(): boolean {
    return this.#undeliveredSteers.size > 0;
  }

  matches(message: SDKMessage): boolean | undefined {
    return getClaudeInputMatch(message, this.#ids);
  }

  /**
   * Accepts the steer a native replay delivered into the run and returns its
   * content for the transcript boundary, or undefined when the replay is not
   * an undelivered steer of a live run.
   */
  deliver(id: string): string | undefined {
    const delivery = this.#undeliveredSteers.get(id);
    if (!delivery || this.#abandoned) return undefined;
    this.#undeliveredSteers.delete(id);
    delivery.resolve(true);
    return delivery.content;
  }

  /** The run ended: handed-off input with unknown delivery must not be resent as unsent. */
  abandon(): void {
    if (this.#abandoned) return;
    this.#abandoned = true;
    // Entries stay: Claude's command queue still holds them for interrupt handling.
    for (const delivery of this.#undeliveredSteers.values()) {
      delivery.reject(new Error('Claude Code run ended before the steer was delivered.'));
    }
  }

  /** Records native consumption and turn-over evidence. Replays are delivered through `deliver`. */
  observe(message: SDKMessage): void {
    if (this.#settled) return;
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      this.#reportsSessionState = true;
      if (message.state === 'idle' && this.#awaitingIdle) this.#settled = true;
      return;
    }
    if (message.type !== 'result' || this.matches(message) === false) return;

    // Only the consumption list proves delivery on an error result: failed-delivery
    // and session-scoped errors omit it while still naming or ending the turn.
    const confirms = Boolean(message.user_message_uuids?.length)
      || (message.subtype === 'success' && !message.is_error);
    const consumed = message.user_message_uuids?.length
      ? message.user_message_uuids
      : message.user_message_uuid ? [message.user_message_uuid] : null;
    if (!consumed) {
      // Producers without consumption echoes end the run on its first result.
      for (const id of this.#unconsumed) this.#consume(id, confirms);
      this.#settled = true;
      return;
    }
    for (const id of consumed) this.#consume(id, confirms);
    if (this.#unconsumed.size === 0) {
      this.#settled = true;
    } else if (this.#reportsSessionState) {
      // queued_turn_count stays 0 while a steer waits to run as the next native
      // turn; going idle is Claude's authoritative turn-over signal.
      this.#awaitingIdle = true;
    } else if ((message.queued_turn_count ?? 0) === 0) {
      this.#settled = true;
    }
  }

  /** Confirmed consumption without a replay is still definite; history supplies the message. */
  #consume(id: string, confirms: boolean): void {
    this.#unconsumed.delete(id);
    const delivery = this.#undeliveredSteers.get(id);
    if (!delivery || !confirms) return;
    this.#undeliveredSteers.delete(id);
    if (!this.#abandoned) delivery.resolve(true);
  }
}

/** A replay is Claude's acknowledgement that it took a streamed user send into a turn. */
export function getReplayedUserMessageId(message: SDKMessage): string | undefined {
  return message.type === 'user'
    && 'isReplay' in message
    && message.isReplay === true
    && message.parent_tool_use_id === null
    ? message.uuid
    : undefined;
}
