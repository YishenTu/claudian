import { ProviderRegistry } from './ProviderRegistry';
import type { ProviderId } from './types';

export function getProviderForModel(model: string, settings?: Record<string, unknown>): ProviderId {
  return ProviderRegistry.resolveProviderForModel(model, settings);
}
