import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';

import { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { getOpencodeProviderSettings } from '../settings';

type OpencodeMetadataServiceFactory = (
  plugin: ProviderHost,
) => OpencodeMetadataService;

const DEFAULT_METADATA_SERVICE_FACTORY: OpencodeMetadataServiceFactory =
  plugin => new OpencodeMetadataService(plugin);

export class OpencodeCommandLoader implements ProviderCommandLoaderContract {
  constructor(
    private readonly metadataService?: OpencodeMetadataService,
    private readonly createMetadataService: OpencodeMetadataServiceFactory =
      DEFAULT_METADATA_SERVICE_FACTORY,
  ) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `opencode:commands:v1:${getOpencodeProviderSettings(settings).enabled ? 'enabled' : 'disabled'}`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getOpencodeProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    let ownedService: OpencodeMetadataService | null = null;
    return loadRuntimeCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      cleanup: async () => ownedService?.dispose(),
      discover: async (signal) => {
        const metadataService = this.metadataService
          ?? (ownedService = this.createMetadataService(context.plugin));
        return await metadataService.discoverCommands(signal);
      },
      errorMessage: 'Could not load OpenCode commands.',
      projectItems: result => result.loaded ? result.commands : null,
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: 'OpenCode command metadata has not been loaded for this tab.',
      signal: context.signal,
    });
  }
}
