interface ClaudeModelVersion {
  major: number;
  minor: number;
}

export const CLAUDE_MODEL_TIER_DEFINITIONS = [
  {
    id: 'haiku',
    label: 'Haiku',
    agentLabel: 'Haiku',
    description: 'Fast and efficient',
    environmentKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    environmentPriority: 4,
    agentOrder: 3,
    legacyAliases: [],
    supportsOneMillionSuffix: false,
    aliasHasOneMillionContext: false,
    versionedOneMillionContextFrom: null,
    aliasSupportsXHigh: false,
    versionedXHighFrom: null,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    agentLabel: 'Sonnet',
    description: 'Balanced performance',
    environmentKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    environmentPriority: 3,
    agentOrder: 1,
    legacyAliases: ['sonnet[1m]'],
    supportsOneMillionSuffix: true,
    aliasHasOneMillionContext: true,
    versionedOneMillionContextFrom: { major: 4, minor: 6 },
    aliasSupportsXHigh: true,
    versionedXHighFrom: { major: 5, minor: 0 },
  },
  {
    id: 'opus',
    label: 'Opus',
    agentLabel: 'Opus',
    description: 'Most capable',
    environmentKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    environmentPriority: 2,
    agentOrder: 2,
    legacyAliases: ['opus[1m]'],
    supportsOneMillionSuffix: true,
    aliasHasOneMillionContext: true,
    versionedOneMillionContextFrom: { major: 4, minor: 6 },
    aliasSupportsXHigh: true,
    versionedXHighFrom: { major: 4, minor: 7 },
  },
  {
    id: 'fable',
    label: 'Fable 5 ($$$)',
    agentLabel: 'Fable',
    description: "Anthropic's most capable model — premium pricing above Opus",
    environmentKey: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    environmentPriority: 1,
    agentOrder: 4,
    legacyAliases: ['claude-fable-5'],
    supportsOneMillionSuffix: false,
    aliasHasOneMillionContext: true,
    versionedOneMillionContextFrom: { major: 0, minor: 0 },
    aliasSupportsXHigh: true,
    versionedXHighFrom: { major: 0, minor: 0 },
  },
] as const;

export type ClaudeModelTier = typeof CLAUDE_MODEL_TIER_DEFINITIONS[number]['id'];
export type ClaudeModelEnvironmentType = 'model' | ClaudeModelTier;
export type ClaudeModelTierDefinition = typeof CLAUDE_MODEL_TIER_DEFINITIONS[number];
export type ClaudeModelTierEnvironmentKey = ClaudeModelTierDefinition['environmentKey'];

export const CLAUDE_MODEL_TIER_PATTERN = CLAUDE_MODEL_TIER_DEFINITIONS
  .map(definition => definition.id)
  .join('|');

export function isClaudeModelTier(value: string): value is ClaudeModelTier {
  return CLAUDE_MODEL_TIER_DEFINITIONS.some(definition => definition.id === value);
}

export function isClaudeModelEnvironmentType(value: string): value is ClaudeModelEnvironmentType {
  return value === 'model' || isClaudeModelTier(value);
}

export function getClaudeModelTierDefinition(tier: ClaudeModelTier): ClaudeModelTierDefinition {
  return CLAUDE_MODEL_TIER_DEFINITIONS.find(definition => definition.id === tier)!;
}

export function resolveClaudeModelTierAlias(value: string): ClaudeModelTier | null {
  const normalized = value.trim().toLowerCase();
  const definition = CLAUDE_MODEL_TIER_DEFINITIONS.find(candidate =>
    candidate.id === normalized
    || (candidate.legacyAliases as readonly string[]).includes(normalized)
  );
  return definition?.id ?? null;
}

export function isVersionAtLeast(
  major: number,
  minor: number,
  minimum: ClaudeModelVersion | null,
): boolean {
  if (!minimum) {
    return false;
  }
  return major > minimum.major || (major === minimum.major && minor >= minimum.minor);
}
