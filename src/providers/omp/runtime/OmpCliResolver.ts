import { CachedProviderCliResolver } from '../../../core/providers/cli/CachedProviderCliResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getOmpProviderSettings } from '../settings';

export class OmpCliResolver {
  private readonly resolver = new CachedProviderCliResolver({
    binaryName: 'omp',
    getSettingsProjection: settings => {
      const provider = getOmpProviderSettings(settings);
      return {
        cliPathsByHost: provider.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'omp'),
        legacyCliPath: provider.cliPath,
      };
    },
    providerId: 'omp',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void { this.resolver.reset(); }
}
