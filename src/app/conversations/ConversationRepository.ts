import {
  computeConversationInputDigest,
  CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
  type ConversationInputLedger,
  type ConversationInputLedgerReadResult,
  type ConversationInputRecord,
} from '../../core/bootstrap/ConversationInputLedgerStorage';
import type { ConversationPersistence } from '../../core/bootstrap/ConversationPersistenceStore';
import type {
  SessionMetadataReadResult,
} from '../../core/bootstrap/SessionStorage';
import type { ProviderSessionSnapshot } from '../../core/execution';
import { normalizeProviderModelSelection, resolveConversationModel } from '../../core/providers/conversationModel';
import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderHistoryPathContext } from '../../core/providers/types';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type ProviderId,
} from '../../core/providers/types';
import {
  type ChatMessage,
  type Conversation,
  type ConversationMeta,
  isCanonicalUserMessage,
  type SessionMetadata,
} from '../../core/types';
import { extractUserDisplayContent } from '../../utils/context';

interface ConversationRepositoryBaseDeps {
  getSettings: () => Record<string, unknown>;
  getVaultPath: () => string | null;
  onConversationDeleted: (conversationId: string) => Promise<void>;
}

export type ConversationRepositoryDeps = ConversationRepositoryBaseDeps & {
  persistence: ConversationPersistence;
};

interface LoadedLedgerState {
  status: 'loaded';
  ledger: ConversationInputLedger;
}

interface UnavailableLedgerState {
  status: 'unavailable';
  reason: Extract<
    ConversationInputLedgerReadResult,
    { status: 'unavailable' }
  >['reason'];
}

type LedgerState = LoadedLedgerState | UnavailableLedgerState;

interface ExecutionBindingState {
  readonly bindingId: string;
  readonly providerId: ProviderId;
  readonly providerGeneration: number;
  closed: boolean;
  latestSnapshot: ProviderSessionSnapshot | null;
  lastPersistedRevision: number;
}

interface ConversationDeletionState {
  readonly conversation: Conversation;
  readonly executionBinding: ExecutionBindingState | null;
}

export class ConversationInputLedgerUnavailableError extends Error {
  constructor(
    readonly conversationId: string,
    readonly reason: UnavailableLedgerState['reason'],
  ) {
    super(`Conversation input ledger is unavailable: ${conversationId} (${reason})`);
    this.name = 'ConversationInputLedgerUnavailableError';
  }
}

export class ConversationInputStageRejectedError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation input was not durably staged: ${conversationId}`);
    this.name = 'ConversationInputStageRejectedError';
  }
}

export class ConversationRepository {
  private conversations: Conversation[] = [];
  private hydratedConversationIds = new Set<string>();
  private hydrationPromises = new Map<string, Promise<Conversation | null>>();
  private conversationGenerations = new Map<string, number>();
  private deletedConversationIds = new Set<string>();
  private deletingConversationIds = new Set<string>();
  private readonly ledgerStates = new Map<string, LedgerState>();
  private readonly ledgerLoadPromises = new Map<string, Promise<LedgerState>>();
  private readonly persistenceQueues = new Map<string, Promise<void>>();
  private readonly executionBindings = new Map<string, ExecutionBindingState>();
  private readonly deletionStates = new Map<string, ConversationDeletionState>();
  private readonly persistence: ConversationPersistence;

  constructor(private readonly deps: ConversationRepositoryDeps) {
    this.persistence = deps.persistence;
  }

  replaceAll(conversations: Conversation[]): void {
    for (const conversation of this.conversations) {
      this.invalidateConversation(conversation.id);
    }
    this.conversations = conversations.filter(
      ({ id }) => !this.deletedConversationIds.has(id),
    );
    this.hydratedConversationIds = new Set(
      this.conversations
        .filter((conversation) => conversation.messages.length > 0)
        .map(({ id }) => id),
    );
    this.hydrationPromises.clear();
    this.ledgerStates.clear();
    this.ledgerLoadPromises.clear();
    this.executionBindings.clear();
    this.deletionStates.clear();
  }

  async adoptMetadataConversations(
    entries: ReadonlyArray<{
      conversation: Conversation;
      source: SessionMetadataReadResult['source'];
    }>,
  ): Promise<void> {
    const added = this.mergeMetadataConversations(
      entries.map(({ conversation }) => conversation),
    );
    const addedIds = new Set(added.map(({ id }) => id));
    const migrations = entries
      .filter(
        ({ conversation, source }) =>
          source === 'legacy'
          && (addedIds.has(conversation.id) || !!this.getSync(conversation.id)),
      )
      .map(({ conversation }) => this.enqueuePersistence(
        conversation.id,
        async () => {
          const current = this.getSync(conversation.id);
          if (!current || !await this.canWriteConversation(current)) return;
          await this.persistence.saveMetadata(this.toSessionMetadata(current));
          await this.persistence.deleteLegacyMetadata(current.id);
        },
      ));
    await Promise.all(migrations);
  }

  mergeMetadataConversations(conversations: Conversation[]): Conversation[] {
    const existingIds = new Set(this.conversations.map(({ id }) => id));
    const added = conversations.filter(
      ({ id }) =>
        !existingIds.has(id)
        && !this.deletedConversationIds.has(id)
        && !this.deletingConversationIds.has(id),
    );
    if (added.length === 0) {
      return [];
    }

    this.conversations.push(...added);
    this.conversations.sort(
      (left, right) =>
        (right.lastResponseAt ?? right.updatedAt)
        - (left.lastResponseAt ?? left.updatedAt),
    );
    for (const conversation of added) {
      if (conversation.messages.length > 0) {
        this.hydratedConversationIds.add(conversation.id);
      }
    }
    return added;
  }

  discardUnresolvedMetadataShells(
    shells: readonly Conversation[],
  ): void {
    for (const shell of shells) {
      if (this.getSync(shell.id) !== shell) continue;

      const index = this.conversations.indexOf(shell);
      if (index === -1) continue;
      this.conversations.splice(index, 1);
      this.hydratedConversationIds.delete(shell.id);
      this.hydrationPromises.delete(shell.id);
      this.ledgerStates.delete(shell.id);
      this.ledgerLoadPromises.delete(shell.id);
      this.executionBindings.delete(shell.id);
      this.invalidateConversation(shell.id);
    }
  }

  getAll(): Conversation[] {
    return this.conversations;
  }

  backfillResponseTimestamps(): Conversation[] {
    const updated: Conversation[] = [];
    for (const conversation of this.conversations) {
      if (
        conversation.lastResponseAt != null
        || conversation.messages.length === 0
      ) {
        continue;
      }

      for (
        let index = conversation.messages.length - 1;
        index >= 0;
        index -= 1
      ) {
        const message = conversation.messages[index];
        if (message.role === 'assistant') {
          conversation.lastResponseAt = message.timestamp;
          updated.push(conversation);
          break;
        }
      }
    }
    return updated;
  }

  async create(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
  }): Promise<Conversation> {
    const settings = this.deps.getSettings();
    const providerId = options?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    const sessionId = options?.sessionId;
    const id = sessionId ?? this.generateId();
    if (
      this.deletedConversationIds.has(id)
      || await this.persistence.isDeleted(id)
    ) {
      throw new Error(`Conversation ID is permanently deleted: ${id}`);
    }
    const providerSettings =
      ProviderSettingsCoordinator.getProviderSettingsSnapshot(
        settings,
        providerId,
      );
    const selectedModel = normalizeProviderModelSelection(
      providerId,
      settings,
      options?.selectedModel ?? providerSettings.model,
    ) ?? undefined;
    const conversation: Conversation = {
      id,
      providerId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      selectedModel,
      messages: [],
    };

    this.conversations.unshift(conversation);
    if (!sessionId) {
      this.hydratedConversationIds.add(conversation.id);
    }
    await this.save(conversation);
    return conversation;
  }

  async switchTo(id: string): Promise<Conversation | null> {
    return this.ensureHydrated(id);
  }

  async delete(id: string): Promise<void> {
    const index = this.conversations.findIndex(
      (conversation) => conversation.id === id,
    );
    if (index === -1) {
      if (
        this.deletedConversationIds.has(id)
        || await this.persistence.isDeleted(id)
      ) {
        await this.retryDeletedConversationCleanup(id);
      }
      return;
    }

    const conversation = this.conversations[index];
    const pendingHydration = this.hydrationPromises.get(id) ?? null;
    const deletionState: ConversationDeletionState = {
      conversation,
      executionBinding: this.executionBindings.get(id) ?? null,
    };
    this.deletionStates.set(id, deletionState);
    this.deletingConversationIds.add(id);
    this.deletedConversationIds.add(id);
    this.conversations.splice(index, 1);
    this.hydratedConversationIds.delete(id);
    this.hydrationPromises.delete(id);
    this.invalidateConversation(id);

    if (pendingHydration) {
      await Promise.allSettled([pendingHydration]);
    }

    let markerDurable = false;
    try {
      await this.enqueuePersistence(id, async () => {
        await this.persistence.markDeleted(id, Date.now());
        markerDurable = true;
        this.deletingConversationIds.delete(id);
        this.deletionStates.delete(id);
        this.executionBindings.delete(id);
        await this.finalizeDeletedConversation(id);
      });
    } catch (error) {
      if (!markerDurable) {
        this.deletingConversationIds.delete(id);
        this.deletedConversationIds.delete(id);
        this.deletionStates.delete(id);
        this.conversations.splice(
          Math.min(index, this.conversations.length),
          0,
          conversation,
        );
        if (conversation.messages.length > 0) {
          this.hydratedConversationIds.add(id);
        }
        this.invalidateConversation(id);
        await this.replayDeletionSnapshot(id, deletionState);
      }
      throw error;
    }
  }

  async retryDeletedConversationCleanup(id: string): Promise<void> {
    if (
      !this.deletedConversationIds.has(id)
      && !await this.persistence.isDeleted(id)
    ) {
      return;
    }
    this.deletedConversationIds.add(id);
    this.deletingConversationIds.delete(id);
    await this.enqueuePersistence(
      id,
      () => this.finalizeDeletedConversation(id),
    );
  }

  async handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'> {
    const conversation = this.getSync(id);
    if (!conversation) return 'not_found';

    const historyService = ProviderRegistry.getConversationHistoryService(
      conversation.providerId,
    );
    if (!historyService.resolveMissingConversationSession) return 'preserved';

    const previousSessionId = conversation.sessionId;
    const previousProviderState = conversation.providerState;
    const previousResumeAtMessageId = conversation.resumeAtMessageId;
    const vaultPath = this.deps.getVaultPath();
    let resolution: 'delete' | 'reset' | 'preserve';
    try {
      resolution = await historyService.resolveMissingConversationSession(
        conversation,
        vaultPath,
        missingProviderSessionId,
        this.getHistoryPathContext(conversation.providerId, vaultPath),
      );
    } catch {
      conversation.sessionId = previousSessionId;
      conversation.providerState = previousProviderState;
      conversation.resumeAtMessageId = previousResumeAtMessageId;
      return 'preserved';
    }
    if (resolution === 'delete') {
      await this.delete(id);
      return 'deleted';
    }
    if (resolution === 'reset') {
      await this.save(conversation);
      return 'reset';
    }
    return 'preserved';
  }

  async rename(id: string, title: string): Promise<void> {
    const conversation = this.getSync(id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();
    await this.save(conversation);
  }

  async update(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.getSync(id);
    if (!conversation) return;

    const safeUpdates = { ...updates };
    delete safeUpdates.providerId;
    if ('selectedModel' in safeUpdates) {
      const selectedModel = normalizeProviderModelSelection(
        conversation.providerId,
        this.deps.getSettings(),
        safeUpdates.selectedModel,
      );
      if (selectedModel) {
        safeUpdates.selectedModel = selectedModel;
      } else {
        delete safeUpdates.selectedModel;
      }
    }
    Object.assign(conversation, safeUpdates, { updatedAt: Date.now() });
    if (
      'sessionId' in safeUpdates
      || 'providerState' in safeUpdates
      || 'resumeAtMessageId' in safeUpdates
    ) {
      this.hydratedConversationIds.delete(id);
      this.invalidateConversation(id);
    }
    await this.save(conversation);
  }

  async persistConversations(
    conversations: readonly Conversation[],
  ): Promise<void> {
    await Promise.all(
      conversations.map((conversation) => this.save(conversation)),
    );
  }

  registerExecutionBinding(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
  ): void {
    const conversation = this.getSync(conversationId);
    if (!conversation) return;
    this.executionBindings.set(conversationId, {
      bindingId,
      providerId: conversation.providerId,
      providerGeneration,
      closed: false,
      latestSnapshot: null,
      lastPersistedRevision: -1,
    });
  }

  persistExecutionSnapshot(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
    snapshot: ProviderSessionSnapshot,
  ): Promise<boolean> {
    const binding = this.executionBindings.get(conversationId);
    const conversation = this.getSync(conversationId);
    const deletionState = this.deletionStates.get(conversationId);
    const isTransientDeletionBinding = (
      !conversation
      && this.deletingConversationIds.has(conversationId)
      && deletionState?.executionBinding === binding
    );
    if (
      !binding
      || (!conversation && !isTransientDeletionBinding)
      || binding.bindingId !== bindingId
      || binding.providerGeneration !== providerGeneration
      || binding.closed
      || snapshot.providerId !== binding.providerId
      || snapshot.revision < (binding.latestSnapshot?.revision ?? -1)
      || snapshot.revision <= binding.lastPersistedRevision
    ) {
      return Promise.resolve(false);
    }
    if (
      !binding.latestSnapshot
      || snapshot.revision > binding.latestSnapshot.revision
    ) {
      binding.latestSnapshot = snapshot;
    }

    if (!conversation) {
      return Promise.resolve(false);
    }

    return this.persistLatestExecutionSnapshot(conversationId, binding);
  }

  private persistLatestExecutionSnapshot(
    conversationId: string,
    binding: ExecutionBindingState,
  ): Promise<boolean> {
    return this.enqueuePersistence(conversationId, async () => {
      if (
        this.executionBindings.get(conversationId) !== binding
        || !binding.latestSnapshot
        || binding.latestSnapshot.revision <= binding.lastPersistedRevision
      ) {
        return false;
      }
      const current = this.getSync(conversationId);
      if (!current || !await this.canWriteConversation(current)) {
        return false;
      }
      if (
        this.executionBindings.get(conversationId) !== binding
        || !binding.latestSnapshot
        || binding.latestSnapshot.revision <= binding.lastPersistedRevision
      ) {
        return false;
      }

      const latest = binding.latestSnapshot;
      this.applySnapshot(current, latest);
      await this.persistence.saveMetadata(this.toSessionMetadata(current));
      binding.lastPersistedRevision = latest.revision;
      return true;
    });
  }

  private replayDeletionSnapshot(
    conversationId: string,
    deletionState: ConversationDeletionState,
  ): Promise<boolean> {
    const binding = deletionState.executionBinding;
    if (
      !binding
      || binding.closed
      || this.executionBindings.get(conversationId) !== binding
      || this.getSync(conversationId) !== deletionState.conversation
      || !binding.latestSnapshot
      || binding.latestSnapshot.revision <= binding.lastPersistedRevision
    ) {
      return Promise.resolve(false);
    }
    return this.persistExecutionSnapshot(
      conversationId,
      binding.bindingId,
      binding.providerGeneration,
      binding.latestSnapshot,
    );
  }

  releaseExecutionBinding(
    conversationId: string,
    bindingId: string,
  ): void {
    const binding = this.executionBindings.get(conversationId);
    if (binding?.bindingId === bindingId) {
      binding.closed = true;
    }
  }

  async stageConversationInput(
    conversationId: string,
    record: ConversationInputRecord,
  ): Promise<void> {
    const ledger = await this.requireInputLedger(conversationId);
    await this.enqueuePersistence(conversationId, async () => {
      if (!await this.canWriteLedger(conversationId, ledger)) {
        throw new ConversationInputStageRejectedError(conversationId);
      }
      const existing = ledger.records.find(({ id }) => id === record.id);
      let insertedRecord: ConversationInputRecord | null = null;
      if (!existing) {
        insertedRecord = cloneJson(record);
        ledger.records.push(insertedRecord);
      }
      try {
        await this.persistence.saveInputLedger(conversationId, ledger);
      } catch (error) {
        if (insertedRecord) {
          const insertedIndex = ledger.records.indexOf(insertedRecord);
          if (insertedIndex !== -1) {
            ledger.records.splice(insertedIndex, 1);
          }
        }
        throw error;
      }
    });
  }

  async acceptConversationInput(
    conversationId: string,
    recordId: string,
    nativeIds: {
      providerUserMessageId?: string;
      providerAssistantMessageId?: string;
    } = {},
  ): Promise<void> {
    const ledger = await this.requireInputLedger(conversationId);
    const record = ledger.records.find(({ id }) => id === recordId);
    if (!record) {
      throw new Error(`Conversation input record not found: ${recordId}`);
    }
    record.state = 'accepted';
    if (nativeIds.providerUserMessageId !== undefined) {
      record.providerUserMessageId = nativeIds.providerUserMessageId;
    }
    if (nativeIds.providerAssistantMessageId !== undefined) {
      record.providerAssistantMessageId = nativeIds.providerAssistantMessageId;
    }
    const conversation = this.getSync(conversationId);
    if (conversation) {
      this.attachRecordToInMemoryMessages(conversation, record);
      conversation.updatedAt = Date.now();
    }

    await this.enqueuePersistence(conversationId, async () => {
      if (!await this.canWriteLedger(conversationId, ledger)) return;
      await this.persistence.saveInputLedger(conversationId, ledger);
      const current = this.getSync(conversationId);
      if (current && await this.canWriteConversation(current)) {
        await this.persistence.saveMetadata(this.toSessionMetadata(current));
      }
    });
  }

  async discardStagedConversationInput(
    conversationId: string,
    recordId: string,
  ): Promise<void> {
    const ledger = await this.requireInputLedger(conversationId);
    const index = ledger.records.findIndex(({ id }) => id === recordId);
    if (index === -1 || ledger.records[index].state !== 'staged') return;
    ledger.records.splice(index, 1);
    await this.persistLedgerOnly(conversationId, ledger);
  }

  async getConversationInputLedger(
    conversationId: string,
  ): Promise<ConversationInputLedger | null> {
    const state = await this.loadInputLedger(conversationId);
    return state.status === 'loaded' ? cloneJson(state.ledger) : null;
  }

  async copyConversationInputsForFork(
    sourceConversationId: string,
    targetConversationId: string,
    throughAssistantCheckpointId?: string,
  ): Promise<void> {
    const source = await this.requireInputLedger(sourceConversationId);
    let records = source.records;
    if (throughAssistantCheckpointId !== undefined) {
      const checkpointIndex = records.findIndex(
        ({ providerAssistantMessageId }) =>
          providerAssistantMessageId === throughAssistantCheckpointId,
      );
      records = checkpointIndex === -1 ? [] : records.slice(0, checkpointIndex + 1);
    }
    const target = await this.requireInputLedger(targetConversationId);
    target.records = cloneJson(records);
    await this.persistLedgerOnly(targetConversationId, target);
  }

  async truncateConversationInputsFrom(
    conversationId: string,
    inputIdentity: string,
  ): Promise<void> {
    const ledger = await this.requireInputLedger(conversationId);
    const index = ledger.records.findIndex(
      (record) =>
        record.id === inputIdentity
        || record.localMessageId === inputIdentity
        || record.providerUserMessageId === inputIdentity,
    );
    if (index === -1) return;
    ledger.records.splice(index);
    await this.persistLedgerOnly(conversationId, ledger);
  }

  async flushPersistence(conversationId: string): Promise<void> {
    await this.persistenceQueues.get(conversationId);
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.ensureHydrated(id);
  }

  getCachedConversation(id: string): Conversation | null {
    return this.getSync(id);
  }

  getMetadata(id: string): ConversationMeta | null {
    const conversation = this.getSync(id);
    if (!conversation) {
      return null;
    }
    return {
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      messageCount: conversation.messages.length,
      preview: this.getPreview(conversation),
      titleGenerationStatus: conversation.titleGenerationStatus,
    };
  }

  async ensureHydrated(id: string): Promise<Conversation | null> {
    const conversation = this.getSync(id);
    if (!conversation) {
      return null;
    }

    const existing = this.hydrationPromises.get(id);
    if (existing) {
      return existing;
    }

    const generation = this.getConversationGeneration(id);
    const promise = this.hydratedConversationIds.has(id)
      ? this.reconcileHydratedConversation(conversation, generation)
      : this.hydrateConversation(id, generation);
    this.hydrationPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.hydrationPromises.get(id) === promise) {
        this.hydrationPromises.delete(id);
      }
    }
  }

  private async reconcileHydratedConversation(
    conversation: Conversation,
    generation: number,
  ): Promise<Conversation | null> {
    await this.ensureSelectedModel(conversation);
    if (!this.isConversationCurrent(conversation, generation)) return null;
    await this.hydrateInputLedger(conversation);
    return this.isConversationCurrent(conversation, generation)
      ? conversation
      : null;
  }

  private async hydrateConversation(
    id: string,
    generation: number,
  ): Promise<Conversation | null> {
    const conversation = this.getSync(id);
    if (!conversation) {
      return null;
    }

    await this.reconcileProviderSession(conversation);
    if (!this.isConversationCurrent(conversation, generation)) return null;
    await this.ensureSelectedModel(conversation);
    if (!this.isConversationCurrent(conversation, generation)) return null;
    await this.hydrateProviderHistory(conversation);
    if (!this.isConversationCurrent(conversation, generation)) return null;
    await this.hydrateInputLedger(conversation);
    if (!this.isConversationCurrent(conversation, generation)) return null;
    this.hydratedConversationIds.add(id);
    return conversation;
  }

  getSync(id: string): Conversation | null {
    return this.conversations.find(
      (conversation) => conversation.id === id,
    ) ?? null;
  }

  findEmpty(): Conversation | null {
    return this.conversations.find(
      (conversation) => conversation.messages.length === 0,
    ) ?? null;
  }

  list(): ConversationMeta[] {
    return this.conversations.map((conversation) => ({
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      messageCount: conversation.messages.length,
      preview: this.getPreview(conversation),
      titleGenerationStatus: conversation.titleGenerationStatus,
    }));
  }

  private async reconcileProviderSession(
    conversation: Conversation,
  ): Promise<void> {
    const historyService = ProviderRegistry.getConversationHistoryService(
      conversation.providerId,
    );
    if (!historyService.getConversationSessionAvailability) return;

    const vaultPath = this.deps.getVaultPath();
    const pathContext = this.getHistoryPathContext(
      conversation.providerId,
      vaultPath,
    );
    let availability;
    try {
      availability =
        await historyService.getConversationSessionAvailability(
          conversation,
          vaultPath,
          pathContext,
        );
    } catch {
      return;
    }
    if (
      availability !== 'relocated'
      || !historyService.prepareRelocatedConversationSession
    ) {
      return;
    }

    const previousSessionId = conversation.sessionId;
    const previousProviderState = conversation.providerState;
    const previousResumeAtMessageId = conversation.resumeAtMessageId;
    try {
      if (
        await historyService.prepareRelocatedConversationSession(
          conversation,
          vaultPath,
          pathContext,
        )
      ) {
        await this.save(conversation);
      }
    } catch {
      conversation.sessionId = previousSessionId;
      conversation.providerState = previousProviderState;
      conversation.resumeAtMessageId = previousResumeAtMessageId;
    }
  }

  private async ensureSelectedModel(
    conversation: Conversation,
  ): Promise<void> {
    const resolved = resolveConversationModel(
      this.deps.getSettings(),
      conversation.providerId,
      conversation,
    );
    if (
      !resolved.shouldPersist
      || !resolved.model
      || conversation.selectedModel === resolved.model
    ) {
      return;
    }

    conversation.selectedModel = resolved.model;
    await this.save(conversation);
  }

  private async hydrateProviderHistory(
    conversation: Conversation,
  ): Promise<void> {
    const vaultPath = this.deps.getVaultPath();
    await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .hydrateConversationHistory(
        conversation,
        vaultPath,
        this.getHistoryPathContext(conversation.providerId, vaultPath),
      );
  }

  private async hydrateInputLedger(
    conversation: Conversation,
  ): Promise<void> {
    const state = await this.loadInputLedger(conversation.id);
    if (state.status !== 'loaded') return;
    const promoted = this.correlateInputLedger(conversation, state.ledger);
    if (promoted) {
      try {
        await this.persistLedgerOnly(conversation.id, state.ledger);
      } catch {
        // Native history remains usable; the accepted promotion stays dirty.
      }
    }
  }

  private async loadInputLedger(conversationId: string): Promise<LedgerState> {
    const existing = this.ledgerStates.get(conversationId);
    if (existing) return existing;
    const pending = this.ledgerLoadPromises.get(conversationId);
    if (pending) return pending;

    const load = this.persistence.loadInputLedger(conversationId).then(
      (result): LedgerState => {
        let state: LedgerState;
        if (result.status === 'loaded') {
          state = { status: 'loaded', ledger: result.ledger };
        } else if (result.status === 'missing') {
          state = {
            status: 'loaded',
            ledger: {
              schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
              conversationId,
              records: [],
            },
          };
        } else {
          state = {
            status: 'unavailable',
            reason: result.reason,
          };
        }
        this.ledgerStates.set(conversationId, state);
        return state;
      },
    );
    this.ledgerLoadPromises.set(conversationId, load);
    try {
      return await load;
    } finally {
      if (this.ledgerLoadPromises.get(conversationId) === load) {
        this.ledgerLoadPromises.delete(conversationId);
      }
    }
  }

  private async requireInputLedger(
    conversationId: string,
  ): Promise<ConversationInputLedger> {
    const conversation = this.getSync(conversationId);
    if (
      !conversation
      || this.deletedConversationIds.has(conversationId)
      || this.deletingConversationIds.has(conversationId)
    ) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    const state = await this.loadInputLedger(conversationId);
    if (state.status === 'unavailable') {
      throw new ConversationInputLedgerUnavailableError(
        conversationId,
        state.reason,
      );
    }
    return state.ledger;
  }

  private correlateInputLedger(
    conversation: Conversation,
    ledger: ConversationInputLedger,
  ): boolean {
    const usedRecordIds = new Set<string>();
    let promoted = false;
    let userTurnOrdinal = 0;
    for (
      let messageIndex = 0;
      messageIndex < conversation.messages.length;
      messageIndex += 1
    ) {
      const message = conversation.messages[messageIndex];
      if (!isCanonicalUserMessage(message)) continue;
      userTurnOrdinal += 1;

      let candidates: ConversationInputRecord[] = [];
      if (message.userMessageId) {
        candidates = ledger.records.filter(
          (record) =>
            record.providerUserMessageId === message.userMessageId
            && !usedRecordIds.has(record.id),
        );
      }
      if (candidates.length === 0) {
        const visibleText = message.displayContent
          ?? extractUserDisplayContent(message.content)
          ?? message.content;
        const digest = computeConversationInputDigest({
          visibleText,
          images: message.images ?? [],
        });
        candidates = ledger.records.filter(
          (record) =>
            record.userTurnOrdinal === userTurnOrdinal
            && record.contentDigest === digest
            && !usedRecordIds.has(record.id),
        );
      }
      if (candidates.length !== 1) continue;

      const record = candidates[0];
      usedRecordIds.add(record.id);
      if (
        message.userMessageId
        && record.providerUserMessageId !== message.userMessageId
      ) {
        record.providerUserMessageId = message.userMessageId;
        promoted = true;
      }
      if (!record.providerAssistantMessageId) {
        const assistant = findAssistantForCanonicalUserTurn(
          conversation.messages,
          messageIndex,
        );
        if (assistant?.assistantMessageId) {
          record.providerAssistantMessageId = assistant.assistantMessageId;
          promoted = true;
        }
      }
      this.attachRecordToMessage(message, record);
      if (record.state === 'staged') {
        record.state = 'accepted';
        promoted = true;
      }
    }
    return promoted;
  }

  private attachRecordToInMemoryMessages(
    conversation: Conversation,
    record: ConversationInputRecord,
  ): void {
    const userIndex = conversation.messages.findIndex(
      (message) =>
        message.role === 'user'
        && (
          message.id === record.localMessageId
          || message.userMessageId === record.providerUserMessageId
        ),
    );
    if (userIndex === -1) return;
    const userMessage = conversation.messages[userIndex];
    this.attachRecordToMessage(userMessage, record);
    if (record.providerUserMessageId) {
      userMessage.userMessageId = record.providerUserMessageId;
    }
    if (record.providerAssistantMessageId) {
      const assistant = findAssistantForCanonicalUserTurn(
        conversation.messages,
        userIndex,
      );
      if (assistant) {
        assistant.assistantMessageId = record.providerAssistantMessageId;
      }
    }
  }

  private attachRecordToMessage(
    message: ChatMessage,
    record: ConversationInputRecord,
  ): void {
    message.displayContent = record.rawDisplayText;
    message.images = cloneJson(record.images);
    message.executionInput = {
      schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
      canonicalText: record.canonicalText,
      ...(record.context ? { context: cloneJson(record.context) } : {}),
    };
  }

  private async persistLedgerOnly(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): Promise<void> {
    await this.enqueuePersistence(conversationId, async () => {
      if (!await this.canWriteLedger(conversationId, ledger)) return;
      await this.persistence.saveInputLedger(conversationId, ledger);
    });
  }

  private async canWriteLedger(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): Promise<boolean> {
    const isCurrent = (): boolean => {
      const state = this.ledgerStates.get(conversationId);
      return (
        state?.status === 'loaded'
        && state.ledger === ledger
        && !!this.getSync(conversationId)
        && !this.deletedConversationIds.has(conversationId)
        && !this.deletingConversationIds.has(conversationId)
      );
    };
    if (!isCurrent() || await this.persistence.isDeleted(conversationId)) {
      return false;
    }
    return isCurrent();
  }

  private applySnapshot(
    conversation: Conversation,
    snapshot: ProviderSessionSnapshot,
  ): void {
    if (snapshot.providerSessionId !== undefined) {
      conversation.sessionId = snapshot.providerSessionId;
    } else if (snapshot.status === 'invalidated') {
      conversation.sessionId = null;
    }
    if (
      snapshot.providerState !== undefined
      || snapshot.providerStateDeletes !== undefined
    ) {
      const retainedProviderState = { ...conversation.providerState };
      for (const key of snapshot.providerStateDeletes ?? []) {
        delete retainedProviderState[key];
      }
      const nextProviderState = {
        ...retainedProviderState,
        ...snapshot.providerState,
      };
      conversation.providerState = Object.keys(nextProviderState).length > 0
        ? nextProviderState
        : undefined;
    }
    conversation.updatedAt = Date.now();
  }

  private save(conversation: Conversation): Promise<void> {
    const generation = this.getConversationGeneration(conversation.id);
    return this.enqueuePersistence(conversation.id, async () => {
      if (
        !this.isConversationCurrent(conversation, generation)
        || !await this.canWriteConversation(conversation)
      ) {
        return;
      }
      await this.persistence.saveMetadata(this.toSessionMetadata(conversation));
    });
  }

  private async canWriteConversation(
    conversation: Conversation,
  ): Promise<boolean> {
    return (
      this.getSync(conversation.id) === conversation
      && !this.deletedConversationIds.has(conversation.id)
      && !this.deletingConversationIds.has(conversation.id)
      && !await this.persistence.isDeleted(conversation.id)
    );
  }

  private toSessionMetadata(conversation: Conversation): SessionMetadata {
    const historyService = ProviderRegistry.getConversationHistoryService(
      conversation.providerId,
    );
    const providerState = historyService.buildPersistedProviderState
      ? historyService.buildPersistedProviderState(conversation)
      : conversation.providerState;
    return {
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      titleGenerationStatus: conversation.titleGenerationStatus,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      sessionId: conversation.sessionId,
      selectedModel: conversation.selectedModel,
      providerState:
        providerState && Object.keys(providerState).length > 0
          ? providerState
          : undefined,
      currentNote: conversation.currentNote,
      externalContextPaths: conversation.externalContextPaths,
      enabledMcpServers: conversation.enabledMcpServers,
      usage: conversation.usage,
      resumeAtMessageId: conversation.resumeAtMessageId,
    };
  }

  private async cleanupDeletedConversation(id: string): Promise<void> {
    await this.persistence.deleteCurrentMetadata(id);
    await this.persistence.deleteLegacyMetadata(id);
    await this.persistence.deleteInputLedger(id);
    this.ledgerStates.delete(id);
    this.ledgerLoadPromises.delete(id);
  }

  private async finalizeDeletedConversation(id: string): Promise<void> {
    let callbackError: unknown;
    try {
      await this.deps.onConversationDeleted(id);
    } catch (error) {
      callbackError = error;
    }

    await this.cleanupDeletedConversation(id);
    if (callbackError !== undefined) {
      throw toError(callbackError);
    }
  }

  private enqueuePersistence<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.persistenceQueues.get(conversationId)
      ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(operation);
    const barrier = result.then(
      () => undefined,
      () => undefined,
    );
    this.persistenceQueues.set(conversationId, barrier);
    void barrier.finally(() => {
      if (this.persistenceQueues.get(conversationId) === barrier) {
        this.persistenceQueues.delete(conversationId);
      }
    });
    return result;
  }

  private getHistoryPathContext(
    providerId: ProviderId,
    vaultPath: string | null = this.deps.getVaultPath(),
  ): ProviderHistoryPathContext {
    const settings = this.deps.getSettings();
    return {
      environment: {
        ...process.env,
        ...getRuntimeEnvironmentVariables(settings, providerId),
      },
      hostPlatform: process.platform,
      settings,
      vaultPath,
    };
  }

  private getConversationGeneration(id: string): number {
    return this.conversationGenerations.get(id) ?? 0;
  }

  private invalidateConversation(id: string): void {
    this.conversationGenerations.set(
      id,
      this.getConversationGeneration(id) + 1,
    );
  }

  private isConversationCurrent(
    conversation: Conversation,
    generation: number,
  ): boolean {
    return (
      this.getSync(conversation.id) === conversation
      && this.getConversationGeneration(conversation.id) === generation
    );
  }

  private generateId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private getPreview(conversation: Conversation): string {
    const firstUserMessage = conversation.messages.find(
      (message) => message.role === 'user',
    );
    if (!firstUserMessage) return 'New conversation';

    const previewText = firstUserMessage.displayContent
      ?? extractUserDisplayContent(firstUserMessage.content)
      ?? firstUserMessage.content;
    return (
      previewText.substring(0, 50)
      + (previewText.length > 50 ? '...' : '')
    );
  }
}

function findAssistantForCanonicalUserTurn(
  messages: readonly ChatMessage[],
  userIndex: number,
): ChatMessage | undefined {
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (isCanonicalUserMessage(message)) return undefined;
    if (message.role === 'assistant') return message;
  }
  return undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
