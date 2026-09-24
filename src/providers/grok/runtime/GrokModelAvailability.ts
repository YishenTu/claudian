import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { decodeGrokModelId } from '../models';
import { getGrokProviderSettings, getOrderedGrokVisibleModelIds } from '../settings';

export function assertGrokModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getGrokProviderSettings(settings);
  const id = decodeGrokModelId(model) ?? '';
  if (!(config.enabled && getOrderedGrokVisibleModelIds(config).includes(id)
    && Boolean(config.currentCatalog?.models.some(candidate => candidate.rawId === id)))) {
    throw new ProviderModelUnavailableError('Grok');
  }
}
