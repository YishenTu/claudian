import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { getClaudeInputMatch } from './ClaudeResponseOwnership';

/**
 * Native user sends owned by one requested Claude run: the prompt that started
 * it plus any steers handed to the live input stream while it runs.
 *
 * Claude folds a steer into the running native turn, or runs it as the next
 * native turn when the current one is already finishing. Either way the run
 * stays open until a result has consumed every send it owns.
 */
export class ClaudeTurnInputs {
  readonly #ids: string[] = [];
  readonly #unconsumed = new Set<string>();
  readonly #undeliveredSteers = new Set<string>();
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

  /** True once a result consumed every owned send, or nothing further is queued natively. */
  get settled(): boolean {
    return this.#settled;
  }

  addSteer(id: string): void {
    if (this.#settled) throw new Error('Claude Code turn inputs are already settled');
    this.#ids.push(id);
    this.#unconsumed.add(id);
    this.#undeliveredSteers.add(id);
  }

  /** Steers still waiting in Claude's command queue can run after an interrupt. */
  hasUndeliveredSteers(): boolean {
    return this.#undeliveredSteers.size > 0;
  }

  isUndeliveredSteer(id: string): boolean {
    return this.#undeliveredSteers.has(id);
  }

  wasConsumed(id: string): boolean {
    return this.#ids.includes(id) && !this.#unconsumed.has(id);
  }

  matches(message: SDKMessage): boolean | undefined {
    return getClaudeInputMatch(message, this.#ids);
  }

  /**
   * Records native delivery evidence and returns the steer ID that the
   * message delivered into the run, if any.
   */
  observe(message: SDKMessage): string | undefined {
    if (this.#settled) return undefined;
    const replayedId = getReplayedUserMessageId(message);
    if (replayedId && this.#undeliveredSteers.delete(replayedId)) {
      return replayedId;
    }
    if (message.type !== 'result' || this.matches(message) === false) return undefined;

    const consumed = message.user_message_uuids?.length
      ? message.user_message_uuids
      : message.user_message_uuid ? [message.user_message_uuid] : null;
    if (!consumed) {
      // Producers without consumption echoes end the run on its first result.
      this.#consumeAll();
      return undefined;
    }
    for (const id of consumed) {
      this.#unconsumed.delete(id);
      this.#undeliveredSteers.delete(id);
    }
    if (this.#unconsumed.size === 0 || (message.queued_turn_count ?? 0) === 0) {
      this.#settled = true;
    }
    return undefined;
  }

  #consumeAll(): void {
    this.#unconsumed.clear();
    this.#undeliveredSteers.clear();
    this.#settled = true;
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
