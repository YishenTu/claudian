import * as crypto from 'node:crypto';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { clearKimiDiscoveryState } from '../discoveryState';
import { sameStringList, sameStringMap } from '../internal/compareCollections';
import { ensureProviderProjectionMap } from '../internal/providerProjection';
import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  KIMI_DEFAULT_THINKING_LEVEL,
  resolveKimiBaseModelRawId,
} from '../models';
import {
  getKimiProviderSettings,
  normalizeKimiPreferredThinkingByModel,
  normalizeKimiVisibleModels,
  updateKimiProviderSettings,
} from '../settings';
import { getKimiState } from '../types';

interface NormalizedSelection {
  baseModelId: string | null;
}

const KIMI_ENV_HASH_KEYS = [
  'KIMI_CODE_HOME',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
] as const;

function computeKimiEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  const canonical = KIMI_ENV_HASH_KEYS
    .filter((key) => envVars[key])
    .map((key) => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
  return canonical
    ? `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`
    : '';
}

function invalidateKimiConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.providerId !== 'kimi') {
      continue;
    }

    const state = getKimiState(conversation.providerState);
    if (!conversation.sessionId && !state.sessionId) {
      continue;
    }

    conversation.sessionId = null;
    conversation.providerState = undefined;
    invalidatedConversations.push(conversation);
  }
  return invalidatedConversations;
}

export const kimiSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings: Record<string, unknown>): boolean {
    return clearKimiDiscoveryState(settings);
  },

  invalidateConversationSessions: invalidateKimiConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'kimi');
    const currentHash = computeKimiEnvHash(envText);
    const savedHash = getKimiProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateKimiConversationSessions(conversations);
    updateKimiProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const kimiSettings = getKimiProviderSettings(settings);
    let changed = false;

    const normalizeSelection = (value: unknown): NormalizedSelection => {
      if (typeof value !== 'string' || !isKimiModelSelectionId(value)) {
        return { baseModelId: null };
      }

      const rawModelId = decodeKimiModelId(value);
      if (!rawModelId) {
        return { baseModelId: value };
      }

      const baseRawId = resolveKimiBaseModelRawId(rawModelId, kimiSettings.discoveredModels);
      return {
        baseModelId: encodeKimiModelId(baseRawId),
      };
    };

    const modelSelection = normalizeSelection(settings.model);
    if (
      typeof settings.model === 'string'
      && modelSelection.baseModelId
      && settings.model !== modelSelection.baseModelId
    ) {
      settings.model = modelSelection.baseModelId;
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
      const savedSelection = normalizeSelection(savedProviderModel.kimi);
      if (
        typeof savedProviderModel.kimi === 'string'
        && savedSelection.baseModelId
        && savedProviderModel.kimi !== savedSelection.baseModelId
      ) {
        savedProviderModel.kimi = savedSelection.baseModelId;
        changed = true;
      }
      if (savedSelection.baseModelId) {
        ensureProviderProjectionMap(settings, 'savedProviderEffort');
      }
    }

    const normalizedVisibleModels = normalizeKimiVisibleModels(
      kimiSettings.visibleModels,
      kimiSettings.discoveredModels,
    );
    const normalizedPreferredThinking = normalizeKimiPreferredThinkingByModel(
      kimiSettings.preferredThinkingByModel,
      kimiSettings.discoveredModels,
    );
    const shouldUpdateProviderSettings = !sameStringList(normalizedVisibleModels, kimiSettings.visibleModels)
      || !sameStringMap(normalizedPreferredThinking, kimiSettings.preferredThinkingByModel);
    if (shouldUpdateProviderSettings) {
      updateKimiProviderSettings(settings, {
        preferredThinkingByModel: normalizedPreferredThinking,
        visibleModels: normalizedVisibleModels,
      });
      changed = true;
    }

    if (typeof settings.effortLevel === 'string' && !settings.effortLevel.trim()) {
      settings.effortLevel = KIMI_DEFAULT_THINKING_LEVEL;
      changed = true;
    }

    return changed;
  },
};
