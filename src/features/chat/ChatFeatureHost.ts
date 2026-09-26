import type { AppTabManagerState, ProviderId } from '../../core/providers/types';
import type { FeatureHost, FeatureViewHost } from '../FeatureHost';
import type { ChatExecutionPersistence } from './execution/ChatExecutionCoordinator';
import type { WarmExecutionPool } from './execution/WarmExecutionPool';
import type { AssembledTabRuntime, TabId, TabManagerViewHost,TabProviderCatalogContext } from './tabs/types';

export interface TabWorkspaceStateDeliveryRegistration {
  readonly declarationsReady: boolean;
  readonly waitUntilDeclarationsReady: Promise<void>;
}

export interface ChatTabManagerHost {
  canCreateTab(): boolean;
  resetConversationTabs(conversationId: string): Promise<void>;
  getAllTabs(): AssembledTabRuntime[];
  getTabIdentities(): readonly TabProviderCatalogContext[];
  getTab(tabId: TabId): AssembledTabRuntime | null;
  isTabWorking(tabId: TabId): boolean;
  switchToTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId, force?: boolean): Promise<boolean>;
  primeProviderExecution(providerIds?: ProviderId | ProviderId[]): void;
  invalidateProviderResources(providerIds: ProviderId | ProviderId[], generation: number): void;
}

export interface ChatViewHost extends FeatureViewHost, TabManagerViewHost {
  getActiveTab(): AssembledTabRuntime | null;
  getTabManager(): ChatTabManagerHost | null;
}

/** Application capabilities chat needs on top of the feature-neutral `FeatureHost`. */
export interface ChatFeatureHost extends FeatureHost {
  readonly executionPersistence: ChatExecutionPersistence;
  readonly warmExecutionPool: WarmExecutionPool;

  registerTabWorkspaceStateDelivery(
    view: ChatViewHost,
    hasViewScopedState: boolean,
  ): TabWorkspaceStateDeliveryRegistration;
  claimLegacyTabManagerState(): Promise<AppTabManagerState | null>;
  completeLegacyTabManagerStateMigration(): Promise<void>;

  getView(): ChatViewHost | null;
  getAllViews(): ChatViewHost[];
  findConversationAcrossViews(
    conversationId: string,
  ): { view: ChatViewHost; tabId: TabId } | null;
}
