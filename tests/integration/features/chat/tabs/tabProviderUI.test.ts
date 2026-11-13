import type { UsageInfo } from '@/core/types';
import { refreshTabContextUsage } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

describe('tab context usage projection', () => {
  it.each([
    { reportedWindow: 0, expected: null },
    { reportedWindow: 200_000, expected: expect.objectContaining({ contextWindow: 200_000, percentage: 25 }) },
  ])('shows only a provider-reported window ($reportedWindow)', ({ reportedWindow, expected }) => {
    const usage: UsageInfo = {
      model: 'claude-fable-5',
      inputTokens: 50_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      contextTokens: 50_000,
      contextWindow: reportedWindow,
      percentage: 0,
    };
    const update = vi.fn();
    const tab = { state: { usage }, ui: { contextUsageMeter: { update } } } as unknown as AssembledTabRuntime;

    refreshTabContextUsage(tab);

    expect(update).toHaveBeenLastCalledWith(expected);
  });
});
