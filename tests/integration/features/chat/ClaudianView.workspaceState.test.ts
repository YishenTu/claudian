import { createClaudianView } from '@test/helpers/features/chat/ClaudianViewHarness';

import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';

test('a later delivered view snapshot supersedes a restore still loading metadata', async () => {
  const earlier: AppTabManagerState = { activeTabId: 'earlier', openTabs: [{ tabId: 'earlier', conversationId: 'earlier-conversation' }] };
  const current: AppTabManagerState = { activeTabId: 'current', openTabs: [{ tabId: 'current', conversationId: null }] };
  let finishLoad!: () => void;
  let markLoading!: () => void;
  const loading = new Promise<void>(resolve => { markLoading = resolve; });
  const view = createClaudianView();
  let restored: AppTabManagerState | null = null;
  view.tabManager = {
    getActiveTab: () => null,
    restoreState: vi.fn(async (state: AppTabManagerState) => { restored = state; }),
    getPersistedState: () => restored,
  };
  const persistence = { update: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) };
  view.tabWorkspace.persistence = persistence;
  view.plugin = {
    ...view.plugin,
    settings: { restoreTabsOnStartup: true },
    ensureConversationMetadataLoaded: vi.fn(async () => {
      markLoading();
      await new Promise<void>(resolve => { finishLoad = resolve; });
    }),
  };
  for (const name of ['syncProviderBrandColor', 'updateTabBar', 'notifyConversationNavigationChanged']) view[name] = vi.fn();
  const firstDelivery = view.setState({ tabWorkspace: { version: 1, ...earlier } }, { history: false });
  await loading;
  const secondDelivery = view.setState({ tabWorkspace: { version: 1, ...current } }, { history: false });
  finishLoad();
  await Promise.all([firstDelivery, secondDelivery]);
  expect(view.tabManager.restoreState).toHaveBeenCalledTimes(1);
  expect(view.tabManager.restoreState).toHaveBeenLastCalledWith(current);
  expect(persistence.update).toHaveBeenLastCalledWith(current);
});
