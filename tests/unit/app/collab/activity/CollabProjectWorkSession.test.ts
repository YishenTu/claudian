import {
  CollabProjectWorkSession,
  CollabProjectWorkSessionRegistry,
} from '@/app/collab/activity/CollabProjectWorkSession';
import type { CollabError } from '@/core/collab/ClaudianCollabError';

describe('CollabProjectWorkSession', () => {
  it('coalesces acquisition per Project and isolates different Projects', () => {
    const registry = new CollabProjectWorkSessionRegistry();

    const first = registry.acquire('project-a');

    expect(registry.acquire('project-a')).toBe(first);
    expect(registry.acquire('project-b')).not.toBe(first);
  });

  it('does not retain a failed construction', () => {
    const factory = jest.fn()
      .mockImplementationOnce(() => { throw new Error('failed'); })
      .mockImplementation(projectId => new CollabProjectWorkSession(projectId));
    const registry = new CollabProjectWorkSessionRegistry(factory);

    expect(() => registry.acquire('project-a')).toThrow('failed');
    expect(registry.acquire('project-a').projectId).toBe('project-a');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('serializes mutations for one Project without blocking another', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const otherSession = new CollabProjectWorkSession('project-b');
    const first = deferred<void>();
    const calls: string[] = [];

    const firstMutation = session.runMutation(async () => {
      calls.push('first-start');
      await first.promise;
      calls.push('first-end');
    });
    const secondMutation = session.runMutation(async () => {
      calls.push('second');
    });
    const otherMutation = otherSession.runMutation(async () => {
      calls.push('other');
    });
    await Promise.resolve();

    expect(calls).toEqual(['first-start', 'other']);
    first.resolve();
    await Promise.all([firstMutation, secondMutation, otherMutation]);
    expect(calls).toEqual(['first-start', 'other', 'first-end', 'second']);
  });

  it('orders cache updates independently from mutations and drains after rejection', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const first = deferred<void>();
    const failure = new Error('cache update failed');
    const calls: string[] = [];

    const rejected = session.enqueueCacheUpdate(async () => {
      calls.push('cache-first-start');
      await first.promise;
      calls.push('cache-first-end');
      throw failure;
    });
    const rejection = rejected.catch(error => error);
    const second = session.enqueueCacheUpdate(async () => {
      calls.push('cache-second');
    });
    const mutation = session.runMutation(async () => {
      calls.push('mutation');
    });
    const draining = session.drainCacheUpdates();

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(expect.arrayContaining(['cache-first-start', 'mutation']));
    expect(calls).not.toContain('cache-second');

    first.resolve();
    await expect(rejection).resolves.toBe(failure);
    await Promise.all([second, mutation, draining]);
    expect(calls.indexOf('cache-first-start')).toBeLessThan(calls.indexOf('cache-first-end'));
    expect(calls.indexOf('cache-first-end')).toBeLessThan(calls.indexOf('cache-second'));
  });

  it('fences synchronization behind current inspections and later inspections behind sync', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const inspection = session.beginInspection();
    const synchronization = deferred<void>();
    const started = jest.fn();

    session.scheduleSynchronization(async () => {
      started();
      await synchronization.promise;
    });
    await Promise.resolve();
    expect(started).not.toHaveBeenCalled();

    inspection.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveBeenCalledTimes(1);

    const later = session.beginInspection();
    expect(later.precedingSynchronization).not.toBeNull();
    synchronization.resolve();
    await later.precedingSynchronization;
    later.release();
  });

  it('coalesces snapshot, refresh, and reconnect work independently', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const snapshot = deferred<never>();
    const refresh = deferred<number>();
    const reconnect = deferred<boolean>();

    expect(session.coalesceSnapshot(() => snapshot.promise))
      .toBe(session.coalesceSnapshot(() => Promise.reject(new Error('unused'))));
    const firstRefresh = session.coalesceEventRefresh(1, () => refresh.promise);
    const repeatedRefresh = session.coalesceEventRefresh(
      1,
      () => Promise.reject(new Error('unused')),
    );
    expect(session.coalesceAutoReconnect(() => reconnect.promise))
      .toBe(session.coalesceAutoReconnect(() => Promise.reject(new Error('unused'))));

    refresh.resolve(1);
    reconnect.resolve(true);
    await Promise.all([
      firstRefresh,
      repeatedRefresh,
      session.currentEventRefresh(),
      session.currentAutoReconnect(),
    ]);
  });

  it('owns one authority session per generation and disposes it during reset', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const firstDispose = jest.fn();
    const secondDispose = jest.fn();
    const createFirst = jest.fn(async () => ({ dispose: firstDispose }));

    const first = session.ensureAuthoritySession(createFirst);
    expect(session.ensureAuthoritySession(createFirst)).toBe(first);
    await expect(first).resolves.toEqual({ dispose: firstDispose });
    expect(createFirst).toHaveBeenCalledTimes(1);

    session.resetProjection();
    await Promise.resolve();
    expect(firstDispose).toHaveBeenCalledTimes(1);

    await expect(session.ensureAuthoritySession(async () => ({ dispose: secondDispose })))
      .resolves.toEqual({ dispose: secondDispose });
    await session.close();
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it('does not retain a failed authority-session construction', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const failure = new Error('authority unavailable');
    await expect(session.ensureAuthoritySession(() => Promise.reject(failure)))
      .rejects.toBe(failure);

    const dispose = jest.fn();
    await expect(session.ensureAuthoritySession(async () => ({ dispose })))
      .resolves.toEqual({ dispose });
    await session.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects and disposes an authority session that resolves after its generation resets', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const created = deferred<{ dispose(): void }>();
    const dispose = jest.fn();

    const authority = session.ensureAuthoritySession(() => created.promise);
    await Promise.resolve();
    session.resetProjection();
    created.resolve({ dispose });

    await expect(authority).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'projection-project-connection-reset' },
    } satisfies Partial<CollabError>);
    expect(dispose).toHaveBeenCalledTimes(1);

    await session.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('restarts a coalesced event refresh when a later invalidation requires a newer sequence', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const first = deferred<number>();
    const second = deferred<number>();
    const refresh = jest.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const current = session.coalesceEventRefresh(4, refresh);
    const later = session.coalesceEventRefresh(5, refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve(4);
    await expect(current).resolves.toBe(4);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    second.resolve(5);
    await expect(later).resolves.toBe(5);
  });

  it('bounds client refresh work under saturation while server send-queue bounds stay server-owned', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const first = deferred<number>();
    const second = deferred<number>();
    const refresh = jest.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const invalidations = Array.from({ length: 100 }, (_, index) => (
      session.coalesceEventRefresh(index + 1, refresh)
    ));
    expect(refresh).toHaveBeenCalledTimes(1);

    first.resolve(50);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    second.resolve(100);
    await expect(Promise.all(invalidations)).resolves.toHaveLength(100);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('closes resources, rejects new work, and drains admitted work', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const mutation = deferred<void>();
    const disposed = jest.fn();
    session.setEventConnection({ dispose: disposed });
    const admitted = session.runMutation(() => mutation.promise);

    const close = session.close();
    expect(disposed).toHaveBeenCalledTimes(1);
    await expect(session.runMutation(async () => undefined)).rejects.toMatchObject({
      code: 'project-retired',
    } satisfies Partial<CollabError>);

    let closed = false;
    void close.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    mutation.resolve();
    await admitted;
    await close;
    expect(closed).toBe(true);
  });

  it('disposes every registry session with failure isolation', async () => {
    const registry = new CollabProjectWorkSessionRegistry();
    const first = registry.acquire('project-a');
    const second = registry.acquire('project-b');
    jest.spyOn(first, 'close').mockRejectedValue(new Error('failed'));
    const secondClose = jest.spyOn(second, 'close');

    await registry.close();

    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(() => registry.acquire('project-c')).toThrow(expect.objectContaining({
      code: 'cancelled',
    }));
  });

  it('waits for Project closes that started before registry shutdown', async () => {
    const registry = new CollabProjectWorkSessionRegistry();
    const session = registry.acquire('project-a');
    const admitted = deferred<void>();
    const operation = session.runMutation(() => admitted.promise);

    const projectClose = registry.closeProject('project-a');
    const firstClose = registry.close();
    const secondClose = registry.close();
    let settled = false;
    void firstClose.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    admitted.resolve();
    await operation;
    await expect(Promise.all([projectClose, firstClose, secondClose])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('reopens a drained Project after a nonterminal operation is rejected', async () => {
    const registry = new CollabProjectWorkSessionRegistry();
    const original = registry.acquire('project-a');

    const suspension = await registry.suspendProject('project-a');
    expect(() => registry.acquire('project-a')).toThrow(expect.objectContaining({
      code: 'project-retired',
    }));

    await expect(registry.resumeProject(suspension)).resolves.toBe(true);
    const reopened = registry.acquire('project-a');
    expect(reopened).not.toBe(original);
    expect(reopened.projectId).toBe('project-a');
  });

  it('treats connection invalidation for a suspended Project as an idempotent no-op', async () => {
    const registry = new CollabProjectWorkSessionRegistry();
    registry.acquire('project-a');
    const suspension = await registry.suspendProject('project-a');

    expect(() => registry.resetProject('project-a')).not.toThrow();

    await expect(registry.resumeProject(suspension)).resolves.toBe(true);
    await registry.close();
  });

  it('does not reopen a suspension invalidated by terminal Project closure', async () => {
    const registry = new CollabProjectWorkSessionRegistry();
    registry.acquire('project-a');
    const suspension = await registry.suspendProject('project-a');

    await registry.closeProject('project-a');
    await expect(registry.resumeProject(suspension)).resolves.toBe(false);
    expect(() => registry.acquire('project-a')).toThrow(expect.objectContaining({
      code: 'project-retired',
    }));
  });

  it('consumes a completed suspension as permanent local Project closure', async () => {
    const registry = new CollabProjectWorkSessionRegistry();
    registry.acquire('project-a');
    const suspension = await registry.suspendProject('project-a');

    await registry.completeSuspension(suspension);
    await expect(registry.resumeProject(suspension)).resolves.toBe(false);
    expect(() => registry.acquire('project-a')).toThrow(expect.objectContaining({
      code: 'project-retired',
    }));
  });

  it('drains snapshot, event, and subscription work detached by a projection reset', async () => {
    const session = new CollabProjectWorkSession('project-a');
    const snapshot = deferred<never>();
    const event = deferred<number>();
    const subscription = deferred<{ dispose(): void }>();
    const disposed = jest.fn();
    void session.coalesceSnapshot(() => snapshot.promise).catch(() => undefined);
    void session.coalesceEventRefresh(1, () => event.promise);
    void session.ensureCoordinationSubscription(() => subscription.promise);

    session.resetProjection();
    const close = session.close();
    let settled = false;
    void close.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    event.resolve(1);
    subscription.resolve({ dispose: disposed });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    snapshot.resolve(undefined as never);
    await close;
    expect(settled).toBe(true);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
