import {
  decodeAntigravityModelId,
  DEFAULT_ANTIGRAVITY_MODELS,
  encodeAntigravityModelId,
  isAntigravityModelSelectionId,
  normalizeAntigravityDiscoveredModels,
} from '@/providers/antigravity/models';

describe('Antigravity models', () => {
  it('encodes and decodes antigravity model IDs', () => {
    const rawId = 'gemini-3.8-flash-high';
    const encoded = encodeAntigravityModelId(rawId);
    expect(encoded).toBe('antigravity:gemini-3.8-flash-high');
    expect(isAntigravityModelSelectionId(encoded)).toBe(true);
    expect(decodeAntigravityModelId(encoded)).toBe(rawId);
  });

  it('handles decodeAntigravityModelId edge cases', () => {
    expect(decodeAntigravityModelId('antigravity:gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high');
    expect(decodeAntigravityModelId('invalid-prefix')).toBeNull();
    expect(decodeAntigravityModelId('')).toBeNull();
  });

  it('normalizes discovered models and strips duplicate entries', () => {
    const raw = [
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'custom-model', name: 'Custom Model' },
      { id: 'gemini-3.8-flash-high', name: 'Duplicate' },
    ];
    const discovered = normalizeAntigravityDiscoveredModels(raw);
    expect(discovered).toHaveLength(2);
    expect(discovered[0].rawId).toBe('gemini-3.8-flash-high');
    expect(discovered[1].rawId).toBe('custom-model');
  });

  it('provides sensible default models', () => {
    expect(DEFAULT_ANTIGRAVITY_MODELS.length).toBeGreaterThan(0);
    const ids = DEFAULT_ANTIGRAVITY_MODELS.map((m) => m.rawId);
    expect(ids).toContain('gemini-3.8-flash-high');
    expect(ids).toContain('gemini-3.7-flash-high');
    expect(ids).toContain('gemini-pro-agent');
  });
});
