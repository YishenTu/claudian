import { CachedProviderCliResolver } from '../../../core/providers/cli/CachedProviderCliResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getCursorProviderSettings } from '../settings';

export class CursorCliResolver {
  private readonly resolver = new CachedProviderCliResolver({
    binaryName: 'agent',
    getSettingsProjection: settings => {
      const provider = getCursorProviderSettings(settings);
      return {
        cliPathsByHost: provider.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'cursor'),
        legacyCliPath: provider.cliPath,
      };
    },
    providerId: 'cursor',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void { this.resolver.reset(); }
}
