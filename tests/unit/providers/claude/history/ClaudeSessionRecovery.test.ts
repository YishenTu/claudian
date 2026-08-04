import {
  type ClaudeSessionTimeCandidate,
  selectClaudeSessionRecoveryCandidate,
} from '@/providers/claude/history/ClaudeSessionRecovery';

const candidates: ClaudeSessionTimeCandidate[] = [
  {
    sessionId: 'closest-start-wrong-end',
    firstTimestamp: 1_200,
    lastTimestamp: 40_000,
  },
  {
    sessionId: 'matching-session',
    firstTimestamp: 1_900,
    lastTimestamp: 10_500,
  },
];

describe('selectClaudeSessionRecoveryCandidate', () => {
  it('uses the start and end timestamps to identify a native transcript', () => {
    expect(selectClaudeSessionRecoveryCandidate(candidates, {
      createdAt: 1_000,
      lastResponseAt: 10_000,
    })).toBe('matching-session');
  });

  it('refuses candidates that remain temporally ambiguous', () => {
    expect(selectClaudeSessionRecoveryCandidate([
      { sessionId: 'first', firstTimestamp: 1_100, lastTimestamp: 10_100 },
      { sessionId: 'second', firstTimestamp: 1_200, lastTimestamp: 10_200 },
    ], {
      createdAt: 1_000,
      lastResponseAt: 10_000,
    })).toBeNull();
  });

  it('requires a strict and unique creation-time match without a response timestamp', () => {
    expect(selectClaudeSessionRecoveryCandidate([
      { sessionId: 'matching-session', firstTimestamp: 1_200, lastTimestamp: 2_000 },
      { sessionId: 'too-far', firstTimestamp: 20_000, lastTimestamp: 21_000 },
    ], {
      createdAt: 1_000,
    })).toBe('matching-session');
  });
});
