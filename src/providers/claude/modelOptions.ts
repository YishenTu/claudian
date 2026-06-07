import { getActiveCCSwitchSnapshot } from '../../core/ccswitch/CCSwitchSnapshot';
import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getModelsFromEnvironment } from './env/claudeModelEnv';
import { formatCustomModelLabel } from './modelLabels';
import { getClaudeProviderSettings } from './settings';
import { DEFAULT_CLAUDE_MODELS, filterVisibleModelOptions } from './types/models';

function parseConfiguredCustomModelIds(value: string): string[] {
  const modelIds: string[] = [];
  const seen = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const modelId = line.trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }

  return modelIds;
}

function normalizeCustomModelAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const aliases: Record<string, string> = {};
  for (const [rawModelId, rawAlias] of Object.entries(value)) {
    if (typeof rawAlias !== 'string') {
      continue;
    }

    const modelId = rawModelId.trim();
    const alias = rawAlias.trim();
    if (modelId && alias) {
      aliases[modelId] = alias;
    }
  }

  return aliases;
}

export function getClaudeModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const customModelAliases = normalizeCustomModelAliases(settings.customModelAliases);
  const customModels = getModelsFromEnvironment(
    getRuntimeEnvironmentVariables(settings, 'claude'),
    customModelAliases,
  );
  if (customModels.length > 0) {
    return customModels;
  }

  const claudeSettings = getClaudeProviderSettings(settings);
  const models = filterVisibleModelOptions(
    [...DEFAULT_CLAUDE_MODELS],
    claudeSettings.enableOpus1M,
    claudeSettings.enableSonnet1M,
  );

  const seenValues = new Set(models.map(model => model.value));
  const switchModel = getActiveCCSwitchSnapshot(settings, 'claude')?.model;
  if (switchModel) {
    const existingIndex = models.findIndex(model => model.value === switchModel);
    if (existingIndex >= 0) {
      models.splice(existingIndex, 1);
    }
    seenValues.add(switchModel);
    models.unshift({
      value: switchModel,
      label: customModelAliases[switchModel] ?? formatCustomModelLabel(switchModel),
      description: 'CC-Switch active model',
    });
  }
  for (const modelId of parseConfiguredCustomModelIds(claudeSettings.customModels)) {
    if (seenValues.has(modelId)) {
      continue;
    }

    seenValues.add(modelId);
    models.push({
      value: modelId,
      label: customModelAliases[modelId] ?? formatCustomModelLabel(modelId),
      description: 'Custom model',
    });
  }

  return models;
}

export function resolveClaudeModelSelection(
  settings: Record<string, unknown>,
  currentModel: string,
): string | null {
  const modelOptions = getClaudeModelOptions(settings);
  const defaultModelIds = new Set(DEFAULT_CLAUDE_MODELS.map(option => option.value));
  const switchModel = getActiveCCSwitchSnapshot(settings, 'claude')?.model;
  if (switchModel && (!currentModel || defaultModelIds.has(currentModel))) {
    return switchModel;
  }

  if (currentModel && modelOptions.some(option => option.value === currentModel)) {
    return currentModel;
  }

  const lastModel = getClaudeProviderSettings(settings).lastModel;
  if (lastModel && modelOptions.some(option => option.value === lastModel)) {
    return lastModel;
  }

  return modelOptions[0]?.value ?? null;
}
