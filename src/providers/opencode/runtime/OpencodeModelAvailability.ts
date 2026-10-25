import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeOpencodeConfig } from '../config';
import { buildOpencodeBaseModels, decodeOpencodeModelId, resolveOpencodeBaseModelRawId } from '../models';

export function assertOpencodeModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection'>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  const config = decodeOpencodeConfig(host.config);
  const rawId = decodeOpencodeModelId(model);
  const id = rawId ? resolveOpencodeBaseModelRawId(rawId, config.discoveredModels) : '';
  if (!(config.enabled && config.visibleModels.includes(id)
    && buildOpencodeBaseModels(config.discoveredModels).some(candidate => candidate.rawId === id))) {
    throw new ProviderModelUnavailableError('OpenCode');
  }
}
