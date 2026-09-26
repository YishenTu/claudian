import '@/providers';

import type { ClaudianSettings, UsageInfo } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { refreshTabContextUsage } from '@/features/chat/tabs/TabProviderState';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

function createTab(model: string, customContextLimits: Record<string, number>, usageOverrides: Partial<UsageInfo> = {}) {
  const usage: UsageInfo = {
    model,
    inputTokens: 50_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextTokens: 50_000,
    contextWindow: 0,
    percentage: 0,
    ...usageOverrides,
  };
  const update = jest.fn();
  const tab = {
    conversationId: null,
    providerId: 'claude',
    draftModel: model,
    state: { usage },
    ui: { contextUsageMeter: { update } },
  } as unknown as AssembledTabRuntime;
  const plugin = {
    getCommittedSettings: () => plugin.settings,
    settings: {
      model,
      customContextLimits,
      providerConfigs: { claude: { enabled: true, discoveredModels: [], visibleModels: [] } },
    } as unknown as ClaudianSettings,
  } as ChatFeatureHost;
  return { tab, plugin, update };
}

describe('tab context usage projection', () => {
  it.each<{ model: string; limits: Record<string, number> }>([
    { model: 'claude-fable-5', limits: { fable: 500_000 } },
    { model: 'claude-code/claude-fable-5', limits: { fable: 500_000 } },
    { model: 'fable', limits: { 'claude-code/claude-fable-5': 500_000 } },
  ])('does not borrow custom limits through retired Claude aliases for $model', ({ model, limits }) => {
    const { tab, plugin, update } = createTab(model, limits);

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(null);
    expect(tab.state.usage).toMatchObject({ contextWindow: 0, percentage: 0 });
  });

  it('uses an exact custom-limit key without interpreting retired aliases', () => {
    const { tab, plugin, update } = createTab('claude-fable-5', {
      'claude-fable-5': 100_000,
      fable: 500_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 100_000, percentage: 50 }));
  });

  it('rejects ambiguous equivalent custom-limit keys', () => {
    const { tab, plugin, update } = createTab('claude-fable-5', {
      'CLAUDE-FABLE-5': 500_000,
      'claude-code/CLAUDE-FABLE-5': 100_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(null);
  });

  it('uses a reported window even when custom limits belong to another model', () => {
    const { tab, plugin, update } = createTab('claude-fable-5', { fable: 500_000 }, {
      contextWindow: 200_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 200_000, percentage: 25 }));
  });

  it.each([
    { model: 'claude-fable-5', reportedModel: 'fable' },
    { model: 'sonnet[1m]', reportedModel: 'sonnet' },
  ])('does not transfer a report from $reportedModel to $model', ({ model, reportedModel }) => {
    const { tab, plugin, update } = createTab(model, {}, {
      model: reportedModel,
      contextWindow: 200_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(null);
  });
});
