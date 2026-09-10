import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import { getVaultPath } from '@/utils/path';

import type { PiCommandMetadataProbe } from '../execution/PiCommandMetadataProbe';
import type { PiFamilyProfile } from '../PiFamilyProfile';

export class PiCommandLoader implements ProviderCommandLoaderContract {
  constructor(
    private readonly profile: PiFamilyProfile,
    private readonly metadataProbe: PiCommandMetadataProbe,
  ) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `${this.profile.providerId}:commands:v1:${
      this.profile.settings.get(settings).enabled ? 'enabled' : 'disabled'
    }`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return this.profile.settings.get(settings).enabled;
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
      errorMessage: `Could not load ${this.profile.displayName} commands.`,
      projectItems: commands => commands,
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: `${this.profile.displayName} command metadata has not been loaded for this tab.`,
      signal: context.signal,
    });
  }
}
