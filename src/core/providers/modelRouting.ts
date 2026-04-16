import { ProviderRegistry } from './ProviderRegistry';
import type { ProviderId } from './types';

export function getProviderForModel(model: string, settings?: Record<string, unknown>): ProviderId {
  return ProviderRegistry.resolveProviderForModel(model, settings);
}

export function getEnabledProviderForModel(
  model: string,
  settings: Record<string, unknown>,
  fallbackProviderId?: ProviderId,
): ProviderId {
  return ProviderRegistry.resolveProviderForModel(model, settings, {
    onlyEnabledProviders: true,
    fallbackProviderId,
  });
}
