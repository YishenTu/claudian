import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeGrokConfig, getOrderedGrokVisibleModelIds } from '../config';
import { decodeGrokModelId } from '../models';

export function assertGrokModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection'>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  const config = decodeGrokConfig(host.config, host.selection);
  const id = decodeGrokModelId(model) ?? '';
  if (!(config.enabled && getOrderedGrokVisibleModelIds(config).includes(id)
    && Boolean(config.currentCatalog?.models.some(candidate => candidate.rawId === id)))) {
    throw new ProviderModelUnavailableError('Grok Build');
  }
}
