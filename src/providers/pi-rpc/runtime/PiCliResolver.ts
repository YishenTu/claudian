import { CachedProviderCliResolver } from '../../../core/providers/cli/CachedProviderCliResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { PiFamilyProfile } from '../PiFamilyProfile';

export class PiCliResolver {
  private readonly resolver: CachedProviderCliResolver;

  constructor(profile: PiFamilyProfile) {
    this.resolver = new CachedProviderCliResolver({
      binaryName: profile.defaultBinaryName,
      getSettingsProjection: (settings) => {
        const providerSettings = profile.settings.get(settings);
        return {
          cliPathsByHost: providerSettings.cliPathsByHost,
          environmentText: getRuntimeEnvironmentText(settings, profile.providerId),
          legacyCliPath: providerSettings.cliPath,
        };
      },
      providerId: profile.providerId,
    });
  }

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    envText = '',
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
