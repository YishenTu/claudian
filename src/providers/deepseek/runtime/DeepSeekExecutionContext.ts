import { posix } from 'node:path';

import { parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionPathMapper, ExecutionTarget } from '@/core/process/execution-target/types';
import type { WSLForwardedVariable } from '@/core/process/execution-target/WSLEnvironment';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeDeepSeekConfig } from '../config';
import { getDeepSeekHome } from './DeepSeekHome';

/** Resolved once for a Host generation, discarded with it on a provider transition. Metadata never probes a home. */
export interface DeepSeekExecutionContext {
  readonly target: ExecutionTarget;
  readonly pathMapper: ExecutionPathMapper;
  readonly targetCwd: string;
  readonly targetHome: string;
  /** The host-visible native store identity, including its distro for Linux filesystem stores. */
  readonly home: string;
  readonly forwardEnvironment: readonly WSLForwardedVariable[];
}

const PATH_KEYS = new Set(['DSH_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'TMPDIR', 'TMP', 'TEMP']);

/** DeepSeek declares the meaning of its exports; shared mechanics encode WSLENV. */
export function getDeepSeekWSLForwardedEnvironment(env: Record<string, string>, environmentText: string): WSLForwardedVariable[] {
  const configured = parseEnvironmentVariables(environmentText);
  const keys = new Set([...Object.keys(configured), ...Object.keys(env).filter(key => /^(?:DSH_|DEEPSEEK_)/u.test(key))]);
  return [...keys].filter(key => {
    if (['HOME', 'PATH', 'USERPROFILE'].includes(key)) {
      return key !== 'USERPROFILE' && configured[key]?.startsWith('/') && !configured[key].includes('\\');
    }
    return key !== 'WSLENV';
  }).map(key => {
    const hostPath = PATH_KEYS.has(key) && /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/u.test(env[key] ?? '');
    return { key, hostPath, pathList: hostPath && key === 'SSL_CERT_DIR' };
  });
}

export async function resolveDeepSeekExecutionWorkingDirectory(host: ProviderRuntimeHost, hostCwd: string): Promise<string> {
  const target = await resolveExecutionTargetAsync({ settings: decodeDeepSeekConfig(host.config), hostVaultPath: hostCwd });
  return buildTargetLaunchSpec({ target, hostCwd, command: 'dsh', args: [], env: {} }).targetCwd;
}

export async function resolveDeepSeekExecutionContext(
  target: ExecutionTarget, hostCwd: string, env: Record<string, string>, environmentText: string,
): Promise<DeepSeekExecutionContext> {
  const forwardEnvironment = getDeepSeekWSLForwardedEnvironment(env, environmentText);
  const spec = buildTargetLaunchSpec({ target, hostCwd, command: 'dsh', args: [], env, forwardEnvironment });
  let childEnvironment: NodeJS.ProcessEnv = env;
  if (target.method === 'wsl') {
    if (forwardEnvironment.some(row => row.key === 'DSH_HOME' && row.hostPath) && !spec.pathMapper.toTargetPath(env.DSH_HOME)) {
      throw new Error('DSH_HOME must be accessible inside the selected WSL distro.');
    }
    const probed = await probeTargetEnvironment({ target, hostCwd, env, forwardEnvironment, variables: ['HOME', 'DSH_HOME'] });
    if (!probed?.HOME) throw new Error('Could not resolve the Linux home in WSL. Check the selected distro and its shell environment.');
    childEnvironment = probed;
  }
  const targetHome = getDeepSeekHome(childEnvironment, spec.targetCwd, target.platformOs === 'windows' ? 'win32' : 'linux');
  const home = spec.pathMapper.toHostPath(targetHome);
  if (!home) throw new Error('DeepSeek home cannot be accessed from the selected WSL distro.');
  return { target, pathMapper: spec.pathMapper, targetCwd: spec.targetCwd, targetHome, home, forwardEnvironment };
}


/** Native tool paths must be host-visible before rendering/diff consumers perform filesystem reads. */
export function toDeepSeekHostPath(path: string, execution?: DeepSeekExecutionContext): string {
  if (!execution || execution.target.method !== 'wsl' || !path) return path;
  return execution.pathMapper.toHostPath(posix.resolve(execution.targetCwd, path)) ?? path;
}
