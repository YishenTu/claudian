import { createTurnStats, isTokenCount, type TurnStats } from '@/core/types';

import { resolveExistingOpencodeDatabasePath } from '../runtime/OpencodePaths';
import type { OpencodeProviderState } from '../types';
import { loadOpencodeTurnRows, type OpencodeTurnSelector, type StoredRow } from './OpencodeSqliteReader';

/** Native metadata only; v1 links every assistant step to its user. */
export class OpencodeTurnStats {
  private userId: string | undefined;
  private startedAt: number | null = null;
  private outputTokens: number | undefined = 0;

  reset(): void {
    this.userId = undefined;
    this.startedAt = null;
    this.outputTokens = 0;
  }

  add(info: StoredRow, version: 1 | 2): TurnStats | undefined {
    if (info.role === 'user') {
      this.reset();
      this.userId = typeof info.id === 'string' ? info.id : undefined;
      this.startedAt = getMessageCreatedAt(info);
      return undefined;
    }
    if (info.role !== 'assistant' || info.data_valid === 0) {
      this.reset();
      return undefined;
    }
    const tokens = object(info.tokens);
    const output = tokens?.output;
    const reasoning = tokens?.reasoning;
    if (!isTokenCount(output) || !isTokenCount(reasoning) || info.error
      || (version === 1 && info.parentID !== this.userId)) this.outputTokens = undefined;
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
  if (!databasePath || databasePath === ':memory:') return undefined;
  const rows = await loadOpencodeTurnRows(databasePath, sessionId, selector, {
    environment, nativeVersion: state.nativeVersion === 2 ? 2 : 'auto',
  });
  const stats = new OpencodeTurnStats();
  let result: TurnStats | undefined;
  for (const row of rows.messageRows) {
    if (row.data_valid === 0) {
      stats.reset();
      result = undefined;
      continue;
    }
    if (row.role !== 'user' && row.role !== 'assistant') {
      if (rows.nativeVersion === 2) return result;
      continue;
    }
    result = stats.add({
      ...row,
      parentID: row.parent_id,
      tokens: { output: row.output_tokens, reasoning: row.reasoning_tokens },
    }, rows.nativeVersion === 2 ? 2 : 1);
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
