import {
  type KimiDiscoveredModel,
  type KimiThinkingOption,
  normalizeKimiDiscoveredModels,
  normalizeKimiThinkingOptions,
} from './models';

// ACP session model/thinking discovery is runtime-owned; this symbol-keyed,
// non-persisted state mirrors the last catalog into the settings bag so UI
// configs can read it.
const KIMI_DISCOVERY_STATE = Symbol('kimiDiscoveryState');

interface KimiDiscoveryState {
  currentThinkingByModel: Record<string, string>;
  discoveredModels: KimiDiscoveredModel[];
  thinkingOptionsByModel: Record<string, KimiThinkingOption[]>;
}

type SettingsBag = Record<string | symbol, unknown>;

function ensureDiscoveryState(settings: Record<string, unknown>): KimiDiscoveryState {
  const bag = settings as SettingsBag;
  const existing = bag[KIMI_DISCOVERY_STATE];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const state = existing as Partial<KimiDiscoveryState>;
    state.discoveredModels ??= [];
    state.thinkingOptionsByModel ??= {};
    state.currentThinkingByModel ??= {};
    return state as KimiDiscoveryState;
  }

  const next: KimiDiscoveryState = {
    currentThinkingByModel: {},
    discoveredModels: [],
    thinkingOptionsByModel: {},
  };
  bag[KIMI_DISCOVERY_STATE] = next;
  return next;
}

export function getKimiDiscoveryState(settings: Record<string, unknown>): KimiDiscoveryState {
  const state = ensureDiscoveryState(settings);
  return {
    currentThinkingByModel: { ...state.currentThinkingByModel },
    discoveredModels: state.discoveredModels.map((model) => ({ ...model })),
    thinkingOptionsByModel: Object.fromEntries(
      Object.entries(state.thinkingOptionsByModel).map(([rawId, options]) => [
        rawId,
        options.map((option) => ({ ...option })),
      ]),
    ),
  };
}

export function updateKimiDiscoveryState(
  settings: Record<string, unknown>,
  updates: {
    currentThinkingByModel?: Record<string, unknown>;
    discoveredModels?: unknown;
    thinkingOptionsByModel?: Record<string, unknown>;
  },
): boolean {
  const state = ensureDiscoveryState(settings);
  const nextDiscoveredModels = updates.discoveredModels !== undefined
    ? normalizeKimiDiscoveredModels(updates.discoveredModels)
    : state.discoveredModels;
  const nextThinkingOptionsByModel = updates.thinkingOptionsByModel !== undefined
    ? normalizeThinkingOptionsByModel(updates.thinkingOptionsByModel)
    : state.thinkingOptionsByModel;
  const nextCurrentThinkingByModel = updates.currentThinkingByModel !== undefined
    ? normalizeCurrentThinkingByModel(updates.currentThinkingByModel)
    : state.currentThinkingByModel;

  if (
    sameDiscoveredModels(state.discoveredModels, nextDiscoveredModels)
    && sameThinkingOptionsByModel(state.thinkingOptionsByModel, nextThinkingOptionsByModel)
    && sameStringMap(state.currentThinkingByModel, nextCurrentThinkingByModel)
  ) {
    return false;
  }

  state.discoveredModels = nextDiscoveredModels.map((model) => ({ ...model }));
  state.thinkingOptionsByModel = Object.fromEntries(
    Object.entries(nextThinkingOptionsByModel).map(([rawId, options]) => [
      rawId,
      options.map((option) => ({ ...option })),
    ]),
  );
  state.currentThinkingByModel = { ...nextCurrentThinkingByModel };
  return true;
}

export function clearKimiDiscoveryState(settings: Record<string, unknown>): boolean {
  const state = ensureDiscoveryState(settings);
  if (
    state.discoveredModels.length === 0
    && Object.keys(state.thinkingOptionsByModel).length === 0
    && Object.keys(state.currentThinkingByModel).length === 0
  ) {
    return false;
  }

  state.discoveredModels = [];
  state.thinkingOptionsByModel = {};
  state.currentThinkingByModel = {};
  return true;
}

function normalizeThinkingOptionsByModel(
  value: Record<string, unknown>,
): Record<string, KimiThinkingOption[]> {
  const normalized: Record<string, KimiThinkingOption[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rawId = key.trim();
    const options = normalizeKimiThinkingOptions(entry);
    if (!rawId || options.length === 0) {
      continue;
    }
    normalized[rawId] = options;
  }
  return normalized;
}

function normalizeCurrentThinkingByModel(
  value: Record<string, unknown>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rawId = key.trim();
    const level = typeof entry === 'string' ? entry.trim() : '';
    if (!rawId || !level) {
      continue;
    }
    normalized[rawId] = level;
  }
  return normalized;
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

function sameThinkingOptionsByModel(
  left: Record<string, KimiThinkingOption[]>,
  right: Record<string, KimiThinkingOption[]>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => {
      const leftOptions = left[key];
      const rightOptions = right[key];
      return Array.isArray(rightOptions)
        && leftOptions.length === rightOptions.length
        && leftOptions.every((option, index) => {
          const other = rightOptions[index];
          return option.value === other.value
            && option.label === other.label
            && (option.description ?? '') === (other.description ?? '');
        });
    });
}

function sameStringMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}
