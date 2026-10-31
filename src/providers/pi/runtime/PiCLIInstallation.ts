import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { type CLIInstallation,probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodePiConfig } from '../config';
import { resolvePiProcessSpec } from './PiSubprocess';
import { getPiWSLForwardedEnvironment } from './piWSLEnvironment';

export async function inspectPiInstallation(host: ProviderRuntimeHost): Promise<CLIInstallation> {
  const config = decodePiConfig(host.config, host.selection);
  const hostCwd = host.workingDirectory ?? process.cwd();
  const target = await resolveExecutionTargetAsync({ settings: config, hostVaultPath: hostCwd });
  const command = await host.resolveCliPath({ executionTarget: target });
  const env = { ...process.env, ...parseEnvironmentVariables(host.environmentText) };
  const configuredPath = config.cliPathsByHost[host.storage.installationKey] || config.cliPath;
  if (target.method !== 'wsl') {
    return probeCLIInstallation({
      path: command, configuredPath, args: ['--version'], env,
      prepareLaunch: spec => ({ ...spec, ...resolvePiProcessSpec(spec, spec.env.PATH ?? '') }),
    });
  }
  return probeTargetCLIInstallation({
    target, hostCwd, command, configuredPath, args: ['--version'],
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    forwardEnvironment: getPiWSLForwardedEnvironment(env, host.environmentText),
  });
}
