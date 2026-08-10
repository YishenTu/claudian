import type {
  SessionMetadataReader,
  SessionMetadataReadResult,
} from '../../core/bootstrap/SessionStorage';
import { StartupProfiler } from '../../core/performance/StartupProfiler';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '../../core/providers/types';
import { DEFAULT_CHAT_PROVIDER_ID } from '../../core/providers/types';
import type {
  Conversation,
  SessionMetadata,
} from '../../core/types';
import type { ConversationRepository } from './ConversationRepository';

export interface SessionMetadataCoordinatorOptions {
  sessions: SessionMetadataReader;
  repository: ConversationRepository;
  getPendingInvalidationProviderIds: () => readonly ProviderId[];
  isUnloading: () => boolean;
  recoverMissingConversationModels: () => Promise<Conversation[]>;
  completePendingSessionInvalidations: () => Promise<void>;
  notifyConversationViewsChanged: () => void;
}

export class SessionMetadataCoordinator {
  private readonly sessions: SessionMetadataReader;
  private readonly repository: ConversationRepository;
  private readonly getPendingInvalidationProviderIds: () => readonly ProviderId[];
  private readonly isUnloading: () => boolean;
  private readonly recoverMissingConversationModels: () => Promise<Conversation[]>;
  private readonly completePendingSessionInvalidations: () => Promise<void>;
  private readonly notifyConversationViewsChanged: () => void;

  constructor(options: SessionMetadataCoordinatorOptions) {
    this.sessions = options.sessions;
    this.repository = options.repository;
    this.getPendingInvalidationProviderIds = options.getPendingInvalidationProviderIds;
    this.isUnloading = options.isUnloading;
    this.recoverMissingConversationModels = options.recoverMissingConversationModels;
    this.completePendingSessionInvalidations = options.completePendingSessionInvalidations;
    this.notifyConversationViewsChanged = options.notifyConversationViewsChanged;
  }

  async loadSessionMetadataWithSources(): Promise<{
    records: SessionMetadataReadResult[];
    complete: boolean;
    invalidMetadataCount: number;
  }> {
    const scan = await this.sessions.scanMetadata();
    return {
      records: await this.resolveMetadataSources(scan.metadata),
      complete: scan.complete,
      invalidMetadataCount: scan.invalidMetadataCount,
    };
  }

  async loadRemainingSessionMetadata(): Promise<boolean> {
    const addedConversations: Conversation[] = [];
    const invalidatedConversations: Conversation[] = [];
    let didChangeConversationList = false;
    const publishBatch = (metadata: SessionMetadata[]): void => {
      if (this.isUnloading() || metadata.length === 0) return;

      const recoverySources = metadata.map((item) => (
        createConversationMetadataShell(item)
      ));
      const shells = metadata
        .map((item) => createConversationMetadataShell(item))
        .filter((conversation) => (
          this.repository.isSelectedModelPublicationSafe(conversation)
        ));
      const publishedIds = new Set(shells.map(({ id }) => id));
      const invalidatedShells = ProviderSettingsCoordinator
        .invalidateConversationSessions(
          shells,
          [...this.getPendingInvalidationProviderIds()],
        );
      const invalidatedIds = new Set(
        invalidatedShells.map(({ id }) => id),
      );
      const added = this.repository.mergeMetadataConversations(shells);
      this.repository.registerHistoricalModelRecoverySources(
        recoverySources.filter(({ id }) => publishedIds.has(id)),
      );
      if (added.length === 0) return;

      addedConversations.push(...added);
      invalidatedConversations.push(
        ...added.filter(({ id }) => invalidatedIds.has(id)),
      );
      didChangeConversationList = true;
    };
    const scan = await this.sessions.scanMetadata({
      onBatch: publishBatch,
    });
    if (this.isUnloading()) {
      return scan.complete;
    }

    StartupProfiler.recordCount('session-metadata-count', scan.metadata.length);
    StartupProfiler.recordCount(
      'invalid-session-metadata-count',
      scan.invalidMetadataCount,
    );
    const scannedShells = scan.metadata
      .map(({ id }) => this.repository.getCachedConversation(id))
      .filter((shell): shell is Conversation => shell !== null);
    const records = await this.resolveMetadataSources(scan.metadata);
    const resolvedIds = new Set(records.map(({ metadata }) => metadata.id));
    const unresolvedShells = scannedShells.filter(
      ({ id }) => !resolvedIds.has(id),
    );
    this.repository.discardUnresolvedMetadataShells(unresolvedShells);
    if (unresolvedShells.length > 0) {
      didChangeConversationList = true;
    }
    publishBatch(records.map(({ metadata }) => metadata));
    const entries = records.map(({ metadata, needsMigration, source }) => ({
      conversation: createConversationMetadataShell(metadata),
      needsMigration,
      source,
    }));
    const shells = entries.map(({ conversation }) => conversation);
    const invalidatedEntries = ProviderSettingsCoordinator
      .invalidateConversationSessions(
        shells,
        [...this.getPendingInvalidationProviderIds()],
      );
    const invalidatedIds = new Set(
      invalidatedEntries.map(({ id }) => id),
    );
    const existingIds = new Set(
      this.repository.getAll().map(({ id }) => id),
    );
    await this.repository.adoptMetadataConversations(entries);
    this.repository.registerHistoricalModelRecoverySources(shells);
    const adoptedConversations = shells.filter((conversation) => (
      !existingIds.has(conversation.id)
      && this.repository.getCachedConversation(conversation.id)
        === conversation
    ));
    if (adoptedConversations.length > 0) {
      addedConversations.push(...adoptedConversations);
      invalidatedConversations.push(
        ...adoptedConversations.filter(({ id }) => invalidatedIds.has(id)),
      );
      didChangeConversationList = true;
    }
    const currentAddedConversations = addedConversations.filter((conversation) => (
      this.repository.getCachedConversation(conversation.id) === conversation
    ));
    const currentInvalidatedConversations = invalidatedConversations.filter(
      (conversation) => (
        this.repository.getCachedConversation(conversation.id) === conversation
      ),
    );
    const uniqueCurrentInvalidatedConversations = currentInvalidatedConversations.filter(
      ({ id }, index, conversations) => (
        conversations.findIndex(conversation => conversation.id === id) === index
      ),
    );
    StartupProfiler.recordCount(
      'background-session-metadata-count',
      currentAddedConversations.length,
    );
    let recoveredModels: Conversation[] = [];
    if (!this.isUnloading()) {
      recoveredModels = await this.recoverMissingConversationModels();
      StartupProfiler.recordCount(
        'recovered-session-model-count',
        recoveredModels.length,
      );
    }
    await this.repository.persistConversations(uniqueCurrentInvalidatedConversations);
    if (
      !this.isUnloading()
      && (didChangeConversationList || recoveredModels.length > 0)
    ) {
      this.notifyConversationViewsChanged();
    }
    if (scan.complete && !this.isUnloading()) {
      await this.completePendingSessionInvalidations();
    }
    return scan.complete;
  }

  private async resolveMetadataSources(
    metadata: SessionMetadata[],
  ): Promise<SessionMetadataReadResult[]> {
    const records = await Promise.all(
      metadata.map(({ id }) => this.sessions.load(id)),
    );
    return records.filter(
      (record): record is SessionMetadataReadResult => record !== null,
    );
  }
}

export function createConversationMetadataShell(meta: SessionMetadata): Conversation {
  return {
    id: meta.id,
    providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
    title: meta.title,
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    sessionId: meta.sessionId !== undefined ? meta.sessionId : meta.id,
    selectedModel: meta.selectedModel,
    providerState: meta.providerState,
    task: meta.task,
    modelRecoverySource: meta.modelRecoverySource,
    messages: [],
    currentNote: meta.currentNote,
    isPinned: meta.isPinned,
    isArchived: meta.isArchived,
    externalContextPaths: meta.externalContextPaths,
    enabledMcpServers: meta.enabledMcpServers,
    usage: meta.usage,
    titleGenerationStatus: meta.titleGenerationStatus,
    resumeAtMessageId: meta.resumeAtMessageId,
  };
}
