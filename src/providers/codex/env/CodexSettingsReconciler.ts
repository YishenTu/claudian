import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { InstallationSettings } from '@/core/providers/settings/InstallationSettings';

import {
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type {
  ProviderEnvironmentReconciliation,
  ProviderSettingsReconciler,
  ProviderSettingsReconciliationContext,
} from '../../../core/providers/types';
import { codexModelPolicy } from '../CodexModelPolicy';
import { resolveCodexModelSelection } from '../modelOptions';
import { computeCodexEnvHash } from '../runtime/codexEnvironmentHash';
import {
  getCodexProviderSettings,
  updateCodexProviderSettings,
} from '../settings';

export const codexSettingsReconciler = {
  reconcileModelWithEnvironment(settings: Record<string, unknown>, context?: ProviderSettingsReconciliationContext): ProviderEnvironmentReconciliation {
    const environmentText = getRuntimeEnvironmentText(settings, 'codex');
    const codexSettings = getCodexProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      codexSettings.cliPathsByHost[getInstallationKey()],
      codexSettings.cliPath,
    );
    const installation: InstallationSettings = {
      installationMethod: codexSettings.installationMethod,
      wslDistroOverride: codexSettings.wslDistroOverride,
    };
    if (context?.vaultPath && process.platform === 'win32' && installation.installationMethod === 'wsl') {
      const target = resolveExecutionTarget({ settings: installation, hostVaultPath: context.vaultPath });
      installation.wslDistroOverride = target.distroName ?? installation.wslDistroOverride;
    }
    const hasFingerprintInputs = hasCLIPathFingerprintInputs(cliPathInputs)
      || codexSettings.installationMethod === 'wsl'
      || Boolean(codexSettings.wslDistroOverride)
      || Object.keys(parseEnvironmentVariables(environmentText)).length > 0;
    if (!codexSettings.environmentHash && !hasFingerprintInputs) {
      return { changed: false };
    }
    const environmentHash = computeCodexEnvHash(environmentText, { ...cliPathInputs, ...installation });
    if (environmentHash === codexSettings.environmentHash) {
      return { changed: false };
    }

    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    const nextModel = resolveCodexModelSelection(codexSettings, currentModel);
    if (nextModel) {
      settings.model = nextModel;
    }

    updateCodexProviderSettings(settings, { environmentHash });
    return { changed: true };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const model = settings.model as string;
    if (!model) {
      return false;
    }

    const normalizedModel = codexModelPolicy.normalizeModelVariant(model, settings);
    if (normalizedModel === model) {
      return false;
    }

    settings.model = normalizedModel;
    return true;
  },
} satisfies ProviderSettingsReconciler;
