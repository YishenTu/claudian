import type { ProviderId } from '../../core/providers/types';

export type AcpTransportType = 'stdio' | 'http' | 'websocket';

export interface AcpAgentConfig {
  id: string;
  name: string;
  transportType: AcpTransportType;
  // For stdio
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // For http/websocket (future use)
  url?: string;
  headers?: Record<string, string>;
  // Common
  enabled: boolean;
}

export interface AcpProviderSettings {
  enabled: boolean;
  agents: AcpAgentConfig[];
  defaultAgentId?: string;
}

export const DEFAULT_ACP_SETTINGS: Readonly<AcpProviderSettings> = Object.freeze({
  enabled: false,
  agents: [],
});

export function getAcpProviderSettings(
  settings: Record<string, unknown>,
): AcpProviderSettings {
  const acpSettings = settings.acp as Record<string, unknown> | undefined;
  if (!acpSettings) {
    return { ...DEFAULT_ACP_SETTINGS };
  }

  return {
    enabled: acpSettings.enabled === true,
    agents: Array.isArray(acpSettings.agents)
      ? (acpSettings.agents as AcpAgentConfig[]).filter((agent): agent is AcpAgentConfig =>
        agent && typeof agent.id === 'string' && typeof agent.name === 'string',
      )
      : [],
    defaultAgentId: typeof acpSettings.defaultAgentId === 'string'
      ? acpSettings.defaultAgentId
      : undefined,
  };
}

export function setAcpProviderSettings(
  settings: Record<string, unknown>,
  acpSettings: Partial<AcpProviderSettings>,
): void {
  const current = getAcpProviderSettings(settings);
  const merged: AcpProviderSettings = {
    ...current,
    ...acpSettings,
    agents: acpSettings.agents ?? current.agents,
  };

  (settings as Record<string, unknown>)[providerIdToKey('acp')] = merged;
}

export function providerIdToKey(providerId: ProviderId): string {
  return providerId;
}
