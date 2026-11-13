import { getInstallationKey } from '@/core/device/InstallationKey';
import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';

import { createCLIPathFingerprintInputs } from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { AntigravityProviderSettings } from '../config';

export function buildAntigravityRuntimeEnv(environmentText: string, cliPath: string): Record<string, string> {
  const configured = parseEnvironmentVariables(environmentText);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...configured,
    PATH: getEnhancedPath(configured.PATH, cliPath || undefined),
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Fingerprint of the launch inputs: this installation's CLI path and the environment. */
export function computeAntigravityRuntimeInputHash(
  settings: Pick<AntigravityProviderSettings, 'cliPath' | 'cliPathsByHost'>,
  environmentText: string,
): string {
  const environment = Object.entries(parseEnvironmentVariables(environmentText))
    .sort(([left], [right]) => left.localeCompare(right));
  return createRuntimeInputFingerprint({
    additionalInputs: createCLIPathFingerprintInputs(settings.cliPathsByHost[getInstallationKey()], settings.cliPath),
    environmentKeys: environment.map(([key]) => key),
    environmentText,
  });
}
