import type { ProviderExecutionSession } from '@/core/execution/ProviderExecutionSession';
import {
  isRewindableExecutionSession,
  isSteerableExecutionSession,
} from '@/core/execution/RewindableExecutionSession';

describe('optional execution session capabilities', () => {
  it('detects supported operations at the provider boundary', () => {
    const base = {} as ProviderExecutionSession;
    const rewindable = { ...base, previewRewind: jest.fn(), rewind: jest.fn() };
    const steerable = { ...base, steer: jest.fn() };

    expect(isRewindableExecutionSession(base)).toBe(false);
    expect(isSteerableExecutionSession(base)).toBe(false);
    expect(isRewindableExecutionSession(rewindable)).toBe(true);
    expect(isSteerableExecutionSession(steerable)).toBe(true);
  });
});
