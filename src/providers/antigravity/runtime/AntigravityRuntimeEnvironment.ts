import { getInstallationKey } from '@/core/device/InstallationKey';
import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';

import { createCLIPathFingerprintInputs } from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { AntigravityProviderSettings } from '../config';

export function buildAntigravityRuntimeEnv(
  environmentText: string,
  cliPath: string,
  target?: ExecutionTarget,
): Record<string, string> {
  const configured = parseEnvironmentVariables(environmentText);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...configured,
    // Linux keeps its own PATH; only an explicitly configured one is forwarded.
    ...(target?.method === 'wsl' ? {} : { PATH: getEnhancedPath(configured.PATH, cliPath || undefined) }),
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Fingerprint of the launch inputs: this installation's CLI path, its execution target and the environment. */
export function computeAntigravityRuntimeInputHash(
  settings: Pick<AntigravityProviderSettings, 'cliPath' | 'cliPathsByHost' | 'installationMethod' | 'wslDistroOverride'>,
  environmentText: string,
  target = resolveExecutionTarget({ settings }),
): string {
  const environment = Object.entries(parseEnvironmentVariables(environmentText))
    .sort(([left], [right]) => left.localeCompare(right));
  return createRuntimeInputFingerprint({
    additionalInputs: {
      ...createCLIPathFingerprintInputs(settings.cliPathsByHost[getInstallationKey()], settings.cliPath),
      target: JSON.stringify(target),
    },
    environmentKeys: environment.map(([key]) => key),
    environmentText,
  });
}
