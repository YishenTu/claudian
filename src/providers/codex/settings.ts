import { getInstallationKey } from '@/core/device/InstallationKey';

import { selectModelMetadata } from '../../core/providers/models/selectedModelMetadata';
import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { DEFAULT_REASONING_VALUE } from '../../core/providers/reasoning';
import {
  type CodexProviderConfig,
  type CodexProviderSettings,
  decodeCodexConfig,
  decodeCodexStoredConfig,
  DEFAULT_CODEX_PROVIDER_CONFIG,
  getVisibleCodexModelIds,
  shouldDisableCodexReasoningSummary,
  updateCodexConfig,
} from './config';
import {
  findCodexModel,
  getCodexDefaultReasoningEffort,
} from './models';

export interface NormalizeCodexStoredConfigContext {
  platform?: NodeJS.Platform;
  hostnameKey?: string;
}

export interface NormalizeCodexStoredConfigResult {
  config: CodexProviderConfig & Record<string, unknown>;
  changed: boolean;
}

export function applyCodexModelDefaults(
  model: string,
  settings: Record<string, unknown>,
): void {
  const codexSettings = getCodexProviderSettings(settings);
  const modelMetadata = findCodexModel(codexSettings.discoveredModels, model);
  settings.effortLevel = modelMetadata
    ? getCodexDefaultReasoningEffort(modelMetadata, codexSettings.enableUltraEffort)
      ?? DEFAULT_REASONING_VALUE
    : DEFAULT_REASONING_VALUE;
  if (shouldDisableCodexReasoningSummary(model)) {
    updateCodexProviderSettings(settings, { reasoningSummary: 'none' });
  }
}

function getNormalizedCodexStoredConfigContext(
  context: NormalizeCodexStoredConfigContext,
): Required<NormalizeCodexStoredConfigContext> {
  return {
    platform: context.platform ?? process.platform,
    hostnameKey: context.hostnameKey ?? getInstallationKey(),
  };
}

function projectStoredCodexConfigNormalization(
  originalConfig: Record<string, unknown>,
  normalizedConfig: Record<string, unknown>,
): Record<string, unknown> {
  const projected = { ...originalConfig };
  for (const key of Object.keys(DEFAULT_CODEX_PROVIDER_CONFIG)) {
    if (key in originalConfig) {
      projected[key] = normalizedConfig[key];
    }
  }
  delete projected.customModels;
  return projected;
}

export function normalizeCodexStoredConfig(
  settings: Record<string, unknown>,
  context: NormalizeCodexStoredConfigContext = {},
): NormalizeCodexStoredConfigResult {
  const originalConfig = getProviderConfig(settings, 'codex');
  const {
    platform,
    hostnameKey,
  } = getNormalizedCodexStoredConfigContext(context);
  const storedConfig = decodeCodexStoredConfig(originalConfig);
  const installationMethodsByHost = { ...storedConfig.installationMethodsByHost };
  const wslDistroOverridesByHost = { ...storedConfig.wslDistroOverridesByHost };

  if (platform !== 'win32') {
    delete installationMethodsByHost[hostnameKey];
    delete wslDistroOverridesByHost[hostnameKey];
  }

  const normalizedConfig: CodexProviderConfig & Record<string, unknown> = {
    ...originalConfig,
    ...storedConfig,
    installationMethodsByHost,
    wslDistroOverridesByHost,
  };
  delete normalizedConfig.customModels;

  const projectedConfig = projectStoredCodexConfigNormalization(originalConfig, normalizedConfig);
  return {
    config: normalizedConfig,
    changed: JSON.stringify(projectedConfig) !== JSON.stringify(originalConfig),
  };
}

/** Reads Codex's configuration from the settings document. */
export function getCodexProviderSettings(
  settings: Record<string, unknown>,
): CodexProviderSettings {
  return decodeCodexConfig(getProviderConfig(settings, 'codex'));
}

/** Writes Codex's configuration into the settings document. */
export function updateCodexProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CodexProviderSettings>,
): CodexProviderSettings {
  const config = getProviderConfig(settings, 'codex');
  const next = updateCodexConfig(config, updates);
  setProviderConfig(settings, 'codex', config);
  return next;
}

export function projectCodexModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getCodexProviderSettings(settings);
  const visibleModels = getVisibleCodexModelIds(current.visibleModels, current.discoveredModels);
  const selected = new Set(visibleModels);
  const config = {
    ...getProviderConfig(settings, 'codex'),
    visibleModels,
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    selectedModels: current.discoveredModels.filter(model => selected.has(model.model)),
  };
  for (const key of ['discoveredModels', 'catalogTimestamp', 'catalogFingerprint', 'availableModes', 'customModels']) delete (config as Record<string, unknown>)[key];
  return config;
}
