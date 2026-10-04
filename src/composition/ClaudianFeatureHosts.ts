import type { App } from 'obsidian';

import type { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationService } from '@/app/conversations/ConversationService';
import type { SessionSnapshotStore } from '@/app/conversations/SessionSnapshotStore';
import type { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import type { EnvironmentSettingsService } from '@/app/settings/EnvironmentSettingsService';
import type { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { TabWorkspaceMigrationCoordinator } from '@/app/storage/TabWorkspaceMigrationCoordinator';
import type { SharedAppStorage } from '@/core/bootstrap/storage';
import type { AppTabManagerState } from '@/core/bootstrap/tabManagerState';
import { resolveConversationModel } from '@/core/providers/conversationModel';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderId } from '@/core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
  ConversationMutablePatch,
  ConversationSummary,
  StoredChatModelSelection,
} from '@/core/types';
import type {
  ChatFeatureHost,
  ChatViewHost,
  TabWorkspaceStateDeliveryRegistration,
} from '@/features/chat/ChatFeatureHost';
import type { ClaudianView } from '@/features/chat/ClaudianView';
import type { ConversationLifecycle } from '@/features/chat/workspace/ConversationLifecycle';
import type { ZenModeSource } from '@/features/chat/zen/types';
import type { ZenModeController } from '@/features/chat/zen/ZenModeController';
import type { FeatureHost } from '@/features/FeatureHost';

import type { AgentSkillResources } from './AgentSkillResources';
import type { ClaudianViews } from './ClaudianViews';

export interface FeatureHostDomains {
  readonly app: App;
  readonly providerHost: ProviderHost;
  readonly storage: SharedAppStorage;
  readonly settings: Pick<SettingsCoordinator<ClaudianSettings>, 'getCommittedSettings' | 'mutate'>;
  readonly environment: Pick<EnvironmentSettingsService, 'getActiveEnvironmentVariables'>;
  readonly agentSkills: AgentSkillResources;
  readonly conversations: Pick<ConversationService, 'getConversationSummary'>;
  readonly views: ClaudianViews;
  notifyProviderChatOptionsChanged(providerId: ProviderId): Promise<void>;
}

export interface ChatFeatureHostDomains extends FeatureHostDomains {
  readonly conversations: ConversationService;
  readonly executionPersistence: ConversationRepository;
  readonly chatModelSelection: ChatModelSelectionCoordinator;
  readonly sessionSnapshots: SessionSnapshotStore;
  readonly tabWorkspaceMigration: TabWorkspaceMigrationCoordinator;
  readonly conversationLifecycle: ConversationLifecycle;
  readonly zenMode: Pick<ZenModeController, 'register'>;
}

/** Feature-neutral application capabilities for settings, inline edit, and chat. */
export class ClaudianFeatureHost implements FeatureHost {
  readonly app: App;
  readonly providerHost: ProviderHost;
  readonly storage: SharedAppStorage;

  constructor(protected readonly domains: FeatureHostDomains) {
    this.app = domains.app;
    this.providerHost = domains.providerHost;
    this.storage = domains.storage;
  }

  get settings(): Readonly<ClaudianSettings> {
    return this.domains.settings.getCommittedSettings();
  }

  getCommittedSettings(): Readonly<ClaudianSettings> {
    return this.domains.settings.getCommittedSettings();
  }

  mutateSettings(mutation: (settings: ClaudianSettings) => void | Promise<void>): Promise<void> {
    return this.domains.settings.mutate(mutation);
  }

  getActiveEnvironmentVariables(providerId?: ProviderId): string {
    return this.domains.environment.getActiveEnvironmentVariables(providerId);
  }

  getAgentSkillResourceGeneration(): number {
    return this.domains.agentSkills.getGeneration();
  }

  notifyAgentSkillsChanged(): Promise<void> {
    return this.domains.agentSkills.notifyChanged();
  }

  notifyProviderChatOptionsChanged(providerId: ProviderId): void {
    void this.domains.notifyProviderChatOptionsChanged(providerId);
  }

  getActiveModelSelection(): StoredChatModelSelection | null {
    const tab = this.domains.views.getView()?.getActiveTab();
    if (!tab) return null;
    const conversation = tab.conversationId
      ? this.domains.conversations.getConversationSummary(tab.conversationId)
      : null;
    const providerId = conversation?.providerId ?? tab.providerId;
    if (!providerId) return null;
    const model = conversation
      ? resolveConversationModel(this.getCommittedSettings(), providerId, conversation).model
      : tab.draftModel;
    return model ? { providerId, model } : null;
  }
}

/** Chat capabilities: conversations, execution persistence, tab workspace state, and views. */
export class ClaudianChatFeatureHost extends ClaudianFeatureHost implements ChatFeatureHost {
  readonly chatModelSelection: ChatModelSelectionCoordinator;
  readonly executionPersistence: ConversationRepository;
  readonly conversationLifecycle: ConversationLifecycle;

  constructor(protected readonly domains: ChatFeatureHostDomains) {
    super(domains);
    this.chatModelSelection = domains.chatModelSelection;
    this.executionPersistence = domains.executionPersistence;
    this.conversationLifecycle = domains.conversationLifecycle;
  }

  writeSessionSnapshot(conversationId: string, markdown: string): Promise<string> {
    return this.domains.sessionSnapshots.write(conversationId, markdown);
  }

  getSessionSnapshotDirectory(): string {
    return this.domains.sessionSnapshots.directory;
  }

  createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
    linkedContentPath?: string;
  }): Promise<Conversation> {
    return this.domains.conversations.createConversation(options);
  }

  switchConversation(id: string): Promise<Conversation | null> {
    return this.domains.conversations.switchConversation(id);
  }

  assignConversationToCurrentDevice(id: string): Promise<boolean> {
    return this.domains.conversations.assignConversationToCurrentDevice(id);
  }

  deleteConversation(id: string): Promise<void> {
    return this.domains.conversations.deleteConversation(id);
  }

  handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'> {
    return this.domains.conversations.handleMissingProviderSession(id, missingProviderSessionId);
  }

  renameConversation(id: string, title: string): Promise<void> {
    return this.domains.conversations.renameConversation(id, title);
  }

  setLinkedContentPinned(contentPath: string, isPinned: boolean): Promise<void> {
    return this.domains.conversations.setLinkedContentPinned(contentPath, isPinned);
  }

  rewriteLinkedContentPaths(oldPath: string, newPath: string, includeDescendants: boolean): Promise<void> {
    return this.domains.conversations.rewriteLinkedContentPaths(oldPath, newPath, includeDescendants);
  }

  getWorkspaceConversationIds(): ReadonlySet<string> {
    return this.domains.views.getWorkspaceConversationIds();
  }

  updateConversation(id: string, updates: ConversationMutablePatch): Promise<void> {
    return this.domains.conversations.updateConversation(id, updates);
  }

  getConversationById(id: string): Promise<Conversation | null> {
    return this.domains.conversations.getConversationById(id);
  }

  getCachedConversation(id: string): Conversation | null {
    return this.domains.conversations.getCachedConversation(id);
  }

  getConversationSummary(id: string): ConversationSummary | null {
    return this.domains.conversations.getConversationSummary(id);
  }

  getConversationSync(id: string): Conversation | null {
    return this.domains.conversations.getConversationSync(id);
  }

  getConversationList(): ConversationMeta[] {
    return this.domains.conversations.getConversationList();
  }

  ensureConversationMetadataLoaded(conversationIds: readonly string[]): Promise<void> {
    return this.domains.conversations.ensureConversationMetadataLoaded(conversationIds);
  }

  registerTabWorkspaceStateDelivery(
    view: ChatViewHost,
    hasViewScopedState: boolean,
  ): TabWorkspaceStateDeliveryRegistration {
    return this.domains.tabWorkspaceMigration.registerStateDelivery(view, hasViewScopedState);
  }

  claimLegacyTabManagerState(): Promise<AppTabManagerState | null> {
    return this.domains.tabWorkspaceMigration.claimLegacyState();
  }

  completeLegacyTabManagerStateMigration(): Promise<void> {
    return this.domains.tabWorkspaceMigration.completeMigration();
  }

  registerZenModeSource(source: ZenModeSource): () => void {
    return this.domains.zenMode.register(source);
  }

  getView(): ClaudianView | null {
    return this.domains.views.getView();
  }

  getAllViews(): ClaudianView[] {
    return this.domains.views.getAllViews();
  }

  findConversationAcrossViews(conversationId: string): { view: ClaudianView; tabId: string } | null {
    return this.domains.views.findConversationAcrossViews(conversationId);
  }
}
