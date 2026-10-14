import type { ProviderId } from '@/core/providers/types';
import type { Conversation, ConversationMeta, ConversationMutablePatch, ConversationSummary, StoredChatModelSelection } from '@/core/types';
import type { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import type { ChatExecutionPersistence } from '@/features/chat/execution/ChatExecutionCoordinator';
import type { SessionToolBinding } from '@/features/chat/session-messaging/SessionMessagingService';
import type { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';
import type { ChatTab, TabId, TabManagerViewHost } from '@/features/chat/tabs/ChatTab';
import type { TabIdentity } from '@/features/chat/tabs/TabIdentity';
import type { ZenModeSource } from '@/features/chat/zen/types';
import type { FeatureHost } from '@/features/FeatureHost';

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
}

export interface ChatTabManagerHost {
  canCreateTab(): boolean;
  resetConversationTabs(conversationId: string): Promise<void>;
  getAllTabs(): ChatTab[];
  getTabIdentities(): readonly Readonly<TabIdentity>[];
  getTab(tabId: TabId): ChatTab | null;
  getActiveTab(): ChatTab | null;
  getActiveTabId(): TabId | null;
  /** Replaces the active tab's conversation with a blank draft. */
  createNewConversation(): Promise<void>;
  isTabWorking(tabId: TabId): boolean;
  /** Owned, without an admitted close, and the manager is live: the tab may receive new work. */
  isTabLive(tabId: TabId): boolean;
  switchToTab(tabId: TabId): Promise<void>;
  /** Shows a tab's session the layout's way: the wide viewer for a narrow tab, otherwise the tab. */
  focusTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId): Promise<boolean>;
  invalidateProviderResources(providerIds: ProviderId | ProviderId[], generation: number): void;
}

export interface ChatViewHost extends ChatViewRefreshHost, TabManagerViewHost {
  getActiveTab(): ChatTab | null;
  getTabManager(): ChatTabManagerHost | null;
  /** The tabs that replace and close commands target; null while the wide layout owns navigation. */
  getCompactTabManager(): ChatTabManagerHost | null;
  /** Starts a new conversation the active layout's way: a slot draft when wide, else a new tab. */
  startNewConversation(): Promise<void>;
  focusActiveInput(): void;
  /** Whether the compact tab bar is shown, counting restored tabs that are not assembled yet. */
  isTabBarVisible(): boolean;
  /** Starts inline renaming of the active tab's badge; false when no badge is shown for it. */
  renameActiveTab(): boolean;
}

/** Session attachment and lookup; retirement and shutdown stay with the pool's main-owned callers. */
export type ChatSessionRuntimes = Pick<SessionRuntimePool, 'awaitConversationCreations' | 'acquire' | 'ensure' | 'release' | 'get' | 'getAttachment' | 'holdDraft'>;

/** Application capabilities chat needs on top of the feature-neutral `FeatureHost`. */
export interface ChatFeatureHost extends FeatureHost {
  readonly sessionRuntimes: ChatSessionRuntimes;
  bindSessionTools(conversationId: string): SessionToolBinding;
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
  /** Completes generation atomically; null records failure. A changed title takes precedence. */
  completeConversationTitleGeneration(id: string, expectedTitle: string, title: string | null): Promise<void>;
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

  /** Offers a view's presentation to the single zen workspace owner; returns its unregistration. */
  registerZenModeSource(source: ZenModeSource): () => void;

  getView(): ChatViewHost | null;
  getAllViews(): ChatViewHost[];
  findConversationAcrossViews(
    conversationId: string,
  ): { view: ChatViewHost; tabId: TabId } | null;
}
