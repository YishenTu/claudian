import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type ChildProcess, spawn } from 'child_process';

import { cliPathRequiresNode, findNodeExecutable } from '../../../utils/env';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '../../../utils/windowsCmdShim';

export function createCustomSpawnFunction(
  enhancedPath: string
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    let { args } = options;
    const { cwd, env, signal } = options;
    const shouldPipeStderr = !!env?.DEBUG_CLAUDE_AGENT_SDK;

    // The SDK only routes some script extensions through `node`; normalize the
    // remaining Node-backed paths here before Electron spawns with shell=false.
    if (command === 'node' || cliPathRequiresNode(command)) {
      const nodeFullPath = findNodeExecutable(enhancedPath);
      if (command === 'node') {
        if (nodeFullPath) {
          command = nodeFullPath;
        }
      } else {
        args = [command, ...args];
        command = nodeFullPath ?? 'node';
      }
    }

    const resolvedSpawnSpec = resolveWindowsCmdShimSpawnSpec({ args, command });

    // Do not pass `signal` directly to spawn() — Obsidian's Electron runtime
    // uses a different realm for AbortSignal, causing `instanceof EventTarget`
    // checks inside Node's internals to fail. Handle abort manually instead.
    const child = spawn(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
      cwd,
      env: env,
      stdio: ['pipe', 'pipe', shouldPipeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
      ...(resolvedSpawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    installTreeAwareKill(child, resolvedSpawnSpec);

    if (signal) {
      const killChild = (): void => {
        child.kill('SIGTERM');
      };
      if (signal.aborted) {
        killChild();
      } else {
        signal.addEventListener('abort', killChild, { once: true });
      }
    }

    if (shouldPipeStderr && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', () => {});
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create process streams');
    }

    return child as unknown as SpawnedProcess;
  };
}

function installTreeAwareKill(child: ChildProcess, spawnSpec: WindowsCmdShimSpawnSpec): void {
  if (!spawnSpec.killProcessTree) {
    return;
  }

  const originalKill: (signal?: NodeJS.Signals | number) => boolean = child.kill.bind(child);
  const killableChild = {
    get pid(): number | undefined {
      return child.pid;
    },
    kill: (signal?: NodeJS.Signals | number): boolean => originalKill(signal),
  };

  child.kill = ((signal?: NodeJS.Signals | number): boolean =>
    terminateSpawnedProcess(killableChild, signal, spawn, spawnSpec)
  );
}
