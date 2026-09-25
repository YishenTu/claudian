import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getOpencodeProviderSettings } from '../settings';

export class OpencodeCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'opencode',
    getSettingsProjection: (settings) => {
      const providerSettings = getOpencodeProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'opencode'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'opencode',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    envText: string,
  ): string | null {
    return this.resolver.resolve({
      cliPathsByHost: hostnamePaths,
      environmentText: envText,
      legacyCliPath: legacyPath,
    });
  }

  reset(): void {
    this.resolver.reset();
  }
}
