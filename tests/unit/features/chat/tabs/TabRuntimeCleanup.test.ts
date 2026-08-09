import { TabRuntimeCleanup } from '@/features/chat/tabs/TabRuntimeCleanup';

describe('TabRuntimeCleanup', () => {
  it('disposes registered resources in reverse order', async () => {
    const order: string[] = [];
    const cleanup = new TabRuntimeCleanup();
    cleanup.register('first', () => {
      order.push('first');
    });
    cleanup.register('second', async () => {
      order.push('second');
    });

    await expect(cleanup.dispose()).resolves.toEqual([]);
    expect(order).toEqual(['second', 'first']);
  });

  it('continues cleanup after a resource fails and reports the failure', async () => {
    const order: string[] = [];
    const error = new Error('release failed');
    const cleanup = new TabRuntimeCleanup();
    cleanup.register('first', () => {
      order.push('first');
    });
    cleanup.register('broken', () => {
      order.push('broken');
      throw error;
    });
    cleanup.register('last', () => {
      order.push('last');
    });

    await expect(cleanup.dispose()).resolves.toEqual([
      { error, resource: 'broken' },
    ]);
    expect(order).toEqual(['last', 'broken', 'first']);
  });

  it('makes disposal idempotent and rejects late registration', async () => {
    const cleanup = new TabRuntimeCleanup();
    const first = cleanup.dispose();

    expect(cleanup.isDisposed).toBe(true);
    await expect(cleanup.dispose()).resolves.toBe(await first);
    expect(() => cleanup.register('late', () => undefined)).toThrow(
      'Cannot register late after tab runtime cleanup',
    );
  });
});
