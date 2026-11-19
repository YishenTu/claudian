import { getInstallationKey } from '@/core/device/InstallationKey';
import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import type { ExecutionPathMapper, ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { decodeInstallationSettings, selectInstallationSettings } from '@/core/providers/settings/InstallationSettings';
import type { ProviderHistoryEnvironment, ProviderHistoryPathContext } from '@/core/providers/types';

import { getAntigravityWSLForwardedEnvironment } from '../runtime/antigravityWSLEnvironment';
import { resolveAntigravityStoreRoot } from './AntigravityHistoryPaths';

export interface AntigravityNativeStore {
  /** Host path of agy's data root. */
  readonly root: string;
  /** Maps the Linux paths a WSL agy records; absent for host installations. */
  readonly pathMapper?: ExecutionPathMapper;
}

/** Resolves the native store through the same environment as the CLI: under WSL, the distro's own Linux HOME. */
export async function resolveAntigravityNativeStore(
  context: ProviderHistoryEnvironment & Partial<Pick<ProviderHistoryPathContext, 'config' | 'environmentText'>>,
  resolvedTarget?: ExecutionTarget,
): Promise<AntigravityNativeStore | null> {
  const target = resolvedTarget ?? await resolveExecutionTargetAsync({
    settings: selectInstallationSettings(decodeInstallationSettings(context.config ?? {}), getInstallationKey()),
    hostPlatform: context.hostPlatform,
    hostVaultPath: context.vaultPath,
  });
  if (target.method !== 'wsl') {
    const root = resolveAntigravityStoreRoot(context.environment, context.hostPlatform);
    return root ? { root } : null;
  }
  const pathMapper = createExecutionPathMapper(target);
  // A vault the selected distro cannot address has no Linux cwd to probe from; launch reports that mismatch.
  if (!context.vaultPath || !target.distroName || !pathMapper.toTargetPath(context.vaultPath)) return null;
  const env = Object.fromEntries(Object.entries(context.environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const environment = await probeTargetEnvironment({
    target, hostCwd: context.vaultPath, env,
    forwardEnvironment: getAntigravityWSLForwardedEnvironment(env, context.environmentText ?? ''),
    variables: ['HOME'],
  });
  const root = environment ? resolveAntigravityStoreRoot(environment, context.hostPlatform, target) : null;
  return root ? { pathMapper, root } : null;
}
