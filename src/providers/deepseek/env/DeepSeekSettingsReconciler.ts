import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '@/core/providers/types';

import { getDeepSeekProviderSettings, updateDeepSeekProviderSettings } from '../settings';

export const deepseekSettingsReconciler: ProviderSettingsReconciler = {
  environmentSessionPolicy: 'reload',
  invalidateConversationSessions: () => [],
  reconcileModelWithEnvironment(settings) {
    const current = getDeepSeekProviderSettings(settings);
    const environmentText = getRuntimeEnvironmentText(settings, 'deepseek');
    const environmentKeys = Object.keys(parseEnvironmentVariables(environmentText));
    const cliPath = current.cliPathsByHost[getInstallationKey()] ?? current.cliPath;
    if (!current.environmentHash && !cliPath && !environmentKeys.length) return { changed: false, invalidatedConversations: [] };
    const environmentHash = createRuntimeInputFingerprint({ environmentText, environmentKeys,
      additionalInputs: { cliPath },
    });
    if (current.environmentHash === environmentHash) return { changed: false, invalidatedConversations: [] };
    updateDeepSeekProviderSettings(settings, { environmentHash });
    return { changed: true, invalidatedConversations: [] };
  },
};
