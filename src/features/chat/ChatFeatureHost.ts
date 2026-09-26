import type { AppTabManagerState, ProviderId } from '../../core/providers/types';
import type { Conversation, ConversationMeta, ConversationMutablePatch, ConversationSummary, StoredChatModelSelection } from '../../core/types';
import type { FeatureHost } from '../FeatureHost';
import type { ChatExecutionPersistence } from './execution/ChatExecutionCoordinator';
import type { WarmExecutionPool } from './execution/WarmExecutionPool';
import type { AssembledTabRuntime, TabId, TabManagerViewHost,TabProviderCatalogContext } from './tabs/types';

export interface ChatModelSelectionPort {
  beginIntent(): number;
  commitIntent(
    intent: number,
    selection: StoredChatModelSelection,
    isStillValid: () => boolean,
  ): Promise<boolean>;
}

export interface ChatViewRefreshHost {
  notifyConversationListChanged(): void;
  refreshModelSelector(providerId?: ProviderId): void;
  refreshTabControls(): void;
  refreshDualPaneLayout(): void;
  refreshMessageTimestamps(): void;
  updateHiddenProviderCommands(): void;
  invalidateProviderResources(providerIds: ProviderId[], generation: number): void;
}

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

export interface ChatViewHost extends ChatViewRefreshHost, TabManagerViewHost {
  getActiveTab(): AssembledTabRuntime | null;
  getTabManager(): ChatTabManagerHost | null;
}

/** Application capabilities chat needs on top of the feature-neutral `FeatureHost`. */
export interface ChatFeatureHost extends FeatureHost {
  readonly chatModelSelection: ChatModelSelectionPort;
  createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
    linkedContentPath?: string;
  }): Promise<Conversation>;
  switchConversation(id: string): Promise<Conversation | null>;
  assignConversationToCurrentDevice(id: string): Promise<boolean>;
  deleteConversation(id: string): Promise<void>;
  handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'>;
  renameConversation(id: string, title: string): Promise<void>;
  setConversationPinned(id: string, isPinned: boolean): Promise<void>;
  setLinkedContentPinned(contentPath: string, isPinned: boolean): Promise<void>;
  rewriteLinkedContentPaths(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean,
  ): Promise<void>;
  setConversationArchived(id: string, isArchived: boolean): Promise<void>;
  updateConversation(id: string, updates: ConversationMutablePatch): Promise<void>;
  getConversationById(id: string): Promise<Conversation | null>;
  getCachedConversation(id: string): Conversation | null;
  getConversationSummary(id: string): ConversationSummary | null;
  getConversationSync(id: string): Conversation | null;
  getConversationList(): ConversationMeta[];
  ensureConversationMetadataLoaded(conversationIds: readonly string[]): Promise<void>;


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
