import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';

import { getClaudeProviderSettings } from '../settings';
import { findClaudeBinaryPath } from './ClaudeBinaryLocator';

export class ClaudeCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'claude',
    findBinaryPath: findClaudeBinaryPath,
    getSettingsProjection: (settings) => {
      const providerSettings = getClaudeProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'claude'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'claude',
    // A missing installation can appear before the next settings change.
    shouldCache: result => result !== null,
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
