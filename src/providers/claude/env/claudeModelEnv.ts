import { formatCustomModelLabel } from '../modelLabels';
import {
  CLAUDE_MODEL_TIER_DEFINITIONS,
  type ClaudeModelEnvironmentType,
  type ClaudeModelTierEnvironmentKey,
  getClaudeModelTierDefinition,
} from '../modelTiers';

export type ClaudeModelEnvKey = 'ANTHROPIC_MODEL' | ClaudeModelTierEnvironmentKey;
export type ClaudeModelEnvType = ClaudeModelEnvironmentType;

export const CLAUDE_MODEL_ENV_KEYS: readonly ClaudeModelEnvKey[] = [
  'ANTHROPIC_MODEL',
  ...CLAUDE_MODEL_TIER_DEFINITIONS.map(definition => definition.environmentKey),
];

export interface ClaudeEnvironmentModel {
  value: string;
  label: string;
  description: string;
  environmentTypes: ClaudeModelEnvType[];
}

function getModelTypeFromEnvKey(envKey: ClaudeModelEnvKey): ClaudeModelEnvType {
  if (envKey === 'ANTHROPIC_MODEL') {
    return 'model';
  }
  return CLAUDE_MODEL_TIER_DEFINITIONS.find(definition => definition.environmentKey === envKey)!.id;
}

function getModelTypePriority(type: ClaudeModelEnvType): number {
  return type === 'model'
    ? CLAUDE_MODEL_TIER_DEFINITIONS.length + 1
    : getClaudeModelTierDefinition(type).environmentPriority;
}

export function getModelsFromEnvironment(
  envVars: Record<string, string>,
  modelAliases: Record<string, string> = {},
): ClaudeEnvironmentModel[] {
  const modelMap = new Map<string, { types: ClaudeModelEnvType[]; label: string }>();

  for (const envKey of CLAUDE_MODEL_ENV_KEYS) {
    const type = getModelTypeFromEnvKey(envKey);
    const modelValue = envVars[envKey];
    if (modelValue) {
      const label = modelAliases[modelValue] ?? formatCustomModelLabel(modelValue);

      if (!modelMap.has(modelValue)) {
        modelMap.set(modelValue, { types: [type], label });
      } else {
        modelMap.get(modelValue)!.types.push(type);
      }
    }
  }

  const models: ClaudeEnvironmentModel[] = [];

  const sortedEntries = Array.from(modelMap.entries()).sort(([, aInfo], [, bInfo]) => {
    const aPriority = Math.max(...aInfo.types.map(getModelTypePriority));
    const bPriority = Math.max(...bInfo.types.map(getModelTypePriority));
    return bPriority - aPriority;
  });

  for (const [modelValue, info] of sortedEntries) {
    const sortedTypes = info.types.sort((a, b) =>
      getModelTypePriority(b) - getModelTypePriority(a)
    );

    models.push({
      value: modelValue,
      label: info.label,
      description: `Custom model (${sortedTypes.join(', ')})`,
      environmentTypes: [...sortedTypes],
    });
  }

  return models;
}

export function getCurrentModelFromEnvironment(envVars: Record<string, string>): string | null {
  for (const envKey of CLAUDE_MODEL_ENV_KEYS) {
    const modelId = envVars[envKey];
    if (modelId) {
      return modelId;
    }
  }
  return null;
}

export function getCustomModelIds(envVars: Record<string, string>): Set<string> {
  const modelIds = new Set<string>();
  for (const envKey of CLAUDE_MODEL_ENV_KEYS) {
    const modelId = envVars[envKey];
    if (modelId) {
      modelIds.add(modelId);
    }
  }
  return modelIds;
}
