import '@/providers';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

function createStorage(initial: Record<string, unknown>) {
  let content = JSON.stringify(initial);
  const adapter = {
    exists: jest.fn(async () => Boolean(content)),
    read: jest.fn(async () => content),
    write: jest.fn(async (_path: string, value: string) => { content = value; }),
    delete: jest.fn(async () => undefined),
  } as unknown as VaultFileAdapter;
  return {
    adapter,
    storage: new ClaudianSettingsStorage(adapter),
    read: () => JSON.parse(content) as Record<string, any>,
  };
}

describe('Claude effort metadata migration', () => {
  it('leaves missing metadata for native startup discovery instead of filling a hardcoded table', async () => {
    const { storage, read } = createStorage({
      effortLevel: 'xhigh',
      providerConfigs: { claude: {
        visibleModels: ['haiku', 'opus', 'claude-fable-5-1[1m]'],
        selectedModels: [
          { value: 'haiku', label: 'Haiku', description: '', resolvedModel: 'claude-haiku-4-5' },
          { value: 'opus', label: 'Opus', description: '', resolvedModel: 'claude-opus-5-5' },
          { value: 'claude-fable-5-1[1m]', label: 'Fable', description: '', resolvedModel: 'claude-fable-5-1' },
        ],
      } },
    });

    const loaded = await storage.load();

    const stored = read().providerConfigs.claude;
    expect(stored.effortMetadataMigrated).toBeUndefined();
    expect(stored.selectedModels.map((model: any) => [model.value, model.supportedEffortLevels])).toEqual([
      ['haiku', undefined],
      ['opus', undefined],
      ['claude-fable-5-1[1m]', undefined],
    ]);
    expect(read().effortLevel).toBe('xhigh');
    expect(getClaudeProviderSettings(loaded).discoveredModels[1].supportedEffortLevels).toBeUndefined();
  });

  it('removes the retired completion flag without treating missing metadata as complete', async () => {
    const { storage, read, adapter } = createStorage({
      providerConfigs: { claude: { effortMetadataMigrated: true, visibleModels: ['haiku'], selectedModels: [
        { value: 'haiku', label: 'Haiku', description: '' },
      ] } },
    });
    await storage.load();
    expect(read().providerConfigs.claude.effortMetadataMigrated).toBeUndefined();

    const settings = read();
    settings.providerConfigs.claude.visibleModels = ['claude-sonnet-5'];
    settings.providerConfigs.claude.selectedModels = [
      { value: 'claude-sonnet-5', label: 'Sonnet', description: '', supportedEffortLevels: [] },
    ];
    await (adapter.write as jest.Mock)('', JSON.stringify(settings));
    const reloaded = await storage.load();

    expect(getClaudeProviderSettings(reloaded).discoveredModels[0].supportedEffortLevels).toEqual([]);
  });
});
