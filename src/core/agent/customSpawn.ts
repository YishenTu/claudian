/**
 * Gemini CLI process spawner.
 *
 * Spawns the Gemini CLI as a subprocess with --output-format stream-json
 * for structured JSONL output parsing.
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';

import { findNodeExecutable } from '../../utils/env';

export interface GeminiSpawnOptions {
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  enhancedPath?: string;
}

export function spawnGeminiCli(options: GeminiSpawnOptions): ChildProcess {
  const { cliPath, args, cwd, env, signal, enhancedPath } = options;

  let command = cliPath;
  let spawnArgs = args;

  // If cliPath is a .js file, run it with node
  if (cliPath.endsWith('.js')) {
    const nodePath = findNodeExecutable(enhancedPath || env.PATH || '');
    command = nodePath || 'node';
    spawnArgs = [cliPath, ...args];
  }

  return spawn(command, spawnArgs, {
    cwd,
    env: env as NodeJS.ProcessEnv,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
