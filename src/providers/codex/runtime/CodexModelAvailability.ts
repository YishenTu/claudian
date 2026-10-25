import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeCodexConfig, getVisibleCodexModelIds } from '../config';
import { isCodexModelAvailable } from '../models';
import { toCodexRuntimeModelId } from '../modelSelection';

export function assertCodexModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection'>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  const config = decodeCodexConfig(host.config);
  const id = toCodexRuntimeModelId(model);
  const candidate = config.discoveredModels.find(entry => entry.model === id);
  if (!(config.enabled && getVisibleCodexModelIds(config.visibleModels, config.discoveredModels).includes(id)
    && Boolean(candidate && isCodexModelAvailable(candidate, config.enableUltraEffort)))) {
    throw new ProviderModelUnavailableError('Codex');
  }
}
