import {
  CLAUDE_MODEL_TIER_DEFINITIONS,
  getClaudeModelTierDefinition,
  isClaudeModelTier,
} from '@/providers/claude/modelTiers';
import { isDefaultClaudeModel } from '@/providers/claude/types/models';

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

  it('does not classify retired aliases as built-in tiers', () => {
    expect(isDefaultClaudeModel('sonnet[1M]')).toBe(false);
    expect(isDefaultClaudeModel('opus[1m]')).toBe(false);
    expect(isDefaultClaudeModel('claude-fable-5')).toBe(false);
    expect(isDefaultClaudeModel('claude-fable-6')).toBe(false);
  });

  it('keeps [1m] suffix compatibility explicit in the descriptor', () => {
    expect(getClaudeModelTierDefinition('fable').supportsOneMillionSuffix).toBe(false);
    expect(getClaudeModelTierDefinition('opus').supportsOneMillionSuffix).toBe(true);
    expect(getClaudeModelTierDefinition('haiku').supportsOneMillionSuffix).toBe(false);
  });
});
