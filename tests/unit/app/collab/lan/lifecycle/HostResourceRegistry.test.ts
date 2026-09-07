import {
  type HostResourceCloseReason,
  HostResourceRegistry,
} from '@/app/collab/lan/lifecycle/HostResourceRegistry';

describe('HostResourceRegistry', () => {
  it('closes only one Member and reports the access-removal reason', async () => {
    const registry = new HostResourceRegistry();
    const first = jest.fn();
    const second = jest.fn();
    const otherProject = jest.fn();
    registry.register('project-a', 'member-a', first);
    registry.register('project-a', 'member-b', second);
    registry.register('project-b', 'member-a', otherProject);

    await registry.closeMember('project-a', 'member-a', 'access-removed');
    await registry.closeMember('project-a', 'member-a', 'access-removed');

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith('access-removed');
    expect(second).not.toHaveBeenCalled();
    expect(otherProject).not.toHaveBeenCalled();
    expect(registry.size).toBe(2);
  });

  it('supports unregistering a naturally closed resource', async () => {
    const registry = new HostResourceRegistry();
    const close = jest.fn();
    const unregister = registry.register('project-a', 'member-a', close);

    unregister();
    unregister();
    await registry.closeProject('project-a', 'project-stopped');

    expect(close).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  it('removes every selected resource before invoking reentrant closers', async () => {
    const registry = new HostResourceRegistry();
    const calls: HostResourceCloseReason[] = [];
    registry.register('project-a', 'member-a', reason => {
      calls.push(reason);
      registry.register('project-a', 'member-new', jest.fn());
    });
    registry.register('project-a', 'member-b', reason => {
      calls.push(reason);
    });

    await registry.closeProject('project-a', 'project-stopped');

    expect(calls).toEqual(['project-stopped', 'project-stopped']);
    expect(registry.size).toBe(1);
  });

  it('bounds a non-settling closer and leaves no orphan registration', async () => {
    jest.useFakeTimers();
    try {
      const registry = new HostResourceRegistry({ closeTimeoutMs: 250 });
      const close = jest.fn(() => new Promise<void>(() => undefined));
      registry.register('project-a', 'member-a', close);

      const closing = registry.closeAll('host-stopped');
      const result = closing.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(250);

      await expect(result).resolves.toMatchObject({ code: 'operation-timeout' });
      expect(close).toHaveBeenCalledWith('host-stopped');
      expect(registry.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('attempts every closer and reports failures after clearing ownership', async () => {
    const registry = new HostResourceRegistry();
    const second = jest.fn();
    registry.register('project-a', 'member-a', () => {
      throw new Error('close failed');
    });
    registry.register('project-a', 'member-b', second);

    await expect(registry.closeAll('host-stopped')).rejects.toMatchObject({
      code: 'operation-failed',
    });
    expect(second).toHaveBeenCalledWith('host-stopped');
    expect(registry.size).toBe(0);
  });
});
