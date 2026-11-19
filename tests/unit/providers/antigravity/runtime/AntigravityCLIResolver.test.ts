import * as fs from 'fs';
import type { Mock } from 'vitest';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { AntigravityCLIResolver } from '@/providers/antigravity/runtime/AntigravityCLIResolver';

vi.mock('fs');
const mockedStat = fs.statSync as Mock;

describe('AntigravityCLIResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as Mock).mockReturnValue(false);
  });

  it('preserves Linux-only WSL paths and skips host filesystem discovery', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    try {
      const resolver = new AntigravityCLIResolver();
      const wsl = { installationMethodsByHost: { [getInstallationKey()]: 'wsl' } };
      expect(resolver.resolveFromSettings({ providerConfigs: { antigravity: {
        ...wsl, cliPathsByHost: { [getInstallationKey()]: '"~/agy cli"' },
      } } })).toBe('~/agy cli');
      expect(mockedStat).not.toHaveBeenCalled();
      expect(resolver.resolveFromSettings({ providerConfigs: { antigravity: { ...wsl, cliPath: 'C:\\agy.exe' } } })).toBe('agy');
      // A Windows reference on this device falls through to a Linux legacy path.
      expect(resolver.resolveFromSettings({ providerConfigs: { antigravity: {
        ...wsl, cliPathsByHost: { [getInstallationKey()]: 'C:\\agy.exe' }, cliPath: '  /opt/agy  ',
      } } })).toBe('/opt/agy');
    } finally { vi.unstubAllGlobals(); }
  });
});
