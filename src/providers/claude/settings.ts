import { decodeModelAliases } from '../../core/providers/models/modelAliases';
import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCLIPaths } from '../../core/types/settings';
import { type ClaudeDiscoveredModel, decodeClaudeModels } from './modelCatalog';

export type ClaudeResponseStyle = 'Default' | 'Concise';
type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface ClaudeProviderSettings {
  enabled: boolean;
  responseStyle: ClaudeResponseStyle;
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  loadUserSettings: boolean;
  enableChrome: boolean;
  discoveredModels: ClaudeDiscoveredModel[];
  /** Ordered enabled SDK identities; null seeds selections from legacy configuration. */
  visibleModels: string[] | null;
  modelAliases: Record<string, string>;
  environmentVariables: string;
  environmentHash: string;
}

export const DEFAULT_CLAUDE_PROVIDER_SETTINGS: Readonly<ClaudeProviderSettings> = Object.freeze({
  enabled: true,
  responseStyle: 'Default',
  cliPath: '',
  cliPathsByHost: {},
  loadUserSettings: true,
  enableChrome: false,
  discoveredModels: [],
  // Fresh configurations have no saved selections to migrate. A stored config
  // without the field predates the migration and still needs it.
  visibleModels: [],
  modelAliases: {},
  environmentVariables: '',
  environmentHash: '',
});

export function getClaudeProviderSettings(
  settings: Record<string, unknown>,
): ClaudeProviderSettings {
  const config = getProviderConfig(settings, 'claude');
  const cliPathsByHost = normalizeHostnameStringMap(
    config.cliPathsByHost,
  );

  return {
    enabled: readStoredBoolean(
      config.enabled,
      DEFAULT_CLAUDE_PROVIDER_SETTINGS.enabled,
    ),
    responseStyle: config.responseStyle === 'Concise' ? 'Concise' : 'Default',
    cliPath: readStoredString(
      config.cliPath,
      DEFAULT_CLAUDE_PROVIDER_SETTINGS.cliPath,
    ),
    cliPathsByHost,
    loadUserSettings: readStoredBoolean(
      config.loadUserSettings,
      DEFAULT_CLAUDE_PROVIDER_SETTINGS.loadUserSettings,
    ),
    enableChrome: readStoredBoolean(
      config.enableChrome,
      DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableChrome,
    ),
    modelAliases: decodeModelAliases(config.modelAliases),
    discoveredModels: decodeClaudeModels(config.discoveredModels ?? config.selectedModels),
    visibleModels: config.visibleModels == null ? null : Array.isArray(config.visibleModels)
      ? [...new Set(config.visibleModels.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))]
      : [],
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings, 'claude')
        ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentVariables,
    ),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentHash,
    ),
  };
}

export function resolveClaudeSettingSources(
  loadUserSettings: boolean,
): ClaudeSettingSource[] {
  return loadUserSettings
    ? ['user', 'project', 'local']
    : ['project', 'local'];
}

export function updateClaudeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<ClaudeProviderSettings>,
): ClaudeProviderSettings {
  const current = getClaudeProviderSettings(settings);
  const stored = getProviderConfig(settings, 'claude');
  const next = {
    ...stored,
    ...current,
    ...updates,
    modelAliases: decodeModelAliases(updates.modelAliases ?? current.modelAliases),
  };
  setProviderConfig(settings, 'claude', next);
  return next;
}
