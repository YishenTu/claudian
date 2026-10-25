import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodePiConfig } from '../config';

export function assertPiModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection'>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  const config = decodePiConfig(host.config, host.selection);
  if (!(config.enabled && config.visibleModels.includes(model)
    && config.discoveredModels.some(candidate => candidate.encodedId === model))) {
    throw new ProviderModelUnavailableError('Pi');
  }
}
