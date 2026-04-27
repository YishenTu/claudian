import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import { resolveGeminiModelSelection } from '../modelOptions';
import { getGeminiProviderSettings, updateGeminiProviderSettings } from '../settings';
import { geminiChatUIConfig } from '../ui/GeminiChatUIConfig';

const ENV_HASH_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'GOOGLE_GEMINI_MODEL',
  'GEMINI_API_BASE_URL',
  'GOOGLE_GEMINI_BASE_URL',
];

function computeGeminiEnvHash(envText: string): string {
  const envVars = parseEnvironmentVariables(envText || '');
  return ENV_HASH_KEYS
    .filter(key => envVars[key])
    .map(key => `${key}=${envVars[key]}`)
    .sort()
    .join('|');
}

export const geminiSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    _conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'gemini');
    const currentHash = computeGeminiEnvHash(envText);
    const savedHash = getGeminiProviderSettings(settings).environmentHash;

    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveGeminiModelSelection(settings, currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateGeminiProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const model = settings.model as string;
    if (!model) {
      return false;
    }

    const normalizedModel = geminiChatUIConfig.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return false;
    }

    settings.model = normalizedModel;
    return true;
  },
};
