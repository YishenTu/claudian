import { TurnCoordinator } from '@/features/chat/controllers/TurnCoordinator';

describe('TurnCoordinator', () => {
  it('owns the admitted turn, rejects overlap, and drains through settlement', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const changed = jest.fn();
    const coordinator = new TurnCoordinator(changed);
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
});


test('admits main work synchronously and drains it even when a work observer fails', async () => {
  let release!: () => void;
  const execution = new Promise<void>(resolve => { release = resolve; });
  const execute = jest.fn(() => execution);
  const observer = jest.fn().mockImplementationOnce(() => { throw new Error('view detached'); });
  const coordinator = new TurnCoordinator(observer);
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
