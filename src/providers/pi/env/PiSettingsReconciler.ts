import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { sameStringList } from '../internal/compareCollections';
import {
  clampPiThinkingLevel,
  decodePiModelId,
  encodePiModelId,
  findPiModel,
  isPiModelSelectionId,
  PI_DEFAULT_THINKING_LEVEL,
} from '../models';
import {
  getPiProviderSettings,
  normalizePiVisibleModels,
  updatePiProviderSettings,
} from '../settings';
import { getPiState } from '../types';

const PI_ENV_HASH_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_CACHE_RETENTION',
] as const;

function computePiEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return PI_ENV_HASH_KEYS
    .filter((key) => envVars[key])
    .map((key) => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const piSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings: Record<string, unknown>): boolean {
    const current = getPiProviderSettings(settings);
    if (current.discoveredModels.length === 0) {
      return false;
    }
    updatePiProviderSettings(settings, {
      discoveredModels: [],
    });
    return true;
  },

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const currentHash = computePiEnvHash(envText);
    const savedHash = getPiProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conversation of conversations) {
      if (conversation.providerId !== 'pi') {
        continue;
      }

      const state = getPiState(conversation.providerState);
      if (!conversation.sessionId && !state.sessionId && !state.sessionFile) {
        continue;
      }

      conversation.sessionId = null;
      conversation.providerState = undefined;
      invalidatedConversations.push(conversation);
    }

    updatePiProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const piSettings = getPiProviderSettings(settings);
    let changed = false;

    const normalizeSelection = (
      value: unknown,
      fallback: 'clear' | 'synthetic',
    ): string | null => {
      if (typeof value !== 'string' || !isPiModelSelectionId(value)) {
        return null;
      }

      if (value === 'pi') {
        return value;
      }

      const decoded = decodePiModelId(value);
      if (decoded) {
        return encodePiModelId(decoded.provider, decoded.modelId);
      }

      return fallback === 'synthetic' ? 'pi' : '';
    };

    const modelSelection = normalizeSelection(settings.model, 'synthetic');
    if (typeof settings.model === 'string' && modelSelection && settings.model !== modelSelection) {
      settings.model = modelSelection;
      changed = true;
    }

    const titleModelSelection = normalizeSelection(settings.titleGenerationModel, 'clear');
    if (
      typeof settings.titleGenerationModel === 'string'
      && titleModelSelection !== null
      && settings.titleGenerationModel !== titleModelSelection
    ) {
      settings.titleGenerationModel = titleModelSelection;
      changed = true;
    }

    const savedProviderModelRaw = settings.savedProviderModel;
    if (savedProviderModelRaw && typeof savedProviderModelRaw === 'object' && !Array.isArray(savedProviderModelRaw)) {
      const savedProviderModel = savedProviderModelRaw as Record<string, unknown>;
      const savedSelection = normalizeSelection(savedProviderModel.pi, 'clear');
      if (
        typeof savedProviderModel.pi === 'string'
        && savedSelection !== null
        && savedProviderModel.pi !== savedSelection
      ) {
        if (savedSelection) {
          savedProviderModel.pi = savedSelection;
        } else {
          delete savedProviderModel.pi;
        }
        changed = true;
      }
    }

    const normalizedVisibleModels = normalizePiVisibleModels(
      piSettings.visibleModels,
      piSettings.discoveredModels,
    );
    const shouldUpdateProviderSettings = !sameStringList(normalizedVisibleModels, piSettings.visibleModels);
    if (shouldUpdateProviderSettings) {
      updatePiProviderSettings(settings, {
        visibleModels: normalizedVisibleModels,
      });
      changed = true;
    }

    if (typeof settings.effortLevel === 'string' && !settings.effortLevel.trim()) {
      settings.effortLevel = getDefaultPiEffortForSelection(settings.model, piSettings);
      changed = true;
    }

    return changed;
  },
};

function getDefaultPiEffortForSelection(
  selection: unknown,
  piSettings: ReturnType<typeof getPiProviderSettings>,
): string {
  if (typeof selection !== 'string') {
    return 'off';
  }

  const decoded = decodePiModelId(selection);
  if (!decoded) {
    return 'off';
  }

  const model = findPiModel(piSettings, encodePiModelId(decoded.provider, decoded.modelId));
  return model
    ? clampPiThinkingLevel(PI_DEFAULT_THINKING_LEVEL, model.thinkingLevels)
    : PI_DEFAULT_THINKING_LEVEL;
}
