import {
  CLAUDE_MODEL_TIER_DEFINITIONS,
  getClaudeModelTierDefinition,
  isClaudeModelTier,
  resolveClaudeModelTierAlias,
} from '@/providers/claude/modelTiers';

describe('Claude model tiers', () => {
  it('defines every SDK model tier once', () => {
    expect(CLAUDE_MODEL_TIER_DEFINITIONS.map(definition => definition.id)).toEqual([
      'haiku',
      'sonnet',
      'opus',
      'fable',
    ]);
  });

  it('recognizes every tier through the shared guard', () => {
    for (const definition of CLAUDE_MODEL_TIER_DEFINITIONS) {
      expect(isClaudeModelTier(definition.id)).toBe(true);
    }
    expect(isClaudeModelTier('model')).toBe(false);
  });

  it('resolves legacy aliases through the owning tier definition', () => {
    expect(resolveClaudeModelTierAlias('sonnet[1M]')).toBe('sonnet');
    expect(resolveClaudeModelTierAlias('opus[1m]')).toBe('opus');
    expect(resolveClaudeModelTierAlias('claude-fable-5')).toBe('fable');
    expect(resolveClaudeModelTierAlias('claude-fable-6')).toBeNull();
  });

  it('keeps tier-specific capabilities explicit in the descriptor', () => {
    const fable = getClaudeModelTierDefinition('fable');
    const haiku = getClaudeModelTierDefinition('haiku');

    expect(fable.aliasHasOneMillionContext).toBe(true);
    expect(fable.supportsOneMillionSuffix).toBe(false);
    expect(fable.aliasSupportsXHigh).toBe(true);
    expect(haiku.aliasHasOneMillionContext).toBe(false);
    expect(haiku.aliasSupportsXHigh).toBe(false);
  });
});
