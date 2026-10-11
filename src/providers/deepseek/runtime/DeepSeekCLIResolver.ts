import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';

import { getDeepSeekProviderSettings } from '../settings';
import { findDeepSeekDesktopCLI, resolveDeepSeekCLIPath } from './DeepSeekInstallation';

export class DeepSeekCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    providerId: 'deepseek', binaryName: 'dsh',
    getSettingsProjection: settings => {
      const current = getDeepSeekProviderSettings(settings);
      return { cliPathsByHost: current.cliPathsByHost, legacyCliPath: current.cliPath, environmentText: getRuntimeEnvironmentText(settings, 'deepseek') };
    },
    resolve: (context, resolveDefault) => {
      const configured = context.hostnamePath || context.legacyCliPath;
      if (configured) return resolveDeepSeekCLIPath(configured);
      const cli = resolveDefault();
      return cli ? resolveDeepSeekCLIPath(cli) : findDeepSeekDesktopCLI();
    },
    // Install, move and uninstall can change Auto resolution without a settings edit.
    shouldCache: () => false,
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null { return this.resolver.resolveFromSettings(settings); }
  reset(): void { this.resolver.reset(); }
}
