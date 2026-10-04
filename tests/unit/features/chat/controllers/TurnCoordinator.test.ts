import { TurnCoordinator } from '@/features/chat/controllers/TurnCoordinator';

describe('TurnCoordinator', () => {
  it('owns the admitted turn, rejects overlap, and drains through settlement', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const changed = jest.fn();
    const coordinator = new TurnCoordinator();
    coordinator.subscribe(changed);
    const run = coordinator.run(() => pending);
    expect(coordinator.isActive).toBe(true);
    await expect(coordinator.run(async () => undefined)).rejects.toThrow('already active');
    const drain = coordinator.drain();
    release();
    await Promise.all([run, drain]);
    expect(coordinator.isActive).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('clears ownership without swallowing execution failures', async () => {
    const coordinator = new TurnCoordinator();
    await expect(coordinator.run(async () => { throw new Error('turn failed'); })).rejects.toThrow('turn failed');
    expect(coordinator.isActive).toBe(false);
    await expect(coordinator.drain()).resolves.toBeUndefined();
  });

  it('moves a response through preparation, provider response, and settlement', async () => {
    const coordinator = new TurnCoordinator();
    const phases: string[] = [];
    const record = () => phases.push([
      coordinator.isPreparing && 'preparing', coordinator.isResponding && 'responding',
      coordinator.isResponseActive && !coordinator.isInFlight && 'settling',
    ].filter(Boolean).join() || 'idle');
    let respond!: () => void;
    let settle!: () => void;
    const responding = new Promise<void>(resolve => { respond = resolve; });
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const run = coordinator.run(async () => {
      record();
      await responding;
      expect(coordinator.beginResponse()).toBe(1);
      record();
      await settled;
      coordinator.settle();
      record();
    });
    respond();
    await Promise.resolve();
    settle();
    await run;
    record();
    expect(phases).toEqual(['preparing', 'responding', 'settling', 'idle']);
  });

  it('keeps a cancel for the whole turn and supersedes presentation only for non-user reasons', async () => {
    const coordinator = new TurnCoordinator();
    expect(coordinator.cancel('user')).toBe(false);
    let generation = 0;
    const observed: Array<{ cancelRequested: boolean; generation: number }> = [];
    const run = coordinator.run(async signal => {
      generation = coordinator.beginResponse();
      coordinator.cancel('user');
      coordinator.settle();
      observed.push({ cancelRequested: coordinator.cancelRequested, generation: coordinator.streamGeneration });
      expect(signal.reason).toBe('user');
      coordinator.cancel('shutdown');
      observed.push({ cancelRequested: coordinator.cancelRequested, generation: coordinator.streamGeneration });
    });
    await run;
    expect(observed).toEqual([
      { cancelRequested: true, generation },
      { cancelRequested: true, generation: generation + 1 },
    ]);
    expect(coordinator.cancelRequested).toBe(false);
  });
});


test('admits main work synchronously and drains it even when a work observer fails', async () => {
  let release!: () => void;
  const execution = new Promise<void>(resolve => { release = resolve; });
  const execute = jest.fn(() => execution);
  const observer = jest.fn().mockImplementationOnce(() => { throw new Error('view detached'); });
  const coordinator = new TurnCoordinator();
  coordinator.subscribe(observer);
  const result = coordinator.run(execute);
  const failure = result.catch(error => error);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(coordinator.isActive).toBe(true);
  let drained = false;
  const drain = coordinator.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await drain;
  expect(await failure).toEqual(new Error('view detached'));
  expect(coordinator.isActive).toBe(false);
});
