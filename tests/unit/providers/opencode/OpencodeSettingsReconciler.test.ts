import { opencodeSettingsReconciler } from '../../../../src/providers/opencode/env/OpencodeSettingsReconciler';

describe('opencodeSettingsReconciler.normalizeModelVariantSettings', () => {
  it('migrates saved variant model ids into base model ids plus effort', () => {
    const settings: Record<string, unknown> = {
      effortLevel: '',
      model: 'opencode:anthropic/claude-sonnet-4/high',
      providerConfigs: {
        opencode: {
          discoveredModels: [
            { label: 'Anthropic/Claude Sonnet 4', rawId: 'anthropic/claude-sonnet-4' },
            { label: 'Anthropic/Claude Sonnet 4 (high)', rawId: 'anthropic/claude-sonnet-4/high' },
          ],
          visibleModels: ['anthropic/claude-sonnet-4/high'],
        },
      },
      savedProviderEffort: {},
      savedProviderModel: {
        opencode: 'opencode:anthropic/claude-sonnet-4/high',
      },
      settingsProvider: 'opencode',
      titleGenerationModel: 'opencode:anthropic/claude-sonnet-4/high',
    };

    expect(opencodeSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings).toMatchObject({
      effortLevel: 'high',
      model: 'opencode:anthropic/claude-sonnet-4',
      savedProviderEffort: {
        opencode: 'high',
      },
      savedProviderModel: {
        opencode: 'opencode:anthropic/claude-sonnet-4',
      },
      titleGenerationModel: 'opencode:anthropic/claude-sonnet-4',
    });
  });
});
