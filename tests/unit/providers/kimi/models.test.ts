import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  normalizeKimiDiscoveredModels,
  normalizeKimiThinkingOptions,
  resolveKimiThinkingLevel,
} from '@/providers/kimi/models';

describe('Kimi model identity', () => {
  it('round-trips kimi:-scoped selection ids', () => {
    expect(encodeKimiModelId('kimi-for-coding')).toBe('kimi:kimi-for-coding');
    expect(encodeKimiModelId(' kimi-for-coding ')).toBe('kimi:kimi-for-coding');
    expect(encodeKimiModelId('')).toBe('');
    expect(encodeKimiModelId('   ')).toBe('');
    expect(decodeKimiModelId('kimi:kimi-for-coding')).toBe('kimi-for-coding');
    expect(decodeKimiModelId('kimi: kimi-for-coding ')).toBe('kimi-for-coding');
    expect(decodeKimiModelId(encodeKimiModelId('kimi-k2'))).toBe('kimi-k2');
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
      { label: 'K2 Latest', rawId: 'kimi-k2-latest', description: '' },
    ])).toEqual([
      { description: 'Fast', label: 'Kimi Coding', rawId: 'kimi-for-coding' },
      { label: 'kimi-k2', rawId: 'kimi-k2' },
      { label: 'K2 Latest', rawId: 'kimi-k2-latest' },
    ]);
  });

  it('returns an empty catalog for non-array input', () => {
    expect(normalizeKimiDiscoveredModels(undefined)).toEqual([]);
    expect(normalizeKimiDiscoveredModels(null)).toEqual([]);
    expect(normalizeKimiDiscoveredModels('kimi-for-coding')).toEqual([]);
    expect(normalizeKimiDiscoveredModels({ rawId: 'kimi-for-coding' })).toEqual([]);
  });
});

describe('normalizeKimiThinkingOptions', () => {
  it('trims, dedupes by value, and preserves first-seen order', () => {
    expect(normalizeKimiThinkingOptions([
      { label: ' Off ', value: ' off ', description: ' Disabled ' },
      { label: 'Duplicate', value: 'off' },
      { label: '', value: 'high' },
      { label: 'No value' },
      { value: '   ' },
      'not-a-record',
      null,
      { label: 'Medium', value: 'medium', description: '' },
    ])).toEqual([
      { description: 'Disabled', label: 'Off', value: 'off' },
      { label: 'high', value: 'high' },
      { label: 'Medium', value: 'medium' },
    ]);
  });

  it('returns an empty list for non-array input', () => {
    expect(normalizeKimiThinkingOptions(undefined)).toEqual([]);
    expect(normalizeKimiThinkingOptions(null)).toEqual([]);
    expect(normalizeKimiThinkingOptions('off')).toEqual([]);
    expect(normalizeKimiThinkingOptions({ value: 'off' })).toEqual([]);
  });
});

describe('resolveKimiThinkingLevel', () => {
  const options = normalizeKimiThinkingOptions([
    { label: 'Off', value: 'off' },
    { label: 'Low', value: 'low' },
    { label: 'Medium', value: 'medium' },
    { label: 'High', value: 'high' },
  ]);

  it('prefers the stored preference, then the session level, then off, then the first row', () => {
    expect(resolveKimiThinkingLevel(options, 'high', 'low')).toBe('high');
    expect(resolveKimiThinkingLevel(options, 'bogus', 'low')).toBe('low');
    expect(resolveKimiThinkingLevel(options, null, 'medium')).toBe('medium');
    expect(resolveKimiThinkingLevel(options)).toBe('off');
    expect(resolveKimiThinkingLevel(
      normalizeKimiThinkingOptions([{ label: 'On', value: 'on' }]),
    )).toBe('on');
    expect(resolveKimiThinkingLevel([])).toBe('');
  });
});
