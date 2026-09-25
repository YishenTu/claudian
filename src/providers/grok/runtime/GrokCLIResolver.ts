import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getGrokProviderSettings } from '../settings';

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
    return this.resolver.resolveFromSettings(settings);
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    environmentText: string,
  ): string | null {
    return this.resolver.resolve({
      cliPathsByHost: hostnamePaths,
      environmentText,
      legacyCliPath: legacyPath,
    });
  }

  reset(): void {
    this.resolver.reset();
  }
}
