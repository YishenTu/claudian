import {
  normalizeOpencodeDiscoveredModels,
  type OpencodeDiscoveredModel,
} from './models';
import {
  normalizeOpencodeAvailableModes,
  type OpencodeMode,
} from './modes';

const OPENCODE_DISCOVERY_STATE = Symbol('opencodeDiscoveryState');

interface OpencodeDiscoveryState {
  availableModes: OpencodeMode[];
  discoveredModels: OpencodeDiscoveredModel[];
}

type SettingsBag = Record<string | symbol, unknown>;

function ensureDiscoveryState(settings: Record<string, unknown>): OpencodeDiscoveryState {
  const bag = settings as SettingsBag;
  const existing = bag[OPENCODE_DISCOVERY_STATE];
  if (isDiscoveryState(existing)) {
    return existing;
  }

  const next: OpencodeDiscoveryState = {
    availableModes: [],
    discoveredModels: [],
  };
  bag[OPENCODE_DISCOVERY_STATE] = next;
  return next;
}

function isDiscoveryState(value: unknown): value is OpencodeDiscoveryState {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneModes(modes: OpencodeMode[]): OpencodeMode[] {
  return modes.map((mode) => ({ ...mode }));
}

function cloneDiscoveredModels(models: OpencodeDiscoveredModel[]): OpencodeDiscoveredModel[] {
  return models.map((model) => ({ ...model }));
}

function sameModes(left: OpencodeMode[], right: OpencodeMode[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((mode, index) => (
    mode.id === right[index]?.id
    && mode.name === right[index]?.name
    && (mode.description ?? '') === (right[index]?.description ?? '')
  ));
}

function sameDiscoveredModels(
  left: OpencodeDiscoveredModel[],
  right: OpencodeDiscoveredModel[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((model, index) => (
    model.rawId === right[index]?.rawId
    && model.label === right[index]?.label
    && (model.description ?? '') === (right[index]?.description ?? '')
  ));
}

export function getOpencodeDiscoveryState(settings: Record<string, unknown>): OpencodeDiscoveryState {
  const state = ensureDiscoveryState(settings);
  return {
    availableModes: cloneModes(state.availableModes),
    discoveredModels: cloneDiscoveredModels(state.discoveredModels),
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
  const changed = !sameModes(state.availableModes, nextAvailableModes)
    || !sameDiscoveredModels(state.discoveredModels, nextDiscoveredModels);

  if (!changed) {
    return false;
  }

  state.availableModes = cloneModes(nextAvailableModes);
  state.discoveredModels = cloneDiscoveredModels(nextDiscoveredModels);
  return true;
}

export function clearOpencodeDiscoveryState(settings: Record<string, unknown>): boolean {
  const state = ensureDiscoveryState(settings);
  if (state.availableModes.length === 0 && state.discoveredModels.length === 0) {
    return false;
  }

  state.availableModes = [];
  state.discoveredModels = [];
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

  return updateOpencodeDiscoveryState(settings, {
    availableModes: nextAvailableModes,
    discoveredModels: nextDiscoveredModels,
  });
}
