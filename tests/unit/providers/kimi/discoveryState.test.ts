import {
  clearKimiDiscoveryState,
  getKimiDiscoveryState,
  updateKimiDiscoveryState,
} from '@/providers/kimi/discoveryState';

describe('Kimi discovery state', () => {
  it('starts empty and is not persisted as an enumerable settings key', () => {
    const settings: Record<string, unknown> = {};

    expect(getKimiDiscoveryState(settings)).toEqual({ discoveredModels: [] });
    expect(Object.keys(settings)).toEqual([]);
    expect(JSON.stringify(settings)).toBe('{}');
  });

  it('mirrors normalized catalog snapshots and reports real changes only', () => {
    const settings: Record<string, unknown> = {};
    const discovered = [
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
      { description: 'Thinking variant', label: 'K2 Thinking', rawId: 'kimi-k2,thinking' },
    ];

    expect(updateKimiDiscoveryState(settings, { discoveredModels: discovered })).toBe(true);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual(discovered);

    expect(updateKimiDiscoveryState(settings, {
      discoveredModels: [
        { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
        { description: 'Thinking variant', label: 'K2 Thinking', rawId: 'kimi-k2,thinking' },
      ],
    })).toBe(false);

    expect(updateKimiDiscoveryState(settings, {
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
    })).toBe(true);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
    ]);
  });

  it('normalizes incoming snapshots through the shared model rules', () => {
    const settings: Record<string, unknown> = {};

    updateKimiDiscoveryState(settings, {
      discoveredModels: [
        { label: ' One ', rawId: ' one ' },
        { label: 'Duplicate', rawId: 'one' },
        'garbage' as never,
      ],
    });

    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'One', rawId: 'one' },
    ]);
  });

  it('returns defensive copies that cannot mutate the mirrored catalog', () => {
    const settings: Record<string, unknown> = {};
    updateKimiDiscoveryState(settings, {
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
    });

    const snapshot = getKimiDiscoveryState(settings);
    snapshot.discoveredModels[0].label = 'Mutated';
    snapshot.discoveredModels.push({ label: 'Injected', rawId: 'injected' });

    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
    ]);
  });

  it('clears the mirrored catalog exactly once', () => {
    const settings: Record<string, unknown> = {};

    expect(clearKimiDiscoveryState(settings)).toBe(false);

    updateKimiDiscoveryState(settings, {
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
    });
    expect(clearKimiDiscoveryState(settings)).toBe(true);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([]);
    expect(clearKimiDiscoveryState(settings)).toBe(false);
  });
});
