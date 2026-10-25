import { getProviderConfig } from '../../../core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createOpencodeCLIResolver, projectOpencodeCLIConfig } from './OpencodeCLILaunch';

export class OpencodeCLIResolver {
  private readonly resolver = createOpencodeCLIResolver(settings => projectOpencodeCLIConfig(
    getProviderConfig(settings, 'opencode'),
    getRuntimeEnvironmentText(settings, 'opencode'),
  ));

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
