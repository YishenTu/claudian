import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
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
    context.signal?.throwIfAborted();
    if (context.readyCommandSnapshot) {
      return normalizeProviderCommandDiscoveryItems(context.readyCommandSnapshot);
    }
    if (!context.allowIsolatedMetadataCreation) {
      return {
        message: 'Pi command metadata has not been loaded for this tab.',
        status: 'requires-session',
      };
    }

    try {
      const commands = await this.metadataProbe.load(
        getVaultPath(context.plugin.app) ?? process.cwd(),
        context.signal,
      );
      context.signal?.throwIfAborted();
      return normalizeProviderCommandDiscoveryItems(commands);
    } catch {
      return {
        message: 'Could not load Pi commands.',
        retryable: true,
        status: 'error' as const,
      };
    }
  }
}
