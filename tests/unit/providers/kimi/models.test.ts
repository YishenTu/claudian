import {
  decodeKimiModelId,
  encodeKimiModelId,
  isKimiModelSelectionId,
  KIMI_SYNTHETIC_MODEL_ID,
  normalizeKimiDiscoveredModels,
  normalizeKimiModelVariants,
} from '@/providers/kimi/models';

describe('kimi models', () => {
  it('namespaces model ids as Kimi-owned', () => {
    expect(encodeKimiModelId('kimi-code/k3')).toBe('kimi:kimi-code/k3');
    expect(decodeKimiModelId('kimi:kimi-code/k3')).toBe('kimi-code/k3');
    expect(isKimiModelSelectionId(KIMI_SYNTHETIC_MODEL_ID)).toBe(true);
    expect(isKimiModelSelectionId('claude-sonnet')).toBe(false);
  });

  it('normalizes discovered models and thinking variants', () => {
    expect(normalizeKimiDiscoveredModels([
      { rawId: 'kimi-code/k3', label: 'K3', description: 'default' },
      { id: 'kimi-plain', name: 'Plain' },
      { rawId: 'kimi-code/k3', label: 'dup' },
    ])).toEqual([
      { rawId: 'kimi-code/k3', label: 'K3', description: 'default' },
      { rawId: 'kimi-plain', label: 'Plain' },
    ]);

    expect(normalizeKimiModelVariants([
      { value: 'off', name: 'Thinking Off' },
      { id: 'on', label: 'Thinking On' },
    ])).toEqual([
      { value: 'off', label: 'Thinking Off' },
      { value: 'on', label: 'Thinking On' },
    ]);
  });
});
