import type { ExecutionTarget } from '@/core/process/execution-target/types';

import {
  CachedProviderCLIResolver,
  type ProviderCLISettingsProjection,
} from '../../../core/providers/cli/CachedProviderCLIResolver';
import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { decodeOpencodeConfig } from '../config';
import { resolveOpencodeWSLCLIPath } from './opencodeCLIReference';
import { resolveOpencodeTarget } from './OpencodeExecutionTarget';

/** The CLI and environment text a native history read launches with. */
export interface OpencodeHistoryLaunch {
  readonly target: ExecutionTarget;
  readonly cliPath: string;
  readonly environmentText: string;
}

/** Projects OpenCode provider configuration onto the inputs CLI resolution reads. */
export function projectOpencodeCLIConfig(
  config: Readonly<Record<string, unknown>>,
  environmentText: string,
): ProviderCLISettingsProjection {
  const providerSettings = decodeOpencodeConfig(config);
  return {
    cliPathsByHost: providerSettings.cliPathsByHost,
    environmentText,
    legacyCliPath: providerSettings.cliPath,
  };
}

export function createOpencodeCLIResolver(
  getSettingsProjection: (settings: Record<string, unknown>) => ProviderCLISettingsProjection,
): CachedProviderCLIResolver {
  return new CachedProviderCLIResolver({
    binaryName: 'opencode',
    getSettingsProjection,
    providerId: 'opencode',
  });
}

/** Resolves a native history read's launch from the configuration a history path context carries. */
export async function resolveOpencodeHistoryLaunch(context?: ProviderHistoryPathContext, cwd = context?.vaultPath ?? process.cwd()): Promise<OpencodeHistoryLaunch> {
  const target = await resolveOpencodeTarget(context?.config ?? {}, cwd);
  const environmentText = context?.environmentText ?? '';
  const projection = projectOpencodeCLIConfig(context?.config ?? {}, environmentText);
  return {
    target,
    cliPath: target.method === 'wsl' ? resolveOpencodeWSLCLIPath(decodeOpencodeConfig(context?.config ?? {})) : createOpencodeCLIResolver(() => projection).resolve(projection) ?? 'opencode',
    environmentText,
  };
}
