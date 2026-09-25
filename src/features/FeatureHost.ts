import type { App, WorkspaceLeaf } from 'obsidian';

import type { SharedAppStorage } from '../core/bootstrap/storage';
import type { CollabComposerReferencePort } from '../core/collab';
import type { ProviderHost } from '../core/providers/ProviderHost';
import type { ProviderId } from '../core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
  ConversationMutablePatch,
  StoredChatModelSelection,
} from '../core/types';

/** What features outside chat may read about the active chat tab. */
export interface FeatureActiveTab {
  readonly conversationId: string | null;
  readonly draftModel: string | null;
  readonly providerId: ProviderId | null;
}

/** Chat view capabilities available to every feature. Chat narrows this in `ChatFeatureHost`. */
export interface FeatureViewHost {
  getActiveTab(): FeatureActiveTab | null;
  notifyConversationListChanged(): void;
  refreshModelSelector(providerId?: ProviderId): void;
  refreshTabControls(): void;
  refreshDualPaneLayout(): void;
  refreshCollabAvailability(): void;
  refreshMessageTimestamps(): void;
  updateHiddenProviderCommands(): void;
  invalidateProviderResources(providerIds: ProviderId[], generation: number): void;
}

export interface ChatModelSelectionPort {
  beginIntent(): number;
  commitIntent(
    intent: number,
    selection: StoredChatModelSelection,
    isStillValid: () => boolean,
  ): Promise<boolean>;
}

export interface CollabSidebarSurfaceController {
  /** Starts lazy construction and initialization without making the surface active. */
  preload?(): void;
  setActive(active: boolean): void;
  destroy(): void;
}

export interface CollabSidebarSurfaceFactory {
  create(
    hostEl: HTMLElement,
    leaf: WorkspaceLeaf,
  ): CollabSidebarSurfaceController;
}

export type CollabGitInstallationStatus = 'available' | 'unavailable';

/** Lets settings re-apply the warm agent process limit without owning the pool. */
export interface WarmExecutionLimitPort {
  reconcileLimit(): Promise<boolean>;
}

/** Application capabilities consumed by user-facing features. */
export interface FeatureHost {
  readonly app: App;
  readonly chatModelSelection: ChatModelSelectionPort;
  readonly providerHost: ProviderHost;
  readonly settings: ClaudianSettings;
  readonly storage: SharedAppStorage;
  readonly warmExecutionPool: WarmExecutionLimitPort;
  readonly collabSurfaceFactory?: CollabSidebarSurfaceFactory;
  readonly collabComposerReferences?: CollabComposerReferencePort;

  getMainAgentDynamicSystemPromptSections?(): Promise<readonly string[]>;

  checkCollabGitInstallation(rescan?: boolean): Promise<CollabGitInstallationStatus>;
  isCollabEnabled(): boolean;
  setCollabEnabled(enabled: boolean): Promise<void>;
  setCollabProjectsFolder(raw: string): Promise<
    { readonly ok: true; readonly value: string }
    | { readonly message: string; readonly ok: false }
  >;

  mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void>;
  getActiveEnvironmentVariables(providerId?: ProviderId): string;
  getAgentSkillResourceGeneration(): number;
  notifyAgentSkillsChanged(): Promise<void>;
  notifyProviderChatOptionsChanged(providerId: ProviderId): void;

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
  getConversationSync(id: string): Conversation | null;
  getConversationList(): ConversationMeta[];
  ensureConversationMetadataLoaded(conversationIds: readonly string[]): Promise<void>;

  getView(): FeatureViewHost | null;
  getAllViews(): FeatureViewHost[];
}
