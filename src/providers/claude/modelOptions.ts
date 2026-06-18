import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getModelsFromEnvironment } from './env/claudeModelEnv';
import { formatCustomModelLabel } from './modelLabels';
import { encodeClaudeModelSelectionId, toClaudeRuntimeModelId } from './modelSelection';
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
    return customModels.map((model) => ({
      ...model,
      value: encodeClaudeModelSelectionId(model.value),
    }));
  }

  const claudeSettings = getClaudeProviderSettings(settings);
  const models = filterVisibleModelOptions(
    [...DEFAULT_CLAUDE_MODELS],
    claudeSettings.enableOpus1M,
    claudeSettings.enableSonnet1M,
  );

  const seenModelIds = new Set(models.map(model => toClaudeRuntimeModelId(model.value)));
  for (const configuredModelId of parseConfiguredCustomModelIds(claudeSettings.customModels)) {
    const modelId = toClaudeRuntimeModelId(configuredModelId);
    if (seenModelIds.has(modelId)) {
      continue;
    }

    seenModelIds.add(modelId);
    models.push({
      value: encodeClaudeModelSelectionId(modelId),
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
  if (currentModel) {
    const currentRuntimeModel = toClaudeRuntimeModelId(currentModel);
    const currentOption = modelOptions.find(option =>
      option.value === currentModel
      || toClaudeRuntimeModelId(option.value) === currentRuntimeModel
    );
    if (currentOption) {
      return currentOption.value;
    }
  }

  const lastModel = getClaudeProviderSettings(settings).lastModel;
  if (lastModel) {
    const lastRuntimeModel = toClaudeRuntimeModelId(lastModel);
    const lastOption = modelOptions.find(option =>
      option.value === lastModel
      || toClaudeRuntimeModelId(option.value) === lastRuntimeModel
    );
    if (lastOption) {
      return lastOption.value;
    }
  }

  return modelOptions[0]?.value ?? null;
}
