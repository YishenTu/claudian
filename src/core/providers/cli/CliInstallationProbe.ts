import * as fs from 'node:fs';

import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { cliPathRequiresNode, findNodeExecutable, getEnhancedPath } from '@/utils/env';
import { normalizeConfiguredCliPath } from '@/utils/path';

export interface CliInstallation {
  path: string | null;
  version: string | null;
  source: 'auto' | 'custom';
}

interface CliInstallationProbeOptions {
  path: string | null;
  configuredPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  prepareLaunch?: (spec: ManagedStdioProcessOptions) => ManagedStdioProcessOptions;
}

export function parseCliVersion(output: string | null): string | null {
  return output?.match(/\bv?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?\b/u)?.[0] ?? null;
}

export async function probeCliInstallation(options: CliInstallationProbeOptions): Promise<CliInstallation> {
  const result: CliInstallation = { path: null, version: null, source: 'auto' };
  if (!options.path) return result;
  const cliPath = options.path;
  const requiresNode = cliPathRequiresNode(cliPath);
  try {
    if (!fs.statSync(cliPath).isFile()) return result;
    fs.accessSync(cliPath, requiresNode ? fs.constants.R_OK : fs.constants.X_OK);
  } catch {
    return result;
  }
  result.path = cliPath;
  result.source = normalizeConfiguredCliPath(options.configuredPath) === cliPath ? 'custom' : 'auto';
  const env = { ...options.env, PATH: getEnhancedPath(options.env.PATH, cliPath) };
  try {
    let spec: ManagedStdioProcessOptions = { command: cliPath, args: options.args, cwd: process.cwd(), env };
    if (options.prepareLaunch) {
      spec = options.prepareLaunch(spec);
    } else if (requiresNode) {
      const node = findNodeExecutable(env.PATH);
      if (!node) return result;
      spec = { ...spec, command: node, args: [cliPath, ...options.args] };
    }
    result.version = parseCliVersion(await runProcessProbe(spec));
  } catch {
    // Finding the binary and reading its version are separate outcomes.
  }
  return result;
}
