import { TabWorkspaceMigrationCoordinator } from '@/app/storage/TabWorkspaceMigrationCoordinator';
import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';
import { ClaudianView } from '@/features/chat/ClaudianView';

test.each(['legacy read', 'metadata load'] as const)('a delivered view snapshot supersedes pending %s', async phase => {
  const legacy: AppTabManagerState = { activeTabId: 'legacy', openTabs: [{ tabId: 'legacy', conversationId: 'legacy-conversation' }] };
  const current: AppTabManagerState = { activeTabId: 'current', openTabs: [{ tabId: 'current', conversationId: null }] };
  let finishRead!: (state: AppTabManagerState) => void;
  let markReading!: () => void;
  const reading = new Promise<void>(resolve => { markReading = resolve; });
  const storage = {
    getTabManagerState: () => {
      if (phase === 'metadata load') return Promise.resolve(legacy);
      markReading();
      return new Promise<AppTabManagerState>(resolve => { finishRead = resolve; });
    },
    clearTabManagerState: jest.fn().mockResolvedValue(undefined),
  };
  const view = Object.create(ClaudianView.prototype) as any;
  const workspace = { layoutReady: true, getLeavesOfType: () => [{view}], onLayoutReady: () => undefined };
  const migration = new TabWorkspaceMigrationCoordinator(storage, workspace, candidate => candidate === view);
  let restored: AppTabManagerState | null = null;
  view.tabWorkspace = view.createTabWorkspace();
  view.tabManager = {
    restoreState: jest.fn(async (state: AppTabManagerState) => { restored = state; }),
    getPersistedState: () => restored,
  };
  const persistence = { update: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
  view.tabWorkspace.persistence = persistence;
  view.plugin = {
    settings: { restoreTabsOnStartup: true },
    registerTabWorkspaceStateDelivery: (owner: object, scoped: boolean) => migration.registerStateDelivery(owner, scoped),
    claimLegacyTabManagerState: () => migration.claimLegacyState(),
    completeLegacyTabManagerStateMigration: () => migration.completeMigration(),
    ensureConversationMetadataLoaded: jest.fn(async () => {
      if (phase === 'metadata load') {
        markReading();
        await new Promise<void>(resolve => { finishRead = () => resolve(); });
      }
    }),
  };
  for (const name of ['syncProviderBrandColor','updateInputLocation','updateTabBar',
    'notifyConversationNavigationChanged','startSessionSidebarLayoutObserver']) view[name] = jest.fn();
  const firstDelivery = view.setState({}, { history: false });
  await reading;
  const scopedDelivery = view.setState({ tabWorkspace: {version: 1, ...current} }, {history: false});
  finishRead(legacy);
  await Promise.all([firstDelivery, scopedDelivery]);
  expect(view.tabManager.restoreState).toHaveBeenLastCalledWith(current);
  expect(persistence.update).toHaveBeenLastCalledWith(current);
});
