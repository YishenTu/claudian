import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type {
  ProviderCommandLoader,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';

import { filterAntigravityCommands } from '../commands/AntigravityCommandCatalog';
import { getAntigravityProviderSettings } from '../settings';
import type { AntigravityMetadataProbe } from './AntigravityMetadataProbe';

export class AntigravityCommandLoader implements ProviderCommandLoader {
  constructor(private readonly metadataProbe: Pick<AntigravityMetadataProbe, 'load'>) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const current = getAntigravityProviderSettings(settings);
    const configuredCli = current.cliPath.length > 0
      || Object.values(current.cliPathsByHost).some(path => path.trim().length > 0);
    return ['antigravity:commands:v1', current.enabled ? 'enabled' : 'disabled', configuredCli ? 'configured-cli' : 'auto-cli'].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getAntigravityProviderSettings(settings).enabled;
  }

  loadCommands(context: ProviderCommandLoaderContext): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    return loadRuntimeCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      discover: async signal => (await this.metadataProbe.load(signal)).commands,
      errorMessage: 'Could not load Antigravity commands.',
      projectItems: commands => filterAntigravityCommands(commands),
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: 'Antigravity command metadata has not been loaded for this tab.',
      signal: context.signal,
    });
  }
}
