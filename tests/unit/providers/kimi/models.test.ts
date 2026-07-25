import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  isKimiThinkingModelId,
  KIMI_THINKING_MODEL_SUFFIX,
  normalizeKimiDiscoveredModels,
  resolveKimiBaseModelRawId,
} from '@/providers/kimi/models';

describe('Kimi model identity', () => {
  it('round-trips kimi:-scoped selection ids', () => {
    expect(encodeKimiModelId('kimi-for-coding')).toBe('kimi:kimi-for-coding');
    expect(encodeKimiModelId(' kimi-for-coding ')).toBe('kimi:kimi-for-coding');
    expect(encodeKimiModelId('')).toBe('');
    expect(encodeKimiModelId('   ')).toBe('');
    expect(decodeKimiModelId('kimi:kimi-for-coding')).toBe('kimi-for-coding');
    expect(decodeKimiModelId('kimi: kimi-for-coding ')).toBe('kimi-for-coding');
    expect(decodeKimiModelId(encodeKimiModelId('kimi-k2,thinking'))).toBe('kimi-k2,thinking');
  });

  it('rejects other providers\' selection ids and malformed kimi ids', () => {
    expect(isKimiModelSelectionId('kimi:kimi-for-coding')).toBe(true);
    expect(isKimiModelSelectionId('kimi:')).toBe(false);
    expect(isKimiModelSelectionId('kimi:   ')).toBe(false);
    expect(isKimiModelSelectionId('kimi-for-coding')).toBe(false);
    expect(isKimiModelSelectionId('grok/grok-4')).toBe(false);
    expect(isKimiModelSelectionId('opencode:anthropic/claude-sonnet-4')).toBe(false);
    expect(isKimiModelSelectionId('claude-sonnet-4-5')).toBe(false);
    expect(decodeKimiModelId('grok/kimi-for-coding')).toBeNull();
  });
});

describe('Kimi thinking model variants', () => {
  it('detects and strips the thinking suffix', () => {
    expect(KIMI_THINKING_MODEL_SUFFIX).toBe(',thinking');
    expect(isKimiThinkingModelId('kimi-k2,thinking')).toBe(true);
    expect(isKimiThinkingModelId(' kimi-k2,thinking ')).toBe(true);
    expect(isKimiThinkingModelId('kimi-k2')).toBe(false);
    expect(isKimiThinkingModelId('kimi-k2,thinking-extra')).toBe(false);
    expect(resolveKimiBaseModelRawId('kimi-k2,thinking')).toBe('kimi-k2');
    expect(resolveKimiBaseModelRawId('kimi-k2')).toBe('kimi-k2');
    expect(resolveKimiBaseModelRawId(' kimi-k2,thinking ')).toBe('kimi-k2');
  });
});

describe('normalizeKimiDiscoveredModels', () => {
  it('trims, dedupes by raw id, and preserves first-seen order', () => {
    expect(normalizeKimiDiscoveredModels([
      { label: ' Kimi Coding ', rawId: ' kimi-for-coding ', description: ' Fast ' },
      { label: 'Duplicate', rawId: 'kimi-for-coding' },
      { label: '', rawId: 'kimi-k2' },
      { label: 'No raw id' },
      { rawId: '   ' },
      'not-a-record',
      null,
      { label: 'K2 Thinking', rawId: 'kimi-k2,thinking', description: '' },
    ])).toEqual([
      { description: 'Fast', label: 'Kimi Coding', rawId: 'kimi-for-coding' },
      { label: 'kimi-k2', rawId: 'kimi-k2' },
      { label: 'K2 Thinking', rawId: 'kimi-k2,thinking' },
    ]);
  });

  it('returns an empty catalog for non-array input', () => {
    expect(normalizeKimiDiscoveredModels(undefined)).toEqual([]);
    expect(normalizeKimiDiscoveredModels(null)).toEqual([]);
    expect(normalizeKimiDiscoveredModels('kimi-for-coding')).toEqual([]);
    expect(normalizeKimiDiscoveredModels({ rawId: 'kimi-for-coding' })).toEqual([]);
  });
});
