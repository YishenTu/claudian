import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { DEFAULT_CLAUDE_MODELS, normalizeVisibleModelVariant } from '../types/models';
import { getCurrentModelFromEnvironment, getModelsFromEnvironment } from './claudeModelEnv';

const ENV_HASH_MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];
const ENV_HASH_PROVIDER_KEYS = ['ANTHROPIC_BASE_URL'];

function computeEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  const allKeys = [...ENV_HASH_MODEL_KEYS, ...ENV_HASH_PROVIDER_KEYS];
  return allKeys
    .filter(key => envVars[key])
    .map(key => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const claudeSettingsReconciler: ProviderSettingsReconciler = {
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

    const invalidatedConversations: Conversation[] = [];
    for (const conv of conversations) {
      if (conv.sessionId) {
        conv.sessionId = null;
        invalidatedConversations.push(conv);
      }
    }

    const envVars = parseEnvironmentVariables(envText || '');
    const customModels = getModelsFromEnvironment(envVars);

    if (customModels.length > 0) {
      const envPreferred = getCurrentModelFromEnvironment(envVars);
      if (envPreferred && customModels.some(m => m.value === envPreferred)) {
        settings.model = envPreferred;
      } else {
        settings.model = customModels[0].value;
      }
    } else {
      settings.model = DEFAULT_CLAUDE_MODELS[0].value;
    }

    updateClaudeProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const claudeSettings = getClaudeProviderSettings(settings);
    let changed = false;

    const normalize = (model: string): string =>
      normalizeVisibleModelVariant(
        model,
        claudeSettings.enableOpus1M,
        claudeSettings.enableSonnet1M,
      );

    const model = settings.model as string;
    const normalizedModel = normalize(model);
    if (model !== normalizedModel) {
      settings.model = normalizedModel;
      changed = true;
    }

    const titleModel = settings.titleGenerationModel as string;
    if (titleModel) {
      const normalizedTitleModel = normalize(titleModel);
      if (titleModel !== normalizedTitleModel) {
        settings.titleGenerationModel = normalizedTitleModel;
        changed = true;
      }
    }

    const lastClaudeModel = claudeSettings.lastModel;
    if (lastClaudeModel) {
      const normalizedLastClaudeModel = normalize(lastClaudeModel);
      if (lastClaudeModel !== normalizedLastClaudeModel) {
        updateClaudeProviderSettings(settings, { lastModel: normalizedLastClaudeModel });
        changed = true;
      }
    }

    return changed;
  },
};
