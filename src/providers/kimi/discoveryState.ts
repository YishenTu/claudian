import { type KimiDiscoveredModel, normalizeKimiDiscoveredModels } from './models';

// ACP session model discovery is runtime-owned; this symbol-keyed, non-persisted
// state mirrors the last catalog into the settings bag so UI configs can read it.
const KIMI_DISCOVERY_STATE = Symbol('kimiDiscoveryState');

interface KimiDiscoveryState {
  discoveredModels: KimiDiscoveredModel[];
}

type SettingsBag = Record<string | symbol, unknown>;

function ensureDiscoveryState(settings: Record<string, unknown>): KimiDiscoveryState {
  const bag = settings as SettingsBag;
  const existing = bag[KIMI_DISCOVERY_STATE];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const state = existing as Partial<KimiDiscoveryState>;
    state.discoveredModels ??= [];
    return state as KimiDiscoveryState;
  }

  const next: KimiDiscoveryState = { discoveredModels: [] };
  bag[KIMI_DISCOVERY_STATE] = next;
  return next;
}

export function getKimiDiscoveryState(settings: Record<string, unknown>): KimiDiscoveryState {
  return {
    discoveredModels: ensureDiscoveryState(settings).discoveredModels.map((model) => ({ ...model })),
  };
}

export function updateKimiDiscoveryState(
  settings: Record<string, unknown>,
  updates: Partial<KimiDiscoveryState>,
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextDiscoveredModels = 'discoveredModels' in updates
    ? normalizeKimiDiscoveredModels(updates.discoveredModels)
    : state.discoveredModels;

  if (sameDiscoveredModels(state.discoveredModels, nextDiscoveredModels)) {
    return false;
  }

  state.discoveredModels = nextDiscoveredModels.map((model) => ({ ...model }));
  return true;
}

export function clearKimiDiscoveryState(settings: Record<string, unknown>): boolean {
  const state = ensureDiscoveryState(settings);
  if (state.discoveredModels.length === 0) {
    return false;
  }

  state.discoveredModels = [];
  return true;
}

function sameDiscoveredModels(
  left: KimiDiscoveredModel[],
  right: KimiDiscoveredModel[],
): boolean {
  return left.length === right.length
    && left.every((model, index) => {
      const other = right[index];
      return model.rawId === other.rawId
        && model.label === other.label
        && (model.description ?? '') === (other.description ?? '');
    });
}
