import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';

import { getDeepSeekProviderSettings } from '../settings';

export class DeepSeekCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    providerId: 'deepseek', binaryName: 'dsh',
    getSettingsProjection: settings => {
      const current = getDeepSeekProviderSettings(settings);
      return { cliPathsByHost: current.cliPathsByHost, legacyCliPath: current.cliPath, environmentText: getRuntimeEnvironmentText(settings, 'deepseek') };
    },
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null { return this.resolver.resolveFromSettings(settings); }
  reset(): void { this.resolver.reset(); }
}
