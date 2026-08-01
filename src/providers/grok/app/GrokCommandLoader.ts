import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { getGrokProviderSettings } from '../settings';
import type { GrokCommandMetadataProbe } from './GrokCommandMetadataProbe';

export class GrokCommandLoader implements ProviderCommandLoaderContract {
  constructor(private readonly metadataProbe: GrokCommandMetadataProbe) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const providerSettings = getGrokProviderSettings(settings);
    const hasConfiguredCli = providerSettings.cliPath.length > 0
      || Object.values(providerSettings.cliPathsByHost).some(path => path.trim().length > 0);
    return [
      'grok:commands:v2',
      providerSettings.enabled ? 'enabled' : 'disabled',
      hasConfiguredCli ? 'configured-cli' : 'auto-cli',
    ].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getGrokProviderSettings(settings).enabled;
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
        message: 'Grok command metadata has not been loaded for this tab.',
        status: 'requires-session',
      };
    }

    try {
      return normalizeProviderCommandDiscoveryItems(
        await this.metadataProbe.load(context.signal),
      );
    } catch {
      return {
        message: 'Could not load Grok skills and commands.',
        retryable: true,
        status: 'error',
      };
    }
  }
}
