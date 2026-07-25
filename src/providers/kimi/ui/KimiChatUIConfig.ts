import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { KIMI_PROVIDER_ICON } from '../../../shared/icons';
import { getKimiDiscoveryState } from '../discoveryState';
import { encodeKimiModelId, isKimiModelSelectionId } from '../models';
import { getKimiProviderSettings } from '../settings';

const DEFAULT_CONTEXT_WINDOW = 200_000;

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

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(): string {
    return '';
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
    delete settingsBag.effortLevel;
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

  getPermissionModeToggle(): null {
    return null;
  },

  getProviderIcon() {
    return KIMI_PROVIDER_ICON;
  },
};
