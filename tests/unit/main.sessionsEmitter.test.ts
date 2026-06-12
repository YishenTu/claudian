import ClaudianPlugin from '@/main';

describe('ClaudianPlugin sessions-change emitter', () => {
  function createPlugin(): ClaudianPlugin {
    // The emitter methods operate only on the in-memory listener set, so a bare
    // instance (no onload) is sufficient to exercise the subscribe/notify contract.
    return new ClaudianPlugin({} as never, {} as never);
  }

  it('delivers notifications to subscribers', () => {
    const plugin = createPlugin();
    const listener = jest.fn();

    plugin.onSessionsChanged(listener);
    plugin.notifySessionsChanged();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops delivery after unsubscribe', () => {
    const plugin = createPlugin();
    const listener = jest.fn();

    const unsubscribe = plugin.onSessionsChanged(listener);
    plugin.notifySessionsChanged();
    unsubscribe();
    plugin.notifySessionsChanged();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing listener from the others', () => {
    const plugin = createPlugin();
    const failing = jest.fn(() => {
      throw new Error('listener boom');
    });
    const healthy = jest.fn();

    plugin.onSessionsChanged(failing);
    plugin.onSessionsChanged(healthy);

    expect(() => plugin.notifySessionsChanged()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
