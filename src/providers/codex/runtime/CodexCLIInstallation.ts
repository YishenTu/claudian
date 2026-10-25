import * as path from 'node:path';

import { stripSurroundingQuotes } from '@/core/process/cliPath';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { type CLIInstallation, parseCLIVersion, probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeCodexConfig } from '../config';
import { buildCodexAppServerEnvironment, getCodexAppServerWorkingDirectory } from './codexAppServerSupport';
import { resolveCodexExecutionTargetAsync } from './CodexExecutionTargetResolver';
import { buildCodexLaunchSpec } from './CodexLaunchSpecBuilder';

export async function inspectCodexInstallation(host: ProviderRuntimeHost): Promise<CLIInstallation> {
  const config = decodeCodexConfig(host.config);
  const configuredPath = config.cliPathsByHost[host.storage.installationKey] || config.cliPath;
  const hostVaultPath = getCodexAppServerWorkingDirectory(host);
  const target = await resolveCodexExecutionTargetAsync({ codexSettings: config, hostVaultPath });
  const command = await host.resolveCliPath({ executionTarget: target });
  const env = buildCodexAppServerEnvironment(host);
  if (target.method !== 'wsl') {
    return probeCLIInstallation({ path: command, configuredPath, args: ['--version'], env });
  }
  const missing: CLIInstallation = { path: null, version: null, source: 'auto' };
  if (!command || !target.distroName) return missing;
  const launch = (resolvedCliCommand: string, cliArgs: string[]) => buildCodexLaunchSpec({
    codexSettings: config, resolvedCliCommand, cliArgs, hostVaultPath, env, executionTarget: target,
  });
  const probe = (spec: ReturnType<typeof launch>) => runProcessProbe({
    command: spec.command,
    // WSL forwards the remaining raw Windows command line to its default shell.
    // Keep POSIX quoting intact instead of letting Node add Windows quotes to it.
    args: spec.args.map((arg, index) => index < spec.args.indexOf('--cd') + 2 ? quoteWindowsArgument(arg) : arg),
    cwd: spec.spawnCwd,
    env: spec.env,
    windowsVerbatimArguments: true,
  });
  // WSL's default shell supplies the same environment as chat. Quote the inner
  // script and CLI reference for that shell; sh receives the reference as $1.
  const lookup = launch('sh', [
    '-c', quoteShellArgument('resolved=$(command -v -- "$1") || exit 1; test -f "$resolved" && test -x "$resolved" || exit 1; printf "%s\\n" "$resolved"'),
    'claudian-cli-probe', quoteShellArgument(command),
  ]);
  const resolved = (await probe(lookup))?.trim();
  if (!resolved || /[\r\n]/u.test(resolved)) return missing;
  const resolvedPath = path.posix.resolve(lookup.targetCwd, resolved);
  return {
    path: resolvedPath,
    source: stripSurroundingQuotes(configuredPath.trim()) === command ? 'custom' : 'auto',
    version: parseCLIVersion(await probe(launch(quoteShellArgument(resolvedPath), ['--version']))),
  };
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function quoteWindowsArgument(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}
