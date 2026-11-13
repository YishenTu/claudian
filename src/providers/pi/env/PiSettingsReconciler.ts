import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';

import {
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createEnvironmentRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type {
  ProviderEnvironmentReconciliation,
  ProviderSettingsReconciler,
  ProviderSettingsReconciliationContext,
} from '../../../core/providers/types';
import {
  getPiProviderSettings,
  updatePiProviderSettings
} from '../settings';

export const piSettingsReconciler = {
  reconcileModelWithEnvironment(settings: Record<string, unknown>, context?: ProviderSettingsReconciliationContext): ProviderEnvironmentReconciliation {
    const envText = getRuntimeEnvironmentText(settings, 'pi');
    const piSettings = getPiProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      piSettings.cliPathsByHost[getInstallationKey()],
      piSettings.cliPath,
    );
    const target = resolveExecutionTarget({ settings: piSettings, hostVaultPath: context?.vaultPath });
    const targetInputs = target.method === 'wsl' ? { method: target.method, distroName: target.distroName } : {};
    const hasFingerprintInputs = hasCLIPathFingerprintInputs(cliPathInputs)
      || target.method === 'wsl'
      || Object.keys(parseEnvironmentVariables(envText)).length > 0;
    if (!piSettings.environmentHash && !hasFingerprintInputs) {
      return { changed: false };
    }
    const environmentHash = createEnvironmentRuntimeInputFingerprint(envText, { ...cliPathInputs, ...targetInputs });
    if (environmentHash === piSettings.environmentHash) {
      return { changed: false };
    }

    updatePiProviderSettings(settings, { environmentHash });
    return { changed: true };
  },
} satisfies ProviderSettingsReconciler;
