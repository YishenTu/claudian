import { createTurnStats, isTokenCount, type TurnStats } from '@/core/types';

import { readOpencodeHTTPMessagesBackward } from '../http/OpencodeHTTPHistory';
import type { OpencodeServerLease } from '../http/OpencodeServerService';

/** A native message record, as stored or as served by the native message API. */
type NativeRecord = Record<string, unknown>;

/** Accumulates native metadata from a user entry through its assistant steps. */
export class OpencodeTurnStats {
  private startedAt: number | null = null;
  private outputTokens: number | undefined = 0;

  reset(): void {
    this.startedAt = null;
    this.outputTokens = 0;
  }

  add(info: NativeRecord): TurnStats | undefined {
    if (info.role === 'user') {
      this.reset();
      this.startedAt = getMessageCreatedAt(info);
      return undefined;
    }
    if (info.role !== 'assistant') {
      this.reset();
      return undefined;
    }
    const tokens = object(info.tokens);
    const output = tokens?.output;
    const reasoning = tokens?.reasoning;
    if (!isTokenCount(output) || !isTokenCount(reasoning) || info.error) this.outputTokens = undefined;
    else if (this.outputTokens !== undefined) this.outputTokens += output + reasoning;
    const completedAt = getMessageCompletedAt(info);
    return (info.finish === 'stop' || info.finish === 'length') && this.startedAt !== null && completedAt !== null
      ? createTurnStats(this.outputTokens, completedAt - this.startedAt) : undefined;
  }
}

/** Selects a turn by its admitted user message, else the latest user entry since the prompt started. */
export interface OpencodeTurnSelector {
  userMessageId?: string | null;
  startedAt: number;
}

function isTurnStart(message: NativeRecord, selector: OpencodeTurnSelector): boolean {
  return selector.userMessageId
    ? message.id === selector.userMessageId
    : message.type === 'user' && (getMessageCreatedAt(message) ?? -Infinity) >= selector.startedAt;
}

/** Statistics for the selected turn of a native session's ordered messages. */
export function selectOpencodeTurnStats(messages: readonly NativeRecord[], selector: OpencodeTurnSelector): TurnStats | undefined {
  let start = messages.length - 1;
  while (start >= 0 && !isTurnStart(messages[start], selector)) start -= 1;
  if (start === -1) return undefined;
  const stats = new OpencodeTurnStats();
  let result: TurnStats | undefined;
  for (const [index, message] of messages.slice(start).entries()) {
    if (index > 0 && message.type === 'user') break;
    // Native control entries end the turn.
    if (message.type !== 'user' && message.type !== 'assistant') break;
    result = stats.add({ ...message, role: message.type });
  }
  return result;
}

/**
 * Reads the selected turn's statistics backward from the newest native message,
 * stopping at the turn's user boundary or at the first message created before
 * the prompt started, so earlier history is never requested.
 */
export async function readOpencodeTurnStats(
  client: Pick<OpencodeServerLease, 'request'>,
  sessionId: string,
  selector: OpencodeTurnSelector,
): Promise<TurnStats | undefined> {
  const newestFirst: NativeRecord[] = [];
  for await (const message of readOpencodeHTTPMessagesBackward(client, sessionId)) {
    newestFirst.push(message);
    if (isTurnStart(message, selector)) return selectOpencodeTurnStats(newestFirst.reverse(), selector);
    if ((getMessageCreatedAt(message) ?? Infinity) < selector.startedAt) return undefined;
  }
  return undefined;
}

export function getMessageCreatedAt(info: NativeRecord): number | null {
  return number(object(info.time)?.created) ?? number(info.time_created);
}

export function getMessageCompletedAt(info: NativeRecord): number | null {
  return number(object(info.time)?.completed);
}

function object(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : undefined;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
