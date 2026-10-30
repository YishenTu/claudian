import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '@/core/providers/types';

import { getDeepSeekProviderSettings, updateDeepSeekProviderSettings } from '../settings';

export const deepseekSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: () => [],
  reconcileModelWithEnvironment(settings, context) {
    const current = getDeepSeekProviderSettings(settings);
    const environmentText = getRuntimeEnvironmentText(settings, 'deepseek');
    const environmentKeys = Object.keys(parseEnvironmentVariables(environmentText));
    const cliPath = current.cliPathsByHost[getInstallationKey()] ?? current.cliPath;
    const target = resolveExecutionTarget({ settings: current, hostVaultPath: context?.vaultPath });
    if (target.method !== 'wsl' && !current.environmentHash && !cliPath && !environmentKeys.length) return { changed: false };
    const environmentHash = createRuntimeInputFingerprint({ environmentText, environmentKeys,
      additionalInputs: { cliPath, target: target.method, distro: target.distroName },
    });
    if (current.environmentHash === environmentHash) return { changed: false };
    updateDeepSeekProviderSettings(settings, { environmentHash });
    // DeepSeek sessions resume across environment changes.
    return { changed: true, sessionPolicy: 'reload' };
  },
};
