export const CLAUDE_MODEL_TIER_DEFINITIONS = [
  {
    id: 'haiku',
    label: 'Haiku',
    description: 'Fast and efficient',
    supportsOneMillionSuffix: false,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Balanced performance',
    supportsOneMillionSuffix: true,
  },
  {
    id: 'opus',
    label: 'Opus',
    description: 'Most capable',
    supportsOneMillionSuffix: true,
  },
  {
    id: 'fable',
    label: 'Fable',
    description: "Anthropic's most capable model — premium pricing above Opus",
    supportsOneMillionSuffix: false,
  },
] as const;

export type ClaudeModelTier = typeof CLAUDE_MODEL_TIER_DEFINITIONS[number]['id'];
type ClaudeModelTierDefinition = typeof CLAUDE_MODEL_TIER_DEFINITIONS[number];

export const CLAUDE_MODEL_TIER_PATTERN = CLAUDE_MODEL_TIER_DEFINITIONS
  .map(definition => definition.id)
  .join('|');

export function isClaudeModelTier(value: string): value is ClaudeModelTier {
  return CLAUDE_MODEL_TIER_DEFINITIONS.some(definition => definition.id === value);
}

export function getClaudeModelTierDefinition(tier: ClaudeModelTier): ClaudeModelTierDefinition {
  return CLAUDE_MODEL_TIER_DEFINITIONS.find(definition => definition.id === tier)!;
}
