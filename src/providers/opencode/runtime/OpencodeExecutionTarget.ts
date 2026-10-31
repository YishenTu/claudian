import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { forwardWSLEnvironment, selectWSLForwardedEnvironment, type WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

import { decodeOpencodeConfig } from '../config';
import { buildOpencodeRuntimeEnv } from './OpencodeRuntimeEnvironment';

export function opencodeEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Only provider-owned values and explicitly configured user values cross the boundary. */
export function getOpencodeWSLForwardedEnvironment(env: NodeJS.ProcessEnv, environmentText = ''): WSLForwardedVariable[] {
  return selectWSLForwardedEnvironment({
    env, configured: parseEnvironmentVariables(environmentText),
    inheritedKeys: [...Object.keys(env).filter(key => /^(?:OPENCODE_|CLAUDIAN_SESSION_TOOLS_)/u.test(key)), 'XDG_DATA_HOME'],
    providerPathVariables: [{ key: 'HOME' }, { key: 'XDG_DATA_HOME' }, { key: 'OPENCODE_DB' }, { key: 'OPENCODE_CONFIG' }],
  });
}

export function opencodeTargetPath(value: string, target?: ExecutionTarget): string {
  if (!target || target.method !== 'wsl' || value === ':memory:') return value;
  if (!/^(?:[a-zA-Z]:|[\\/]{2})/u.test(value)) return path.posix.normalize(value);
  const mapped = createExecutionPathMapper(target).toTargetPath(value);
  if (!mapped) throw new Error(`OpenCode path is outside the selected WSL distro: ${value}`);
  return mapped;
}

export function opencodeHostPath(value: string, target?: ExecutionTarget): string {
  if (!target || target.method !== 'wsl') return value;
  const mapped = createExecutionPathMapper(target).toHostPath(opencodeTargetPath(value, target));
  if (!mapped) throw new Error(`Cannot access OpenCode path from Windows: ${value}`);
  return mapped;
}

export function opencodeFileURL(value: string, target?: ExecutionTarget): string {
  if (target?.method !== 'wsl') return pathToFileURL(value).href;
  const url = new URL('file:///');
  url.pathname = opencodeTargetPath(value, target).split('/').map(part => encodeURIComponent(part)).join('/');
  return url.href;
}

export function resolveOpencodeTarget(config: Readonly<Record<string, unknown>>, cwd: string): Promise<ExecutionTarget> {
  return resolveExecutionTargetAsync({ settings: decodeOpencodeConfig(config), hostVaultPath: cwd });
}

/** Provider-owned async cache. Transitions clear it; projections never probe the target. */
export class OpencodeTargetEnvironment {
  private cached?: { key: string; value: Promise<NodeJS.ProcessEnv> };

  reset(): void { this.cached = undefined; }

  async resolve(target: ExecutionTarget, cwd: string, environmentText: string, cliPath: string, inherited?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const env = buildOpencodeRuntimeEnv(environmentText, cliPath, undefined, inherited, target);
    if (target.method !== 'wsl') return env;
    const forwarded = forwardWSLEnvironment(opencodeEnvironment(env), getOpencodeWSLForwardedEnvironment(env, environmentText));
    const key = JSON.stringify([target, cwd, forwarded]);
    if (this.cached?.key === key) return this.cached.value;
    const value = (async () => {
      // Inline JSON is literal, so a known value need not consume the shared probe's output budget.
      const variables = ['HOME', 'XDG_DATA_HOME', 'OPENCODE_DB', 'OPENCODE_CONFIG', ...(env.OPENCODE_CONFIG_CONTENT === undefined ? ['OPENCODE_CONFIG_CONTENT'] : [])];
      const native = await probeTargetEnvironment({ target, hostCwd: cwd, env: forwarded, variables });
      if (!native?.HOME || !path.posix.isAbsolute(native.HOME)) throw new Error('Could not resolve the OpenCode WSL home. Check the distro and shell configuration.');
      const resolved = opencodeEnvironment({ ...forwarded, ...native });
      return forwardWSLEnvironment(resolved, getOpencodeWSLForwardedEnvironment(resolved, environmentText));
    })();
    this.cached = { key, value };
    try { return await value; } catch (error) { if (this.cached?.value === value) this.reset(); throw error; }
  }
}
