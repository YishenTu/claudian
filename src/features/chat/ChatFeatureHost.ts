import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';

import type { ProviderId } from '../../core/providers/types';
import type { Conversation, ConversationMeta, ConversationMutablePatch, ConversationSummary, StoredChatModelSelection } from '../../core/types';
import type { FeatureHost } from '../FeatureHost';
import type { ChatExecutionPersistence } from './execution/ChatExecutionCoordinator';
import type { ChatTab, TabId, TabManagerViewHost, TabProviderCatalogContext } from './tabs/types';
import type { ConversationLifecycle } from './workspace/ConversationLifecycle';
import type { ZenModeSource } from './zen/types';

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
  updateHiddenCommands(): void;
  invalidateProviderCommandCaches(providerIds?: ProviderId[]): void;
  invalidateProviderResources(providerIds: ProviderId[], generation: number): void;
  handleLinkedContentRenamed(oldPath: string, newPath: string, includeDescendants: boolean): void;
  handleLinkedContentDeleted(path: string, includeDescendants: boolean): void;
  handleLinkedContentCreated(path: string): void;
}

export interface TabWorkspaceStateDeliveryRegistration {
  readonly declarationsReady: boolean;
  readonly waitUntilDeclarationsReady: Promise<void>;
}

export interface ChatTabManagerHost {
  canCreateTab(): boolean;
  resetConversationTabs(conversationId: string): Promise<void>;
  getAllTabs(): ChatTab[];
  getTabIdentities(): readonly TabProviderCatalogContext[];
  getTab(tabId: TabId): ChatTab | null;
  getActiveTab(): ChatTab | null;
  getActiveTabId(): TabId | null;
  /** Replaces the active tab's conversation with a blank draft. */
  createNewConversation(): Promise<void>;
  isTabWorking(tabId: TabId): boolean;
  /** Commits provisional previews to retained tabs and claims user ownership. */
  retainTabs(tabIds: readonly TabId[]): void;
  switchToTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId, force?: boolean): Promise<boolean>;
  invalidateProviderResources(providerIds: ProviderId | ProviderId[], generation: number): void;
}

export interface ChatViewHost extends ChatViewRefreshHost, TabManagerViewHost {
  getActiveTab(): ChatTab | null;
  getTabManager(): ChatTabManagerHost | null;
  /** True while the wide layout gives New and tab commands session-navigation semantics. */
  isDualPaneMode(): boolean;
  handleNewConversationCommand(): Promise<boolean>;
  createNewTab(): Promise<unknown>;
  focusActiveInput(): void;
}

/** Application capabilities chat needs on top of the feature-neutral `FeatureHost`. */
export interface ChatFeatureHost extends FeatureHost {
  writeSessionSnapshot(conversationId: string, markdown: string): Promise<string>;
  getSessionSnapshotDirectory(): string;
  readonly chatModelSelection: ChatModelSelectionPort;
  createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
    linkedContentPath?: string;
  }): Promise<Conversation>;
  switchConversation(id: string): Promise<Conversation | null>;
  assignConversationToCurrentDevice(id: string): Promise<boolean>;
  /** Removes a record without tab policy; only for rolling back a conversation the caller created. */
  deleteConversation(id: string): Promise<void>;
  /** The single owner of user archive, restore, pin, and delete intents. */
  readonly conversationLifecycle: ConversationLifecycle;
  handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'>;
  renameConversation(id: string, title: string): Promise<void>;
  setLinkedContentPinned(contentPath: string, isPinned: boolean): Promise<void>;
  rewriteLinkedContentPaths(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean,
  ): Promise<void>;
  /** Sessions held by any chat pane's tabs, including unloaded panes and pending restoration. */
  getWorkspaceConversationIds(): ReadonlySet<string>;
  updateConversation(id: string, updates: ConversationMutablePatch): Promise<void>;
  getConversationById(id: string): Promise<Conversation | null>;
  getCachedConversation(id: string): Conversation | null;
  getConversationSummary(id: string): ConversationSummary | null;
  getConversationSync(id: string): Conversation | null;
  getConversationList(): ConversationMeta[];
  ensureConversationMetadataLoaded(conversationIds: readonly string[]): Promise<void>;

  readonly executionPersistence: ChatExecutionPersistence;

  registerTabWorkspaceStateDelivery(
    view: ChatViewHost,
    hasViewScopedState: boolean,
  ): TabWorkspaceStateDeliveryRegistration;
  claimLegacyTabManagerState(): Promise<AppTabManagerState | null>;
  completeLegacyTabManagerStateMigration(): Promise<void>;

  /** Offers a view's presentation to the single zen workspace owner; returns its unregistration. */
  registerZenModeSource(source: ZenModeSource): () => void;

  getView(): ChatViewHost | null;
  getAllViews(): ChatViewHost[];
  findConversationAcrossViews(
    conversationId: string,
  ): { view: ChatViewHost; tabId: TabId } | null;
}
