import { getInstallationKey } from '@/core/device/InstallationKey';
import { decodeModelAliases } from '@/core/providers/models/modelAliases';
import { normalizeHostnameStringMap } from '@/core/providers/settings/HostnameStringMap';
import { readStoredBoolean, readStoredString } from '@/core/providers/settings/storedSettings';

import { decodeDeepSeekModelId, type DeepSeekModel, normalizeDeepSeekModels } from './models';

export interface DeepSeekProviderSettings {
  enabled: boolean;
  codeMode: boolean;
  /** Raw YAML list of additional chat preset rows, validated before it is saved. */
  presetPlugins: string;
  cliPath: string;
  cliPathsByHost: Record<string, string>;
  environmentVariables: string;
  environmentHash: string;
  discoveredModels: DeepSeekModel[];
  visibleModels: string[];
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, string>;
}

export const DEFAULT_DEEPSEEK_PROVIDER_SETTINGS: Readonly<DeepSeekProviderSettings> = Object.freeze({
  enabled: false, codeMode: false, presetPlugins: '', cliPath: '', cliPathsByHost: {}, environmentVariables: '',
  environmentHash: '',
  discoveredModels: [], visibleModels: [], modelAliases: {}, preferredReasoningByModel: {},
});

export function decodeDeepSeekConfig(config: Readonly<Record<string, unknown>>): DeepSeekProviderSettings {
  const visibleModels = Array.isArray(config.visibleModels)
    ? [...new Set(config.visibleModels.filter((value): value is string => typeof value === 'string' && !!decodeDeepSeekModelId(value)))]
    : [];
  return {
    enabled: readStoredBoolean(config.enabled, false),
    codeMode: readStoredBoolean(config.codeMode, false),
    presetPlugins: readStoredString(config.presetPlugins, ''),
    cliPath: readStoredString(config.cliPath, ''),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    environmentVariables: readStoredString(config.environmentVariables, ''),
    environmentHash: readStoredString(config.environmentHash, ''),
    discoveredModels: normalizeDeepSeekModels(config.discoveredModels ?? config.selectedModels),
    visibleModels,
    modelAliases: normalizeModelMap(config.modelAliases),
    preferredReasoningByModel: normalizeModelMap(config.preferredReasoningByModel),
  };
}

/** Applies updates to a stored DeepSeek configuration in place; keys this provider does not decode are kept. */
export function updateDeepSeekConfig(
  config: Record<string, unknown>, updates: Partial<DeepSeekProviderSettings>,
): DeepSeekProviderSettings {
  const current = decodeDeepSeekConfig(config);
  const next = { ...current, ...updates };
  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    next.cliPathsByHost = { ...current.cliPathsByHost };
    const key = getInstallationKey();
    const path = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (path) next.cliPathsByHost[key] = path;
    else delete next.cliPathsByHost[key];
    next.cliPath = '';
  }
  Object.assign(config, next);
  const normalized = decodeDeepSeekConfig(config);
  Object.assign(config, normalized);
  return normalized;
}

function normalizeModelMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(decodeModelAliases(value)).filter(([id]) => !!decodeDeepSeekModelId(id)));
}

export function findDeepSeekModel(current: DeepSeekProviderSettings, id: string): DeepSeekModel | undefined {
  return current.discoveredModels.find(model => model.encodedId === id);
}

/** A visible model the latest native catalog still offers. */
export function isDeepSeekModelSelectable(current: DeepSeekProviderSettings, id: string): boolean {
  const model = findDeepSeekModel(current, id);
  return current.visibleModels.includes(id) && !!model && model.available !== false;
}
