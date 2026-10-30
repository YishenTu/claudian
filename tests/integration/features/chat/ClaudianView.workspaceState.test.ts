/** @vitest-environment jsdom */
import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';

import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { VaultMentionDataProvider } from '@/shared/mention/VaultMentionDataProvider';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function installPersistence(view: Awaited<ReturnType<typeof createClaudianView>>) {
  const lifecycle = view['tabWorkspace'];
  const saved: Record<string, unknown>[] = [];
  const save = vi.spyOn(view.app.workspace.requestSaveLayout, 'run');
  save.mockImplementation(async () => { saved.push(structuredClone(view.getState())); });
  const persistence = (await lifecycle.preparePersistence(lifecycle.beginOpen()))!;
  return { lifecycle, persistence, saved, save };
}


test('a later delivered view snapshot supersedes a restore still loading metadata', async () => {
  const earlier: AppTabManagerState = { activeTabId: 'earlier', openTabs: [{ tabId: 'earlier', conversationId: 'earlier-conversation' }] };
  const current: AppTabManagerState = { activeTabId: 'current', openTabs: [{ tabId: 'current', conversationId: null }] };
  let finishLoad!: () => void;
  let markLoading!: () => void;
  const loading = new Promise<void>(resolve => { markLoading = resolve; });
  const view = await createClaudianView({ plugin: { settings: { restoreTabsOnStartup: true } } });
  let restored: AppTabManagerState = { openTabs: [], activeTabId: null };
  const manager = new TabManager(view['plugin'], view.contentEl, view, {}, new VaultMentionDataProvider(view.app));
  view['tabManager'] = manager;
  Object.assign(manager, {
    getActiveTab: () => null,
    restoreState: vi.fn(async (state: AppTabManagerState) => { restored = state; }),
    getPersistedState: () => restored,
  });
  const { persistence, saved } = await installPersistence(view);
  view['plugin'].ensureConversationMetadataLoaded = vi.fn(async () => {
      markLoading();
      await new Promise<void>(resolve => { finishLoad = resolve; });
    });
  for (const name of ['syncProviderBrandColor', 'updateTabBar', 'notifyConversationNavigationChanged'] as const) view[name] = vi.fn();
  const firstDelivery = view.setState({ tabWorkspace: { version: 1, ...earlier } }, { history: false });
  await loading;
  const secondDelivery = view.setState({ tabWorkspace: { version: 1, ...current } }, { history: false });
  finishLoad();
  await Promise.all([firstDelivery, secondDelivery]);
  expect(manager.restoreState).toHaveBeenCalledTimes(1);
  expect(manager.restoreState).toHaveBeenLastCalledWith(current);
  await persistence.flush();
  expect(saved).toEqual([{ tabWorkspace: { version: 1, ...current } }]);
  persistence.dispose();
});


test('coalesces live view changes into the latest saved snapshot and does not rewrite it after acknowledgement', async () => {
  let state: AppTabManagerState = { openTabs: [], activeTabId: null };
  const view = await createClaudianView({ tabManager: { getPersistedState: () => state } });
  const { lifecycle, persistence, saved } = await installPersistence(view);
  try {
    lifecycle.persist();
    state = { openTabs: [{ tabId: 'tab-1', conversationId: 'conversation-1' }], activeTabId: 'tab-1' };
    lifecycle.persist();
    await vi.advanceTimersByTimeAsync(299);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([{ tabWorkspace: { version: 1, ...state } }]);

    await persistence.flush();
    await persistence.flush();
    lifecycle.persist();
    await vi.advanceTimersByTimeAsync(300);
    expect(saved).toHaveLength(1);
  } finally {
    persistence.dispose();
  }
});

test('serializes a change received during an in-flight workspace save and flushes the final snapshot', async () => {
  let state: AppTabManagerState = { openTabs: [], activeTabId: null };
  const view = await createClaudianView({ tabManager: { getPersistedState: () => state } });
  const { lifecycle, persistence, saved, save } = await installPersistence(view);
  let finishFirst!: () => void;
  const firstWrite = new Promise<void>(resolve => { finishFirst = resolve; });
  save.mockImplementationOnce(async () => {
    saved.push(structuredClone(view.getState()));
    await firstWrite;
  });
  try {
    lifecycle.persist();
    await vi.advanceTimersByTimeAsync(300);
    expect(saved).toEqual([{ tabWorkspace: { version: 1, openTabs: [], activeTabId: null } }]);
    state = { openTabs: [{ tabId: 'tab-2', conversationId: null }], activeTabId: 'tab-2' };
    lifecycle.persist();
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);

    finishFirst();
    await persistence.flush();
    expect(saved).toEqual([
      { tabWorkspace: { version: 1, openTabs: [], activeTabId: null } },
      { tabWorkspace: { version: 1, ...state } },
    ]);
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    finishFirst();
    await persistence.flush();
    persistence.dispose();
  }
});
