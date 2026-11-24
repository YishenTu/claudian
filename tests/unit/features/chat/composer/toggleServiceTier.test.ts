import { createServiceTierPolicy } from '@/core/providers/serviceTier';
import type { ProviderServiceTierPolicy } from '@/core/providers/types';
import { toggleServiceTier } from '@/features/chat/composer/toggleServiceTier';

function policy(selectedValue: string, hasFast = true): ProviderServiceTierPolicy {
  return createServiceTierPolicy({
    standard: { value: 'default', label: 'Standard' },
    accelerated: hasFast
      ? [
        { value: 'priority', label: 'Fast', isFast: true },
        { value: 'ultrafast', label: 'Ultrafast' },
      ]
      : [{ value: 'ultrafast', label: 'Ultrafast' }],
    selectedValue,
  })!;
}

describe('toggleServiceTier', () => {
  it.each([
    { caseName: 'switches Standard to Fast', selected: 'default', expected: 'priority' },
    { caseName: 'switches Fast back to Standard', selected: 'priority', expected: 'default' },
    { caseName: 'switches another accelerated tier back to Standard', selected: 'ultrafast', expected: 'default' },
    {
      caseName: 'switches an accelerated tier back to Standard without a Fast tier',
      selected: 'ultrafast',
      expected: 'default',
      hasFast: false,
    },
  ])('$caseName from the provider-resolved selection', async ({ selected, expected, hasFast = true }) => {
    const onServiceTierChange = vi.fn().mockResolvedValue(undefined);

    await expect(toggleServiceTier({
      // The provider's resolved policy selection decides the toggle direction, independent of raw settings.
      getSettings: () => ({ serviceTier: 'unsupported' }),
      getUIConfig: () => ({ getServiceTierToggle: () => policy(selected, hasFast) }),
      onServiceTierChange,
    })).resolves.toBe(true);

    expect(onServiceTierChange).toHaveBeenCalledWith(expected);
  });

  it.each([
    { caseName: 'no service tiers', getServiceTierToggle: undefined },
    { caseName: 'tiers without a Fast tier', getServiceTierToggle: () => policy('default', false) },
  ])('returns false without persisting for $caseName', async ({ getServiceTierToggle }) => {
    const onServiceTierChange = vi.fn().mockResolvedValue(undefined);

    await expect(toggleServiceTier({
      getSettings: () => ({ serviceTier: 'default' }),
      getUIConfig: () => ({ getServiceTierToggle }),
      onServiceTierChange,
    })).resolves.toBe(false);

    expect(onServiceTierChange).not.toHaveBeenCalled();
  });

  it('propagates persistence failures to the invoking surface', async () => {
    const failure = new Error('save failed');

    await expect(toggleServiceTier({
      getSettings: () => ({ serviceTier: 'priority' }),
      getUIConfig: () => ({ getServiceTierToggle: () => policy('priority') }),
      onServiceTierChange: vi.fn().mockRejectedValue(failure),
    })).rejects.toBe(failure);
  });
});
