import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { CLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeCodexConfig } from '../config';
import { buildCodexAppServerEnvironment, getCodexAppServerWorkingDirectory } from './codexAppServerSupport';
import { getCodexWSLForwardedEnvironment } from './codexWSLEnvironment';

export async function inspectCodexInstallation(host: ProviderRuntimeHost): Promise<CLIInstallation> {
  const config = decodeCodexConfig(host.config);
  const hostCwd = getCodexAppServerWorkingDirectory(host);
  const target = await resolveExecutionTargetAsync({ settings: config, hostVaultPath: hostCwd });
  const env = buildCodexAppServerEnvironment(host, target);
  return probeTargetCLIInstallation({
    target, hostCwd, env, args: ['--version'],
    command: await host.resolveCliPath({ executionTarget: target }),
    configuredPath: config.cliPathsByHost[host.storage.installationKey] || config.cliPath,
    forwardEnvironment: getCodexWSLForwardedEnvironment(env, host.environmentText),
  });
}
