import { TabStatePersistenceCoordinator } from '@/features/chat/tabs/persistence/TabStatePersistenceCoordinator';

describe('TabStatePersistenceCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid updates into one write', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const coordinator = new TabStatePersistenceCoordinator(write, window, 300);

    coordinator.update({ openTabs: [], activeTabId: null });
    coordinator.update({
      openTabs: [{ tabId: 'tab-1', conversationId: 'conv-1' }],
      activeTabId: 'tab-1',
    });
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('serializes writes and writes again for an update received during an in-flight write', async () => {
    let finishFirstWrite!: () => void;
    const firstWrite = new Promise<void>(resolve => {
      finishFirstWrite = resolve;
    });
    const write = vi.fn()
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce(undefined);
    const coordinator = new TabStatePersistenceCoordinator(write, window, 300);

    coordinator.update({ openTabs: [], activeTabId: null });
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    coordinator.update({
      openTabs: [{ tabId: 'tab-2', conversationId: null }],
      activeTabId: 'tab-2',
    });

    expect(write).toHaveBeenCalledTimes(1);
    finishFirstWrite();
    await coordinator.flush();

    expect(write).toHaveBeenCalledTimes(2);
  });

  it('flushes a change once and does not rewrite an acknowledged state', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const coordinator = new TabStatePersistenceCoordinator(write, window, 300);
    const state = {
      openTabs: [{ tabId: 'tab-1', conversationId: null }],
      activeTabId: 'tab-1',
    };

    coordinator.update(state);
    await coordinator.flush();
    await coordinator.flush();
    coordinator.update(state);
    vi.advanceTimersByTime(300);
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);
  });
});
