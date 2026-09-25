import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { sameDiscoveredModels, sameModes, sameThinkingOptionsByModel } from './internal/compareCollections';
import {
  normalizeOpencodeDiscoveredModels,
  normalizeOpencodeThinkingOptionsByModel,
  type OpencodeDiscoveredModel,
  type OpencodeThinkingOptionsByModel,
} from './models';
import {
  normalizeOpencodeAvailableModes,
  type OpencodeMode,
} from './modes';

interface OpencodeDiscoveryState {
  availableModes: OpencodeMode[];
  discoveredModels: OpencodeDiscoveredModel[];
  thinkingOptionsByModel: OpencodeThinkingOptionsByModel;
}

function ensureDiscoveryState(settings: Record<string, unknown>): OpencodeDiscoveryState {
  const config = getProviderConfig(settings, 'opencode');
  const discoveredModels = normalizeOpencodeDiscoveredModels(config.discoveredModels ?? config.selectedModels);
  return {
    availableModes: normalizeOpencodeAvailableModes(config.availableModes),
    discoveredModels,
    thinkingOptionsByModel: normalizeOpencodeThinkingOptionsByModel(config.thinkingOptionsByModel, discoveredModels),
  };
}

function cloneModes(modes: OpencodeMode[]): OpencodeMode[] {
  return modes.map((mode) => ({ ...mode }));
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
    availableModes: cloneModes(state.availableModes),
    discoveredModels: cloneDiscoveredModels(state.discoveredModels),
    thinkingOptionsByModel: cloneThinkingOptionsByModel(state.thinkingOptionsByModel),
  };
}

export function updateOpencodeDiscoveryState(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeDiscoveryState>,
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextAvailableModes = 'availableModes' in updates
    ? normalizeOpencodeAvailableModes(updates.availableModes)
    : state.availableModes;
  const nextDiscoveredModels = 'discoveredModels' in updates
    ? normalizeOpencodeDiscoveredModels(updates.discoveredModels)
    : state.discoveredModels;
  const nextThinkingOptionsByModel = 'thinkingOptionsByModel' in updates
    ? normalizeOpencodeThinkingOptionsByModel(updates.thinkingOptionsByModel, nextDiscoveredModels)
    : state.thinkingOptionsByModel;
  const changed = !sameModes(state.availableModes, nextAvailableModes)
    || !sameDiscoveredModels(state.discoveredModels, nextDiscoveredModels)
    || !sameThinkingOptionsByModel(state.thinkingOptionsByModel, nextThinkingOptionsByModel);

  if (!changed) {
    return false;
  }

  state.availableModes = cloneModes(nextAvailableModes);
  state.discoveredModels = cloneDiscoveredModels(nextDiscoveredModels);
  state.thinkingOptionsByModel = cloneThinkingOptionsByModel(nextThinkingOptionsByModel);
  setProviderConfig(settings, 'opencode', { ...getProviderConfig(settings, 'opencode'), ...state });
  return true;
}
