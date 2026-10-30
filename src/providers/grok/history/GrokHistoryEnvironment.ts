import { getInstallationKey } from '@/core/device/InstallationKey';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { decodeInstallationSettings, selectInstallationSettings } from '@/core/providers/settings/InstallationSettings';
import type { ProviderHistoryEnvironment, ProviderHistoryPathContext } from '@/core/providers/types';

import { getGrokWSLForwardedEnvironment } from '../runtime/grokWSLEnvironment';

export interface GrokHistoryEnvironment extends ProviderHistoryEnvironment {
  target?: ExecutionTarget;
  targetCwd?: string;
}

/** Resolve the native store through the same Linux environment as the CLI. */
export async function resolveGrokHistoryEnvironment(
  context: ProviderHistoryEnvironment & Partial<ProviderHistoryPathContext>,
  resolvedTarget?: ExecutionTarget,
): Promise<GrokHistoryEnvironment> {
  const target = resolvedTarget ?? await resolveExecutionTargetAsync({
    settings: selectInstallationSettings(decodeInstallationSettings(context.config ?? {}), getInstallationKey()),
    hostPlatform: context.hostPlatform,
    hostVaultPath: context.vaultPath,
  });
  if (target.method !== 'wsl') return context;
  const targetCwd = context.vaultPath ? createExecutionPathMapper(target).toTargetPath(context.vaultPath) ?? undefined : undefined;
  const empty = { ...context, environment: {}, target, targetCwd };
  if (!context.vaultPath || !targetCwd || !target.distroName) return empty;
  const env = Object.fromEntries(Object.entries(context.environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const environment = await probeTargetEnvironment({
    target, hostCwd: context.vaultPath, env,
    forwardEnvironment: getGrokWSLForwardedEnvironment(env, context.environmentText ?? ''),
    variables: ['HOME', 'GROK_HOME'],
  });
  return { ...empty, environment: environment ?? {} };
}
