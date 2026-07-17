import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';
import { getCodexModelOptions } from '../modelOptions';
import {
  findCodexModel,
  getCodexDefaultReasoningEffort,
  getCodexFastServiceTier,
  getDefaultCodexModel,
} from '../models';
import {
  isCodexModelSelectionId,
  looksLikeCodexModel,
  toCodexRuntimeModelId,
} from '../modelSelection';
import {
  applyCodexModelDefaults,
  getCodexProviderSettings,
  getVisibleCodexModelIds,
} from '../settings';

const EFFORT_LEVELS: ProviderReasoningOption[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
].map(value => ({ value, label: formatReasoningValueLabel(value) }));

const CODEX_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};

const DEFAULT_SERVICE_TIER_VALUE = 'default';
const DEFAULT_SERVICE_TIER_LABEL = 'Standard';

const DEFAULT_CONTEXT_WINDOW = 200_000;

function getVisibleDiscoveredModels(settings: Record<string, unknown>) {
  const codexSettings = getCodexProviderSettings(settings);
  const visibleModelIds = new Set(getVisibleCodexModelIds(
    codexSettings.visibleModels,
    codexSettings.discoveredModels,
  ));
  return codexSettings.discoveredModels.filter(model => visibleModelIds.has(model.model));
}

export const codexChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    return getCodexModelOptions(settings);
  },

  getDefaultModel(settings: Record<string, unknown>): string | null {
    return getDefaultCodexModel(getVisibleDiscoveredModels(settings))?.model ?? null;
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (isCodexModelSelectionId(model)) {
      return true;
    }

    const runtimeModel = toCodexRuntimeModelId(model);
    if (getCodexModelOptions(settings).some((option: ProviderUIOption) =>
      option.value === model || toCodexRuntimeModelId(option.value) === runtimeModel
    )) {
      return true;
    }

    return looksLikeCodexModel(runtimeModel);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(modelId: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    const model = findCodexModel(
      getCodexProviderSettings(settings).discoveredModels,
      modelId,
    );
    if (!model) {
      return [...EFFORT_LEVELS];
    }

    return model.supportedReasoningEfforts.map(option => ({
      value: option.value,
      label: formatReasoningValueLabel(option.value),
      ...(option.description ? { description: option.description } : {}),
    }));
  },

  getDefaultReasoningValue(modelId: string, settings: Record<string, unknown>): string {
    const model = findCodexModel(
      getCodexProviderSettings(settings).discoveredModels,
      modelId,
    );
    return model ? getCodexDefaultReasoningEffort(model) : DEFAULT_REASONING_VALUE;
  },

  getContextWindowSize(): number {
    return DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return looksLikeCodexModel(toCodexRuntimeModelId(model)) && !isCodexModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object') {
      return;
    }

    applyCodexModelDefaults(toCodexRuntimeModelId(model), settings as Record<string, unknown>);
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    const runtimeModel = toCodexRuntimeModelId(model);
    const option = getCodexModelOptions(settings).find((candidate) =>
      candidate.value === model || toCodexRuntimeModelId(candidate.value) === runtimeModel
    );
    if (option) {
      return option.value;
    }

    const codexSettings = getCodexProviderSettings(settings);
    const discoveredModels = codexSettings.discoveredModels;
    if (discoveredModels.length === 0) {
      return model;
    }

    return getDefaultCodexModel(getVisibleDiscoveredModels(settings))?.model ?? model;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.OPENAI_MODEL && !looksLikeCodexModel(envVars.OPENAI_MODEL)) {
      ids.add(envVars.OPENAI_MODEL);
    }
    return ids;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return CODEX_PERMISSION_MODE_TOGGLE;
  },

  getServiceTierToggle(settings): ProviderServiceTierToggleConfig | null {
    const model = findCodexModel(
      getCodexProviderSettings(settings).discoveredModels,
      typeof settings.model === 'string' ? settings.model : undefined,
    );
    if (!model) {
      return null;
    }

    const tier = getCodexFastServiceTier(model);
    if (!tier) {
      return null;
    }

    return {
      inactiveValue: model.defaultServiceTier ?? DEFAULT_SERVICE_TIER_VALUE,
      inactiveLabel: DEFAULT_SERVICE_TIER_LABEL,
      activeValue: tier.id,
      activeLabel: tier.name,
      description: tier.description || undefined,
    };
  },

  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
