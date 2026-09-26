export const CLAUDE_MODEL_TIER_DEFINITIONS = [
  {
    id: 'haiku',
    label: 'Haiku',
    agentLabel: 'Haiku',
    description: 'Fast and efficient',
    environmentKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    supportsOneMillionSuffix: false,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    agentLabel: 'Sonnet',
    description: 'Balanced performance',
    environmentKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    supportsOneMillionSuffix: true,
  },
  {
    id: 'opus',
    label: 'Opus',
    agentLabel: 'Opus',
    description: 'Most capable',
    environmentKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    supportsOneMillionSuffix: true,
  },
  {
    id: 'fable',
    label: 'Fable',
    agentLabel: 'Fable',
    description: "Anthropic's most capable model — premium pricing above Opus",
    environmentKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    supportsOneMillionSuffix: false,
  },
] as const;

export type ClaudeModelTier = typeof CLAUDE_MODEL_TIER_DEFINITIONS[number]['id'];
export type ClaudeModelTierDefinition = typeof CLAUDE_MODEL_TIER_DEFINITIONS[number];
export type ClaudeModelTierEnvironmentKey = ClaudeModelTierDefinition['environmentKey'];

export const CLAUDE_MODEL_TIER_PATTERN = CLAUDE_MODEL_TIER_DEFINITIONS
  .map(definition => definition.id)
  .join('|');

export function isClaudeModelTier(value: string): value is ClaudeModelTier {
  return CLAUDE_MODEL_TIER_DEFINITIONS.some(definition => definition.id === value);
}

export function getClaudeModelTierDefinition(tier: ClaudeModelTier): ClaudeModelTierDefinition {
  return CLAUDE_MODEL_TIER_DEFINITIONS.find(definition => definition.id === tier)!;
}
