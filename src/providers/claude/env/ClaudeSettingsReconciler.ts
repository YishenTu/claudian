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
import { invalidateClaudeHistoryContext } from '../history/ClaudeHistoryContext';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';

export const claudeSettingsReconciler = {
  reconcileModelWithEnvironment(settings: Record<string, unknown>, context?: ProviderSettingsReconciliationContext): ProviderEnvironmentReconciliation {
    const environmentText = getRuntimeEnvironmentText(settings, 'claude');
    const claudeSettings = getClaudeProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      claudeSettings.cliPathsByHost[getInstallationKey()],
      claudeSettings.cliPath,
    );
    const targetInputs = process.platform === 'win32' && claudeSettings.installationMethod === 'wsl'
      ? { ...resolveExecutionTarget({ settings: claudeSettings, hostVaultPath: context?.vaultPath }) }
      : undefined;
    const hasFingerprintInputs = Boolean(targetInputs)
      || hasCLIPathFingerprintInputs(cliPathInputs)
      || Object.keys(parseEnvironmentVariables(environmentText)).length > 0;
    if (!claudeSettings.environmentHash && !hasFingerprintInputs) {
      return { changed: false };
    }
    const environmentHash = createEnvironmentRuntimeInputFingerprint(environmentText, {
      ...cliPathInputs,
      ...targetInputs,
    });
    if (environmentHash === claudeSettings.environmentHash) {
      return { changed: false };
    }

    invalidateClaudeHistoryContext();
    updateClaudeProviderSettings(settings, { environmentHash });
    return { changed: true };
  },
} satisfies ProviderSettingsReconciler;
