import { sameDiscoveredModels, sameModes, sameThinkingOptionsByModel } from './internal/compareCollections';
import {
  type KimiDiscoveredModel,
  type KimiThinkingOptionsByModel,
  normalizeKimiDiscoveredModels,
  normalizeKimiThinkingOptionsByModel,
} from './models';
import {
  type KimiMode,
  normalizeKimiAvailableModes,
} from './modes';

const KIMI_DISCOVERY_STATE = Symbol('kimiDiscoveryState');

interface KimiDiscoveryState {
  availableModes: KimiMode[];
  discoveredModels: KimiDiscoveredModel[];
  thinkingOptionsByModel: KimiThinkingOptionsByModel;
}

type SettingsBag = Record<string | symbol, unknown>;

function ensureDiscoveryState(settings: Record<string, unknown>): KimiDiscoveryState {
  const bag = settings as SettingsBag;
  const existing = bag[KIMI_DISCOVERY_STATE];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const state = existing as Partial<KimiDiscoveryState>;
    state.availableModes ??= [];
    state.discoveredModels ??= [];
    state.thinkingOptionsByModel ??= {};
    return state as KimiDiscoveryState;
  }

  const next: KimiDiscoveryState = {
    availableModes: [],
    discoveredModels: [],
    thinkingOptionsByModel: {},
  };
  bag[KIMI_DISCOVERY_STATE] = next;
  return next;
}

function cloneModes(modes: KimiMode[]): KimiMode[] {
  return modes.map((mode) => ({ ...mode }));
}

function cloneDiscoveredModels(models: KimiDiscoveredModel[]): KimiDiscoveredModel[] {
  return models.map((model) => ({ ...model }));
}

function cloneThinkingOptionsByModel(
  optionsByModel: KimiThinkingOptionsByModel,
): KimiThinkingOptionsByModel {
  return Object.fromEntries(
    Object.entries(optionsByModel).map(([rawId, options]) => [
      rawId,
      options.map((option) => ({ ...option })),
    ]),
  );
}

export function getKimiDiscoveryState(settings: Record<string, unknown>): KimiDiscoveryState {
  const state = ensureDiscoveryState(settings);
  return {
    availableModes: cloneModes(state.availableModes),
    discoveredModels: cloneDiscoveredModels(state.discoveredModels),
    thinkingOptionsByModel: cloneThinkingOptionsByModel(state.thinkingOptionsByModel),
  };
}

export function updateKimiDiscoveryState(
  settings: Record<string, unknown>,
  updates: Partial<KimiDiscoveryState>,
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextAvailableModes = 'availableModes' in updates
    ? normalizeKimiAvailableModes(updates.availableModes)
    : state.availableModes;
  const nextDiscoveredModels = 'discoveredModels' in updates
    ? normalizeKimiDiscoveredModels(updates.discoveredModels)
    : state.discoveredModels;
  const nextThinkingOptionsByModel = 'thinkingOptionsByModel' in updates
    ? normalizeKimiThinkingOptionsByModel(updates.thinkingOptionsByModel, nextDiscoveredModels)
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

export function clearKimiDiscoveryState(settings: Record<string, unknown>): boolean {
  const bag = settings as SettingsBag;
  if (!(KIMI_DISCOVERY_STATE in bag)) {
    return false;
  }
  delete bag[KIMI_DISCOVERY_STATE];
  return true;
}

export function seedKimiDiscoveryStateFromLegacyConfig(
  settings: Record<string, unknown>,
  config: Record<string, unknown>,
): void {
  if (
    !('availableModes' in config)
    && !('discoveredModels' in config)
    && !('thinkingOptionsByModel' in config)
  ) {
    return;
  }

  updateKimiDiscoveryState(settings, {
    availableModes: normalizeKimiAvailableModes(config.availableModes),
    discoveredModels: normalizeKimiDiscoveredModels(config.discoveredModels),
    thinkingOptionsByModel: normalizeKimiThinkingOptionsByModel(
      config.thinkingOptionsByModel,
      normalizeKimiDiscoveredModels(config.discoveredModels),
    ),
  });
}
