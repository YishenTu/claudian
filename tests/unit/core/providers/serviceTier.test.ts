import {
  createServiceTierPolicy,
  resolveServiceTier,
  resolveServiceTierToggleTarget,
} from '@/core/providers/serviceTier';

const STANDARD = { value: 'default', label: 'Standard' };
const FAST = { value: 'priority', label: 'Fast', description: '1.5x speed', isFast: true as const };
const ULTRAFAST = { value: 'ultrafast', label: 'Ultrafast', description: 'Lowest latency' };

describe('serviceTier policy helpers', () => {
  it('returns null when no accelerated tiers are offered', () => {
    expect(createServiceTierPolicy({
      standard: STANDARD,
      accelerated: [],
      selectedValue: null,
    })).toBeNull();
  });

  it('builds a fast-switch policy when Fast is the sole accelerated tier', () => {
    const off = createServiceTierPolicy({
      standard: STANDARD,
      accelerated: [FAST],
      selectedValue: null,
    });
    expect(off).toEqual({
      kind: 'fast-switch',
      standard: STANDARD,
      fast: { ...FAST, level: 1 },
      selection: { kind: 'standard', option: STANDARD },
    });
    expect(resolveServiceTierToggleTarget(off)).toBe('priority');

    const on = createServiceTierPolicy({
      standard: STANDARD,
      accelerated: [FAST],
      selectedValue: 'priority',
    });
    expect(on).toEqual({
      kind: 'fast-switch',
      standard: STANDARD,
      fast: { ...FAST, level: 1 },
      selection: { kind: 'accelerated', option: { ...FAST, level: 1 } },
    });
    expect(resolveServiceTierToggleTarget(on)).toBe('default');
  });

  it('builds a tiers policy with explicit acceleration levels for multiple tiers', () => {
    const policy = createServiceTierPolicy({
      standard: STANDARD,
      accelerated: [FAST, ULTRAFAST],
      selectedValue: 'ultrafast',
    });
    expect(policy).toEqual({
      kind: 'tiers',
      standard: STANDARD,
      accelerated: [
        { ...FAST, level: 1 },
        { ...ULTRAFAST, level: 2 },
      ],
      selection: { kind: 'accelerated', option: { ...ULTRAFAST, level: 2 } },
      fastValue: 'priority',
    });
    expect(resolveServiceTierToggleTarget(policy)).toBe('default');

    const standardSelected = createServiceTierPolicy({
      standard: STANDARD,
      accelerated: [FAST, ULTRAFAST],
      selectedValue: 'default',
    });
    expect(standardSelected?.selection).toEqual({ kind: 'standard', option: STANDARD });
    expect(resolveServiceTierToggleTarget(standardSelected)).toBe('priority');
  });

  it('builds a tiers policy with null fastValue when only non-Fast accelerated tiers exist', () => {
    const standardSelected = createServiceTierPolicy({
      standard: STANDARD,
      accelerated: [ULTRAFAST],
      selectedValue: null,
    });
    expect(standardSelected).toEqual({
      kind: 'tiers',
      standard: STANDARD,
      accelerated: [{ ...ULTRAFAST, level: 1 }],
      selection: { kind: 'standard', option: STANDARD },
      fastValue: null,
    });
    expect(resolveServiceTierToggleTarget(standardSelected)).toBeNull();

    const active = createServiceTierPolicy({
      standard: STANDARD,
      accelerated: [ULTRAFAST],
      selectedValue: 'ultrafast',
    });
    expect(resolveServiceTierToggleTarget(active)).toBe('default');
  });

  it('resolves canonical service tier when a provider supplies a policy and falls back to default otherwise', () => {
    expect(resolveServiceTier({}, { serviceTier: 'priority' })).toBe('default');
    expect(resolveServiceTier({}, {})).toBe('default');
    expect(resolveServiceTier({ getServiceTierPolicy: () => null }, { serviceTier: 'ultrafast' })).toBe('default');
    expect(resolveServiceTier({
      getServiceTierPolicy: () => createServiceTierPolicy({
        standard: STANDARD,
        accelerated: [FAST, ULTRAFAST],
        selectedValue: 'ultrafast',
      }),
    }, { serviceTier: 'ultrafast' })).toBe('ultrafast');
    expect(resolveServiceTierToggleTarget(null)).toBeNull();
  });
});
