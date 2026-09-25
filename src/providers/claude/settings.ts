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

export const CLAUDE_SAFE_MODES = ['acceptEdits', 'auto', 'default'] as const;
export type ClaudeSafeMode = typeof CLAUDE_SAFE_MODES[number];
export type ClaudeResponseStyle = 'Default' | 'Concise';
export type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface ClaudeProviderSettings {
  enabled: boolean;
  safeMode: ClaudeSafeMode;
  responseStyle: ClaudeResponseStyle;
  cliPath: string;
  cliPathsByHost: HostnameCLIPaths;
  loadUserSettings: boolean;
  enableChrome: boolean;
  discoveredModels: ClaudeDiscoveredModel[];
  /** Records that the one-time selected-model effort metadata migration completed. */
  effortMetadataMigrated: boolean;
  visibleModels: string[] | null;
  modelAliases: Record<string, string>;
  environmentVariables: string;
  environmentHash: string;
}

export const DEFAULT_CLAUDE_PROVIDER_SETTINGS: Readonly<ClaudeProviderSettings> = Object.freeze({
  enabled: true,
  safeMode: 'acceptEdits',
  responseStyle: 'Default',
  cliPath: '',
  cliPathsByHost: {},
  loadUserSettings: true,
  enableChrome: false,
  discoveredModels: [],
  // Fresh configurations have no saved selections to migrate. A stored config
  // without the field predates the migration and still needs it.
  effortMetadataMigrated: true,
  visibleModels: [],
  modelAliases: {},
  environmentVariables: '',
  environmentHash: '',
});

function normalizeClaudeSafeMode(value: unknown): ClaudeSafeMode | undefined {
  return (CLAUDE_SAFE_MODES as readonly unknown[]).includes(value)
    ? value as ClaudeSafeMode
    : undefined;
}

function readStoredClaudeSafeMode(
  value: unknown,
  fallback: ClaudeSafeMode,
): ClaudeSafeMode {
  if (value === undefined) {
    return fallback;
  }
  return normalizeClaudeSafeMode(value) ?? 'default';
}

export function getClaudeProviderSettings(
  settings: Record<string, unknown>,
): ClaudeProviderSettings {
  const config = getProviderConfig(settings, 'claude');
  const cliPathsByHost = normalizeHostnameStringMap(
    config.cliPathsByHost ?? settings.claudeCliPathsByHost,
  );

  return {
    enabled: readStoredBoolean(
      config.enabled,
      DEFAULT_CLAUDE_PROVIDER_SETTINGS.enabled,
    ),
    responseStyle: config.responseStyle === 'Concise' ? 'Concise' : 'Default',
    safeMode: readStoredClaudeSafeMode(
      config.safeMode,
      readStoredClaudeSafeMode(
        settings.claudeSafeMode,
        DEFAULT_CLAUDE_PROVIDER_SETTINGS.safeMode,
      ),
    ),
    cliPath: readStoredString(
      config.cliPath,
      readStoredString(settings.claudeCliPath, DEFAULT_CLAUDE_PROVIDER_SETTINGS.cliPath),
    ),
    cliPathsByHost,
    loadUserSettings: readStoredBoolean(
      config.loadUserSettings,
      readStoredBoolean(
        settings.loadUserClaudeSettings,
        DEFAULT_CLAUDE_PROVIDER_SETTINGS.loadUserSettings,
      ),
    ),
    enableChrome: readStoredBoolean(
      config.enableChrome,
      readStoredBoolean(settings.enableChrome, DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableChrome),
    ),
    modelAliases: decodeModelAliases(config.modelAliases ?? settings.customModelAliases),
    discoveredModels: decodeClaudeModels(config.discoveredModels ?? config.selectedModels),
    effortMetadataMigrated: config.effortMetadataMigrated === true,
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
      readStoredString(settings.lastEnvHash, DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentHash),
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
  delete stored.enableOpus1M;
  delete stored.enableSonnet1M;
  delete stored.defaultModel;
  const next = {
    ...stored,
    ...current,
    ...updates,
    modelAliases: decodeModelAliases(updates.modelAliases ?? current.modelAliases),
    safeMode: 'safeMode' in updates
      ? normalizeClaudeSafeMode(updates.safeMode) ?? current.safeMode
      : current.safeMode,
  };
  setProviderConfig(settings, 'claude', next);
  return next;
}
