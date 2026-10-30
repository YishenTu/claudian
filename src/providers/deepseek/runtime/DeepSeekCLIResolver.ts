import { getInstallationKey } from '@/core/device/InstallationKey';
import { isWindowsStyleCLIReference, stripSurroundingQuotes } from '@/core/process/cliPath';
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

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const config = getDeepSeekProviderSettings(settings);
    if (process.platform === 'win32' && config.installationMethod === 'wsl') return resolveDeepSeekWSLCLIPath(config);
    return this.resolver.resolveFromSettings(settings);
  }
  reset(): void { this.resolver.reset(); }
}


/** A host Desktop/npm locator cannot establish a Linux installation. Probe dsh inside the distro instead. */
export function resolveDeepSeekWSLCLIPath(config: { cliPath: string; cliPathsByHost: Record<string, string> }): string {
  return [config.cliPathsByHost[getInstallationKey()], config.cliPath]
    .map(value => stripSurroundingQuotes((value ?? '').trim()))
    .find(value => value && !isWindowsStyleCLIReference(value)) || 'dsh';
}
