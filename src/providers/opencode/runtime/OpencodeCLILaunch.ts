import {
  CachedProviderCLIResolver,
  type ProviderCLISettingsProjection,
} from '../../../core/providers/cli/CachedProviderCLIResolver';
import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { decodeOpencodeConfig } from '../config';

/** The CLI and environment text a native history read launches with. */
export interface OpencodeHistoryLaunch {
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
export function resolveOpencodeHistoryLaunch(context?: ProviderHistoryPathContext): OpencodeHistoryLaunch {
  const environmentText = context?.environmentText ?? '';
  const projection = projectOpencodeCLIConfig(context?.config ?? {}, environmentText);
  return {
    cliPath: createOpencodeCLIResolver(() => projection).resolve(projection) ?? 'opencode',
    environmentText,
  };
}
