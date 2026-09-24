import { projectClaudeModelSettings } from '@/providers/claude/modelPersistence';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

describe('projectClaudeModelSettings', () => {
  it('persists reported effort levels only for selected models and restores them', () => {
    const settings = { providerConfigs: { claude: {
      discoveredModels: [
        { value: 'opus', label: 'Opus', description: '', supportedEffortLevels: ['low', 'high', 'xhigh'] },
        { value: 'haiku', label: 'Haiku', description: '', supportedEffortLevels: ['low', 'high'] },
      ],
      visibleModels: ['opus'],
    } } };

    const persisted = projectClaudeModelSettings(settings);

    expect(persisted.discoveredModels).toBeUndefined();
    expect(persisted.selectedModels).toEqual([
      { value: 'opus', label: 'Opus', description: '', supportedEffortLevels: ['low', 'high', 'xhigh'] },
    ]);
    const restored = getClaudeProviderSettings({ providerConfigs: { claude: persisted } });
    expect(restored.discoveredModels).toEqual(persisted.selectedModels);
  });
});
