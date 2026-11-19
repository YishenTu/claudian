import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ANTIGRAVITY_PROVIDER_ID, getAntigravityProviderSettings } from '../settings';
import { resolveAntigravityWSLCLIPath } from './antigravityCLIReference';

export class AntigravityCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'agy',
    getSettingsProjection: (settings) => {
      const providerSettings = getAntigravityProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, ANTIGRAVITY_PROVIDER_ID),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: ANTIGRAVITY_PROVIDER_ID,
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const config = getAntigravityProviderSettings(settings);
    // A WSL CLI lives in Linux, where the host filesystem cannot check it.
    if (process.platform === 'win32' && config.installationMethod === 'wsl') return resolveAntigravityWSLCLIPath(config);
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
