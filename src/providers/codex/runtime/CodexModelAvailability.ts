import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { isCodexModelAvailable } from '../models';
import { toCodexRuntimeModelId } from '../modelSelection';
import { getCodexProviderSettings, getVisibleCodexModelIds } from '../settings';

export function assertCodexModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getCodexProviderSettings(settings);
  const id = toCodexRuntimeModelId(model);
  const candidate = config.discoveredModels.find(entry => entry.model === id);
  if (!(config.enabled && getVisibleCodexModelIds(config.visibleModels, config.discoveredModels).includes(id)
    && Boolean(candidate && isCodexModelAvailable(candidate, config.enableUltraEffort)))) {
    throw new ProviderModelUnavailableError('Codex');
  }
}
