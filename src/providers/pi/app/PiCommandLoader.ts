import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import { getVaultPath } from '@/utils/path';

import type { PiCommandMetadataProbe } from '../execution/PiCommandMetadataProbe';
import { getPiProviderSettings } from '../settings';

export class PiCommandLoader implements ProviderCommandLoaderContract {
  constructor(private readonly metadataProbe: PiCommandMetadataProbe) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `pi:commands:v1:${getPiProviderSettings(settings).enabled ? 'enabled' : 'disabled'}`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getPiProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    return loadRuntimeCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      discover: signal => this.metadataProbe.load(
        getVaultPath(context.plugin.app) ?? process.cwd(),
        signal,
      ),
      errorMessage: 'Could not load Pi commands.',
      projectItems: commands => commands,
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: 'Pi command metadata has not been loaded for this tab.',
      signal: context.signal,
    });
  }
}
