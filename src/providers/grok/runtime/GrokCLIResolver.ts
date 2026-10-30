import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getGrokProviderSettings } from '../settings';
import { resolveGrokWSLCLIPath } from './grokCLIReference';

export class GrokCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'grok',
    getSettingsProjection: (settings) => {
      const providerSettings = getGrokProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'grok'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'grok',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const config = getGrokProviderSettings(settings);
    if (process.platform === 'win32' && config.installationMethod === 'wsl') {
      return resolveGrokWSLCLIPath(config);
    }
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
