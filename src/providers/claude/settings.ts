import { decodeModelAliases } from '../../core/providers/models/modelAliases';
import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '../../core/providers/settings/storedSettings';
import type { HostnameCLIPaths } from '../../core/types/settings';
import { type ClaudeDiscoveredModel, decodeClaudeModels } from './models';

type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface ClaudeProviderSettings {
  enabled: boolean;
  /** Native output style name; null inherits Claude Code's own setting. */
  outputStyle: string | null;
  promptSuggestions: boolean;
  /** Output style names Claude Code last reported, built-in and custom. */
  discoveredOutputStyles: string[];
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
  outputStyle: null,
  promptSuggestions: false,
  discoveredOutputStyles: [],
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
    outputStyle: readOutputStyle(config),
    promptSuggestions: readStoredBoolean(config.promptSuggestions, false),
    discoveredOutputStyles: decodeOutputStyles(config.discoveredOutputStyles),
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

/** Distinct non-empty style names in reported order. */
export function decodeOutputStyles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === 'string')
    .map(name => name.trim())
    .filter(Boolean))];
}

function readOutputStyle(config: Record<string, unknown>): string | null {
  if (config.outputStyle === null) return null;
  if (typeof config.outputStyle === 'string' && config.outputStyle.trim()) return config.outputStyle.trim();
  // The retired `responseStyle` always sent a style; only Concise was a deliberate choice.
  return config.responseStyle === 'Concise' ? 'Concise' : null;
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
