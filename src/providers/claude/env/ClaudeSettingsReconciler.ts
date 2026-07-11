import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { resolveClaudeModelSelection } from '../modelOptions';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import { clearClaudeResumeState } from '../types/providerState';
import { claudeChatUIConfig } from '../ui/ClaudeChatUIConfig';

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
      if (conv.providerId === 'claude' && clearClaudeResumeState(conv)) {
        invalidatedConversations.push(conv);
      }
    }

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveClaudeModelSelection(settings, currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateClaudeProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    let changed = false;

    const normalize = (model: string): string => claudeChatUIConfig.normalizeModelVariant(model, settings);

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

    const lastClaudeModel = getClaudeProviderSettings(settings).lastModel;
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
