import {
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '@/providers/claude/settings';

jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: () => 'host-a',
    getLegacyHostnameKey: () => 'legacy-host',
  };
});

describe('Claude provider WSL settings', () => {
  it('defaults to native Windows', () => {
    expect(getClaudeProviderSettings({}).installationMethod).toBe('native-windows');
  });

  it('stores installation method and distro for the current host', () => {
    const settings: Record<string, unknown> = {};
    const result = updateClaudeProviderSettings(settings, {
      installationMethod: 'wsl2',
      wslDistroOverride: ' Ubuntu ',
    });

    expect(result.installationMethod).toBe('wsl2');
    expect(result.wslDistroOverride).toBe('Ubuntu');
    expect(result.installationMethodsByHost).toEqual({ 'host-a': 'wsl2' });
    expect(result.wslDistroOverridesByHost).toEqual({ 'host-a': 'Ubuntu' });
  });
});
