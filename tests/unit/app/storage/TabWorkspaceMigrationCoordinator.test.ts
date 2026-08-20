import { TabWorkspaceMigrationCoordinator } from '@/app/storage/TabWorkspaceMigrationCoordinator';

function createWorkspaceHarness() {
  let layoutReady = false;
  const layoutReadyCallbacks: Array<() => void> = [];
  const leaves: any[] = [];
  const workspace = {
    get layoutReady() {
      return layoutReady;
    },
    getLeavesOfType: jest.fn(() => leaves),
    onLayoutReady: jest.fn((callback: () => void) => {
      layoutReadyCallbacks.push(callback);
    }),
  };

  return {
    leaves,
    markLayoutReady: () => {
      layoutReady = true;
      for (const callback of layoutReadyCallbacks.splice(0)) callback();
    },
    workspace,
  };
}

describe('TabWorkspaceMigrationCoordinator', () => {
  it('waits for actual state delivery instead of trusting live synthesized view state', async () => {
    const legacyState = {
      activeTabId: 'legacy-tab',
      openTabs: [{ conversationId: null, tabId: 'legacy-tab' }],
    };
    const storage = {
      clearTabManagerState: jest.fn().mockResolvedValue(undefined),
      getTabManagerState: jest.fn().mockResolvedValue(legacyState),
    };
    const { leaves, markLayoutReady, workspace } = createWorkspaceHarness();
    const liveView = { kind: 'claudian' };
    leaves.push({
      view: liveView,
      getViewState: jest.fn().mockReturnValue({
        state: {
          tabWorkspace: {
            version: 1,
            activeTabId: null,
            openTabs: [],
          },
        },
      }),
    });
    const coordinator = new TabWorkspaceMigrationCoordinator(
      storage,
      workspace as any,
      view => view === liveView,
    );

    const registration = coordinator.registerStateDelivery(liveView, false);
    expect(registration.declarationsReady).toBe(false);

    markLayoutReady();
    await registration.waitUntilDeclarationsReady;

    await expect(coordinator.claimLegacyState()).resolves.toEqual(legacyState);
    expect(storage.clearTabManagerState).not.toHaveBeenCalled();
  });

  it('suppresses legacy migration when any live view actually receives scoped state', async () => {
    const storage = {
      clearTabManagerState: jest.fn().mockResolvedValue(undefined),
      getTabManagerState: jest.fn().mockResolvedValue({
        activeTabId: 'legacy-tab',
        openTabs: [{ conversationId: null, tabId: 'legacy-tab' }],
      }),
    };
    const { leaves, markLayoutReady, workspace } = createWorkspaceHarness();
    const firstView = { id: 'first' };
    const secondView = { id: 'second' };
    leaves.push(
      { view: firstView, getViewState: jest.fn().mockReturnValue({ state: {} }) },
      { view: secondView, getViewState: jest.fn().mockReturnValue({ state: {} }) },
    );
    const coordinator = new TabWorkspaceMigrationCoordinator(
      storage,
      workspace as any,
      view => view === firstView || view === secondView,
    );

    const first = coordinator.registerStateDelivery(firstView, false);
    const second = coordinator.registerStateDelivery(secondView, true);
    markLayoutReady();
    await Promise.all([
      first.waitUntilDeclarationsReady,
      second.waitUntilDeclarationsReady,
    ]);

    expect(storage.clearTabManagerState).toHaveBeenCalledTimes(1);
    await expect(coordinator.claimLegacyState()).resolves.toBeNull();
    expect(storage.getTabManagerState).not.toHaveBeenCalled();
    expect(storage.clearTabManagerState).toHaveBeenCalledTimes(1);
  });

  it('recognizes serialized state retained by a deferred leaf', async () => {
    const storage = {
      clearTabManagerState: jest.fn().mockResolvedValue(undefined),
      getTabManagerState: jest.fn(),
    };
    const { leaves, markLayoutReady, workspace } = createWorkspaceHarness();
    const liveView = { kind: 'claudian' };
    leaves.push(
      { view: liveView, getViewState: jest.fn().mockReturnValue({ state: {} }) },
      {
        view: { kind: 'deferred' },
        getViewState: jest.fn().mockReturnValue({
          state: {
            tabWorkspace: {
              version: 1,
              activeTabId: 'deferred-tab',
              openTabs: [{ conversationId: null, tabId: 'deferred-tab' }],
            },
          },
        }),
      },
    );
    const coordinator = new TabWorkspaceMigrationCoordinator(
      storage,
      workspace as any,
      view => view === liveView,
    );

    const registration = coordinator.registerStateDelivery(liveView, false);
    markLayoutReady();
    await registration.waitUntilDeclarationsReady;

    expect(storage.clearTabManagerState).toHaveBeenCalledTimes(1);
    await expect(coordinator.claimLegacyState()).resolves.toBeNull();
    expect(storage.getTabManagerState).not.toHaveBeenCalled();
    expect(storage.clearTabManagerState).toHaveBeenCalledTimes(1);
  });

  it('allows only one view to claim the legacy snapshot', async () => {
    const legacyState = {
      activeTabId: 'legacy-tab',
      openTabs: [{ conversationId: null, tabId: 'legacy-tab' }],
    };
    const storage = {
      clearTabManagerState: jest.fn().mockResolvedValue(undefined),
      getTabManagerState: jest.fn().mockResolvedValue(legacyState),
    };
    const { leaves, markLayoutReady, workspace } = createWorkspaceHarness();
    const liveView = { kind: 'claudian' };
    leaves.push({ view: liveView, getViewState: jest.fn().mockReturnValue({ state: {} }) });
    const coordinator = new TabWorkspaceMigrationCoordinator(
      storage,
      workspace as any,
      view => view === liveView,
    );

    const registration = coordinator.registerStateDelivery(liveView, false);
    markLayoutReady();
    await registration.waitUntilDeclarationsReady;

    await expect(coordinator.claimLegacyState()).resolves.toEqual(legacyState);
    await expect(coordinator.claimLegacyState()).resolves.toBeNull();
    expect(storage.getTabManagerState).toHaveBeenCalledTimes(1);
  });
});
