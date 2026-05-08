import { sameDiscoveredModels, sameModes } from './internal/compareCollections';
import {
  type GeminiDiscoveredModel,
  normalizeGeminiDiscoveredModels,
} from './models';
import {
  type GeminiMode,
  normalizeGeminiAvailableModes,
} from './modes';

const GEMINI_DISCOVERY_STATE = Symbol('geminiDiscoveryState');

interface GeminiDiscoveryState {
  availableModes: GeminiMode[];
  discoveredModels: GeminiDiscoveredModel[];
}

type SettingsBag = Record<string | symbol, unknown>;

function ensureDiscoveryState(settings: Record<string, unknown>): GeminiDiscoveryState {
  const bag = settings as SettingsBag;
  const existing = bag[GEMINI_DISCOVERY_STATE];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as GeminiDiscoveryState;
  }

  const next: GeminiDiscoveryState = {
    availableModes: [],
    discoveredModels: [],
  };
  bag[GEMINI_DISCOVERY_STATE] = next;
  return next;
}

function cloneModes(modes: GeminiMode[]): GeminiMode[] {
  return modes.map((mode) => ({ ...mode }));
}

function cloneDiscoveredModels(models: GeminiDiscoveredModel[]): GeminiDiscoveredModel[] {
  return models.map((model) => ({ ...model }));
}

export function getGeminiDiscoveryState(settings: Record<string, unknown>): GeminiDiscoveryState {
  const state = ensureDiscoveryState(settings);
  return {
    availableModes: cloneModes(state.availableModes),
    discoveredModels: cloneDiscoveredModels(state.discoveredModels),
  };
}

export function updateGeminiDiscoveryState(
  settings: Record<string, unknown>,
  updates: Partial<GeminiDiscoveryState>,
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextAvailableModes = 'availableModes' in updates
    ? normalizeGeminiAvailableModes(updates.availableModes)
    : state.availableModes;
  const nextDiscoveredModels = 'discoveredModels' in updates
    ? normalizeGeminiDiscoveredModels(updates.discoveredModels)
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

export function clearGeminiDiscoveryState(settings: Record<string, unknown>): boolean {
  const state = ensureDiscoveryState(settings);
  if (state.availableModes.length === 0 && state.discoveredModels.length === 0) {
    return false;
  }

  state.availableModes = [];
  state.discoveredModels = [];
  return true;
}

export function seedGeminiDiscoveryStateFromLegacyConfig(
  settings: Record<string, unknown>,
  legacyConfig: Record<string, unknown>,
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextAvailableModes = state.availableModes.length > 0
    ? state.availableModes
    : normalizeGeminiAvailableModes(legacyConfig.availableModes);
  const nextDiscoveredModels = state.discoveredModels.length > 0
    ? state.discoveredModels
    : normalizeGeminiDiscoveredModels(legacyConfig.discoveredModels);

  return updateGeminiDiscoveryState(settings, {
    availableModes: nextAvailableModes,
    discoveredModels: nextDiscoveredModels,
  });
}
