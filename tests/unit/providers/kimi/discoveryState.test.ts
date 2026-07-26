import {
  clearKimiDiscoveryState,
  getKimiDiscoveryState,
  seedKimiDiscoveryStateFromConfig,
  updateKimiDiscoveryState,
} from '@/providers/kimi/discoveryState';

describe('Kimi discovery state', () => {
  it('starts empty and is not persisted as an enumerable settings key', () => {
    const settings: Record<string, unknown> = {};

    expect(getKimiDiscoveryState(settings)).toEqual({
      currentThinkingByModel: {},
      discoveredModels: [],
      thinkingOptionsByModel: {},
    });
    expect(Object.keys(settings)).toEqual([]);
    expect(JSON.stringify(settings)).toBe('{}');
  });

  it('mirrors normalized catalog snapshots and reports real changes only', () => {
    const settings: Record<string, unknown> = {};
    const discovered = [
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
      { description: 'Latest K2', label: 'K2 Latest', rawId: 'kimi-k2-latest' },
    ];

    expect(updateKimiDiscoveryState(settings, { discoveredModels: discovered })).toBe(true);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual(discovered);

    expect(updateKimiDiscoveryState(settings, {
      discoveredModels: [
        { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
        { description: 'Latest K2', label: 'K2 Latest', rawId: 'kimi-k2-latest' },
      ],
    })).toBe(false);

    expect(updateKimiDiscoveryState(settings, {
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
    })).toBe(true);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
    ]);
  });

  it('mirrors thinking options and current levels per model', () => {
    const settings: Record<string, unknown> = {};

    expect(updateKimiDiscoveryState(settings, {
      currentThinkingByModel: { 'kimi-k2': 'medium' },
      thinkingOptionsByModel: {
        'kimi-k2': [
          { label: 'Off', value: 'off' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
    })).toBe(true);
    expect(getKimiDiscoveryState(settings)).toEqual({
      currentThinkingByModel: { 'kimi-k2': 'medium' },
      discoveredModels: [],
      thinkingOptionsByModel: {
        'kimi-k2': [
          { label: 'Off', value: 'off' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
    });

    expect(updateKimiDiscoveryState(settings, {
      currentThinkingByModel: { 'kimi-k2': 'medium' },
      thinkingOptionsByModel: {
        'kimi-k2': [
          { label: 'Off', value: 'off' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
    })).toBe(false);

    expect(updateKimiDiscoveryState(settings, {
      thinkingOptionsByModel: {},
    })).toBe(true);
    expect(getKimiDiscoveryState(settings).thinkingOptionsByModel).toEqual({});
    expect(getKimiDiscoveryState(settings).currentThinkingByModel).toEqual({ 'kimi-k2': 'medium' });
  });

  it('normalizes incoming snapshots through the shared model rules', () => {
    const settings: Record<string, unknown> = {};

    updateKimiDiscoveryState(settings, {
      discoveredModels: [
        { label: ' One ', rawId: ' one ' },
        { label: 'Duplicate', rawId: 'one' },
        'garbage' as never,
      ],
      thinkingOptionsByModel: {
        ' one ': [
          { label: ' Off ', value: ' off ' },
          { label: 'Duplicate', value: 'off' },
          'garbage' as never,
        ],
        'empty-options': [],
      },
    });

    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'One', rawId: 'one' },
    ]);
    expect(getKimiDiscoveryState(settings).thinkingOptionsByModel).toEqual({
      one: [{ label: 'Off', value: 'off' }],
    });
  });

  it('returns defensive copies that cannot mutate the mirrored catalog', () => {
    const settings: Record<string, unknown> = {};
    updateKimiDiscoveryState(settings, {
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
      thinkingOptionsByModel: { 'kimi-for-coding': [{ label: 'Off', value: 'off' }] },
    });

    const snapshot = getKimiDiscoveryState(settings);
    snapshot.discoveredModels[0].label = 'Mutated';
    snapshot.discoveredModels.push({ label: 'Injected', rawId: 'injected' });
    snapshot.thinkingOptionsByModel['kimi-for-coding'][0].label = 'Mutated';

    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
    ]);
    expect(getKimiDiscoveryState(settings).thinkingOptionsByModel).toEqual({
      'kimi-for-coding': [{ label: 'Off', value: 'off' }],
    });
  });

  it('seeds an empty mirror from a persisted config snapshot exactly once', () => {
    const settings: Record<string, unknown> = {};

    expect(seedKimiDiscoveryStateFromConfig(settings, {
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
    })).toBe(true);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
    ]);

    expect(seedKimiDiscoveryStateFromConfig(settings, {
      discoveredModels: [{ label: 'Other', rawId: 'other' }],
    })).toBe(false);
    expect(getKimiDiscoveryState(settings).discoveredModels).toEqual([
      { label: 'Kimi Coding', rawId: 'kimi-for-coding' },
    ]);

    const empty: Record<string, unknown> = {};
    expect(seedKimiDiscoveryStateFromConfig(empty, {})).toBe(false);
    expect(getKimiDiscoveryState(empty).discoveredModels).toEqual([]);
  });

  it('clears the mirrored catalog exactly once', () => {
    const settings: Record<string, unknown> = {};

    expect(clearKimiDiscoveryState(settings)).toBe(false);

    updateKimiDiscoveryState(settings, {
      currentThinkingByModel: { 'kimi-k2': 'high' },
      discoveredModels: [{ label: 'Kimi Coding', rawId: 'kimi-for-coding' }],
      thinkingOptionsByModel: { 'kimi-k2': [{ label: 'High', value: 'high' }] },
    });
    expect(clearKimiDiscoveryState(settings)).toBe(true);
    expect(getKimiDiscoveryState(settings)).toEqual({
      currentThinkingByModel: {},
      discoveredModels: [],
      thinkingOptionsByModel: {},
    });
    expect(clearKimiDiscoveryState(settings)).toBe(false);
  });
});
