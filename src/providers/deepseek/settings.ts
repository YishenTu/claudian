import { getInstallationKey } from '@/core/device/InstallationKey';
import { decodeModelAliases } from '@/core/providers/models/modelAliases';
import { selectModelMetadata } from '@/core/providers/models/selectedModelMetadata';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '@/core/providers/providerEnvironment';
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

export function getDeepSeekProviderSettings(settings: Record<string, unknown>): DeepSeekProviderSettings {
  const config = getProviderConfig(settings, 'deepseek');
  const visibleModels = Array.isArray(config.visibleModels)
    ? [...new Set(config.visibleModels.filter((value): value is string => typeof value === 'string' && !!decodeDeepSeekModelId(value)))]
    : [];
  return {
    enabled: readStoredBoolean(config.enabled, false),
    codeMode: readStoredBoolean(config.codeMode, false),
    presetPlugins: readStoredString(config.presetPlugins, ''),
    cliPath: readStoredString(config.cliPath, ''),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    environmentVariables: getProviderEnvironmentVariables(settings, 'deepseek'),
    environmentHash: readStoredString(config.environmentHash, ''),
    discoveredModels: normalizeDeepSeekModels(config.discoveredModels ?? config.selectedModels),
    visibleModels,
    modelAliases: normalizeModelMap(config.modelAliases),
    preferredReasoningByModel: normalizeModelMap(config.preferredReasoningByModel),
  };
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

export function updateDeepSeekProviderSettings(
  settings: Record<string, unknown>, updates: Partial<DeepSeekProviderSettings>,
): DeepSeekProviderSettings {
  const current = getDeepSeekProviderSettings(settings);
  const next = { ...current, ...updates };
  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    next.cliPathsByHost = { ...current.cliPathsByHost };
    const key = getInstallationKey();
    const path = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (path) next.cliPathsByHost[key] = path;
    else delete next.cliPathsByHost[key];
    next.cliPath = '';
  }
  setProviderConfig(settings, 'deepseek', { ...getProviderConfig(settings, 'deepseek'), ...next });
  const normalized = getDeepSeekProviderSettings(settings);
  setProviderConfig(settings, 'deepseek', { ...getProviderConfig(settings, 'deepseek'), ...normalized });
  return normalized;
}

export function projectDeepSeekModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getDeepSeekProviderSettings(settings);
  const selected = new Set(current.visibleModels);
  const config: Record<string, unknown> = {
    ...getProviderConfig(settings, 'deepseek'), ...current,
    selectedModels: current.discoveredModels.filter(model => selected.has(model.encodedId)),
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredReasoningByModel: selectModelMetadata(current.preferredReasoningByModel, selected),
  };
  delete config.discoveredModels;
  return config;
}
