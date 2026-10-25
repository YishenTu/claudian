import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import { decodeGrokConfig, updateGrokConfig } from '@/providers/grok/config';

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => 'device:current',
}));

describe('Grok configuration through the runtime host', () => {
  it('keeps metadata only for models the current or other selections reference', async () => {
    const settings: Record<string, unknown> = {
      model: 'claude-sonnet-4-5',
      titleGenerationModel: 'grok/title-only',
      savedProviderModel: { claude: 'grok/claude-slot', grok: 'grok/saved-only' },
      providerConfigs: {
        grok: {
          catalogsByHost: {
            'device:current': {
              defaultModelId: 'kimi-coding',
              fingerprint: 'native',
              models: [{ displayName: 'Kimi', rawId: 'kimi-coding', reasoningEfforts: [], supportsReasoning: false }],
              refreshedAt: 1,
            },
          },
          enabled: true,
          visibleModels: ['kimi-coding'],
        },
      },
    };
    const host = runtimeHostFor({ settings }, 'grok');

    await expect(host.updateConfig((config, selection) => {
      updateGrokConfig(config, selection, {
        modelAliases: {
          'claude-slot': 'Other provider slot',
          'kimi-coding': 'Kimi',
          'saved-only': 'Saved',
          'title-only': 'Title',
          unreferenced: 'Dropped',
        },
      });
      return true;
    })).resolves.toBe(true);

    const expected = { 'kimi-coding': 'Kimi', 'saved-only': 'Saved', 'title-only': 'Title' };
    expect(host.config.modelAliases).toEqual(expected);
    expect(decodeGrokConfig(host.config, host.selection).modelAliases).toEqual(expected);
  });
});
