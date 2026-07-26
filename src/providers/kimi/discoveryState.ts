import { getProviderConfig } from '../../core/providers/providerConfig';
import {
  type KimiDiscoveredModel,
  type KimiThinkingOption,
  normalizeKimiDiscoveredModels,
  normalizeKimiThinkingOptions,
} from './models';

// ACP session model/thinking discovery is runtime-owned; this symbol-keyed
// state mirrors the last catalog into the settings bag so UI configs can read
// it. The catalog and per-model thinking state additionally persist in the
// provider config, and a cold mirror is seeded from that persisted copy.
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

function isColdDiscoveryState(state: KimiDiscoveryState): boolean {
  return state.discoveredModels.length === 0
    && Object.keys(state.thinkingOptionsByModel).length === 0
    && Object.keys(state.currentThinkingByModel).length === 0;
}

export function getKimiDiscoveryState(settings: Record<string, unknown>): KimiDiscoveryState {
  const state = ensureDiscoveryState(settings);
  if (isColdDiscoveryState(state)) {
    seedKimiDiscoveryStateFromConfig(settings, getProviderConfig(settings, 'kimi'));
  }
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
    ? normalizeKimiThinkingOptionsByModel(updates.thinkingOptionsByModel)
    : state.thinkingOptionsByModel;
  const nextCurrentThinkingByModel = updates.currentThinkingByModel !== undefined
    ? normalizeKimiCurrentThinkingByModel(updates.currentThinkingByModel)
    : state.currentThinkingByModel;

  if (
    sameKimiDiscoveredModels(state.discoveredModels, nextDiscoveredModels)
    && sameKimiThinkingOptionsByModel(state.thinkingOptionsByModel, nextThinkingOptionsByModel)
    && sameKimiCurrentThinkingByModel(state.currentThinkingByModel, nextCurrentThinkingByModel)
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

// Seeds only a fully cold mirror: once any field holds data, the mirror is
// fresher than the persisted copy (e.g. a session dropped its thinking rows)
// and must win.
export function seedKimiDiscoveryStateFromConfig(
  settings: Record<string, unknown>,
  config: Record<string, unknown>,
): boolean {
  const state = ensureDiscoveryState(settings);
  if (!isColdDiscoveryState(state)) {
    return false;
  }
  const discoveredModels = normalizeKimiDiscoveredModels(config.discoveredModels);
  const thinkingOptionsByModel = normalizeKimiThinkingOptionsByModel(config.thinkingOptionsByModel);
  const currentThinkingByModel = normalizeKimiCurrentThinkingByModel(config.currentThinkingByModel);
  if (
    discoveredModels.length === 0
    && Object.keys(thinkingOptionsByModel).length === 0
    && Object.keys(currentThinkingByModel).length === 0
  ) {
    return false;
  }
  return updateKimiDiscoveryState(settings, {
    currentThinkingByModel,
    discoveredModels,
    thinkingOptionsByModel,
  });
}

export function clearKimiDiscoveryState(settings: Record<string, unknown>): boolean {
  const state = ensureDiscoveryState(settings);
  if (isColdDiscoveryState(state)) {
    return false;
  }

  state.discoveredModels = [];
  state.thinkingOptionsByModel = {};
  state.currentThinkingByModel = {};
  return true;
}

export function normalizeKimiThinkingOptionsByModel(
  value: unknown,
): Record<string, KimiThinkingOption[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

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

export function normalizeKimiCurrentThinkingByModel(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

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

export function sameKimiDiscoveredModels(
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

export function sameKimiThinkingOptionsByModel(
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

export function sameKimiCurrentThinkingByModel(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left[key] === right[key]);
}
