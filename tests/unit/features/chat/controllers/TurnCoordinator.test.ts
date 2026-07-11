import { TurnCoordinator } from '@/features/chat/controllers/TurnCoordinator';

describe('TurnCoordinator', () => {
  it('owns the active execution and clears it after success', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = { activeTurn: null as Promise<void> | null };
    const coordinator = new TurnCoordinator(() => pending, owner);

    const run = coordinator.run();
    expect(coordinator.current).toBe(pending);
    expect(owner.activeTurn).toBe(pending);

    release();
    await run;
    expect(coordinator.current).toBeNull();
    expect(owner.activeTurn).toBeNull();
  });

  it('clears ownership without swallowing execution failures', async () => {
    const owner = { activeTurn: null as Promise<void> | null };
    const coordinator = new TurnCoordinator(
      async () => { throw new Error('turn failed'); },
      owner,
    );

    await expect(coordinator.run()).rejects.toThrow('turn failed');
    expect(coordinator.current).toBeNull();
    expect(owner.activeTurn).toBeNull();
  });
});
