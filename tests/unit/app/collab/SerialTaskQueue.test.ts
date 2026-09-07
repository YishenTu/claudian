import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('SerialTaskQueue', () => {
  it('runs admitted tasks in FIFO order without overlap', async () => {
    const queue = new SerialTaskQueue();
    const releases = [deferred(), deferred(), deferred()];
    const events: string[] = [];
    let activeTasks = 0;
    let maximumActiveTasks = 0;

    const tasks = releases.map((release, index) => queue.run(async () => {
      activeTasks += 1;
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
      events.push(`start-${index}`);
      await release.promise;
      events.push(`finish-${index}`);
      activeTasks -= 1;
    }));

    await Promise.resolve();
    expect(events).toEqual(['start-0']);

    releases[0].resolve();
    await tasks[0];
    await Promise.resolve();
    expect(events).toEqual(['start-0', 'finish-0', 'start-1']);

    releases[1].resolve();
    await tasks[1];
    await Promise.resolve();
    expect(events).toEqual([
      'start-0',
      'finish-0',
      'start-1',
      'finish-1',
      'start-2',
    ]);

    releases[2].resolve();
    await tasks[2];
    expect(maximumActiveTasks).toBe(1);
  });

  it('propagates each task result while healing the queue after rejection', async () => {
    const queue = new SerialTaskQueue();
    const error = new Error('failed task');
    const value = { status: 'completed' } as const;
    const executionOrder: string[] = [];

    const rejected = queue.run(async () => {
      executionOrder.push('rejected');
      throw error;
    });
    const fulfilled = queue.run(async () => {
      executionOrder.push('fulfilled');
      return value;
    });

    await expect(rejected).rejects.toBe(error);
    await expect(fulfilled).resolves.toBe(value);
    expect(executionOrder).toEqual(['rejected', 'fulfilled']);
  });

  it('drains tasks admitted before the call without closing admission', async () => {
    const queue = new SerialTaskQueue();
    const firstRelease = deferred();
    const admittedRelease = deferred();
    const laterRelease = deferred();
    const rejection = new Error('expected rejection');
    let drainSettled = false;
    let admittedStarted = false;
    let laterStarted = false;

    const first = queue.run(async () => {
      await firstRelease.promise;
      throw rejection;
    });
    const firstRejection = first.catch(error => error);
    const admitted = queue.run(async () => {
      admittedStarted = true;
      await admittedRelease.promise;
    });
    const draining = queue.drain().then(() => {
      drainSettled = true;
    });
    const later = queue.run(async () => {
      laterStarted = true;
      await laterRelease.promise;
      return 'later result';
    });

    await Promise.resolve();
    expect(drainSettled).toBe(false);
    expect(laterStarted).toBe(false);

    firstRelease.resolve();
    await expect(firstRejection).resolves.toBe(rejection);
    await Promise.resolve();
    expect(admittedStarted).toBe(true);
    expect(drainSettled).toBe(false);
    expect(laterStarted).toBe(false);

    admittedRelease.resolve();
    await admitted;
    await draining;
    expect(drainSettled).toBe(true);
    expect(laterStarted).toBe(true);

    let laterSettled = false;
    void later.then(() => {
      laterSettled = true;
    });
    await Promise.resolve();
    expect(laterSettled).toBe(false);

    laterRelease.resolve();
    await expect(later).resolves.toBe('later result');
  });
});
