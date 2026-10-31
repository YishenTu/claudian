import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type ChildProcess, spawn as nodeSpawn } from 'child_process';
import crossSpawn from 'cross-spawn';

import { cliPathRequiresNode, findNodeExecutable } from '@/core/process/env';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '@/core/process/windowsCmdShim';

import { getClaudeWSLForwardedEnvironment } from './claudeWSLEnvironment';

const spawn = crossSpawn as typeof nodeSpawn;

export function createCustomSpawnFunction(
  enhancedPath: string,
  execution?: { target: ExecutionTarget; hostCwd: string; environmentText: string },
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    let { args } = options;
    const { cwd, env, signal } = options;
    const shouldPipeStderr = !!env?.DEBUG_CLAUDE_AGENT_SDK;

    // The SDK only routes some script extensions through `node`; normalize the
    // remaining Node-backed paths here before Electron spawns with shell=false.
    const isWSL = execution?.target.method === 'wsl';
    const requiresNode = !isWSL && (command === 'node' || cliPathRequiresNode(command));
    if (requiresNode) {
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

    const wslSpec = isWSL ? buildTargetLaunchSpec({
      target: execution.target, hostCwd: execution.hostCwd, command, args,
      env: env as Record<string, string>,
      forwardEnvironment: getClaudeWSLForwardedEnvironment(env as Record<string, string>, execution.environmentText),
    }) : undefined;
    const resolvedSpawnSpec = wslSpec ?? resolveWindowsCmdShimSpawnSpec({ args, command });

    // Do not pass `signal` directly to spawn() — Obsidian's Electron runtime
    // uses a different realm for AbortSignal, causing `instanceof EventTarget`
    // checks inside Node's internals to fail. Handle abort manually instead.
    const spawnProcess = isWSL || (process.platform === 'win32' && requiresNode) ? nodeSpawn : spawn;
    const child = spawnProcess(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
      cwd: wslSpec?.spawnCwd ?? cwd,
      env: wslSpec?.env ?? env,
      ...(wslSpec ? { windowsVerbatimArguments: wslSpec.windowsVerbatimArguments } : {}),
      stdio: ['pipe', 'pipe', shouldPipeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    });
    if (!wslSpec) installTreeAwareKill(child, resolvedSpawnSpec);

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

  const originalKill = child.kill.bind(child);
  const callOriginalKill = (signal?: NodeJS.Signals | number): boolean =>
    originalKill(signal);
  const killableChild = {
    get pid(): number | undefined {
      return child.pid;
    },
    kill: callOriginalKill,
  };

  child.kill = ((signal?: NodeJS.Signals | number): boolean =>
    terminateSpawnedProcess(killableChild, signal, spawn, spawnSpec)
  );
}
