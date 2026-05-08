import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { clearGeminiDiscoveryState } from '../discoveryState';
import { sameStringList, sameStringMap } from '../internal/compareCollections';
import { ensureProviderProjectionMap } from '../internal/providerProjection';
import {
  decodeGeminiModelId,
  encodeGeminiModelId,
  extractGeminiModelVariantValue,
  GEMINI_DEFAULT_THINKING_LEVEL,
  isGeminiModelSelectionId,
  resolveGeminiBaseModelRawId,
} from '../models';
import {
  getGeminiProviderSettings,
  hasLegacyGeminiDiscoveryFields,
  normalizeGeminiPreferredThinkingByModel,
  normalizeGeminiVisibleModels,
  updateGeminiProviderSettings,
} from '../settings';
import { getGeminiState } from '../types';

interface NormalizedSelection {
  baseModelId: string | null;
  variant: string | null;
}

const GEMINI_ENV_HASH_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'XDG_DATA_HOME',
] as const;

function computeGeminiEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return GEMINI_ENV_HASH_KEYS
    .filter((key) => envVars[key])
    .map((key) => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const geminiSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings: Record<string, unknown>): boolean {
    return clearGeminiDiscoveryState(settings);
  },

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'gemini');
    const currentHash = computeGeminiEnvHash(envText);
    const savedHash = getGeminiProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conversation of conversations) {
      if (conversation.providerId !== 'gemini') {
        continue;
      }

      const state = getGeminiState(conversation.providerState);
      if (!conversation.sessionId && !state.databasePath) {
        continue;
      }

      conversation.sessionId = null;
      conversation.providerState = undefined;
      invalidatedConversations.push(conversation);
    }

    updateGeminiProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const hadLegacyDiscoveryFields = hasLegacyGeminiDiscoveryFields(settings);
    if (hadLegacyDiscoveryFields) {
      updateGeminiProviderSettings(settings, {});
    }

    const geminiSettings = getGeminiProviderSettings(settings);
    let changed = hadLegacyDiscoveryFields;

    const normalizeSelection = (value: unknown): NormalizedSelection => {
      if (typeof value !== 'string' || !isGeminiModelSelectionId(value)) {
        return { baseModelId: null, variant: null };
      }

      const rawModelId = decodeGeminiModelId(value);
      if (!rawModelId) {
        return { baseModelId: value, variant: null };
      }

      const baseRawId = resolveGeminiBaseModelRawId(rawModelId, geminiSettings.discoveredModels);
      return {
        baseModelId: encodeGeminiModelId(baseRawId),
        variant: extractGeminiModelVariantValue(rawModelId, geminiSettings.discoveredModels),
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

    const savedProviderModelRaw = settings.savedProviderModel;
    if (savedProviderModelRaw && typeof savedProviderModelRaw === 'object' && !Array.isArray(savedProviderModelRaw)) {
      const savedProviderModel = savedProviderModelRaw as Record<string, unknown>;
      const savedSelection = normalizeSelection(savedProviderModel.gemini);
      if (
        typeof savedProviderModel.gemini === 'string'
        && savedSelection.baseModelId
        && savedProviderModel.gemini !== savedSelection.baseModelId
      ) {
        savedProviderModel.gemini = savedSelection.baseModelId;
        changed = true;
      }
      if (savedSelection.variant) {
        const savedEffort = ensureProviderProjectionMap(settings, 'savedProviderEffort');
        if (typeof savedEffort.gemini !== 'string') {
          savedEffort.gemini = savedSelection.variant;
          changed = true;
        }
      }
    }

    const normalizedVisibleModels = normalizeGeminiVisibleModels(
      geminiSettings.visibleModels,
      geminiSettings.discoveredModels,
    );
    const normalizedPreferredThinking = normalizeGeminiPreferredThinkingByModel(
      geminiSettings.preferredThinkingByModel,
      geminiSettings.discoveredModels,
    );
    const shouldUpdateProviderSettings = !sameStringList(normalizedVisibleModels, geminiSettings.visibleModels)
      || !sameStringMap(normalizedPreferredThinking, geminiSettings.preferredThinkingByModel);
    if (shouldUpdateProviderSettings) {
      updateGeminiProviderSettings(settings, {
        preferredThinkingByModel: normalizedPreferredThinking,
        visibleModels: normalizedVisibleModels,
      });
      changed = true;
    }

    if (typeof settings.effortLevel === 'string' && !settings.effortLevel.trim()) {
      settings.effortLevel = GEMINI_DEFAULT_THINKING_LEVEL;
      changed = true;
    }

    return changed;
  },
};
