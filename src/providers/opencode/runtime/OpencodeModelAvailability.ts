import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeOpencodeConfig } from '../config';
import { decodeOpencodeModelId } from '../models';

export function assertOpencodeModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection'>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  const config = decodeOpencodeConfig(host.config);
  const id = decodeOpencodeModelId(model);
  if (!(config.enabled && id && config.visibleModels.includes(id)
    && config.discoveredModels.some(candidate => candidate.rawId === id))) {
    throw new ProviderModelUnavailableError('OpenCode');
  }
}
