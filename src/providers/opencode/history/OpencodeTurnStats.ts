import { existsSync } from 'node:fs';

import { createTurnStats, isTokenCount, type TurnStats } from '@/core/types';

import { resolveExistingOpencodeDatabasePath } from '../runtime/OpencodePaths';
import type { OpencodeProviderState } from '../types';
import { loadOpencodeTurnRows, type OpencodeTurnSelector, type StoredRow } from './OpencodeSqliteReader';

/** Accumulates native metadata from a user entry through its assistant steps. */
export class OpencodeTurnStats {
  private startedAt: number | null = null;
  private outputTokens: number | undefined = 0;

  reset(): void {
    this.startedAt = null;
    this.outputTokens = 0;
  }

  add(info: StoredRow): TurnStats | undefined {
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

export async function loadOpencodeTurnStats(
  sessionId: string,
  state: OpencodeProviderState,
  selector: OpencodeTurnSelector,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TurnStats | undefined> {
  const databasePath = resolveExistingOpencodeDatabasePath(state.databasePath, environment);
  // Missing optional metadata cannot be recovered by trying other SQLite runtimes.
  if (!databasePath || databasePath === ':memory:' || !existsSync(databasePath)) return undefined;
  const rows = await loadOpencodeTurnRows(databasePath, sessionId, selector, { environment });
  const stats = new OpencodeTurnStats();
  let result: TurnStats | undefined;
  for (const row of rows) {
    if (row.data_valid === 0) {
      stats.reset();
      result = undefined;
      continue;
    }
    // Native control entries end the turn.
    if (row.role !== 'user' && row.role !== 'assistant') return result;
    result = stats.add({
      ...row,
      tokens: { output: row.output_tokens, reasoning: row.reasoning_tokens },
    });
  }
  return result;
}

export function getMessageCreatedAt(info: StoredRow): number | null {
  return number(object(info.time)?.created) ?? number(info.data_time_created) ?? number(info.time_created);
}

export function getMessageCompletedAt(info: StoredRow): number | null {
  return number(object(info.time)?.completed) ?? number(info.data_time_completed);
}

function object(value: unknown): StoredRow | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StoredRow : undefined;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
