const mockGetHostnameKey = jest.fn(() => 'device:current');

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
}));

import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';

describe('Claude settings normalization', () => {
  it.each(['Default', 'Concise'] as const)('persists the %s response style while preserving other settings', (responseStyle) => {
    const settings = { providerConfigs: { claude: { customModels: 'custom' } } };
    updateClaudeProviderSettings(settings, { responseStyle });
    expect(getClaudeProviderSettings(settings)).toMatchObject({ responseStyle, customModels: 'custom' });
  });

  it.each([undefined, null, '', 'invalid', 42, {}, []])('normalizes invalid response style %p to Default', (responseStyle) => {
    expect(getClaudeProviderSettings({ providerConfigs: { claude: { responseStyle } } }))
      .toMatchObject({ responseStyle: 'Default' });
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
