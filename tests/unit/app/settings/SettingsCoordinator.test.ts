import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';

describe('SettingsCoordinator', () => {
  it('serializes mutation closures over the latest in-memory settings', async () => {
    const settings: Record<string, unknown> = { alpha: 0, beta: 0 };
    const persisted: Array<Record<string, unknown>> = [];
    const coordinator = new SettingsCoordinator(settings, async (current) => {
      persisted.push({ ...current });
    });

    const first = coordinator.mutate((current) => {
      current.alpha = 1;
    });
    const second = coordinator.mutate((current) => {
      expect(current.alpha).toBe(1);
      current.beta = 2;
    });
    await Promise.all([first, second]);

    expect(settings).toEqual({ alpha: 1, beta: 2 });
    expect(persisted).toEqual([
      { alpha: 1, beta: 0 },
      { alpha: 1, beta: 2 },
    ]);
  });

  it('surfaces a failed save without poisoning later queued mutations', async () => {
    const settings: Record<string, unknown> = {};
    const persist = jest.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new SettingsCoordinator(settings, persist);

    await expect(coordinator.mutate(current => { current.first = true; })).rejects.toThrow('write failed');
    await expect(coordinator.mutate(current => { current.second = true; })).resolves.toBeUndefined();

    expect(settings).toEqual({ first: true, second: true });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('serializes compatibility saves with mutations', async () => {
    const settings: Record<string, unknown> = { value: 1 };
    const persisted: number[] = [];
    const coordinator = new SettingsCoordinator(settings, async current => {
      persisted.push(current.value as number);
    });

    await Promise.all([
      coordinator.persistCurrent(),
      coordinator.mutate(current => { current.value = 2; }),
    ]);

    expect(persisted).toEqual([1, 2]);
  });

  it('keeps conditional mutations serialized and persists only when requested', async () => {
    const settings: Record<string, unknown> = { transient: 0, persisted: 0 };
    const persisted: Array<Record<string, unknown>> = [];
    const coordinator = new SettingsCoordinator(settings, async current => {
      persisted.push({ ...current });
    });

    await coordinator.mutateConditionally(current => {
      current.transient = 1;
      return false;
    });
    await coordinator.mutateConditionally(current => {
      current.persisted = 2;
      return true;
    });

    expect(settings).toEqual({ transient: 1, persisted: 2 });
    expect(persisted).toEqual([{ transient: 1, persisted: 2 }]);
  });
});
