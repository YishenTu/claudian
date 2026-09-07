import { toggleServiceTier } from '@/features/chat/actions/toggleServiceTier';

describe('toggleServiceTier', () => {
  it('persists the active tier when the current tier is inactive', async () => {
    const onServiceTierChange = jest.fn().mockResolvedValue(undefined);

    await expect(toggleServiceTier({
      getSettings: () => ({ serviceTier: 'default' }),
      getUIConfig: () => ({
        getServiceTierToggle: () => ({
          inactiveValue: 'default',
          inactiveLabel: 'Standard',
          activeValue: 'priority',
          activeLabel: 'Fast',
          isActive: false,
        }),
      }),
      onServiceTierChange,
    })).resolves.toBe(true);

    expect(onServiceTierChange).toHaveBeenCalledWith('priority');
  });

  it('uses the provider-resolved active state instead of the raw setting', async () => {
    const onServiceTierChange = jest.fn().mockResolvedValue(undefined);

    await expect(toggleServiceTier({
      getSettings: () => ({ serviceTier: 'fast' }),
      getUIConfig: () => ({
        getServiceTierToggle: () => ({
          inactiveValue: 'default',
          inactiveLabel: 'Standard',
          activeValue: 'priority',
          activeLabel: 'Fast',
          isActive: true,
        }),
      }),
      onServiceTierChange,
    })).resolves.toBe(true);

    expect(onServiceTierChange).toHaveBeenCalledWith('default');
  });

  it('returns false without persisting when the provider has no service-tier toggle', async () => {
    const onServiceTierChange = jest.fn().mockResolvedValue(undefined);

    await expect(toggleServiceTier({
      getSettings: () => ({ serviceTier: 'default' }),
      getUIConfig: () => ({}),
      onServiceTierChange,
    })).resolves.toBe(false);

    expect(onServiceTierChange).not.toHaveBeenCalled();
  });

  it('propagates persistence failures to the invoking surface', async () => {
    const failure = new Error('save failed');

    await expect(toggleServiceTier({
      getSettings: () => ({ serviceTier: 'priority' }),
      getUIConfig: () => ({
        getServiceTierToggle: () => ({
          inactiveValue: 'default',
          inactiveLabel: 'Standard',
          activeValue: 'priority',
          activeLabel: 'Fast',
          isActive: true,
        }),
      }),
      onServiceTierChange: jest.fn().mockRejectedValue(failure),
    })).rejects.toBe(failure);
  });
});
