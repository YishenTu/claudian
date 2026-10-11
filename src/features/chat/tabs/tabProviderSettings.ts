import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderUIOption } from '@/core/providers/types';

export function getBlankTabModelOptions(
  settings: Record<string, unknown>,
): ProviderUIOption[] {
  return ProviderRegistry.getBlankTabProviderIds(settings).flatMap((providerId) => {
    const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
    const providerIcon = uiConfig.getProviderIcon?.() ?? undefined;
    const group = ProviderRegistry.getProviderDisplayName(providerId);

    return uiConfig.getModelOptions(settings)
      .map(model => ({ ...model, group, providerIcon, providerId }));
  });
}
