import { getInstallationKey } from '@/core/device/InstallationKey';
import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';

import { createCLIPathFingerprintInputs } from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { GrokProviderSettings } from '../config';

export function buildGrokRuntimeEnv(
  environmentText: string,
  cliPath: string,
): NodeJS.ProcessEnv {
  const configuredEnvironment = parseEnvironmentVariables(environmentText);

  return {
    // Embedded vaults need native project discovery without a terminal trust prompt.
    // Explicit process or configured environment values retain precedence.
    GROK_FOLDER_TRUST: '0',
    ...process.env,
    ...configuredEnvironment,
    PATH: getEnhancedPath(configuredEnvironment.PATH, cliPath || undefined),
  };
}

/** Fingerprint of Grok's runtime inputs: the CLI path for this installation and the environment. */
export function computeGrokRuntimeInputHash(
  settings: Pick<GrokProviderSettings, 'cliPath' | 'cliPathsByHost'>,
  environmentText: string,
): string {
  const cliPathInputs = createCLIPathFingerprintInputs(
    settings.cliPathsByHost[getInstallationKey()],
    settings.cliPath,
  );
  const environment = Object.entries(parseEnvironmentVariables(environmentText))
    .sort(([left], [right]) => left.localeCompare(right));
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: environment.map(([key]) => key),
    environmentText,
  });
}
