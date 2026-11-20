import type { ProviderServiceTierPolicy } from '@/core/providers/types';
import { toggleServiceTier } from '@/features/chat/composer/toggleServiceTier';

const TIERS = [
  { value: 'default', label: 'Standard' },
  { value: 'priority', label: 'Fast' },
  { value: 'ultrafast', label: 'Ultrafast' },
];

function policy(selectedValue: string, fastValue: string | null = 'priority'): ProviderServiceTierPolicy {
  return { options: TIERS, selectedValue, fastValue };
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
      fastValue: null,
    },
  ])('$caseName from the provider-resolved selection', async ({ selected, expected, fastValue }) => {
    const onServiceTierChange = vi.fn().mockResolvedValue(undefined);

    await expect(toggleServiceTier({
      // The raw setting is a legacy alias; the provider's resolved selection decides the direction.
      getSettings: () => ({ serviceTier: 'fast' }),
      getUIConfig: () => ({ getServiceTierToggle: () => policy(selected, fastValue === undefined ? 'priority' : fastValue) }),
      onServiceTierChange,
    })).resolves.toBe(true);

    expect(onServiceTierChange).toHaveBeenCalledWith(expected);
  });

  it.each([
    { caseName: 'no service tiers', getServiceTierToggle: undefined },
    { caseName: 'tiers without a Fast tier', getServiceTierToggle: () => policy('default', null) },
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
