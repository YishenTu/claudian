import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { buildOpencodeBaseModels, decodeOpencodeModelId, resolveOpencodeBaseModelRawId } from '../models';
import { getOpencodeProviderSettings } from '../settings';

export function assertOpencodeModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getOpencodeProviderSettings(settings);
  const rawId = decodeOpencodeModelId(model);
  const id = rawId ? resolveOpencodeBaseModelRawId(rawId, config.discoveredModels) : '';
  if (!(config.enabled && config.visibleModels.includes(id)
    && buildOpencodeBaseModels(config.discoveredModels).some(candidate => candidate.rawId === id))) {
    throw new ProviderModelUnavailableError('OpenCode');
  }
}
