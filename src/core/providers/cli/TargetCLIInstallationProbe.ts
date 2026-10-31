import * as path from 'node:path';

import { stripSurroundingQuotes } from '@/core/process/cliPath';
import { buildTargetLaunchSpec, type BuildTargetLaunchSpecOptions } from '@/core/process/execution-target/TargetLaunchSpec';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { type CLIInstallation, parseCLIVersion, probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';

export interface TargetCLIInstallationProbeOptions extends Omit<BuildTargetLaunchSpecOptions, 'command'> {
  command: string | null;
  configuredPath: string;
}

export async function probeTargetCLIInstallation(options: TargetCLIInstallationProbeOptions): Promise<CLIInstallation> {
  if (options.target.method !== 'wsl') {
    return probeCLIInstallation({ path: options.command, configuredPath: options.configuredPath, args: [...options.args], env: options.env });
  }
  const missing: CLIInstallation = { path: null, version: null, source: 'auto' };
  if (!options.command || !options.target.distroName) return missing;
  const launch = (command: string, args: string[]) => buildTargetLaunchSpec({ ...options, command, args });
  const probe = (spec: ReturnType<typeof launch>) => runProcessProbe({
    command: spec.command, args: spec.args, cwd: spec.spawnCwd, env: spec.env,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  const lookup = launch('/bin/sh', [
    '-c', 'candidate=$1; case "$candidate" in \'~/\'*) candidate=$HOME/${candidate#??};; esac; resolved=$(command -v -- "$candidate") || exit 1; test -f "$resolved" && test -x "$resolved" || exit 1; printf "%s\\n" "$resolved"',
    'claudian-cli-probe', options.command,
  ]);
  const resolved = (await probe(lookup))?.trim();
  if (!resolved || /[\r\n]/u.test(resolved)) return missing;
  const resolvedPath = path.posix.resolve(lookup.targetCwd, resolved);
  return {
    path: resolvedPath,
    source: stripSurroundingQuotes(options.configuredPath.trim()) === options.command ? 'custom' : 'auto',
    version: parseCLIVersion(await probe(launch(resolvedPath, [...options.args]))),
  };
}
