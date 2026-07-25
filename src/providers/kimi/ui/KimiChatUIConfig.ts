import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { KIMI_PROVIDER_ICON } from '../../../shared/icons';
import { getKimiDiscoveryState } from '../discoveryState';
import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  resolveKimiThinkingLevel,
} from '../models';
import { getKimiProviderSettings, updateKimiProviderSettings } from '../settings';

const DEFAULT_CONTEXT_WINDOW = 200_000;
const KIMI_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Default',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

export const kimiChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const kimiSettings = getKimiProviderSettings(settings);
    const discovered = new Map(
      getKimiDiscoveryState(settings).discoveredModels.map((model) => [model.rawId, model] as const),
    );
    const visibleRawIds = kimiSettings.visibleModels ?? [...discovered.keys()];
    const options: ProviderUIOption[] = [];
    const seenValues = new Set<string>();

    for (const rawId of visibleRawIds) {
      const value = encodeKimiModelId(rawId);
      if (!value || seenValues.has(value)) {
        continue;
      }
      seenValues.add(value);
      const model = discovered.get(rawId);
      options.push({
        description: model?.description ?? (model ? 'ACP runtime' : 'Configured model'),
        label: kimiSettings.modelAliases[rawId] ?? model?.label ?? rawId,
        value,
      });
    }

    return options;
  },

  getDefaultModel(settings): string | null {
    return this.getModelOptions(settings)[0]?.value ?? null;
  },

  ownsModel(model: string): boolean {
    return isKimiModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
    return getKimiThinkingOptions(model, settings).length > 0;
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    return getKimiThinkingOptions(model, settings)
      .map((option) => ({
        description: option.description,
        label: option.label,
        value: option.value,
      }));
  },

  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
    const rawModelId = decodeKimiModelId(model);
    if (!rawModelId) {
      return '';
    }

    const kimiSettings = getKimiProviderSettings(settings);
    const discovery = getKimiDiscoveryState(settings);
    return resolveKimiThinkingLevel(
      discovery.thinkingOptionsByModel[rawModelId] ?? [],
      kimiSettings.preferredThinkingByModel[rawModelId],
      discovery.currentThinkingByModel[rawModelId],
    );
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isKimiModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    if (!isKimiModelSelectionId(model)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    settingsBag.model = model;
    const defaultEffort = this.getDefaultReasoningValue(model, settingsBag);
    if (defaultEffort) {
      settingsBag.effortLevel = defaultEffort;
    } else {
      delete settingsBag.effortLevel;
    }
  },

  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeKimiModelId(model);
    if (!rawModelId) {
      return;
    }

    const kimiSettings = getKimiProviderSettings(settingsBag);
    const supportedValues = new Set(
      (getKimiDiscoveryState(settingsBag).thinkingOptionsByModel[rawModelId] ?? [])
        .map((option) => option.value),
    );
    const preferredThinkingByModel = { ...kimiSettings.preferredThinkingByModel };
    if (!value || !supportedValues.has(value)) {
      delete preferredThinkingByModel[rawModelId];
    } else {
      preferredThinkingByModel[rawModelId] = value;
    }

    updateKimiProviderSettings(settingsBag, { preferredThinkingByModel });
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getModeSelector(): null {
    return null;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return KIMI_PERMISSION_MODE_TOGGLE;
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    (settings as Record<string, unknown>).permissionMode = value;
  },

  getProviderIcon() {
    return KIMI_PROVIDER_ICON;
  },
};

function getKimiThinkingOptions(
  model: string,
  settings: Record<string, unknown>,
): ProviderReasoningOption[] {
  const rawModelId = decodeKimiModelId(model);
  if (!rawModelId) {
    return [];
  }

  return getKimiDiscoveryState(settings).thinkingOptionsByModel[rawModelId] ?? [];
}
