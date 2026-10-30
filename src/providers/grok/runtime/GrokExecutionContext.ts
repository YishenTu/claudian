import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { BuildTargetLaunchSpecOptions } from '@/core/process/execution-target/TargetLaunchSpec';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { ProviderCLIResolutionContext } from '@/core/providers/types';

import { decodeGrokConfig } from '../config';
import { resolveGrokWSLCLIPath } from './grokCLIReference';
import { buildGrokRuntimeEnv } from './GrokRuntimeEnvironment';
import { getGrokWSLForwardedEnvironment } from './grokWSLEnvironment';

export type GrokExecutionContext = Omit<BuildTargetLaunchSpecOptions, 'args'>;

async function resolveGrokExecutionTarget(host: ProviderRuntimeHost, hostCwd: string) {
  const settings = decodeGrokConfig(host.config, host.selection);
  return resolveExecutionTargetAsync({ settings, hostVaultPath: hostCwd });
}

export async function resolveGrokExecutionWorkingDirectory(host: ProviderRuntimeHost, hostCwd: string): Promise<string> {
  const target = await resolveGrokExecutionTarget(host, hostCwd);
  if (target.method !== 'wsl') return hostCwd;
  const targetPath = createExecutionPathMapper(target).toTargetPath(hostCwd);
  if (!targetPath) throw new Error('The Vault path cannot be represented in the selected WSL distro.');
  return targetPath;
}

export async function resolveGrokExecutionContext(
  host: ProviderRuntimeHost,
  hostCwd = host.workingDirectory ?? process.cwd(),
  ownerContext?: ProviderCLIResolutionContext,
): Promise<GrokExecutionContext> {
  const settings = decodeGrokConfig(host.config, host.selection);
  const target = await resolveGrokExecutionTarget(host, hostCwd);
  const command = target.method === 'wsl'
    ? resolveGrokWSLCLIPath(settings)
    : await host.resolveCliPath(ownerContext) ?? 'grok';
  const environmentText = host.environmentText;
  const env = Object.fromEntries(Object.entries(buildGrokRuntimeEnv(environmentText, command, target))
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { target, command, hostCwd, env, forwardEnvironment: getGrokWSLForwardedEnvironment(env, environmentText) };
}
