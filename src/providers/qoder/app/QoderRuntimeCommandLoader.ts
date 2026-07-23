import {
  normalizeProviderCommandDiscoveryItems,
  type ProviderCommandDiscoveryResult,
} from '../../../core/providers/commands/ProviderCommandDiscoveryResult';
import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import type { SlashCommand } from '../../../core/types';
import { getQoderProviderSettings } from '../settings';
import type { QoderWorkspaceSnapshot } from './QoderWorkspaceServices';

interface QoderRuntimeCommandLoaderOptions {
  getSnapshot(): QoderWorkspaceSnapshot;
  refreshRuntimeSnapshot(): Promise<void>;
}

export class QoderRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  constructor(private readonly options: QoderRuntimeCommandLoaderOptions) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const providerSettings = getQoderProviderSettings(settings);
    const hasConfiguredCli = providerSettings.cliPath.length > 0
      || Object.values(providerSettings.cliPathsByHost).some(path => path.trim().length > 0);
    return [
      'qoder:commands:v1',
      providerSettings.enabled ? 'enabled' : 'disabled',
      hasConfiguredCli ? 'configured-cli' : 'auto-cli',
      providerSettings.authMode,
    ].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getQoderProviderSettings(settings).enabled;
  }

  async loadCommands(
    _context: ProviderRuntimeCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    const cached = this.options.getSnapshot().commands;
    if (cached.length > 0) {
      return normalizeProviderCommandDiscoveryItems(cached);
    }

    try {
      await this.options.refreshRuntimeSnapshot();
      return normalizeProviderCommandDiscoveryItems(this.options.getSnapshot().commands);
    } catch {
      return {
        message: 'Could not load Qoder commands.',
        retryable: true,
        status: 'error',
      };
    }
  }
}
