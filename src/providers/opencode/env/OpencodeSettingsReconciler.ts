import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  decodeOpencodeModelId,
  encodeOpencodeModelId,
  extractOpencodeModelVariantValue,
  isOpencodeModelSelectionId,
  OPENCODE_DEFAULT_THINKING_LEVEL,
  resolveOpencodeBaseModelRawId,
} from '../models';
import {
  getOpencodeProviderSettings,
  normalizeOpencodePreferredThinkingByModel,
  normalizeOpencodeVisibleModels,
  updateOpencodeProviderSettings,
} from '../settings';

export const opencodeSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(
    _settings: Record<string, unknown>,
    _conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    return { changed: false, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const opencodeSettings = getOpencodeProviderSettings(settings);
    let changed = false;

    const normalizeSelection = (value: unknown): { baseModelId: string | null; variant: string | null } => {
      if (typeof value !== 'string' || !isOpencodeModelSelectionId(value)) {
        return { baseModelId: null, variant: null };
      }

      const rawModelId = decodeOpencodeModelId(value);
      if (!rawModelId) {
        return { baseModelId: value, variant: null };
      }

      const baseRawId = resolveOpencodeBaseModelRawId(rawModelId, opencodeSettings.discoveredModels);
      return {
        baseModelId: encodeOpencodeModelId(baseRawId),
        variant: extractOpencodeModelVariantValue(rawModelId, opencodeSettings.discoveredModels),
      };
    };

    const modelSelection = normalizeSelection(settings.model);
    if (typeof settings.model === 'string' && modelSelection.baseModelId && settings.model !== modelSelection.baseModelId) {
      settings.model = modelSelection.baseModelId;
      changed = true;
    }
    if (
      modelSelection.variant
      && (typeof settings.effortLevel !== 'string' || settings.effortLevel.trim().length === 0)
    ) {
      settings.effortLevel = modelSelection.variant;
      changed = true;
    }

    const titleModelSelection = normalizeSelection(settings.titleGenerationModel);
    if (
      typeof settings.titleGenerationModel === 'string'
      && titleModelSelection.baseModelId
      && settings.titleGenerationModel !== titleModelSelection.baseModelId
    ) {
      settings.titleGenerationModel = titleModelSelection.baseModelId;
      changed = true;
    }

    const savedProviderModel = settings.savedProviderModel;
    if (savedProviderModel && typeof savedProviderModel === 'object' && !Array.isArray(savedProviderModel)) {
      const currentSavedModel = (savedProviderModel as Record<string, unknown>).opencode;
      const savedSelection = normalizeSelection(currentSavedModel);
      if (
        typeof currentSavedModel === 'string'
        && savedSelection.baseModelId
        && currentSavedModel !== savedSelection.baseModelId
      ) {
        (savedProviderModel as Record<string, unknown>).opencode = savedSelection.baseModelId;
        changed = true;
      }
      if (
        savedSelection.variant
        && (
          !settings.savedProviderEffort
          || typeof settings.savedProviderEffort !== 'object'
          || Array.isArray(settings.savedProviderEffort)
        )
      ) {
        settings.savedProviderEffort = {};
      }
      if (
        savedSelection.variant
        && settings.savedProviderEffort
        && typeof settings.savedProviderEffort === 'object'
        && !Array.isArray(settings.savedProviderEffort)
        && typeof (settings.savedProviderEffort as Record<string, unknown>).opencode !== 'string'
      ) {
        (settings.savedProviderEffort as Record<string, unknown>).opencode = savedSelection.variant;
        changed = true;
      }
    }

    const normalizedVisibleModels = normalizeOpencodeVisibleModels(
      opencodeSettings.visibleModels,
      opencodeSettings.discoveredModels,
    );
    const normalizedPreferredThinking = normalizeOpencodePreferredThinkingByModel(
      opencodeSettings.preferredThinkingByModel,
      opencodeSettings.discoveredModels,
    );
    const shouldUpdateProviderSettings = normalizedVisibleModels.length !== opencodeSettings.visibleModels.length
      || normalizedVisibleModels.some((entry, index) => entry !== opencodeSettings.visibleModels[index])
      || !sameStringMap(normalizedPreferredThinking, opencodeSettings.preferredThinkingByModel);
    if (shouldUpdateProviderSettings) {
      updateOpencodeProviderSettings(settings, {
        preferredThinkingByModel: normalizedPreferredThinking,
        visibleModels: normalizedVisibleModels,
      });
      changed = true;
    }

    if (typeof settings.effortLevel === 'string' && !settings.effortLevel.trim()) {
      settings.effortLevel = OPENCODE_DEFAULT_THINKING_LEVEL;
      changed = true;
    }

    return changed;
  },
};

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([key, value]) => right[key] === value);
}
