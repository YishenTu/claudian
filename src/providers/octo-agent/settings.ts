import { getProviderConfig } from '../../core/providers/providerConfig';

export interface OctoAgentProviderSettings {
  enabled: boolean;
  host: string;
  port: number;
  autoStartServer: boolean;
  cliPath: string;
  accessKey: string;
  environmentVariables: string;
  permissionMode?: string;
}

export const DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS: Readonly<OctoAgentProviderSettings> =
  Object.freeze({
    accessKey: '',
    autoStartServer: true,
    cliPath: 'octo',
    enabled: false,
    environmentVariables: '',
    host: '127.0.0.1',
    permissionMode: 'auto',
    port: 8088,
  });

export function getOctoAgentProviderSettings(
  settings: Record<string, unknown>,
): OctoAgentProviderSettings {
  const config = getProviderConfig(settings, 'octo-agent');
  return {
    accessKey: asString(config.accessKey) ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.accessKey,
    autoStartServer: asBoolean(config.autoStartServer)
      ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.autoStartServer,
    cliPath: asString(config.cliPath) ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.cliPath,
    enabled: asBoolean(config.enabled) ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.enabled,
    environmentVariables: asString(config.environmentVariables)
      ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.environmentVariables,
    host: asString(config.host) ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.host,
    permissionMode: asString(config.permissionMode) ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.permissionMode,
    port: asNumber(config.port) ?? DEFAULT_OCTO_AGENT_PROVIDER_SETTINGS.port,
  };
}

export function updateOctoAgentProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OctoAgentProviderSettings>,
): OctoAgentProviderSettings {
  const current = getOctoAgentProviderSettings(settings);
  const next = { ...current, ...updates };
   
  (settings.providerConfigs as Record<string, unknown> | undefined) ??= {};
   
  (settings.providerConfigs as Record<string, unknown>)['octo-agent'] = next;
  return next;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
