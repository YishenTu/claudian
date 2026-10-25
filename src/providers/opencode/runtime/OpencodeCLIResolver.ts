import {
  CachedProviderCLIResolver,
  type ProviderCLISettingsProjection,
} from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getProviderConfig } from '../../../core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { decodeOpencodeConfig } from '../config';
import type { OpencodeHistoryLaunch } from '../history/OpencodeConversationHistoryService';

function projectCliConfig(
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

export class OpencodeCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'opencode',
    getSettingsProjection: settings => projectCliConfig(
      getProviderConfig(settings, 'opencode'),
      getRuntimeEnvironmentText(settings, 'opencode'),
    ),
    providerId: 'opencode',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  resolveFromConfig(config: Readonly<Record<string, unknown>>, environmentText: string): string | null {
    return this.resolver.resolve(projectCliConfig(config, environmentText));
  }

  reset(): void {
    this.resolver.reset();
  }
}

/** Resolves a native history read's launch from the configuration a history path context carries. */
export function resolveOpencodeHistoryLaunch(context?: ProviderHistoryPathContext): OpencodeHistoryLaunch {
  const environmentText = context?.environmentText ?? '';
  return {
    cliPath: new OpencodeCLIResolver().resolveFromConfig(context?.config ?? {}, environmentText) ?? 'opencode',
    environmentText,
  };
}
