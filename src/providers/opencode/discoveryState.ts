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

/** Reads the discovery state of a stored OpenCode configuration. */
export function getOpencodeDiscoveryState(config: Readonly<Record<string, unknown>>): OpencodeDiscoveryState {
  const discoveredModels = normalizeOpencodeDiscoveredModels(config.discoveredModels ?? config.selectedModels);
  return {
    discoveredModels,
    thinkingOptionsByModel: normalizeOpencodeThinkingOptionsByModel(config.thinkingOptionsByModel, discoveredModels),
  };
}

/** Updates the discovery state of a stored OpenCode configuration in place; returns whether it changed. */
export function updateOpencodeDiscoveryState(
  config: Record<string, unknown>,
  updates: Partial<OpencodeDiscoveryState>,
): boolean {
  const state = getOpencodeDiscoveryState(config);
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

  config.discoveredModels = nextDiscoveredModels;
  config.thinkingOptionsByModel = nextThinkingOptionsByModel;
  return true;
}
