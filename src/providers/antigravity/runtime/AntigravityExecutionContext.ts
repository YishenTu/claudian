import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec, type BuildTargetLaunchSpecOptions } from '@/core/process/execution-target/TargetLaunchSpec';
import type { ExecutionTarget, TargetLaunchSpec } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { ProviderCLIResolutionContext } from '@/core/providers/types';

import { decodeAntigravityConfig } from '../config';
import { resolveAntigravityWSLCLIPath } from './antigravityCLIReference';
import { buildAntigravityRuntimeEnv } from './AntigravityRuntimeEnvironment';
import { getAntigravityWSLForwardedEnvironment } from './antigravityWSLEnvironment';

export type AntigravityExecutionContext = Omit<BuildTargetLaunchSpecOptions, 'args'> & { env: Record<string, string> };

function resolveAntigravityExecutionTarget(host: ProviderRuntimeHost, hostCwd: string): Promise<ExecutionTarget> {
  return resolveExecutionTargetAsync({ settings: decodeAntigravityConfig(host.config, host.selection), hostVaultPath: hostCwd });
}

/** The working directory agy sees, which prompts must name instead of the host vault path. */
export async function resolveAntigravityExecutionWorkingDirectory(host: ProviderRuntimeHost, hostCwd: string): Promise<string> {
  const target = await resolveAntigravityExecutionTarget(host, hostCwd);
  if (target.method !== 'wsl') return hostCwd;
  const targetPath = createExecutionPathMapper(target).toTargetPath(hostCwd);
  if (!targetPath) throw new Error('The Vault path cannot be represented in the selected WSL distro.');
  return targetPath;
}

export async function resolveAntigravityExecutionContext(
  host: ProviderRuntimeHost,
  hostCwd = host.workingDirectory ?? process.cwd(),
  ownerContext?: ProviderCLIResolutionContext,
): Promise<AntigravityExecutionContext> {
  const target = await resolveAntigravityExecutionTarget(host, hostCwd);
  const command = target.method === 'wsl'
    ? resolveAntigravityWSLCLIPath(decodeAntigravityConfig(host.config, host.selection))
    : await host.resolveCliPath(ownerContext) ?? 'agy';
  const environmentText = host.environmentText;
  const env = buildAntigravityRuntimeEnv(environmentText, command, target);
  return { command, env, forwardEnvironment: getAntigravityWSLForwardedEnvironment(env, environmentText), hostCwd, target };
}

export async function resolveAntigravityLaunchSpec(
  host: ProviderRuntimeHost,
  args: readonly string[],
  hostCwd = host.workingDirectory ?? process.cwd(),
  ownerContext?: ProviderCLIResolutionContext,
): Promise<TargetLaunchSpec> {
  return buildTargetLaunchSpec({ ...await resolveAntigravityExecutionContext(host, hostCwd, ownerContext), args });
}
