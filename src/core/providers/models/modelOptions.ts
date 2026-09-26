import { decodeProviderModelSelectionId, toProviderRuntimeModelId } from '../modelSelection';
import type { ProviderId,ProviderModelPolicy } from '../types';

/** Match an available identity without applying semantic defaults or dropping a variant. */
export function findAvailableModelOption(
  providerId: ProviderId,
  uiConfig: ProviderModelPolicy,
  model: string,
  settings: Record<string, unknown>,
): string | null {
  const selection = decodeProviderModelSelectionId(model);
  if (selection && selection.providerId !== providerId) return null;
  const options = uiConfig.getModelOptions(settings);
  const find = (candidate: string): string | null => {
    const runtimeModel = toProviderRuntimeModelId(providerId, candidate);
    return options.find(option => option.value === candidate
      || toProviderRuntimeModelId(providerId, option.value) === runtimeModel)?.value ?? null;
  };
  const exact = find(model);
  if (exact) return exact;
  const normalized = uiConfig.normalizeAvailableModelSelection?.(model, { ...settings, model });
  return normalized && normalized !== model ? find(normalized) : null;
}
