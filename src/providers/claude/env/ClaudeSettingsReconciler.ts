import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
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

const ENV_HASH_PROVIDER_KEYS = ['ANTHROPIC_BASE_URL'];

function computeEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  const allKeys = [...CLAUDE_MODEL_ENV_KEYS, ...ENV_HASH_PROVIDER_KEYS];
  return allKeys
    .filter(key => envVars[key])
    .map(key => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

function getModelEnvironmentFromHash(environmentHash: string): Record<string, string> {
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
    const currentHash = computeEnvHash(envText);
    const savedHash = getClaudeProviderSettings(settings).environmentHash;

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
    const environmentChanged = computeEnvHash(
      getRuntimeEnvironmentText(settings, 'claude'),
    ) !== claudeSettings.environmentHash;
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
    ) {
      updateClaudeProviderSettings(settings, {
        modelEnvironmentType: modelEnvironmentType ?? '',
        titleModelEnvironmentType: titleModelEnvironmentType ?? '',
      });
      changed = true;
    }

    return changed;
  },
};
