import type {
  SessionMetadataReader,
  SessionMetadataReadResult,
} from '../../core/bootstrap/SessionStorage';
import { StartupProfiler } from '../../core/performance/StartupProfiler';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import { DEFAULT_CHAT_PROVIDER_ID } from '../../core/providers/types';
import type { Conversation, SessionMetadata } from '../../core/types';
import type { RuntimeSettingsCoordinator } from '../settings/RuntimeSettingsCoordinator';
import type { ConversationRepository } from './ConversationRepository';

export interface InitialSessionMetadataScan {
  records: SessionMetadataReadResult[];
  complete: boolean;
  invalidMetadataCount: number;
}

export interface SessionMetadataLoaderOptions {
  sessions: SessionMetadataReader;
  conversations: ConversationRepository;
  runtimeSettings: RuntimeSettingsCoordinator;
  isUnloading(): boolean;
  whenLayoutReady(callback: () => void): void;
  onConversationListChanged(): void;
}

/**
 * Loads session metadata for the conversation repository. It reads the
 * startup scan for `loadSettings`, which still adopts those records itself,
 * and owns the deferred background scan after layout and on-demand loading
 * of individual conversations.
 */
export class SessionMetadataLoader {
  private stopped = false;
  private disposal: Promise<void> | null = null;
  private readonly requestedLoads = new Set<Promise<void>>();
  private pendingScan = false;
  private loadedAll = false;
  private scheduledLoadTimer: number | null = null;
  private remainingLoad: Promise<void> | null = null;

  constructor(private readonly options: SessionMetadataLoaderOptions) {}

  get hasLoadedAll(): boolean {
    return this.loadedAll;
  }

  async readInitialMetadata(): Promise<InitialSessionMetadataScan> {
    const scan = await this.options.sessions.scan();
    return {
      records: await this.options.sessions.revalidate(scan.records),
      complete: scan.complete,
      invalidMetadataCount: scan.invalidMetadataCount,
    };
  }

  finishStartup(complete: boolean, deferRemaining: boolean): void {
    this.loadedAll = complete;
    this.pendingScan = deferRemaining;
  }

  scheduleRemainingLoad(): void {
    if (!this.pendingScan || this.isStopped()) {
      return;
    }

    const schedule = (): void => {
      if (!this.pendingScan || this.isStopped()) {
        return;
      }
      this.scheduledLoadTimer = window.setTimeout(() => {
        this.scheduledLoadTimer = null;
        this.startRemainingLoad();
      }, 0);
    };

    this.options.whenLayoutReady(schedule);
  }

  /** Stop admission synchronously and join already-admitted repository operations. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    this.pendingScan = false;
    if (this.scheduledLoadTimer !== null) {
      window.clearTimeout(this.scheduledLoadTimer);
      this.scheduledLoadTimer = null;
    }
    this.disposal = Promise.allSettled([
      this.remainingLoad,
      ...this.requestedLoads,
    ]).then(() => undefined);
    return this.disposal;
  }

  private isStopped(): boolean {
    return this.stopped || this.options.isUnloading();
  }

  private async loadRemaining(): Promise<void> {
    if (this.isStopped()) return;
    const { conversations, runtimeSettings } = this.options;
    const addedConversations: Conversation[] = [];
    const invalidatedConversations: Conversation[] = [];
    let didChangeConversationList = false;
    const publishBatch = (records: SessionMetadataReadResult[]): void => {
      if (this.isStopped() || records.length === 0) return;

      const recoverySources = records.map(({ metadata }) => (
        this.createShell(metadata)
      ));
      const publishable = records
        .map(record => ({
          conversation: this.createShell(record.metadata),
          source: record.source,
        }))
        .filter(({ conversation }) => (
          conversations.isSelectedModelPublicationSafe(conversation)
        ));
      const shells = publishable.map(({ conversation }) => conversation);
      const publishedIds = new Set(shells.map(({ id }) => id));
      const invalidatedShells = ProviderSettingsCoordinator
        .invalidateConversationSessions(
          shells,
          runtimeSettings.getPendingProviderIds(),
        );
      const invalidatedIds = new Set(
        invalidatedShells.map(({ id }) => id),
      );
      const added = conversations.mergeMetadataConversations(
        shells,
        new Map(publishable.map(({ conversation, source }) => [
          conversation.id,
          source,
        ])),
      );
      conversations.registerHistoricalModelRecoverySources(
        recoverySources.filter(({ id }) => publishedIds.has(id)),
      );
      if (added.length === 0) return;

      addedConversations.push(...added);
      invalidatedConversations.push(
        ...added.filter(({ id }) => invalidatedIds.has(id)),
      );
      didChangeConversationList = true;
    };
    const scan = await this.options.sessions.scan({
      onBatch: publishBatch,
    });
    if (this.isStopped()) {
      return;
    }

    StartupProfiler.recordCount('session-metadata-count', scan.records.length);
    StartupProfiler.recordCount(
      'invalid-session-metadata-count',
      scan.invalidMetadataCount,
    );
    const scannedShells = scan.records
      .map(({ metadata }) => conversations.getCachedConversation(metadata.id))
      .filter((shell): shell is Conversation => shell !== null);
    const records = await this.options.sessions.revalidate(scan.records);
    if (this.isStopped()) return;
    const resolvedIds = new Set(records.map(({ metadata }) => metadata.id));
    const unresolvedShells = scannedShells.filter(
      ({ id }) => !resolvedIds.has(id),
    );
    conversations.discardUnresolvedMetadataShells(
      unresolvedShells,
    );
    if (unresolvedShells.length > 0) {
      didChangeConversationList = true;
    }
    publishBatch(records);
    const entries = records.map(({ metadata, needsMigration, source }) => ({
      conversation: this.createShell(metadata),
      needsMigration,
      source,
    }));
    const shells = entries.map(({ conversation }) => conversation);
    const invalidatedEntries = ProviderSettingsCoordinator
      .invalidateConversationSessions(
        shells,
        runtimeSettings.getPendingProviderIds(),
      );
    const invalidatedIds = new Set(
      invalidatedEntries.map(({ id }) => id),
    );
    const existingIds = new Set(
      conversations.getAll().map(({ id }) => id),
    );
    await conversations.adoptMetadataConversations(entries);
    if (this.isStopped()) return;
    conversations.registerHistoricalModelRecoverySources(
      shells,
    );
    const adoptedConversations = shells.filter((conversation) => (
      !existingIds.has(conversation.id)
      && conversations.getCachedConversation(conversation.id)
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
      conversations.getCachedConversation(conversation.id)
        === conversation
    ));
    const currentInvalidatedConversations = invalidatedConversations.filter(
      (conversation) => (
        conversations.getCachedConversation(conversation.id)
          === conversation
      ),
    );
    const uniqueCurrentInvalidatedConversations = currentInvalidatedConversations.filter(
      ({ id }, index, candidates) => (
        candidates.findIndex(conversation => conversation.id === id) === index
      ),
    );
    StartupProfiler.recordCount('background-session-metadata-count', currentAddedConversations.length);
    let recoveredModels: Conversation[] = [];
    if (!this.isStopped()) {
      recoveredModels = await conversations
        .recoverMissingSelectedModels();
      StartupProfiler.recordCount(
        'recovered-session-model-count',
        recoveredModels.length,
      );
    }
    if (this.isStopped()) return;
    await conversations.persistConversations(
      uniqueCurrentInvalidatedConversations,
    );
    if (
      !this.isStopped()
      && (didChangeConversationList || recoveredModels.length > 0)
    ) {
      this.options.onConversationListChanged();
    }
    if (scan.complete) {
      this.loadedAll = true;
      if (!this.isStopped()) {
        await runtimeSettings.completePendingSessionInvalidations(
          runtimeSettings.getCompletablePendingSessionInvalidations(),
        );
      }
    }
  }

  async ensureLoaded(conversationIds: readonly string[]): Promise<void> {
    if (this.isStopped()) return;
    const load = this.loadConversations(conversationIds);
    this.requestedLoads.add(load);
    try {
      await load;
    } finally {
      this.requestedLoads.delete(load);
    }
  }

  private async loadConversations(conversationIds: readonly string[]): Promise<void> {
    const { conversations, runtimeSettings } = this.options;
    const missingIds = Array.from(new Set(conversationIds)).filter(
      id => !conversations.getCachedConversation(id),
    );
    if (missingIds.length === 0) return;

    const records = (await Promise.all(
      missingIds.map(id => this.options.sessions.load(id)),
    )).filter((record): record is SessionMetadataReadResult => record !== null);
    if (this.isStopped() || records.length === 0) return;

    const entries = records.map(({ metadata, needsMigration, source }) => ({
      conversation: this.createShell(metadata),
      needsMigration,
      source,
    }));
    const shells = entries.map(({ conversation }) => conversation);
    const invalidatedIds = new Set(
      ProviderSettingsCoordinator.invalidateConversationSessions(
        shells,
        runtimeSettings.getPendingProviderIds(),
      ).map(({ id }) => id),
    );
    await conversations.adoptMetadataConversations(entries);
    if (this.isStopped()) return;
    conversations.registerHistoricalModelRecoverySources(shells);
    await conversations.persistConversations(
      Array.from(invalidatedIds)
        .map(id => conversations.getCachedConversation(id))
        .filter((conversation): conversation is Conversation => conversation !== null),
    );
  }

  createShell(meta: SessionMetadata): Conversation {
    return {
      id: meta.id,
      providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
      title: meta.title,
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      sessionId: meta.sessionId !== undefined ? meta.sessionId : meta.id,
      selectedModel: meta.selectedModel,
      providerState: meta.providerState,
      modelRecoverySource: meta.modelRecoverySource,
      messages: [],
      linkedContentPath: meta.linkedContentPath,
      isPinned: meta.isPinned,
      isArchived: meta.isArchived,
      usage: meta.usage,
      titleGenerationStatus: meta.titleGenerationStatus,
      resumeAtMessageId: meta.resumeAtMessageId,
    };
  }

  private startRemainingLoad(): void {
    if (
      !this.pendingScan
      || this.isStopped()
      || this.remainingLoad
    ) {
      return;
    }

    this.pendingScan = false;
    const load = StartupProfiler.runAsync(
      'session-metadata-background-load',
      () => this.loadRemaining(),
    ).catch(() => {
      StartupProfiler.increment('session-metadata-background-failures');
    }).finally(() => {
      if (this.remainingLoad === load) {
        this.remainingLoad = null;
      }
    });
    this.remainingLoad = load;
  }

}
