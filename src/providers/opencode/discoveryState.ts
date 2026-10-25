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

function ensureDiscoveryState(config: Readonly<Record<string, unknown>>): OpencodeDiscoveryState {
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

/** Reads the discovery state of a stored OpenCode configuration. */
export function getOpencodeDiscoveryState(config: Readonly<Record<string, unknown>>): OpencodeDiscoveryState {
  const state = ensureDiscoveryState(config);
  return {
    discoveredModels: cloneDiscoveredModels(state.discoveredModels),
    thinkingOptionsByModel: cloneThinkingOptionsByModel(state.thinkingOptionsByModel),
  };
}

/** Updates the discovery state of a stored OpenCode configuration in place; returns whether it changed. */
export function updateOpencodeDiscoveryState(
  config: Record<string, unknown>,
  updates: Partial<OpencodeDiscoveryState>,
): boolean {
  const state = ensureDiscoveryState(config);
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
  Object.assign(config, state);
  return true;
}
