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

const OPENCODE_DISCOVERY_STATE = Symbol('opencodeDiscoveryState');

interface OpencodeDiscoveryState {
  availableModes: OpencodeMode[];
  discoveredModels: OpencodeDiscoveredModel[];
  thinkingOptionsByModel: OpencodeThinkingOptionsByModel;
}

type SettingsBag = Record<string | symbol, unknown>;

function ensureDiscoveryState(settings: Record<string, unknown>): OpencodeDiscoveryState {
  const bag = settings as SettingsBag;
  const existing = bag[OPENCODE_DISCOVERY_STATE];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const state = existing as Partial<OpencodeDiscoveryState>;
    state.availableModes ??= [];
    state.discoveredModels ??= [];
    state.thinkingOptionsByModel ??= {};
    return state as OpencodeDiscoveryState;
  }

  const next: OpencodeDiscoveryState = {
    availableModes: [],
    discoveredModels: [],
    thinkingOptionsByModel: {},
  };
  bag[OPENCODE_DISCOVERY_STATE] = next;
  return next;
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
  return true;
}

export function clearOpencodeDiscoveryState(settings: Record<string, unknown>): boolean {
  const state = ensureDiscoveryState(settings);
  if (
    state.availableModes.length === 0
    && state.discoveredModels.length === 0
    && Object.keys(state.thinkingOptionsByModel).length === 0
  ) {
    return false;
  }

  state.availableModes = [];
  state.discoveredModels = [];
  state.thinkingOptionsByModel = {};
  return true;
}

export function seedOpencodeDiscoveryStateFromLegacyConfig(
  settings: Record<string, unknown>,
  legacyConfig: Record<string, unknown>,
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextAvailableModes = state.availableModes.length > 0
    ? state.availableModes
    : normalizeOpencodeAvailableModes(legacyConfig.availableModes);
  const nextDiscoveredModels = state.discoveredModels.length > 0
    ? state.discoveredModels
    : normalizeOpencodeDiscoveredModels(legacyConfig.discoveredModels);
  const nextThinkingOptionsByModel = Object.keys(state.thinkingOptionsByModel).length > 0
    ? state.thinkingOptionsByModel
    : normalizeOpencodeThinkingOptionsByModel(legacyConfig.thinkingOptionsByModel, nextDiscoveredModels);

  return updateOpencodeDiscoveryState(settings, {
    availableModes: nextAvailableModes,
    discoveredModels: nextDiscoveredModels,
    thinkingOptionsByModel: nextThinkingOptionsByModel,
  });
}
