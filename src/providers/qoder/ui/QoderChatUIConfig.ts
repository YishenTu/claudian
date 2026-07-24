import {
  formatReasoningValueLabel,
} from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { QODER_PROVIDER_ICON } from '../../../shared/icons';
import {
  decodeQoderModelId,
  findQoderModel,
  getQoderAvailableReasoningEfforts,
  isQoderModelSelectionId,
  resolveQoderContextWindow,
  resolveQoderDefaultReasoningEffort,
} from '../models';
import { getQoderProviderSettings, updateQoderProviderSettings } from '../settings';

const QODER_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'default',
  inactiveLabel: 'Default',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'PLAN',
};

export const qoderChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const qoderSettings = getQoderProviderSettings(settings);
    const options: ProviderUIOption[] = [];
    const selected = new Set(qoderSettings.visibleModels);
    for (const model of qoderSettings.discoveredModels) {
      const value = `qoder/${model.rawId}`;
      if (selected.size > 0 && !selected.has(value)) {
        continue;
      }
      options.push({
        description: model.description ?? 'Discovered from qodercli',
        label: qoderSettings.modelAliases[model.rawId] ?? model.displayName,
        value,
      });
    }
    return options;
  },

  getDefaultModel(settings): string | null {
    return this.getModelOptions(settings)[0]?.value ?? null;
  },

  ownsModel(model): boolean {
    return isQoderModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return getQoderAvailableReasoningEfforts(getSelectedQoderModel(model, settings)).length > 0;
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return getQoderAvailableReasoningEfforts(getSelectedQoderModel(model, settings)).map(option => ({
      ...(option.description ? { description: option.description } : {}),
      label: formatReasoningValueLabel(option.value),
      value: option.value,
    }));
  },

  getDefaultReasoningValue(model, settings): string {
    const qoderSettings = getQoderProviderSettings(settings);
    const rawId = decodeQoderModelId(model);
    if (!rawId) {
      return '';
    }
    const efforts = getQoderAvailableReasoningEfforts(getSelectedQoderModel(model, settings));
    if (efforts.length === 0) {
      return '';
    }
    const preferred = qoderSettings.preferredEffortByModel[rawId];
    return resolveQoderDefaultReasoningEffort(
      getSelectedQoderModel(model, settings),
      preferred,
    );
  },

  getContextWindowSize(model, customLimits = {}, settings = {}): number {
    return resolveQoderContextWindow(
      model,
      getQoderProviderSettings(settings).discoveredModels,
      customLimits,
    );
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings) || !isQoderModelSelectionId(model)) {
      return;
    }
    settings.model = model;
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings) || !isQoderModelSelectionId(model)) {
      return;
    }
    const availableValues = new Set(
      this.getReasoningOptions(model, settings).map(option => option.value),
    );
    const current = typeof settings.effortLevel === 'string'
      ? settings.effortLevel.trim()
      : '';
    settings.effortLevel = availableValues.has(current)
      ? current
      : this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeQoderModelId(model);
    if (!rawId) {
      delete settings.effortLevel;
      return;
    }
    const next = { ...getQoderProviderSettings(settings).preferredEffortByModel };
    const supportedValues = new Set(
      getQoderAvailableReasoningEfforts(getSelectedQoderModel(model, settings))
        .map(option => option.value),
    );
    if (supportedValues.has(value)) {
      next[rawId] = value;
    } else {
      delete next[rawId];
    }
    updateQoderProviderSettings(settings, { preferredEffortByModel: next });
  },

  normalizeModelVariant(model): string {
    const rawId = decodeQoderModelId(model.trim());
    return rawId ? `qoder/${rawId}` : model;
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return QODER_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings): string | null {
    return getQoderProviderSettings(settings).selectedPermissionMode;
  },

  applyPermissionMode(value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    settings.permissionMode = value;
    updateQoderProviderSettings(settings, { selectedPermissionMode: value });
  },

  getModeSelector(): null {
    return null;
  },

  getProviderIcon() {
    return QODER_PROVIDER_ICON;
  },
};

function getSelectedQoderModel(
  model: string,
  settings: Record<string, unknown>,
) {
  const rawId = decodeQoderModelId(model);
  if (!rawId) {
    return null;
  }
  return findQoderModel(getQoderProviderSettings(settings).discoveredModels, rawId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
