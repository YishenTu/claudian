import type { App } from 'obsidian';

import type { SharedAppStorage } from '../core/bootstrap/storage';
import type { ProviderHost } from '../core/providers/ProviderHost';
import type { ProviderId } from '../core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
} from '../core/types';
import type { ChatExecutionPersistence } from './chat/execution/ChatExecutionCoordinator';
import type { WarmExecutionPool } from './chat/execution/WarmExecutionPool';
import type { TabData, TabId, TabManagerViewHost } from './chat/tabs/types';

export interface FeatureTabManagerHost {
  getAllTabs(): TabData[];
  getTab(tabId: TabId): TabData | null;
  switchToTab(tabId: TabId): Promise<void>;
  closeTab(tabId: TabId, force?: boolean): Promise<boolean>;
  primeProviderExecution(providerIds?: ProviderId | ProviderId[]): void;
  invalidateProviderResources(providerIds: ProviderId | ProviderId[], generation: number): void;
}

export interface FeatureViewHost extends TabManagerViewHost {
  getActiveTab(): TabData | null;
  getTabManager(): FeatureTabManagerHost | null;
  notifyConversationListChanged(): void;
  refreshModelSelector(providerId?: ProviderId): void;
  refreshTabControls(): void;
  updateHiddenProviderCommands(): void;
  invalidateProviderResources(providerIds: ProviderId[], generation: number): void;
}

/** Application capabilities consumed by user-facing features. */
export interface FeatureHost {
  readonly app: App;
  readonly executionPersistence: ChatExecutionPersistence;
  readonly providerHost: ProviderHost;
  readonly settings: ClaudianSettings;
  readonly storage: SharedAppStorage;
  readonly warmExecutionPool: WarmExecutionPool;

  mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void>;
  getActiveEnvironmentVariables(providerId?: ProviderId): string;
  getAgentSkillResourceGeneration(): number;
  notifyAgentSkillsChanged(): Promise<void>;

  createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
    currentNote?: string;
  }): Promise<Conversation>;
  switchConversation(id: string): Promise<Conversation | null>;
  deleteConversation(id: string): Promise<void>;
  handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'>;
  renameConversation(id: string, title: string): Promise<void>;
  setConversationPinned(id: string, isPinned: boolean): Promise<void>;
  setLinkedNotePinned(notePath: string, isPinned: boolean): Promise<void>;
  setConversationArchived(id: string, isArchived: boolean): Promise<void>;
  updateConversation(id: string, updates: Partial<Conversation>): Promise<void>;
  getConversationById(id: string): Promise<Conversation | null>;
  getCachedConversation(id: string): Conversation | null;
  getConversationSync(id: string): Conversation | null;
  getConversationList(): ConversationMeta[];

  getView(): FeatureViewHost | null;
  getAllViews(): FeatureViewHost[];
  findConversationAcrossViews(
    conversationId: string,
  ): { view: FeatureViewHost; tabId: TabId } | null;
}
