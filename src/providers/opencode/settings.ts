import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import {
  decodeOpencodeConfig,
  type OpencodeProviderSettings,
  updateOpencodeConfig,
} from './config';
import type { OpencodeThinkingOptionsByModel } from './models';

/** Reads OpenCode's configuration from the settings document. */
export function getOpencodeProviderSettings(
  settings: Record<string, unknown>,
): OpencodeProviderSettings {
  return decodeOpencodeConfig(getProviderConfig(settings, 'opencode'));
}

/** Writes OpenCode's configuration into the settings document. */
export function updateOpencodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeProviderSettings>,
): OpencodeProviderSettings {
  const config = getProviderConfig(settings, 'opencode');
  const next = updateOpencodeConfig(config, updates);
  setProviderConfig(settings, 'opencode', config);
  return next;
}

function pruneThinkingOptionsToPersistedSelections(
  next: OpencodeProviderSettings,
): OpencodeThinkingOptionsByModel {
  const persistableRawIds = new Set(next.visibleModels);
  const pruned: OpencodeThinkingOptionsByModel = {};
  for (const rawId of persistableRawIds) {
    const options = Object.hasOwn(next.thinkingOptionsByModel, rawId) ? next.thinkingOptionsByModel[rawId] : undefined;
    if (options) {
      Object.defineProperty(pruned, rawId, { value: options.map((option) => ({ ...option })), enumerable: true, writable: true, configurable: true });
    }
  }
  return pruned;
}

export function projectOpencodeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getOpencodeProviderSettings(settings);
  const visibleModels = current.visibleModels;
  const selected = new Set(visibleModels);
  const config = {
    ...getProviderConfig(settings, 'opencode'),
    visibleModels,
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredThinkingByModel: selectModelMetadata(current.preferredThinkingByModel, selected),
    thinkingOptionsByModel: pruneThinkingOptionsToPersistedSelections(current),
    selectedModels: current.discoveredModels.filter(model => selected.has(model.rawId)),
  };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes', 'selectedMode']) delete (config as Record<string, unknown>)[key];
  return config;
}
