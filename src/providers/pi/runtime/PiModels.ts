import { createConfigCatalogStore, ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodePiConfig, updatePiConfig } from '../config';
import { PiModelDiscoveryService } from './PiModelDiscoveryService';

export function createPiModels(host: ProviderRuntimeHost): ProviderModelCatalogController {
  const discovery = new PiModelDiscoveryService(host);
  return new ProviderModelCatalogController({
    providerName: 'Pi',
    store: createConfigCatalogStore(host, {
      update: updatePiConfig,
      read: (config, selection) => {
        const current = decodePiConfig(config, selection);
        return {
          enabled: current.enabled,
          models: current.discoveredModels.map(model => ({
            id: model.encodedId, name: model.label, providerKey: model.provider, providerLabel: model.provider,
            description: [
              model.api,
              model.contextWindow ? `${model.contextWindow.toLocaleString()} context` : '',
              model.reasoning ? `thinking: ${model.thinkingLevels.join(', ')}` : 'thinking: off',
            ].filter(Boolean).join(' | '),
          })).reverse(),
          selectedIds: current.visibleModels,
          aliases: current.modelAliases,
        };
      },
    }),
    discover: async signal => {
      const result = await discovery.discoverModels(signal);
      if (result.kind === 'skipped') return { changed: false };
      if (result.diagnostics) return { changed: false, diagnostics: result.diagnostics };
      await host.updateConfig((config, selection) => {
        if (signal.aborted) return false;
        updatePiConfig(config, selection, { discoveredModels: result.models });
        return true;
      });
      if (signal.aborted) return { changed: false };
      host.notifyChatOptionsChanged();
      return { changed: true };
    },
  });
}
