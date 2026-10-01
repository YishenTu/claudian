import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { sameDiscoveredModels, sameThinkingOptionsByModel } from './internal/compareCollections';
import {
  normalizeOpencodeDiscoveredModels,
  normalizeOpencodeThinkingOptionsByModel,
  type OpencodeDiscoveredModel,
  type OpencodeThinkingOptionsByModel,
} from './models';

interface OpencodeDiscoveryState {
  discoveredModels: OpencodeDiscoveredModel[];
  thinkingOptionsByModel: OpencodeThinkingOptionsByModel;
}

function ensureDiscoveryState(settings: Record<string, unknown>): OpencodeDiscoveryState {
  const config = getProviderConfig(settings, 'opencode');
  const discoveredModels = normalizeOpencodeDiscoveredModels(config.discoveredModels ?? config.selectedModels);
  return {
    discoveredModels,
    thinkingOptionsByModel: normalizeOpencodeThinkingOptionsByModel(config.thinkingOptionsByModel, discoveredModels),
  };
}

function cloneDiscoveredModels(models: OpencodeDiscoveredModel[]): OpencodeDiscoveredModel[] {
  return models.map((model) => ({ ...model }));
}

function cloneThinkingOptionsByModel(
  optionsByModel: OpencodeThinkingOptionsByModel,
): OpencodeThinkingOptionsByModel {
  return Object.fromEntries(
    Object.entries(optionsByModel).map(([rawId, options]) => [
      rawId,
      options.map((option) => ({ ...option })),
    ]),
  );
}

export function getOpencodeDiscoveryState(settings: Record<string, unknown>): OpencodeDiscoveryState {
  const state = ensureDiscoveryState(settings);
  return {
    discoveredModels: cloneDiscoveredModels(state.discoveredModels),
    thinkingOptionsByModel: cloneThinkingOptionsByModel(state.thinkingOptionsByModel),
  };
}

export function updateOpencodeDiscoveryState(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeDiscoveryState>,
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextDiscoveredModels = 'discoveredModels' in updates
    ? normalizeOpencodeDiscoveredModels(updates.discoveredModels)
    : state.discoveredModels;
  const nextThinkingOptionsByModel = 'thinkingOptionsByModel' in updates
    ? normalizeOpencodeThinkingOptionsByModel(updates.thinkingOptionsByModel, nextDiscoveredModels)
    : state.thinkingOptionsByModel;
  const changed = !sameDiscoveredModels(state.discoveredModels, nextDiscoveredModels)
    || !sameThinkingOptionsByModel(state.thinkingOptionsByModel, nextThinkingOptionsByModel);

  if (!changed) {
    return false;
  }

  state.discoveredModels = cloneDiscoveredModels(nextDiscoveredModels);
  state.thinkingOptionsByModel = cloneThinkingOptionsByModel(nextThinkingOptionsByModel);
  setProviderConfig(settings, 'opencode', { ...getProviderConfig(settings, 'opencode'), ...state });
  return true;
}
