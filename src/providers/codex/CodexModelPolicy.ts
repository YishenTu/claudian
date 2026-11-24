import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../core/providers/reasoning';
import { createServiceTierPolicy } from '../../core/providers/serviceTier';
import type {
  ProviderModelPolicy,
  ProviderServiceTierPolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import { t } from '../../i18n/i18n';
import { getVisibleCodexModelIds } from './config';
import { getCodexModelOptions } from './modelOptions';
import {
  CODEX_DEFAULT_SERVICE_TIER,
  CODEX_FALLBACK_REASONING_EFFORT_VALUES,
  findCodexModel,
  getCodexDefaultReasoningEffort,
  getCodexFastServiceTier,
  getCodexReasoningEffortOptions,
  isCodexModelAvailable,
  resolveCodexModelServiceTierState,
} from './models';
import {
  encodeCodexModelSelectionId, isCodexModelSelectionId,
  looksLikeCodexModel,
  toCodexRuntimeModelId
} from './modelSelection';
import { CODEX_PERMISSION_MODE_POLICY } from './permissionModes';
import {
  applyCodexModelDefaults,
  getCodexProviderSettings,
} from './settings';

const EFFORT_LEVELS: ProviderUIOption[] = [
  ...CODEX_FALLBACK_REASONING_EFFORT_VALUES,
].map(value => ({ value, label: formatReasoningValueLabel(value) }));



function getVisibleDiscoveredModels(settings: Record<string, unknown>) {
  const codexSettings = getCodexProviderSettings(settings);
  const visibleModelIds = new Set(getVisibleCodexModelIds(
    codexSettings.visibleModels,
    codexSettings.discoveredModels,
  ));
  return codexSettings.discoveredModels.filter(model =>
    visibleModelIds.has(model.model)
    && isCodexModelAvailable(model, codexSettings.enableUltraEffort)
  );
}

export const codexModelPolicy: ProviderModelPolicy = {
  permissionModes: CODEX_PERMISSION_MODE_POLICY,
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    return getCodexModelOptions(getCodexProviderSettings(settings));
  },

  getDefaultModel(settings: Record<string, unknown>): string | null {
    const codexSettings = getCodexProviderSettings(settings);
    const firstVisibleModel = getVisibleCodexModelIds(
      codexSettings.visibleModels,
      codexSettings.discoveredModels,
    ).find(modelId => getVisibleDiscoveredModels(settings).some(model => model.model === modelId));
    return firstVisibleModel ? encodeCodexModelSelectionId(firstVisibleModel) : getCodexModelOptions(getCodexProviderSettings(settings))[0]?.value ?? null;
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (isCodexModelSelectionId(model)) {
      return true;
    }

    const runtimeModel = toCodexRuntimeModelId(model);
    return getCodexProviderSettings(settings).discoveredModels.some(candidate => candidate.model === runtimeModel)
      || looksLikeCodexModel(runtimeModel);
  },

  supportsReasoningEffort(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(modelId: string, settings: Record<string, unknown>): ProviderUIOption[] {
    const codexSettings = getCodexProviderSettings(settings);
    const model = findCodexModel(
      codexSettings.discoveredModels,
      modelId,
    );
    if (!model) {
      return [...EFFORT_LEVELS];
    }

    const options = getCodexReasoningEffortOptions(model, codexSettings.enableUltraEffort);
    if (options.every(option => option.value === 'none')) return [];
    return options.map(option => ({
      value: option.value,
      label: formatReasoningValueLabel(option.value),
      ...(option.description ? { description: option.description } : {}),
    }));
  },

  getDefaultReasoningValue(modelId: string, settings: Record<string, unknown>): string {
    const codexSettings = getCodexProviderSettings(settings);
    const model = findCodexModel(
      codexSettings.discoveredModels,
      modelId,
    );
    return model
      ? getCodexDefaultReasoningEffort(model, codexSettings.enableUltraEffort)
        ?? DEFAULT_REASONING_VALUE
      : DEFAULT_REASONING_VALUE;
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
    const option = getCodexModelOptions(getCodexProviderSettings(settings)).find((candidate) =>
      candidate.value === model || toCodexRuntimeModelId(candidate.value) === runtimeModel
    );
    if (option) {
      return option.value;
    }

    return this.ownsModel(model, settings) && !looksLikeCodexModel(runtimeModel)
      ? encodeCodexModelSelectionId(runtimeModel) : model;
  },


  getServiceTierPolicy(settings): ProviderServiceTierPolicy | null {
    const model = findCodexModel(
      getCodexProviderSettings(settings).discoveredModels,
      typeof settings.model === 'string' ? settings.model : undefined,
    );
    if (!model) {
      return null;
    }

    const fastTier = getCodexFastServiceTier(model);
    // Fast leads the accelerated tiers, whatever the catalog order, so it takes acceleration level 1.
    const tiers = model.serviceTiers.filter(tier => tier.id !== CODEX_DEFAULT_SERVICE_TIER && tier !== fastTier);
    const orderedTiers = fastTier ? [fastTier, ...tiers] : tiers;
    const resolved = resolveCodexModelServiceTierState(model, settings.serviceTier);
    return createServiceTierPolicy({
      standard: { value: CODEX_DEFAULT_SERVICE_TIER, label: t('chat.modelPicker.standard') },
      accelerated: orderedTiers.map(tier => ({
        value: tier.id,
        label: tier.name,
        ...(tier.description ? { description: tier.description } : {}),
        ...(tier === fastTier ? { isFast: true } : {}),
      })),
      selectedValue: resolved.kind === 'tier' ? resolved.tier.id : null,
    });
  }
};
