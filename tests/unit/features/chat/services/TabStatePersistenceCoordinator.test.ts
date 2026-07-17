import { TabStatePersistenceCoordinator } from '@/features/chat/services/TabStatePersistenceCoordinator';

describe('TabStatePersistenceCoordinator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces rapid updates into one write of the latest serialized state', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const coordinator = new TabStatePersistenceCoordinator(persist, window, 300);

    coordinator.update({ openTabs: [], activeTabId: null });
    coordinator.update({
      openTabs: [{ tabId: 'tab-1', conversationId: 'conv-1' }],
      activeTabId: 'tab-1',
    });
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({
      openTabs: [{ tabId: 'tab-1', conversationId: 'conv-1' }],
      activeTabId: 'tab-1',
    });
  });

  it('serializes writes and persists an update received during an in-flight write', async () => {
    let finishFirstWrite!: () => void;
    const firstWrite = new Promise<void>(resolve => {
      finishFirstWrite = resolve;
    });
    const persist = jest.fn()
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce(undefined);
    const coordinator = new TabStatePersistenceCoordinator(persist, window, 300);

    coordinator.update({ openTabs: [], activeTabId: null });
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    coordinator.update({
      openTabs: [{ tabId: 'tab-2', conversationId: null }],
      activeTabId: 'tab-2',
    });

    expect(persist).toHaveBeenCalledTimes(1);
    finishFirstWrite();
    await coordinator.flush();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({
      openTabs: [{ tabId: 'tab-2', conversationId: null }],
      activeTabId: 'tab-2',
    });
  });

  it('flushes the latest state once and does not rewrite an acknowledged snapshot', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const coordinator = new TabStatePersistenceCoordinator(persist, window, 300);
    const state = {
      openTabs: [{ tabId: 'tab-1', conversationId: null }],
      activeTabId: 'tab-1',
    };

    coordinator.update(state);
    await coordinator.flush();
    await coordinator.flush();
    coordinator.update(state);
    jest.advanceTimersByTime(300);
    await Promise.resolve();

    expect(persist).toHaveBeenCalledTimes(1);
  });
});
