import type { App } from 'obsidian';

import type { SharedAppStorage } from '../core/bootstrap/storage';
import type { ProviderHost } from '../core/providers/ProviderHost';
import type { AppTabManagerState, ProviderId } from '../core/providers/types';
import type { ChatRuntime } from '../core/runtime/ChatRuntime';
import type { ClaudianSettings, Conversation, ConversationMeta } from '../core/types';
import type { TabData, TabId, TabManagerViewHost } from './chat/tabs/types';

export interface FeatureTabManagerHost {
  getAllTabs(): TabData[];
  getTab(tabId: TabId): TabData | null;
  switchToTab(tabId: TabId): Promise<void>;
  broadcastToAllTabs(action: (runtime: ChatRuntime) => Promise<void>): Promise<void>;
  recycleProviderRuntimes(providerIds: ProviderId | ProviderId[]): Promise<void>;
}

export interface FeatureViewHost extends TabManagerViewHost {
  getActiveTab(): TabData | null;
  getTabManager(): FeatureTabManagerHost | null;
  refreshModelSelector(): void;
  refreshTabControls(): void;
  updateHiddenProviderCommands(): void;
}

/** Application capabilities consumed by user-facing features. */
export interface FeatureHost {
  readonly app: App;
  readonly providerHost: ProviderHost;
  readonly settings: ClaudianSettings;
  readonly storage: SharedAppStorage;

  mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void>;
  getActiveEnvironmentVariables(providerId?: ProviderId): string;

  createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
  }): Promise<Conversation>;
  switchConversation(id: string): Promise<Conversation | null>;
  deleteConversation(
    id: string,
    options?: { deleteProviderSession?: boolean },
  ): Promise<void>;
  handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'>;
  renameConversation(id: string, title: string): Promise<void>;
  updateConversation(id: string, updates: Partial<Conversation>): Promise<void>;
  getConversationById(id: string): Promise<Conversation | null>;
  getCachedConversation(id: string): Conversation | null;
  getConversationSync(id: string): Conversation | null;
  getConversationList(): ConversationMeta[];

  persistTabManagerState(state: AppTabManagerState): Promise<void>;
  getView(): FeatureViewHost | null;
  getAllViews(): FeatureViewHost[];
  findConversationAcrossViews(
    conversationId: string,
  ): { view: FeatureViewHost; tabId: TabId } | null;
}
