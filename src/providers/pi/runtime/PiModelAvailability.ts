import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { getPiProviderSettings } from '../settings';

export function assertPiModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getPiProviderSettings(settings);
  if (!(config.enabled && config.visibleModels.includes(model)
    && config.discoveredModels.some(candidate => candidate.encodedId === model))) {
    throw new ProviderModelUnavailableError('Pi');
  }
}
