import { getUsageGuardBlock, setUsageGuardBlock } from '@/core/usageGuard/UsageGuardState';

describe('UsageGuardState', () => {
  afterEach(() => {
    setUsageGuardBlock(null);
  });

  it('starts unblocked', () => {
    expect(getUsageGuardBlock()).toBeNull();
  });

  it('stores and clears a block state', () => {
    setUsageGuardBlock({ reason: 'paused at 92%' });
    expect(getUsageGuardBlock()).toEqual({ reason: 'paused at 92%' });

    setUsageGuardBlock(null);
    expect(getUsageGuardBlock()).toBeNull();
  });
});
