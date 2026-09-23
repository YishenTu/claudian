import {
  CLAUDE_MODEL_TIER_DEFINITIONS,
  type ClaudeModelTierEnvironmentKey,
} from '../modelTiers';

export type ClaudeModelEnvKey = 'ANTHROPIC_MODEL' | ClaudeModelTierEnvironmentKey;

export const CLAUDE_MODEL_ENV_KEYS: readonly ClaudeModelEnvKey[] = [
  'ANTHROPIC_MODEL',
  ...CLAUDE_MODEL_TIER_DEFINITIONS.map(definition => definition.environmentKey),
];

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
