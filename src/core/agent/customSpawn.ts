/**
 * Custom spawn logic for Claude Agent SDK.
 *
 * Provides a custom spawn function that resolves the full path to Node.js
 * instead of relying on PATH lookup. This fixes issues in GUI apps (like Obsidian)
 * where the minimal PATH doesn't include Node.js.
 */

import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

import { findNodeExecutable } from '../../utils/env';

export function createCustomSpawnFunction(
  enhancedPath: string
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    const { args, cwd, env, signal } = options;
    const shouldPipeStderr = !!env?.DEBUG_CLAUDE_AGENT_SDK;

    // Resolve full path to avoid PATH lookup issues in GUI apps
    if (command === 'node') {
      const nodeFullPath = findNodeExecutable(enhancedPath);
      if (nodeFullPath) {
        command = nodeFullPath;
      }
    }

    const child = spawn(command, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      signal,
      stdio: ['pipe', 'pipe', shouldPipeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    });

    if (shouldPipeStderr && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', () => {});
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create process streams');
    }

    return child as unknown as SpawnedProcess;
  };
}
