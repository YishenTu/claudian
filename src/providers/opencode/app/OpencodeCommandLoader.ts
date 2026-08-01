import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { OpencodeMetadataService } from '../metadata/OpencodeMetadataService';
import { getOpencodeProviderSettings } from '../settings';

export class OpencodeCommandLoader implements ProviderCommandLoaderContract {
  constructor(private readonly metadataService?: OpencodeMetadataService) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `opencode:commands:v1:${getOpencodeProviderSettings(settings).enabled ? 'enabled' : 'disabled'}`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getOpencodeProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    context.signal?.throwIfAborted();
    if (context.readyCommandSnapshot) {
      return normalizeProviderCommandDiscoveryItems(context.readyCommandSnapshot);
    }
    if (!context.allowIsolatedMetadataCreation) {
      return {
        message: 'OpenCode command metadata has not been loaded for this tab.',
        status: 'requires-session',
      };
    }

    const metadataService = this.metadataService
      ?? new OpencodeMetadataService(context.plugin);

    try {
      const result = await metadataService.discoverCommands(context.signal);
      context.signal?.throwIfAborted();
      if (!result.loaded) {
        return {
          message: 'Could not load OpenCode commands.',
          retryable: true,
          status: 'error' as const,
        };
      }

      return normalizeProviderCommandDiscoveryItems(result.commands);
    } catch {
      return {
        message: 'Could not load OpenCode commands.',
        retryable: true,
        status: 'error' as const,
      };
    } finally {
      if (!this.metadataService) await metadataService.dispose();
    }
  }
}
