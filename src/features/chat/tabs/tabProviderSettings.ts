import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderUIOption } from '@/core/providers/types';

export function getBlankTabModelOptions(
  settings: Record<string, unknown>,
): ProviderUIOption[] {
  // The picker lists providers in the settings tab's order; default-model fallback keeps its own priority.
  return ProviderRegistry.getRegisteredProviderIds()
    .filter(providerId => ProviderRegistry.isEnabled(providerId, settings))
    .flatMap((providerId) => {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const providerIcon = uiConfig.getProviderIcon?.() ?? undefined;
    const providerLabel = ProviderRegistry.getProviderDisplayName(providerId);

    return uiConfig.getModelOptions(settings)
      .map(model => ({ ...model, providerIcon, providerId, providerLabel }));
  });
}
