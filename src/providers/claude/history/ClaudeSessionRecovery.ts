import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  isValidSessionId,
} from './sdkSessionPaths';

const TRANSCRIPT_CHUNK_SIZE = 64 * 1024;
const TRANSCRIPT_SCAN_CONCURRENCY = 16;
const RECOVERY_INDEX_TTL_MS = 5_000;
const MAX_CREATED_AT_DELTA_WITH_ACTIVITY_MS = 2 * 60_000;
const MAX_LAST_ACTIVITY_AT_DELTA_MS = 2 * 60_000;
const MAX_CREATED_AT_DELTA_MS = 10_000;
const MIN_UNIQUE_SCORE_GAP_MS = 5_000;

export interface ClaudeSessionTimeFingerprint {
  createdAt: number;
  lastActivityAt?: number;
}

export interface ClaudeSessionTimeCandidate {
  sessionId: string;
  firstTimestamp: number;
  lastTimestamp: number;
  hasAssistantMessage: boolean;
}

interface RecoveryIndexCacheEntry {
  expiresAt: number;
  candidates: Promise<ClaudeSessionTimeCandidate[]>;
}

const recoveryIndexCache = new Map<string, RecoveryIndexCacheEntry>();

export function selectClaudeSessionRecoveryCandidate(
  candidates: readonly ClaudeSessionTimeCandidate[],
  fingerprint: ClaudeSessionTimeFingerprint,
): string | null {
  const hasLastActivityAt = Number.isFinite(fingerprint.lastActivityAt)
    && fingerprint.lastActivityAt! > fingerprint.createdAt;
  if (hasLastActivityAt) {
    const activityMatches = candidates.flatMap((candidate) => {
      if (!candidate.hasAssistantMessage) return [];
      const createdAtDelta = Math.abs(candidate.firstTimestamp - fingerprint.createdAt);
      if (createdAtDelta > MAX_CREATED_AT_DELTA_WITH_ACTIVITY_MS) return [];
      const lastActivityAtDelta = Math.abs(
        candidate.lastTimestamp - fingerprint.lastActivityAt!,
      );
      if (lastActivityAtDelta > MAX_LAST_ACTIVITY_AT_DELTA_MS) return [];
      return [{ candidate, score: createdAtDelta + lastActivityAtDelta }];
    });
    return selectUniqueCandidate(activityMatches);
  }

  const creationMatches = candidates.flatMap((candidate) => {
    const createdAtDelta = Math.abs(candidate.firstTimestamp - fingerprint.createdAt);
    if (createdAtDelta > MAX_CREATED_AT_DELTA_MS) return [];
    return [{ candidate, score: createdAtDelta }];
  });
  return selectUniqueCandidate(creationMatches);
}

function selectUniqueCandidate(
  scoredCandidates: Array<{ candidate: ClaudeSessionTimeCandidate; score: number }>,
): string | null {
  const scored = scoredCandidates.sort((left, right) => left.score - right.score);
  if (scored.length === 0) return null;
  if (
    scored.length > 1
    && scored[1].score - scored[0].score < MIN_UNIQUE_SCORE_GAP_MS
  ) {
    return null;
  }
  return scored[0].candidate.sessionId;
}

export async function recoverSDKSessionIdByTime(
  vaultPath: string,
  fingerprint: ClaudeSessionTimeFingerprint,
  pathContext?: ProviderHistoryPathContext,
): Promise<string | null> {
  const projectPath = path.join(
    getSDKProjectsPath(pathContext),
    encodeVaultPathForSDK(vaultPath),
  );
  try {
    const candidates = await getRecoveryIndex(projectPath);
    return selectClaudeSessionRecoveryCandidate(candidates, fingerprint);
  } catch {
    return null;
  }
}

function getRecoveryIndex(projectPath: string): Promise<ClaudeSessionTimeCandidate[]> {
  const now = Date.now();
  const cached = recoveryIndexCache.get(projectPath);
  if (cached && cached.expiresAt > now) {
    return cached.candidates;
  }

  const candidates = buildRecoveryIndex(projectPath);
  recoveryIndexCache.set(projectPath, {
    expiresAt: now + RECOVERY_INDEX_TTL_MS,
    candidates,
  });
  void candidates.catch(() => {
    if (recoveryIndexCache.get(projectPath)?.candidates === candidates) {
      recoveryIndexCache.delete(projectPath);
    }
  });
  return candidates;
}

async function buildRecoveryIndex(
  projectPath: string,
): Promise<ClaudeSessionTimeCandidate[]> {
  const entries = await fs.readdir(projectPath, { withFileTypes: true });
  const transcriptPaths = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => path.join(projectPath, entry.name));
  const candidates: ClaudeSessionTimeCandidate[] = [];
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(TRANSCRIPT_SCAN_CONCURRENCY, transcriptPaths.length) },
    async () => {
      while (nextIndex < transcriptPaths.length) {
        const transcriptPath = transcriptPaths[nextIndex++];
        const candidate = await readSessionTimeCandidate(transcriptPath);
        if (candidate) candidates.push(candidate);
      }
    },
  );
  await Promise.all(workers);
  return candidates;
}

async function readSessionTimeCandidate(
  transcriptPath: string,
): Promise<ClaudeSessionTimeCandidate | null> {
  const sessionId = path.basename(transcriptPath, '.jsonl');
  if (!isValidSessionId(sessionId)) return null;

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(transcriptPath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return null;

    const firstLength = Math.min(size, TRANSCRIPT_CHUNK_SIZE);
    const lastStart = Math.max(0, size - TRANSCRIPT_CHUNK_SIZE);
    const lastLength = size - lastStart;
    const firstBuffer = Buffer.alloc(firstLength);
    const lastBuffer = Buffer.alloc(lastLength);
    await Promise.all([
      handle.read(firstBuffer, 0, firstLength, 0),
      lastStart === 0
        ? Promise.resolve()
        : handle.read(lastBuffer, 0, lastLength, lastStart),
    ]);

    const firstRecords = parseCompleteRecords(
      firstBuffer.toString('utf8'),
      firstLength === size,
      false,
    );
    const lastRecords = lastStart === 0
      ? firstRecords
      : parseCompleteRecords(lastBuffer.toString('utf8'), true, true);
    const observedSessionIds = new Set<string>();
    const timestamps: number[] = [];
    const sampledRecords = [...firstRecords, ...lastRecords];
    for (const record of sampledRecords) {
      if (typeof record.sessionId === 'string') {
        observedSessionIds.add(record.sessionId);
      }
      if (typeof record.timestamp === 'string') {
        const timestamp = Date.parse(record.timestamp);
        if (Number.isFinite(timestamp)) timestamps.push(timestamp);
      }
    }
    if (!observedSessionIds.has(sessionId) || timestamps.length === 0) return null;

    const firstTimestamp = firstTimestampFromRecords(firstRecords);
    const lastTimestamp = lastTimestampFromRecords(lastRecords);
    if (firstTimestamp === null || lastTimestamp === null) return null;
    return {
      sessionId,
      firstTimestamp,
      lastTimestamp,
      hasAssistantMessage: sampledRecords.some(({ type }) => type === 'assistant'),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseCompleteRecords(
  content: string,
  includesEndOfFile: boolean,
  beginsMidLine: boolean,
): Array<{ sessionId?: unknown; timestamp?: unknown; type?: unknown }> {
  let lines = content.split(/\r?\n/);
  if (beginsMidLine) lines = lines.slice(1);
  if (!includesEndOfFile) lines = lines.slice(0, -1);

  return lines.flatMap((line) => {
    if (!line) return [];
    try {
      return [JSON.parse(line) as {
        sessionId?: unknown;
        timestamp?: unknown;
        type?: unknown;
      }];
    } catch {
      return [];
    }
  });
}

function firstTimestampFromRecords(
  records: Array<{ timestamp?: unknown }>,
): number | null {
  for (const record of records) {
    if (typeof record.timestamp !== 'string') continue;
    const timestamp = Date.parse(record.timestamp);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

function lastTimestampFromRecords(
  records: Array<{ timestamp?: unknown }>,
): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const timestampValue = records[index].timestamp;
    if (typeof timestampValue !== 'string') continue;
    const timestamp = Date.parse(timestampValue);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}
