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
import {
  findClaudeModelOptionForEnvironmentType,
  getClaudeModelOptions,
  resolveClaudeModelEnvironmentTypePreference,
  resolveClaudeModelSelection,
} from '../modelOptions';
import { toClaudeRuntimeModelId } from '../modelSelection';
import { isClaudeModelTier } from '../modelTiers';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { normalizeLegacyClaudeModelAlias } from '../types/models';
import { clearClaudeResumeState } from '../types/providerState';
import { claudeChatUIConfig } from '../ui/ClaudeChatUIConfig';
import {
  CLAUDE_MODEL_ENV_KEYS,
  type ClaudeModelEnvType,
  getModelsFromEnvironment,
} from './claudeModelEnv';

const ENV_HASH_PROVIDER_KEYS = ['ANTHROPIC_BASE_URL', 'PATH'];
const ALL_FINGERPRINT_ENV_KEYS = [...CLAUDE_MODEL_ENV_KEYS, ...ENV_HASH_PROVIDER_KEYS];

function getConfiguredCliPathInputs(
  settings: Record<string, unknown>,
): CliPathFingerprintInputs {
  const claudeSettings = getClaudeProviderSettings(settings);
  return createCliPathFingerprintInputs(
    claudeSettings.cliPathsByHost[getHostnameKey()],
    claudeSettings.cliPath,
  );
}

function computeRuntimeFingerprint(
  settings: Record<string, unknown>,
  environmentText: string = getRuntimeEnvironmentText(settings, 'claude'),
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: getConfiguredCliPathInputs(settings),
    environmentKeys: ALL_FINGERPRINT_ENV_KEYS,
    environmentText,
  });
}

function hasFingerprintInputs(settings: Record<string, unknown>, environmentText: string): boolean {
  if (hasCliPathFingerprintInputs(getConfiguredCliPathInputs(settings))) {
    return true;
  }

  const environment = parseEnvironmentVariables(environmentText);
  return ALL_FINGERPRINT_ENV_KEYS
    .some(key => Object.prototype.hasOwnProperty.call(environment, key));
}

function isCurrentLegacyFingerprint(
  settings: Record<string, unknown>,
  environmentText: string,
  savedFingerprint: string,
): boolean {
  if (
    !savedFingerprint
    || isVersionedRuntimeInputFingerprint(savedFingerprint)
    || hasCliPathFingerprintInputs(getConfiguredCliPathInputs(settings))
  ) {
    return false;
  }

  const environment = parseEnvironmentVariables(environmentText);
  const legacyFingerprint = ALL_FINGERPRINT_ENV_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort()
    .join('|');
  return savedFingerprint === legacyFingerprint;
}

function getModelEnvironmentFromHash(environmentHash: string): Record<string, string> {
  if (isVersionedRuntimeInputFingerprint(environmentHash)) {
    return {};
  }

  const envVars: Record<string, string> = {};
  for (const key of CLAUDE_MODEL_ENV_KEYS) {
    const match = environmentHash.match(new RegExp(`(?:^|\\|)${key}=([^|]*)`));
    if (match?.[1]) {
      envVars[key] = match[1];
    }
  }
  return envVars;
}

function inferPreviousModelEnvironmentType(
  environmentHash: string,
  currentModel: string,
  lastModel: string = '',
): ClaudeModelEnvType | undefined {
  const runtimeModel = toClaudeRuntimeModelId(currentModel);
  const previousOption = getModelsFromEnvironment(
    getModelEnvironmentFromHash(environmentHash),
  ).find(option => option.value === runtimeModel);
  if (!previousOption) {
    return undefined;
  }

  const normalizedLastModel = normalizeLegacyClaudeModelAlias(toClaudeRuntimeModelId(lastModel));
  if (
    isClaudeModelTier(normalizedLastModel)
    && previousOption.environmentTypes.includes(normalizedLastModel)
  ) {
    return normalizedLastModel;
  }

  return previousOption.environmentTypes[0];
}

function invalidateClaudeConversationSessions(conversations: Conversation[]): Conversation[] {
  return conversations.filter(conv => (
    conv.providerId === 'claude' && clearClaudeResumeState(conv)
  ));
}

export const claudeSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: invalidateClaudeConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'claude');
    const currentHash = computeRuntimeFingerprint(settings, envText);
    const savedHash = getClaudeProviderSettings(settings).environmentHash;

    if (!savedHash && !hasFingerprintInputs(settings, envText)) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (isCurrentLegacyFingerprint(settings, envText, savedHash)) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateClaudeConversationSessions(conversations);

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const claudeSettings = getClaudeProviderSettings(settings);
    const modelOptions = getClaudeModelOptions(settings);
    const savedProviderModel = settings.savedProviderModel as Record<string, unknown> | undefined;
    const historicalModel = settings.settingsProvider !== 'claude'
      && typeof savedProviderModel?.claude === 'string'
      ? savedProviderModel.claude
      : currentModel;
    const previousEnvironmentType = claudeSettings.modelEnvironmentType
      || inferPreviousModelEnvironmentType(
        savedHash,
        historicalModel,
        claudeSettings.lastModel,
      );
    const nextModel = resolveClaudeModelSelection(
      settings,
      currentModel,
      previousEnvironmentType,
    );
    if (nextModel) {
      settings.model = nextModel;
    }

    const derivedEnvironmentType = nextModel
      ? resolveClaudeModelEnvironmentTypePreference(
        modelOptions,
        nextModel,
        previousEnvironmentType ?? '',
      )
      : null;
    const selectedEnvironmentType = previousEnvironmentType ?? derivedEnvironmentType;
    const selectedTier = selectedEnvironmentType && isClaudeModelTier(selectedEnvironmentType)
      ? selectedEnvironmentType
      : undefined;

    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    const previousTitleEnvironmentType = claudeSettings.titleModelEnvironmentType
      || (titleModel
        ? inferPreviousModelEnvironmentType(savedHash, titleModel)
        : undefined);
    if (previousTitleEnvironmentType) {
      const titleOption = findClaudeModelOptionForEnvironmentType(
        modelOptions,
        previousTitleEnvironmentType,
      );
      if (titleOption) {
        settings.titleGenerationModel = titleOption.value;
      }
    }
    const derivedTitleEnvironmentType = titleModel
      ? resolveClaudeModelEnvironmentTypePreference(
        modelOptions,
        titleModel,
        previousTitleEnvironmentType ?? '',
      )
      : null;
    const selectedTitleEnvironmentType = previousTitleEnvironmentType
      ?? derivedTitleEnvironmentType;

    updateClaudeProviderSettings(settings, {
      environmentHash: currentHash,
      modelEnvironmentType: selectedEnvironmentType ?? '',
      titleModelEnvironmentType: selectedTitleEnvironmentType ?? '',
      ...(selectedTier ? { lastModel: selectedTier } : {}),
    });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    let changed = false;

    const normalize = (model: string): string => claudeChatUIConfig.normalizeModelVariant(model, settings);
    const claudeSettings = getClaudeProviderSettings(settings);
    const modelOptions = getClaudeModelOptions(settings);
    const environmentText = getRuntimeEnvironmentText(settings, 'claude');
    const shouldMigrateLegacyFingerprint = isCurrentLegacyFingerprint(
      settings,
      environmentText,
      claudeSettings.environmentHash,
    );
    const environmentChanged = (
      Boolean(claudeSettings.environmentHash)
      || hasFingerprintInputs(settings, environmentText)
    )
      && !shouldMigrateLegacyFingerprint
      && computeRuntimeFingerprint(settings, environmentText) !== claudeSettings.environmentHash;
    const hasEnvironmentModelOptions = modelOptions.some(option => option.environmentTypes);

    const model = settings.model as string;
    const shouldInferPrimaryEnvironmentType = settings.settingsProvider === undefined
      || settings.settingsProvider === 'claude';
    const historicalModelEnvironmentType = environmentChanged
      ? inferPreviousModelEnvironmentType(
        claudeSettings.environmentHash,
        model,
        claudeSettings.lastModel,
      )
      : undefined;
    const modelEnvironmentType = claudeSettings.modelEnvironmentType
      || (shouldInferPrimaryEnvironmentType
        ? historicalModelEnvironmentType
          || (hasEnvironmentModelOptions
            ? resolveClaudeModelEnvironmentTypePreference(modelOptions, model)
            : null)
        : null);
    const normalizedModel = (
      modelEnvironmentType
        ? findClaudeModelOptionForEnvironmentType(modelOptions, modelEnvironmentType)?.value
        : undefined
    ) ?? normalize(model);
    if (model !== normalizedModel) {
      settings.model = normalizedModel;
      changed = true;
    }

    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    const historicalTitleModelEnvironmentType = environmentChanged && titleModel
      ? inferPreviousModelEnvironmentType(claudeSettings.environmentHash, titleModel)
      : undefined;
    const titleModelEnvironmentType = claudeSettings.titleModelEnvironmentType
      || (titleModel
        ? historicalTitleModelEnvironmentType
          || (hasEnvironmentModelOptions
            ? resolveClaudeModelEnvironmentTypePreference(modelOptions, titleModel)
            : null)
        : null);
    const normalizedTitleModel = (
      titleModelEnvironmentType
        ? findClaudeModelOptionForEnvironmentType(
          modelOptions,
          titleModelEnvironmentType,
        )?.value
        : undefined
    ) ?? (titleModel ? normalize(titleModel) : '');
    if (titleModel !== normalizedTitleModel) {
      settings.titleGenerationModel = normalizedTitleModel;
      changed = true;
    }

    const lastClaudeModel = claudeSettings.lastModel;
    if (lastClaudeModel) {
      const normalizedLastClaudeModel = normalizeLegacyClaudeModelAlias(
        toClaudeRuntimeModelId(lastClaudeModel),
      );
      if (lastClaudeModel !== normalizedLastClaudeModel) {
        updateClaudeProviderSettings(settings, { lastModel: normalizedLastClaudeModel });
        changed = true;
      }
    }

    if (
      claudeSettings.modelEnvironmentType !== (modelEnvironmentType ?? '')
      || claudeSettings.titleModelEnvironmentType !== (titleModelEnvironmentType ?? '')
      || shouldMigrateLegacyFingerprint
    ) {
      updateClaudeProviderSettings(settings, {
        ...(shouldMigrateLegacyFingerprint
          ? { environmentHash: computeRuntimeFingerprint(settings, environmentText) }
          : {}),
        modelEnvironmentType: modelEnvironmentType ?? '',
        titleModelEnvironmentType: titleModelEnvironmentType ?? '',
      });
      changed = true;
    }

    return changed;
  },
};
