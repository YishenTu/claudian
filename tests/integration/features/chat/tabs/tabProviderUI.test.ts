import '@/providers';

import { createTabSession } from '@test/helpers/ConversationPorts';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';

import type { UsageInfo } from '@/core/types';
import { refreshTabContextUsage } from '@/features/chat/tabs/tabProviderUI';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';

async function createTab(model: string, customContextLimits: Record<string, number>, usageOverrides: Partial<UsageInfo> = {}) {
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
  const update = vi.fn();
  const tab = {
    conversationId: null,
    providerId: 'claude',
    draftModel: model,
    state: { usage },
    ui: { contextUsageMeter: { update } },
  } as unknown as AssembledTabRuntime;
  Object.assign(tab, { session: createTabSession({ id: 'test', lifecycleState: 'open', conversationId: null, providerId: 'claude', draftModel: model }, {} as never) });
  const plugin = await createChatFeatureHost({
    settings: {
      model,
      customContextLimits,
      providerConfigs: { claude: { enabled: true, discoveredModels: [], visibleModels: [] } },
    },
  });
  return { tab, plugin, update };
}

describe('tab context usage projection', () => {
  it.each<{ model: string; limits: Record<string, number> }>([
    { model: 'claude-fable-5', limits: { fable: 500_000 } },
    { model: 'claude-code/claude-fable-5', limits: { fable: 500_000 } },
    { model: 'fable', limits: { 'claude-code/claude-fable-5': 500_000 } },
  ])('does not borrow custom limits through retired Claude aliases for $model', async ({ model, limits }) => {
    const { tab, plugin, update } = await createTab(model, limits);

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(null);
    expect(tab.state.usage).toMatchObject({ contextWindow: 0, percentage: 0 });
  });

  it('uses an exact custom-limit key without interpreting retired aliases', async () => {
    const { tab, plugin, update } = await createTab('claude-fable-5', {
      'claude-fable-5': 100_000,
      fable: 500_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 100_000, percentage: 50 }));
  });

  it('rejects ambiguous equivalent custom-limit keys', async () => {
    const { tab, plugin, update } = await createTab('claude-fable-5', {
      'CLAUDE-FABLE-5': 500_000,
      'claude-code/CLAUDE-FABLE-5': 100_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(null);
  });

  it('uses a reported window even when custom limits belong to another model', async () => {
    const { tab, plugin, update } = await createTab('claude-fable-5', { fable: 500_000 }, {
      contextWindow: 200_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 200_000, percentage: 25 }));
  });

  it.each([
    { model: 'claude-fable-5', reportedModel: 'fable' },
    { model: 'sonnet[1m]', reportedModel: 'sonnet' },
  ])('keeps the report from $reportedModel when $model is selected', async ({ model, reportedModel }) => {
    const { tab, plugin, update } = await createTab(model, {}, {
      model: reportedModel,
      contextWindow: 200_000,
    });

    refreshTabContextUsage(tab, plugin);

    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ model: reportedModel, contextWindow: 200_000, percentage: 25 }));
  });
});
