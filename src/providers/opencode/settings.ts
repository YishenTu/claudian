import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';

export interface OpencodeProviderSettings {
  enabled: boolean;
  prewarm: boolean;
  cliPath?: string;
  environmentVariables?: string;
}

export const DEFAULT_OPENCODE_PROVIDER_SETTINGS: Readonly<OpencodeProviderSettings> = Object.freeze({
  enabled: false,
  prewarm: true,
  cliPath: '',
  environmentVariables: '',
});

export function getOpencodeProviderSettings(settings: Record<string, unknown>): OpencodeProviderSettings {
  const config = getProviderConfig(settings, 'opencode');
  return {
    enabled: (config.enabled as boolean) ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.enabled,
    prewarm: (config.prewarm as boolean) ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.prewarm,
    cliPath: (config.cliPath as string) ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.cliPath,
    environmentVariables: (config.environmentVariables as string) ?? DEFAULT_OPENCODE_PROVIDER_SETTINGS.environmentVariables,
  };
}

export function updateOpencodeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OpencodeProviderSettings>,
): OpencodeProviderSettings {
  const current = getOpencodeProviderSettings(settings);
  const next: OpencodeProviderSettings = {
    ...current,
    ...updates,
  };

  setProviderConfig(settings, 'opencode', {
    enabled: next.enabled,
    prewarm: next.prewarm,
    cliPath: next.cliPath,
    environmentVariables: next.environmentVariables,
  });

  return next;
}
