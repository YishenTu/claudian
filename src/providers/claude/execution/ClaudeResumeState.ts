import type { ProviderNativeResumeSeed } from '../../../core/execution';
import type { ClaudeNativeResume } from './ClaudeExecutionRequestEncoder';

/** Persisted provider-state keys owned by the resume state. */
export interface ClaudeResumeStateStore {
  get(key: string): unknown;
  has(key: string): boolean;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/**
 * Native resume target, pending fork, and history-replay generation for one
 * Claude session. The session owns the persisted provider-state record; this
 * class writes only the keys that describe resume.
 */
export class ClaudeResumeState {
  private readonly initialProviderSessionId: string | null;
  private liveProviderSessionId: string | null;
  private resumeAt: string | undefined;
  private pendingFork: boolean;
  private replayHistoryOnNextTurn: boolean;
  private replayHistoryGeneration: number;

  constructor(
    seed: ProviderNativeResumeSeed | undefined,
    private readonly store: ClaudeResumeStateStore,
    private readonly nativePersistenceDisabled: boolean,
  ) {
    const forkSource = getValidForkSource(store.get('forkSource'));
    const persistedSessionId = store.get('providerSessionId');
    const establishedSessionId = seed?.providerSessionId
      ?? (typeof persistedSessionId === 'string'
        ? persistedSessionId
        : undefined);
    this.pendingFork = Boolean(forkSource && !establishedSessionId);
    const seedSessionId = establishedSessionId ?? forkSource?.sessionId;
    this.initialProviderSessionId = seedSessionId ?? null;
    this.liveProviderSessionId = this.pendingFork
      ? null
      : this.initialProviderSessionId;
    this.replayHistoryOnNextTurn = store.get('historyReplayPending') === true;
    this.replayHistoryGeneration = this.replayHistoryOnNextTurn ? 1 : 0;
    this.resumeAt = seed?.resumeCheckpoint ?? forkSource?.resumeAt;
  }

  get providerSessionId(): string | null {
    return this.liveProviderSessionId;
  }

  /** The generation a replaying turn clears on acceptance, or null when none is pending. */
  get pendingReplayGeneration(): number | null {
    return this.replayHistoryOnNextTurn ? this.replayHistoryGeneration : null;
  }

  getNativeResume(): ClaudeNativeResume {
    if (this.nativePersistenceDisabled && !this.pendingFork) {
      return {};
    }
    const nativeResumeSessionId = this.getNativeResumeSessionId();
    return {
      ...(nativeResumeSessionId
        ? { sessionId: nativeResumeSessionId }
        : {}),
      ...(this.resumeAt ? { resumeAt: this.resumeAt } : {}),
      ...(this.pendingFork ? { fork: true } : {}),
    };
  }

  getNativeResumeSessionId(): string | null {
    return this.liveProviderSessionId
      ?? (this.pendingFork ? this.initialProviderSessionId : null);
  }

  shouldReplayConversationHistory(hasHistory: boolean, nativeQueryOpen: boolean): boolean {
    if (!hasHistory) return false;
    if (this.nativePersistenceDisabled) {
      return !this.pendingFork && !nativeQueryOpen;
    }
    return !this.getNativeResumeSessionId()
      || this.replayHistoryOnNextTurn;
  }

  /** Records the session Claude reported; an unexpected switch schedules history replay. */
  capture(sessionId: string, activeRunNativeFork: boolean | undefined): void {
    if (this.nativePersistenceDisabled) {
      this.pendingFork = false;
      this.resumeAt = undefined;
      this.store.delete('forkSource');
      return;
    }
    const liveProviderSessionId = this.liveProviderSessionId;
    const previousProviderSessionId = liveProviderSessionId
      ?? this.initialProviderSessionId;
    const nativeFork = activeRunNativeFork ?? this.pendingFork;
    if (
      previousProviderSessionId
      && previousProviderSessionId !== sessionId
      && !nativeFork
    ) {
      if (liveProviderSessionId) {
        this.#markHistoryReplayPending();
      }
      const storedPriorIds = this.store.get('previousProviderSessionIds');
      const priorIds = Array.isArray(storedPriorIds)
        ? storedPriorIds.filter(
          (value): value is string => typeof value === 'string',
        )
        : [];
      this.store.set('previousProviderSessionIds', [
        ...new Set([...priorIds, previousProviderSessionId]),
      ]);
    }
    this.liveProviderSessionId = sessionId;
    this.store.set('providerSessionId', sessionId);
    this.resumeAt = undefined;
    this.pendingFork = false;
    if (this.store.has('forkSource')) {
      this.store.delete('forkSource');
    }
  }

  /** Returns whether the pending replay of that generation was cleared. */
  clearReplayPending(expectedGeneration: number): boolean {
    if (
      !this.replayHistoryOnNextTurn
      || this.replayHistoryGeneration !== expectedGeneration
    ) {
      return false;
    }
    this.replayHistoryOnNextTurn = false;
    this.store.delete('historyReplayPending');
    return true;
  }

  clearProviderSession(): void {
    this.liveProviderSessionId = null;
    this.store.delete('providerSessionId');
  }

  #markHistoryReplayPending(): void {
    this.replayHistoryOnNextTurn = true;
    this.replayHistoryGeneration += 1;
    this.store.set('historyReplayPending', true);
  }
}

function getValidForkSource(value: unknown): {
  sessionId: string;
  resumeAt: string;
} | null {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === 'string'
    && typeof record.resumeAt === 'string'
    ? {
      sessionId: record.sessionId,
      resumeAt: record.resumeAt,
    }
    : null;
}
