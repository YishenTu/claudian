import * as fs from 'node:fs/promises';

import { createTurnStats, isTokenCount, type TurnStats } from '@/core/types';

import type { ClaudeConfigDirContext } from '../config/ClaudeConfigDir';
import { getSDKSessionPath } from './ClaudeHistoryPathResolver';
import { filterActiveBranch } from './sdkBranchFilter';
import type { SDKNativeMessage } from './sdkHistoryTypes';
import {
  getSDKUserMessageTimestamp,
  isCanonicalSDKUserMessage,
  isQueuedPromptAttachment,
  isSystemInjectedMessage,
} from './sdkMessageParsing';

/** Finalized JSONL response IDs may occur in several content-block records. */
export class ClaudeTurnStats {
  private readonly tokens = new Map<string, number>();
  private complete = true;
  private stopReason: string | null | undefined;

  add(record: SDKNativeMessage): void {
    const id = record.message?.id;
    const output = record.message?.usage?.output_tokens;
    if (!id || !isTokenCount(output)) this.complete = false;
    else this.tokens.set(id, output);
    this.stopReason = record.message?.stop_reason;
  }

  finish(startedAt: number | undefined, completedAt: number | undefined): TurnStats | undefined {
    if (!this.complete || this.tokens.size === 0
      || !['end_turn', 'max_tokens', 'stop_sequence'].includes(this.stopReason ?? '')) return undefined;
    return createTurnStats([...this.tokens.values()].reduce((sum, count) => sum + count, 0),
      startedAt !== undefined && completedAt !== undefined ? completedAt - startedAt : undefined);
  }
}

/** Read backwards only to this turn's user; never hydrate messages or subagents. */
export async function loadClaudeTurnStats(
  vaultPath: string,
  sessionId: string,
  assistantId: string,
  context?: ClaudeConfigDirContext,
): Promise<TurnStats | undefined> {
  const file = await fs.open(getSDKSessionPath(vaultPath, sessionId, context), 'r');
  try {
    const records: SDKNativeMessage[] = [];
    let foundAssistant = false;
    let measure: ((followedAt: string | undefined) => TurnStats | undefined) | null = null;
    // A folded queued prompt is timed from the record it follows, through any consecutive folds.
    const queuedPrompts: SDKNativeMessage[] = [];
    for await (const record of readBackwards(file)) {
      if (record.isSidechain) continue;
      if (measure) {
        if (record.uuid !== queuedPrompts.at(-1)?.parentUuid) continue;
        if (isQueuedPromptAttachment(record) && record.parentUuid) {
          queuedPrompts.push(record);
          continue;
        }
        return measure(record.timestamp);
      }
      if (record.uuid === assistantId) foundAssistant = true;
      const isUser = (record.type === 'user' && !isSystemInjectedMessage(record))
        || (record.type === 'attachment' && record.attachment?.commandMode === 'prompt');
      if (foundAssistant) records.push(record);
      if (isUser) {
        if (!foundAssistant || !isCanonicalSDKUserMessage(record)) return undefined;
        const branch = filterActiveBranch(records.reverse(), assistantId);
        if (!branch.includes(record)) return undefined;
        const stats = new ClaudeTurnStats();
        let completedAt: number | undefined;
        for (const entry of branch) {
          if (entry.type === 'system' && entry.subtype === 'compact_boundary') return undefined;
          if (entry.type !== 'assistant' || entry.message?.model === '<synthetic>') continue;
          stats.add(entry);
          completedAt = timestamp(entry.timestamp);
        }
        measure = followedAt => {
          let startedAt = followedAt;
          for (const queued of queuedPrompts.reverse()) startedAt = getSDKUserMessageTimestamp(queued, startedAt);
          return stats.finish(timestamp(startedAt), completedAt);
        };
        if (!isQueuedPromptAttachment(record) || !record.parentUuid) return stats.finish(timestamp(record.timestamp), completedAt);
        queuedPrompts.push(record);
      }
    }
    return measure?.(undefined);
  } finally {
    await file.close();
  }
}

async function* readBackwards(file: fs.FileHandle): AsyncGenerator<SDKNativeMessage> {
  let position = (await file.stat()).size;
  let fragments: Buffer[] = [];
  while (position > 0) {
    const length = Math.min(position, 16 * 1024);
    position -= length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await file.read(chunk, 0, length, position);
    if (bytesRead !== length) return;
    let end = chunk.length;
    for (let index = chunk.lastIndexOf(10, end - 1); index >= 0; index = chunk.lastIndexOf(10, end - 1)) {
      const line = Buffer.concat([chunk.subarray(index + 1, end), ...fragments.reverse()]).toString('utf8').trim();
      fragments = [];
      if (line) yield JSON.parse(line) as SDKNativeMessage;
      end = index;
      if (end === 0) break;
    }
    if (end > 0) fragments.push(chunk.subarray(0, end));
  }
  const line = Buffer.concat(fragments.reverse()).toString('utf8').trim();
  if (line) yield JSON.parse(line) as SDKNativeMessage;
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
