import { ExecutionEventQueue } from '@/core/execution';

describe('ExecutionEventQueue', () => {
  it('delivers buffered and later values in order, then ends after close', async () => {
    const queue = new ExecutionEventQueue<string>(() => undefined);
    queue.push('first');
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const value of queue) collected.push(value);
    })();

    await Promise.resolve();
    queue.push('second');
    queue.close();
    queue.push('dropped');
    await consumer;

    expect(collected).toEqual(['first', 'second']);
  });

  it('resolves a waiting consumer as done when closed', async () => {
    const queue = new ExecutionEventQueue<string>(() => undefined);
    const pending = queue.next();

    queue.close();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('reports an early return while the stream is still open', async () => {
    const onEarlyReturn = jest.fn();
    const queue = new ExecutionEventQueue<string>(onEarlyReturn);
    queue.push('only');

    for await (const value of queue) {
      expect(value).toBe('only');
      break;
    }

    expect(onEarlyReturn).toHaveBeenCalledTimes(1);
    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('does not report an early return once the producer has closed the stream', async () => {
    const onEarlyReturn = jest.fn();
    const queue = new ExecutionEventQueue<string>(onEarlyReturn);
    queue.push('terminal');
    queue.push('trailing');
    queue.close();

    for await (const value of queue) {
      if (value === 'terminal') break;
    }

    expect(onEarlyReturn).not.toHaveBeenCalled();
  });
});
