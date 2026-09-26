import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getPiProviderSettings, updatePiProviderSettings } from '../settings';
import { PiModelDiscoveryService } from './PiModelDiscoveryService';

export function createPiModels(host: ProviderHost): ProviderModelCatalogController {
  const discovery = new PiModelDiscoveryService(host);
  return new ProviderModelCatalogController({
    providerId: 'pi',
    host,
    update: updatePiProviderSettings,
    providerName: 'Pi',
    read: () => {
      const current = getPiProviderSettings(host.settings);
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
    discover: async signal => {
      const result = await discovery.discoverModels(signal);
      if (result.kind === 'skipped') return { changed: false };
      if (result.diagnostics) return { changed: false, diagnostics: result.diagnostics };
      await host.mutateSettingsConditionally(settings => {
        if (signal.aborted) return false;
        updatePiProviderSettings(settings, { discoveredModels: result.models });
        return true;
      });
      if (signal.aborted) return { changed: false };
      host.notifyProviderChatOptionsChanged('pi');
      return { changed: true };
    },
  });
}
