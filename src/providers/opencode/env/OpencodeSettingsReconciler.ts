import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';

import {
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createEnvironmentRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderEnvironmentReconciliation, ProviderSettingsReconciler, ProviderSettingsReconciliationContext } from '../../../core/providers/types';
import {
  getOpencodeProviderSettings,
  updateOpencodeProviderSettings
} from '../settings';

export const opencodeSettingsReconciler = {

  reconcileModelWithEnvironment(settings: Record<string, unknown>, context?: ProviderSettingsReconciliationContext): ProviderEnvironmentReconciliation {
    const envText = getRuntimeEnvironmentText(settings, 'opencode');
    const opencodeSettings = getOpencodeProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      opencodeSettings.cliPathsByHost[getInstallationKey()],
      opencodeSettings.cliPath,
    );
    const target = resolveExecutionTarget({ settings: opencodeSettings, hostVaultPath: context?.vaultPath });
    const savedHash = opencodeSettings.environmentHash;
    const hasFingerprintInputs = target.method === 'wsl'
      || hasCLIPathFingerprintInputs(cliPathInputs)
      || Object.keys(parseEnvironmentVariables(envText)).length > 0;
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false };
    }
    const currentHash = createEnvironmentRuntimeInputFingerprint(envText, {
      ...cliPathInputs,
      target: JSON.stringify(target),
    });
    if (currentHash === savedHash) {
      return { changed: false };
    }

    updateOpencodeProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true };
  },

} satisfies ProviderSettingsReconciler;
