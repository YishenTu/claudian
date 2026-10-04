const mockGetHostnameKey = jest.fn(() => 'device:current');

import { claudeProviderRegistration } from '@/providers/claude/registration';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => mockGetHostnameKey(),
}));

describe('Claude settings normalization', () => {
  it.each([undefined, null, 'true', 1, false, true])('decodes opt-in prompt suggestions from %p', value => {
    const settings = { providerConfigs: { claude: { promptSuggestions: value } } };
    expect(getClaudeProviderSettings(settings).promptSuggestions).toBe(value === true);
  });

  it.each(['default', 'My Style', null] as const)('persists the %p output style while preserving other settings', (outputStyle) => {
    const settings = { providerConfigs: { claude: { customModels: 'custom' } } };
    updateClaudeProviderSettings(settings, { outputStyle });
    expect(getClaudeProviderSettings(settings)).toMatchObject({ outputStyle });
    expect(settings.providerConfigs.claude.customModels).toBe('custom');
  });

  it.each([
    [{ responseStyle: 'Concise' }, 'Concise'],
    [{ responseStyle: 'Default' }, null],
    [{}, null],
    [{ outputStyle: '', responseStyle: 'Concise' }, 'Concise'],
    [{ outputStyle: null, responseStyle: 'Concise' }, null],
    [{ outputStyle: ' Explanatory ' }, 'Explanatory'],
    [{ outputStyle: 42 }, null],
  ])('reads stored style %p as %p', (config, outputStyle) => {
    expect(getClaudeProviderSettings({ providerConfigs: { claude: config } })).toMatchObject({ outputStyle });
  });

  it('drops the retired response style when stored settings are normalized', () => {
    const target: Record<string, unknown> = {};
    const stored = { providerConfigs: { claude: { responseStyle: 'Concise' } } };
    expect(claudeProviderRegistration.settingsStorage!.normalizeStored!(target, stored)).toBe(true);
    const config = (target.providerConfigs as Record<string, Record<string, unknown>>).claude;
    expect(config).toMatchObject({ outputStyle: 'Concise' });
    expect(config).not.toHaveProperty('responseStyle');
  });

  it('normalizes mixed CLI maps without interpreting host-shaped keys', () => {
    expect(getClaudeProviderSettings({
      providerConfigs: {
        claude: {
          cliPathsByHost: {
            ' legacy-host ': ' /legacy/claude ',
            invalid: 42,
            empty: '',
          },
        },
      },
    }).cliPathsByHost).toEqual({
      'legacy-host': '/legacy/claude',
    });
  });

  it('rejects arrays as CLI maps', () => {
    expect(getClaudeProviderSettings({
      providerConfigs: { claude: { cliPathsByHost: ['/array/claude'] } },
    }).cliPathsByHost).toEqual({});
  });
});
