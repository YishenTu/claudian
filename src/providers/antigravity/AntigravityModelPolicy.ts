import type {
  ProviderModelPolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import { getOrderedAntigravityVisibleModelIds } from './config';
import {
  type AntigravityModel,
  decodeAntigravityModelId,
  encodeAntigravityModelId,
  findAntigravityModel,
  isAntigravityModelSelectionId,
  resolveAntigravityDefaultReasoning,
} from './models';
import { ANTIGRAVITY_PERMISSION_MODE_POLICY } from './permissionModes';
import {
  ANTIGRAVITY_PROVIDER_ID,
  getAntigravityProviderSettings,
  updateAntigravityProviderSettings,
} from './settings';

export const antigravityModelPolicy: ProviderModelPolicy = {
  permissionModes: ANTIGRAVITY_PERMISSION_MODE_POLICY,

  getModelOptions(settings): ProviderUIOption[] {
    const current = getAntigravityProviderSettings(settings);
    const catalogModels = current.currentCatalog?.models ?? [];
    const options: ProviderUIOption[] = [];
    for (const rawId of getOrderedAntigravityVisibleModelIds(current)) {
      const model = catalogModels.find(entry => entry.rawId === rawId);
      const value = encodeAntigravityModelId(rawId);
      if (!model || options.some(option => option.value === value)) continue;
      options.push({
        label: Object.hasOwn(current.modelAliases, rawId) ? current.modelAliases[rawId] : model.displayName,
        value,
      });
    }
    return options;
  },

  getDefaultModel(settings): string | null {
    const current = getAntigravityProviderSettings(settings);
    const rawId = getOrderedAntigravityVisibleModelIds(current)
      .find(id => current.currentCatalog?.models.some(model => model.rawId === id));
    return rawId ? encodeAntigravityModelId(rawId) : null;
  },

  ownsModel(model): boolean {
    return isAntigravityModelSelectionId(model);
  },

  supportsReasoningEffort(model, settings): boolean {
    return (getSelectedModel(model, settings)?.reasoningEfforts.length ?? 0) > 0;
  },

  getReasoningOptions(model, settings): ProviderUIOption[] {
    return (getSelectedModel(model, settings)?.reasoningEfforts ?? [])
      .map(effort => ({ label: effort.label, value: effort.value }));
  },

  getDefaultReasoningValue(model, settings): string {
    const rawId = decodeAntigravityModelId(model);
    const selected = getSelectedModel(model, settings);
    if (!rawId || !selected) return '';
    const preferred = getAntigravityProviderSettings(settings).preferredReasoningByModel;
    return resolveAntigravityDefaultReasoning(selected, Object.hasOwn(preferred, rawId) ? preferred[rawId] : undefined);
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) return;
    const normalized = normalizeSelection(model);
    if (!isAntigravityModelSelectionId(normalized)) return;
    clearSavedEffortProjection(settings);
    settings.model = normalized;
    settings.effortLevel = this.getDefaultReasoningValue(normalized, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) return;
    clearSavedEffortProjection(settings);
    if (!decodeAntigravityModelId(model)) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) return;
    const rawId = decodeAntigravityModelId(model);
    if (!rawId) {
      clearSavedEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const supported = new Set(getSelectedModel(model, settings)?.reasoningEfforts.map(effort => effort.value) ?? []);
    const preferredReasoningByModel = { ...getAntigravityProviderSettings(settings).preferredReasoningByModel };
    if (supported.has(value)) {
      Object.defineProperty(preferredReasoningByModel, rawId, { value, enumerable: true, writable: true, configurable: true });
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateAntigravityProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },
};

/** Only enabled models resolve; a selection missing from the catalog has no reasoning options. */
function getSelectedModel(model: string, settings: Record<string, unknown>): AntigravityModel | null {
  const rawId = decodeAntigravityModelId(model);
  if (!rawId) return null;
  const current = getAntigravityProviderSettings(settings);
  const catalogModels = current.currentCatalog?.models ?? [];
  const visible = current.visibleModels ?? catalogModels.map(entry => entry.rawId);
  if (!visible.includes(rawId)) return null;
  return findAntigravityModel(catalogModels, rawId) ?? { displayName: rawId, rawId, reasoningEfforts: [] };
}

function normalizeSelection(model: string): string {
  const rawId = decodeAntigravityModelId(model);
  return rawId ? encodeAntigravityModelId(rawId) : model;
}

function clearSavedEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) delete settings.savedProviderEffort[ANTIGRAVITY_PROVIDER_ID];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
