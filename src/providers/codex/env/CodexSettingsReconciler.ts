import {
  createCliPathFingerprintInputs,
  hasCliPathFingerprintInputs,
} from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { resolveCodexModelSelection } from '../modelOptions';
import { getCodexProviderSettings, updateCodexProviderSettings } from '../settings';
import { getCodexState } from '../types';
import { codexChatUIConfig } from '../ui/CodexChatUIConfig';

const ENV_HASH_KEYS = ['OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'PATH'];

export function computeCodexEnvHash(
  environmentText: string,
  additionalInputs: Readonly<Record<string, string | undefined>> = {},
): string {
  return createRuntimeInputFingerprint({
    additionalInputs,
    environmentKeys: ENV_HASH_KEYS,
    environmentText,
  });
}

function invalidateCodexConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidatedConversations: Conversation[] = [];
  for (const conversation of conversations) {
    const state = getCodexState(conversation.providerState);
    if (conversation.providerId === 'codex' && (conversation.sessionId || state.threadId)) {
      conversation.sessionId = null;
      conversation.providerState = undefined;
      invalidatedConversations.push(conversation);
    }
  }
  return invalidatedConversations;
}

export const codexSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: invalidateCodexConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'codex');
    const codexSettings = getCodexProviderSettings(settings);
    const cliPathInputs = createCliPathFingerprintInputs(
      codexSettings.cliPathsByHost[getHostnameKey()],
      codexSettings.cliPath,
    );
    const currentHash = computeCodexEnvHash(envText, {
      ...cliPathInputs,
      installationMethod: codexSettings.installationMethod,
      wslDistroOverride: codexSettings.wslDistroOverride,
    });
    const savedHash = codexSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCliPathFingerprintInputs(cliPathInputs)
      || codexSettings.installationMethod === 'wsl'
      || codexSettings.wslDistroOverride
      || ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateCodexConversationSessions(conversations);

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveCodexModelSelection(settings, currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateCodexProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const model = settings.model as string;
    if (!model) {
      return false;
    }

    const normalizedModel = codexChatUIConfig.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return false;
    }

    settings.model = normalizedModel;
    return true;
  },
};
