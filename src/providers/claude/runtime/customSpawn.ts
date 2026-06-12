import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type ChildProcess, spawn } from 'child_process';

import { cliPathRequiresNode, findNodeExecutable } from '../../../utils/env';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '../../../utils/windowsCmdShim';
import type { ClaudeExecutionContext } from './ClaudeExecutionContext';

function quotePosixShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function buildWslEnv(env: SpawnOptions['env']): SpawnOptions['env'] {
  const propagated = Object.keys(env)
    .filter(key => /^(?:ANTHROPIC_|CLAUDE_)/i.test(key));
  const existing = (env.WSLENV ?? '').split(':').filter(Boolean);
  return {
    ...env,
    WSLENV: [...new Set([...existing, ...propagated])].join(':'),
  };
}

export function createCustomSpawnFunction(
  enhancedPath: string,
  executionContext?: ClaudeExecutionContext,
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    let { args } = options;
    let { cwd, env } = options;
    const { signal } = options;
    const shouldPipeStderr = !!env?.DEBUG_CLAUDE_AGENT_SDK;

    if (executionContext?.method === 'wsl') {
      if (cliPathRequiresNode(command)) {
        args = [command, ...args];
        command = 'node';
      }
      const shellCommand = [
        'exec',
        quotePosixShellArgument(command),
        ...args.map(quotePosixShellArgument),
      ].join(' ');
      command = 'wsl.exe';
      args = [
        '--distribution',
        executionContext.distroName!,
        '--cd',
        executionContext.targetVaultPath,
        '--exec',
        'sh',
        '-lc',
        'exec "$SHELL" -lic "$1"',
        'sh',
        shellCommand,
      ];
      cwd = executionContext.hostVaultPath;
      env = buildWslEnv(env);
    }

    // The SDK only routes some script extensions through `node`; normalize the
    // remaining Node-backed paths here before Electron spawns with shell=false.
    if (executionContext?.method !== 'wsl' && (command === 'node' || cliPathRequiresNode(command))) {
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

  const originalKill = child.kill;
  const killableChild = {
    get pid(): number | undefined {
      return child.pid;
    },
    kill: (signal?: NodeJS.Signals | number): boolean => originalKill.call(child, signal),
  };

  child.kill = ((signal?: NodeJS.Signals | number): boolean =>
    terminateSpawnedProcess(killableChild, signal, spawn, spawnSpec)
  );
}
