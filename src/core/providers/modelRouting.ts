import { ProviderRegistry } from './ProviderRegistry';
import type { ProviderId } from './types';

export function getProviderForModel(model: string, settings?: Record<string, unknown>): ProviderId | null {
  return ProviderRegistry.resolveProviderForModel(model, settings);
}

export function getEnabledProviderForModel(
  model: string,
  settings: Record<string, unknown>,
): ProviderId | null {
  return ProviderRegistry.resolveProviderForModel(model, settings, {
    onlyEnabledProviders: true,
  });
}
