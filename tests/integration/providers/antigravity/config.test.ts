import { getInstallationKey } from '@/core/device/InstallationKey';
import { decodeAntigravityConfig, updateAntigravityConfig } from '@/providers/antigravity/config';

const selection = { referencedModelIds: [] };

describe('Antigravity installation settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('projects and updates only the current installation while retaining other devices', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const config: Record<string, unknown> = { installationMethodsByHost: { 'device:other': 'wsl' } };
    const next = updateAntigravityConfig(config, selection, { installationMethod: 'wsl', wslDistroOverride: ' Ubuntu ' });
    expect(next).toMatchObject({ installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
    expect(config.installationMethodsByHost).toEqual({ 'device:other': 'wsl', [getInstallationKey()]: 'wsl' });
    expect(config).not.toHaveProperty('installationMethod');

    // Unrelated writes rebuild the stored configuration and must keep the selection.
    updateAntigravityConfig(config, selection, { enabled: true });
    updateAntigravityConfig(config, selection, { environmentHash: 'next' });
    expect(decodeAntigravityConfig(config, selection)).toMatchObject({ installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
  });
});
