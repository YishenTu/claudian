import {
  type ClaudeSessionTimeCandidate,
  selectClaudeSessionRecoveryCandidate,
} from '@/providers/claude/history/ClaudeSessionRecovery';

const candidates: ClaudeSessionTimeCandidate[] = [
  {
    sessionId: 'closest-start-wrong-end',
    firstTimestamp: 1_200,
    lastTimestamp: 40_000,
    hasAssistantMessage: true,
  },
  {
    sessionId: 'matching-session',
    firstTimestamp: 1_900,
    lastTimestamp: 10_500,
    hasAssistantMessage: true,
  },
];

describe('selectClaudeSessionRecoveryCandidate', () => {
  it('uses the start and end timestamps to identify a native transcript', () => {
    expect(selectClaudeSessionRecoveryCandidate(candidates, {
      createdAt: 1_000,
      lastActivityAt: 10_000,
    })).toBe('matching-session');
  });

  it('refuses candidates that remain temporally ambiguous', () => {
    expect(selectClaudeSessionRecoveryCandidate([
      {
        sessionId: 'first',
        firstTimestamp: 1_100,
        lastTimestamp: 10_100,
        hasAssistantMessage: true,
      },
      {
        sessionId: 'second',
        firstTimestamp: 1_200,
        lastTimestamp: 10_200,
        hasAssistantMessage: true,
      },
    ], {
      createdAt: 1_000,
      lastActivityAt: 10_000,
    })).toBeNull();
  });

  it('requires a strict and unique creation-time match without a response timestamp', () => {
    expect(selectClaudeSessionRecoveryCandidate([
      {
        sessionId: 'matching-session',
        firstTimestamp: 1_200,
        lastTimestamp: 2_000,
        hasAssistantMessage: false,
      },
      {
        sessionId: 'too-far',
        firstTimestamp: 20_000,
        lastTimestamp: 21_000,
        hasAssistantMessage: false,
      },
    ], {
      createdAt: 1_000,
    })).toBe('matching-session');
  });

  it('rejects a transcript outside the strict creation window even when activity matches', () => {
    expect(selectClaudeSessionRecoveryCandidate([
      {
        sessionId: 'unrelated',
        firstTimestamp: 12_000,
        lastTimestamp: 30_000,
        hasAssistantMessage: false,
      },
    ], {
      createdAt: 1_000,
      lastActivityAt: 30_000,
    })).toBeNull();
  });

  it('rejects a creation-only match after local-only activity', () => {
    expect(selectClaudeSessionRecoveryCandidate([
      {
        sessionId: 'matching-session',
        firstTimestamp: 1_200,
        lastTimestamp: 2_000,
        hasAssistantMessage: true,
      },
    ], {
      createdAt: 1_000,
      lastActivityAt: 10 * 60_000,
    })).toBeNull();
  });

  it('allows a wider creation window when assistant activity corroborates the transcript', () => {
    expect(selectClaudeSessionRecoveryCandidate([
      {
        sessionId: 'slow-start-session',
        firstTimestamp: 61_000,
        lastTimestamp: 90_000,
        hasAssistantMessage: true,
      },
    ], {
      createdAt: 1_000,
      lastActivityAt: 90_000,
    })).toBe('slow-start-session');
  });
});
