import {
  type CliPathFingerprintInputs,
  createCliPathFingerprintInputs,
  hasCliPathFingerprintInputs,
} from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import {
  createRuntimeInputFingerprint,
  isVersionedRuntimeInputFingerprint,
} from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
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
import { clearPiResumeState } from '../types';

const LEGACY_PI_ENV_HASH_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_CACHE_RETENTION',
] as const;

const PI_ENV_HASH_KEYS = [
  ...LEGACY_PI_ENV_HASH_KEYS,
  'PATH',
] as const;

function computePiRuntimeFingerprint(
  environmentText: string,
  cliPathInputs: CliPathFingerprintInputs,
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: PI_ENV_HASH_KEYS,
    environmentText,
  });
}

function invalidatePiConversationSessions(conversations: Conversation[]): Conversation[] {
  return conversations.filter(conversation => (
    conversation.providerId === 'pi' && clearPiResumeState(conversation)
  ));
}

function isCurrentLegacyPiFingerprint(
  environmentText: string,
  savedFingerprint: string,
  cliPathInputs: CliPathFingerprintInputs,
): boolean {
  if (
    !savedFingerprint
    || isVersionedRuntimeInputFingerprint(savedFingerprint)
    || hasCliPathFingerprintInputs(cliPathInputs)
  ) {
    return false;
  }

  const environment = parseEnvironmentVariables(environmentText);
  const legacyFingerprint = LEGACY_PI_ENV_HASH_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort()
    .join('|');
  return savedFingerprint === legacyFingerprint;
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

  invalidateConversationSessions: invalidatePiConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const piSettings = getPiProviderSettings(settings);
    const cliPathInputs = createCliPathFingerprintInputs(
      piSettings.cliPathsByHost[getHostnameKey()],
      piSettings.cliPath,
    );
    const currentHash = computePiRuntimeFingerprint(envText, cliPathInputs);
    const savedHash = piSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCliPathFingerprintInputs(cliPathInputs)
      || PI_ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidatePiConversationSessions(conversations);

    updatePiProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const piSettings = getPiProviderSettings(settings);
    let changed = false;

    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const cliPathInputs = createCliPathFingerprintInputs(
      piSettings.cliPathsByHost[getHostnameKey()],
      piSettings.cliPath,
    );
    if (isCurrentLegacyPiFingerprint(
      envText,
      piSettings.environmentHash,
      cliPathInputs,
    )) {
      updatePiProviderSettings(settings, {
        environmentHash: computePiRuntimeFingerprint(envText, cliPathInputs),
      });
      changed = true;
    }

    const normalizeSelection = (value: unknown): string | null => {
      if (typeof value !== 'string') {
        return null;
      }

      if (!isPiModelSelectionId(value)) {
        return value === 'pi' || value.startsWith('pi:') ? '' : null;
      }

      const decoded = decodePiModelId(value);
      if (decoded) {
        return encodePiModelId(decoded.provider, decoded.modelId);
      }
      return null;
    };

    const modelSelection = normalizeSelection(settings.model);
    if (
      typeof settings.model === 'string'
      && modelSelection !== null
      && settings.model !== modelSelection
    ) {
      settings.model = modelSelection;
      changed = true;
    }

    const titleModelSelection = normalizeSelection(settings.titleGenerationModel);
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
      const savedSelection = normalizeSelection(savedProviderModel.pi);
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
