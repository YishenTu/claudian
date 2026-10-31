import { getProviderConfig } from '../../../core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getOpencodeProviderSettings } from '../settings';
import { createOpencodeCLIResolver, projectOpencodeCLIConfig } from './OpencodeCLILaunch';
import { resolveOpencodeWSLCLIPath } from './opencodeCLIReference';

export class OpencodeCLIResolver {
  private readonly resolver = createOpencodeCLIResolver(settings => projectOpencodeCLIConfig(
    getProviderConfig(settings, 'opencode'),
    getRuntimeEnvironmentText(settings, 'opencode'),
  ));

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const config = getOpencodeProviderSettings(settings);
    if (process.platform === 'win32' && config.installationMethod === 'wsl') return resolveOpencodeWSLCLIPath(config);
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
