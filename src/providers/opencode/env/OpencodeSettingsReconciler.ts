import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { clearOpencodeDiscoveryState } from '../discoveryState';
import { sameStringList, sameStringMap } from '../internal/compareCollections';
import { ensureProviderProjectionMap } from '../internal/providerProjection';
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
  hasLegacyOpencodeDiscoveryFields,
  normalizeOpencodePreferredThinkingByModel,
  normalizeOpencodeVisibleModels,
  updateOpencodeProviderSettings,
} from '../settings';
import { getOpencodeState } from '../types';

interface NormalizedSelection {
  baseModelId: string | null;
  variant: string | null;
}

const OPENCODE_ENV_HASH_KEYS = [
  'OPENCODE_CONFIG',
  'OPENCODE_DB',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'XDG_DATA_HOME',
] as const;

function computeOpencodeEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return OPENCODE_ENV_HASH_KEYS
    .filter((key) => envVars[key])
    .map((key) => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

function invalidateOpencodeConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.providerId !== 'opencode') {
      continue;
    }

    const state = getOpencodeState(conversation.providerState);
    if (!conversation.sessionId && !state.databasePath) {
      continue;
    }

    conversation.sessionId = null;
    conversation.providerState = undefined;
    invalidatedConversations.push(conversation);
  }
  return invalidatedConversations;
}

export const opencodeSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings: Record<string, unknown>): boolean {
    return clearOpencodeDiscoveryState(settings);
  },

  invalidateConversationSessions: invalidateOpencodeConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'opencode');
    const currentHash = computeOpencodeEnvHash(envText);
    const savedHash = getOpencodeProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateOpencodeConversationSessions(conversations);

    updateOpencodeProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const hadLegacyDiscoveryFields = hasLegacyOpencodeDiscoveryFields(settings);
    if (hadLegacyDiscoveryFields) {
      updateOpencodeProviderSettings(settings, {});
    }

    const opencodeSettings = getOpencodeProviderSettings(settings);
    let changed = hadLegacyDiscoveryFields;

    const normalizeSelection = (value: unknown): NormalizedSelection => {
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

    const savedProviderModelRaw = settings.savedProviderModel;
    if (savedProviderModelRaw && typeof savedProviderModelRaw === 'object' && !Array.isArray(savedProviderModelRaw)) {
      const savedProviderModel = savedProviderModelRaw as Record<string, unknown>;
      const savedSelection = normalizeSelection(savedProviderModel.opencode);
      if (
        typeof savedProviderModel.opencode === 'string'
        && savedSelection.baseModelId
        && savedProviderModel.opencode !== savedSelection.baseModelId
      ) {
        savedProviderModel.opencode = savedSelection.baseModelId;
        changed = true;
      }
      if (savedSelection.variant) {
        const savedEffort = ensureProviderProjectionMap(settings, 'savedProviderEffort');
        if (typeof savedEffort.opencode !== 'string') {
          savedEffort.opencode = savedSelection.variant;
          changed = true;
        }
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
    const shouldUpdateProviderSettings = !sameStringList(normalizedVisibleModels, opencodeSettings.visibleModels)
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
