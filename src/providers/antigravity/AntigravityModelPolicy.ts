import { DEFAULT_REASONING_VALUE } from '@/core/providers/reasoning';
import type {
  ProviderModelPolicy,
  ProviderUIOption,
} from '@/core/providers/types';

import {
  decodeAntigravityModelId,
  DEFAULT_ANTIGRAVITY_MODEL,
  encodeAntigravityModelId,
  getAntigravityEffectiveModels,
  isAntigravityModelSelectionId,
} from './models';
import { ANTIGRAVITY_PERMISSION_MODE_POLICY } from './permissionModes';
import {
  getAntigravityProviderSettings,
} from './settings';

export const antigravityModelPolicy: ProviderModelPolicy = {
  permissionModes: ANTIGRAVITY_PERMISSION_MODE_POLICY,

  getModelOptions(settings): ProviderUIOption[] {
    const providerSettings = getAntigravityProviderSettings(settings);
    const effectiveModels = getAntigravityEffectiveModels(providerSettings.discoveredModels);
    const modelMap = new Map(effectiveModels.map(m => [m.rawId, m]));

    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const rawId of providerSettings.visibleModels) {
      if (seen.has(rawId)) continue;
      seen.add(rawId);
      const model = modelMap.get(rawId);
      const encoded = encodeAntigravityModelId(rawId);
      options.push({
        value: encoded,
        label: model?.label ?? rawId,
        description: model?.description ?? 'Google Antigravity model',
      });
    }

    if (options.length === 0) {
      for (const model of effectiveModels) {
        options.push({
          value: encodeAntigravityModelId(model.rawId),
          label: model.label,
          description: model.description ?? 'Google Antigravity model',
        });
      }
    }

    return options;
  },

  getDefaultModel(settings: Record<string, unknown>): string | null {
    const current = getAntigravityProviderSettings(settings);
    const selected = current.selectedModel || DEFAULT_ANTIGRAVITY_MODEL;
    return encodeAntigravityModelId(selected);
  },

  ownsModel(model: string): boolean {
    return isAntigravityModelSelectionId(model);
  },

  supportsReasoningEffort(model: string): boolean {
    const raw = decodeAntigravityModelId(model);
    return Boolean(raw && (raw.includes('-high') || raw.includes('-medium') || raw.includes('-low')));
  },

  getReasoningOptions(model: string): ProviderUIOption[] {
    const raw = decodeAntigravityModelId(model);
    if (!raw) return [];
    return [
      { value: 'low', label: 'Low', description: 'Low reasoning effort' },
      { value: 'medium', label: 'Medium', description: 'Medium reasoning effort' },
      { value: 'high', label: 'High', description: 'High reasoning effort' },
    ];
  },

  getDefaultReasoningValue(model: string): string {
    const raw = decodeAntigravityModelId(model);
    if (raw?.endsWith('-low')) return 'low';
    if (raw?.endsWith('-medium')) return 'medium';
    if (raw?.endsWith('-high')) return 'high';
    return DEFAULT_REASONING_VALUE;
  },

  isDefaultModel(model: string): boolean {
    return isAntigravityModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const settingsBag = settings as Record<string, unknown>;
    const raw = decodeAntigravityModelId(model);
    if (raw) {
      settingsBag.model = encodeAntigravityModelId(raw);
    }
  },

  applyModelProjectionDefaults(model: string, settings: unknown): void {
    antigravityModelPolicy.applyModelDefaults?.(model, settings);
  },

  normalizeAvailableModelSelection(model: string): string {
    return isAntigravityModelSelectionId(model)
      ? model
      : encodeAntigravityModelId(model);
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },
};
