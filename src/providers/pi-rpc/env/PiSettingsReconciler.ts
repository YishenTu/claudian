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
import type { PiFamilyProfile } from '../PiFamilyProfile';
import type { PiProviderSettings } from '../settings';
import { clearPiResumeState } from '../types';

/**
 * Builds the provider-agnostic pi-family settings reconciler. All 'pi' literals,
 * env-key lists, and model helpers come from the profile; behavior is identical
 * across pi-family distributions.
 */
export function definePiFamilySettingsReconciler(
  profile: PiFamilyProfile,
): ProviderSettingsReconciler {
  const { models, settings: settingsAccess } = profile;
  // Pre-versioning fingerprints were computed over the provider-specific keys
  // only; PATH is a versioned-fingerprint input and never matched legacy hashes.
  const legacyEnvHashKeys = profile.envHashKeys.filter(key => key !== 'PATH');

  function invalidateConversationSessions(conversations: Conversation[]): Conversation[] {
    return conversations.filter(conversation => (
      conversation.providerId === profile.providerId && clearPiResumeState(conversation)
    ));
  }

  function isCurrentLegacyFingerprint(
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
    const legacyFingerprint = legacyEnvHashKeys
      .filter(key => environment[key])
      .map(key => `${key}=${environment[key]}`)
      .sort()
      .join('|');
    return savedFingerprint === legacyFingerprint;
  }

  function getDefaultEffortForSelection(
    selection: unknown,
    providerSettings: PiProviderSettings,
  ): string {
    if (typeof selection !== 'string') {
      return 'off';
    }

    const decoded = models.decodeModelId(selection);
    if (!decoded) {
      return 'off';
    }

    const model = models.findModel(
      providerSettings,
      models.encodeModelId(decoded.provider, decoded.modelId),
    );
    return model
      ? models.clampThinkingLevel(models.defaultThinkingLevel, model.thinkingLevels)
      : models.defaultThinkingLevel;
  }

  return {
    handleEnvironmentChange(settings: Record<string, unknown>): boolean {
      const current = settingsAccess.get(settings);
      if (current.discoveredModels.length === 0) {
        return false;
      }
      settingsAccess.update(settings, {
        discoveredModels: [],
      });
      return true;
    },

    invalidateConversationSessions,

    reconcileModelWithEnvironment(
      settings: Record<string, unknown>,
      conversations: Conversation[],
    ): { changed: boolean; invalidatedConversations: Conversation[] } {
      const envText = getRuntimeEnvironmentText(settings, profile.providerId);
      const providerSettings = settingsAccess.get(settings);
      const cliPathInputs = createCliPathFingerprintInputs(
        providerSettings.cliPathsByHost[getHostnameKey()],
        providerSettings.cliPath,
      );
      const currentHash = createRuntimeInputFingerprint({
        additionalInputs: cliPathInputs,
        environmentKeys: profile.envHashKeys,
        environmentText: envText,
      });
      const savedHash = providerSettings.environmentHash;

      const environment = parseEnvironmentVariables(envText);
      const hasFingerprintInputs = Boolean(
        hasCliPathFingerprintInputs(cliPathInputs)
        || profile.envHashKeys.some(key => Object.prototype.hasOwnProperty.call(environment, key))
      );
      if (!savedHash && !hasFingerprintInputs) {
        return { changed: false, invalidatedConversations: [] };
      }
      if (currentHash === savedHash) {
        return { changed: false, invalidatedConversations: [] };
      }

      const invalidatedConversations = invalidateConversationSessions(conversations);

      settingsAccess.update(settings, { environmentHash: currentHash });
      return { changed: true, invalidatedConversations };
    },

    normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
      const providerSettings = settingsAccess.get(settings);
      let changed = false;

      const envText = getRuntimeEnvironmentText(settings, profile.providerId);
      const cliPathInputs = createCliPathFingerprintInputs(
        providerSettings.cliPathsByHost[getHostnameKey()],
        providerSettings.cliPath,
      );
      if (isCurrentLegacyFingerprint(
        envText,
        providerSettings.environmentHash,
        cliPathInputs,
      )) {
        settingsAccess.update(settings, {
          environmentHash: createRuntimeInputFingerprint({
            additionalInputs: cliPathInputs,
            environmentKeys: profile.envHashKeys,
            environmentText: envText,
          }),
        });
        changed = true;
      }

      const normalizeSelection = (value: unknown): string | null => {
        if (typeof value !== 'string') {
          return null;
        }

        if (!models.isModelSelectionId(value)) {
          return value === profile.providerId || value.startsWith(profile.modelIdPrefix)
            ? ''
            : null;
        }

        const decoded = models.decodeModelId(value);
        if (decoded) {
          return models.encodeModelId(decoded.provider, decoded.modelId);
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
        const savedSelection = normalizeSelection(savedProviderModel[profile.providerId]);
        if (
          typeof savedProviderModel[profile.providerId] === 'string'
          && savedSelection !== null
          && savedProviderModel[profile.providerId] !== savedSelection
        ) {
          if (savedSelection) {
            savedProviderModel[profile.providerId] = savedSelection;
          } else {
            delete savedProviderModel[profile.providerId];
          }
          changed = true;
        }
      }

      const normalizedVisibleModels = settingsAccess.normalizeVisibleModels(
        providerSettings.visibleModels,
        providerSettings.discoveredModels,
      );
      const shouldUpdateProviderSettings = !sameStringList(normalizedVisibleModels, providerSettings.visibleModels);
      if (shouldUpdateProviderSettings) {
        settingsAccess.update(settings, {
          visibleModels: normalizedVisibleModels,
        });
        changed = true;
      }

      if (typeof settings.effortLevel === 'string' && !settings.effortLevel.trim()) {
        settings.effortLevel = getDefaultEffortForSelection(settings.model, providerSettings);
        changed = true;
      }

      return changed;
    },
  };
}
