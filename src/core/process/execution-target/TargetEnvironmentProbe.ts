import { runProcessProbe } from '@/core/process/ProcessProbe';

import { buildTargetLaunchSpec, type BuildTargetLaunchSpecOptions } from './TargetLaunchSpec';

export interface TargetEnvironmentProbeOptions extends Omit<BuildTargetLaunchSpecOptions, 'command' | 'args'> {
  variables: readonly string[];
}

// Names are argv data, never shell/awk source. Emit presence separately from value.
const READ_ENVIRONMENT = 'BEGIN { for (i = 1; i < ARGC; i++) { key = ARGV[i]; printf "%s%c%s%c", (key in ENVIRON ? "x" : ""), 0, (key in ENVIRON ? ENVIRON[key] : ""), 0 } }';

/** Read execution-visible values without caching. Undefined denotes unset; null denotes probe failure. */
export async function probeTargetEnvironment(options: TargetEnvironmentProbeOptions): Promise<Record<string, string | undefined> | null> {
  for (const key of options.variables) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  }
  if (options.target.method !== 'wsl' || options.variables.length === 0) {
    return Object.fromEntries(options.variables.map(key => [key, options.env[key]]));
  }
  const spec = buildTargetLaunchSpec({ ...options, command: '/usr/bin/awk', args: [READ_ENVIRONMENT, ...options.variables] });
  const output = await runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 20_000);
  if (output === null) return null;
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length !== options.variables.length * 2) return null;
  const entries: [string, string | undefined][] = [];
  for (const [index, key] of options.variables.entries()) {
    const present = fields[index * 2];
    if (present !== 'x' && present !== '') return null;
    entries.push([key, present === 'x' ? fields[index * 2 + 1] : undefined]);
  }
  return Object.fromEntries(entries);
}
