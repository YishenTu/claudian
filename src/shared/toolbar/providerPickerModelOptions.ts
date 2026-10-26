import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId, ProviderUIOption } from '@/core/providers/types';

/**
 * Every enabled provider's model options, tagged with their provider for a model picker that can
 * switch providers. The picker lists providers in the settings tab's order; default-model fallback
 * keeps its own priority.
 */
export function getProviderPickerModelOptions(
  getSettings: (providerId: ProviderId) => Record<string, unknown>,
): ProviderUIOption[] {
  return ProviderRegistry.getRegisteredProviderIds()
    .filter(providerId => ProviderRegistry.isEnabled(providerId, getSettings(providerId)))
    .flatMap((providerId) => {
      const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
      const providerIcon = uiConfig.getProviderIcon?.() ?? undefined;
      const providerLabel = ProviderRegistry.getProviderDisplayName(providerId);
      return uiConfig.getModelOptions(getSettings(providerId))
        .map(model => ({ ...model, providerIcon, providerId, providerLabel }));
    });
}
