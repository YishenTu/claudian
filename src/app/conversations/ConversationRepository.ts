import type { ConversationPersistence } from '../../core/bootstrap/ConversationPersistenceStore';
import type {
  SessionMetadataAuthority,
  SessionMetadataReadResult,
} from '../../core/bootstrap/SessionStorage';
import type { ProviderSessionSnapshot } from '../../core/execution';
import {
  assertLinkedContentPath,
  normalizeLinkedContentPath,
} from '../../core/path/LinkedContentPath';
import {
  getConversationModelPersistenceTarget,
  normalizeProviderModelSelection,
  resolveConversationModel,
} from '../../core/providers/conversationModel';
import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../core/providers/types';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type ProviderId,
} from '../../core/providers/types';
import {
  type Conversation,
  type ConversationMeta,
  type ConversationModelRecoverySource,
  type ConversationMutablePatch,
  type SessionMetadata,
} from '../../core/types';
import { mapWithConcurrency } from '../../utils/concurrency';
import { extractUserDisplayContent } from '../../utils/context';
import { rewriteVaultPathAfterRename } from '../../utils/path';

interface ConversationRepositoryBaseDeps {
  getSettings: () => Record<string, unknown>;
  getVaultPath: () => string | null;
  onConversationDeleted: (conversationId: string) => Promise<void>;
}

export type ConversationRepositoryDeps = ConversationRepositoryBaseDeps & {
  persistence: ConversationPersistence;
};

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
  readonly generation: number;
  readonly executionBinding: ExecutionBindingState | null;
}

interface LinkedContentPathRename {
  oldPath: string;
  newPath: string;
  includeDescendants: boolean;
}

type HistoricalModelRecoveryResult =
  | 'recovered'
  | 'superseded'
  | 'unresolved';

type HistoricalModelRecovery = NonNullable<
  ProviderConversationHistoryService['recoverConversationModelSelection']
>;

const HISTORICAL_MODEL_RECOVERY_CONCURRENCY = 2;

const IMMUTABLE_CONVERSATION_PATCH_FIELDS = [
  'id',
  'providerId',
  'createdAt',
  'linkedContentPath',
] as const;

type MutableLinkedContentConversation = Omit<
  Conversation,
  'linkedContentPath'
> & {
  linkedContentPath?: string;
};

function getStoredModelSelection(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneModelRecoverySource(
  source: ConversationModelRecoverySource,
): ConversationModelRecoverySource {
  return {
    sessionId: source.sessionId,
    ...(source.providerState
      ? { providerState: { ...source.providerState } }
      : {}),
    ...(source.resumeAtMessageId
      ? { resumeAtMessageId: source.resumeAtMessageId }
      : {}),
  };
}

function getModelRecoverySource(
  conversation: Conversation,
): ConversationModelRecoverySource | null {
  if (conversation.modelRecoverySource) {
    return cloneModelRecoverySource(conversation.modelRecoverySource);
  }
  if (
    conversation.sessionId === null
    && !conversation.providerState
    && !conversation.resumeAtMessageId
  ) {
    return null;
  }
  return {
    sessionId: conversation.sessionId,
    ...(conversation.providerState
      ? { providerState: { ...conversation.providerState } }
      : {}),
    ...(conversation.resumeAtMessageId
      ? { resumeAtMessageId: conversation.resumeAtMessageId }
      : {}),
  };
}

function applyModelRecoverySource(
  conversation: Conversation,
  source: ConversationModelRecoverySource,
): Conversation {
  return {
    ...conversation,
    sessionId: source.sessionId,
    providerState: source.providerState
      ? { ...source.providerState }
      : undefined,
    resumeAtMessageId: source.resumeAtMessageId,
  };
}

export class ConversationRepository {
  private conversations: Conversation[] = [];
  private hydratedConversationIds = new Set<string>();
  private hydrationPromises = new Map<string, Promise<Conversation | null>>();
  private conversationGenerations = new Map<string, number>();
  private deletedConversationIds = new Set<string>();
  private deletingConversationIds = new Set<string>();
  private readonly persistenceQueues = new Map<string, Promise<void>>();
  private readonly executionBindings = new Map<string, ExecutionBindingState>();
  private readonly deletionStates = new Map<string, ConversationDeletionState>();
  private readonly historicalModelRecoveryPromises = new Map<
    string,
    Promise<HistoricalModelRecoveryResult>
  >();
  private readonly historicalModelRecoverySources = new Map<string, Conversation>();
  private readonly selectedModelMutationVersions = new WeakMap<Conversation, number>();
  private readonly linkedContentPathsByConversationId = new Map<
    string,
    string | undefined
  >();
  private readonly linkedContentPathRenames: LinkedContentPathRename[] = [];
  private readonly pendingLinkedContentPathCorrectionIds = new Set<string>();
  private readonly metadataTargets = new Map<string, SessionMetadataAuthority>();
  private readonly persistence: ConversationPersistence;

  constructor(private readonly deps: ConversationRepositoryDeps) {
    this.persistence = deps.persistence;
  }

  replaceAll(conversations: Conversation[]): void {
    for (const conversation of this.conversations) {
      this.#invalidateConversation(conversation.id);
    }
    for (const conversation of conversations) {
      this.#applyLinkedContentPathRenamesToHydratedConversation(conversation);
    }
    this.conversations = conversations.filter(
      ({ id }) => !this.deletedConversationIds.has(id),
    );
    this.metadataTargets.clear();
    for (const conversation of this.conversations) {
      this.metadataTargets.set(conversation.id, 'device');
    }
    this.linkedContentPathsByConversationId.clear();
    for (const conversation of this.conversations) {
      this.#captureLinkedContentIdentity(conversation);
    }
    this.hydratedConversationIds = new Set(
      this.conversations
        .filter((conversation) => conversation.messages.length > 0)
        .map(({ id }) => id),
    );
    this.hydrationPromises.clear();
    this.historicalModelRecoveryPromises.clear();
    this.historicalModelRecoverySources.clear();
    this.executionBindings.clear();
    this.deletionStates.clear();
  }

  async adoptMetadataConversations(
    entries: ReadonlyArray<{
      conversation: Conversation;
      needsMigration: SessionMetadataReadResult['needsMigration'];
      source: SessionMetadataReadResult['source'];
    }>,
  ): Promise<void> {
    for (const { conversation, source } of entries) {
      if (!this.metadataTargets.has(conversation.id)) {
        this.metadataTargets.set(conversation.id, source);
      }
    }
    const linkedContentPathCorrectedIds = new Set<string>();
    for (const { conversation } of entries) {
      const current = this.getSync(conversation.id);
      if (this.pendingLinkedContentPathCorrectionIds.has(conversation.id)) {
        linkedContentPathCorrectedIds.add(conversation.id);
      } else if (
        !current
        && this.#applyLinkedContentPathRenamesToHydratedConversation(conversation)
      ) {
        linkedContentPathCorrectedIds.add(conversation.id);
      }
    }
    const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
    for (const { conversation } of entries) {
      if (
        !this.getSync(conversation.id)
        && registeredProviderIds.has(conversation.providerId)
      ) {
        await this.#reconcileIncomingSelectedModel(conversation);
      }
    }
    const added = this.mergeMetadataConversations(
      entries.map(({ conversation }) => conversation),
      null,
    );
    const addedIds = new Set(added.map(({ id }) => id));
    const providerIds = new Set(entries
      .map(({ conversation }) => conversation.providerId)
      .filter(providerId => registeredProviderIds.has(providerId)));
    for (const providerId of providerIds) {
      await this.reconcileSelectedModels(providerId);
    }
    const migrations = entries
      .filter(
        ({ conversation, needsMigration }) =>
          (
            needsMigration
            && (addedIds.has(conversation.id) || !!this.getSync(conversation.id))
          )
          || linkedContentPathCorrectedIds.has(conversation.id),
      )
      .map(({ conversation }) => this.#enqueuePersistence(
        conversation.id,
        async () => {
          const current = this.getSync(conversation.id);
          if (!current || !await this.#canWriteConversation(current)) return;
          await this.#writeMetadata(current, {
            preserveProviderState: !this.hydratedConversationIds.has(current.id),
          });
          this.pendingLinkedContentPathCorrectionIds.delete(current.id);
        },
      ));
    await Promise.all(migrations);
  }

  mergeMetadataConversations(
    conversations: Conversation[],
    metadataTarget: SessionMetadataAuthority | ReadonlyMap<string, SessionMetadataAuthority> | null = 'device',
  ): Conversation[] {
    const existingIds = new Set(this.conversations.map(({ id }) => id));
    for (const conversation of conversations) {
      if (existingIds.has(conversation.id)) {
        this.getSync(conversation.id);
        continue;
      }
      if (this.#applyLinkedContentPathRenamesToHydratedConversation(conversation)) {
        this.pendingLinkedContentPathCorrectionIds.add(conversation.id);
      }
    }
    const added = conversations.filter(({ id }) => {
      if (existingIds.has(id) || this.deletedConversationIds.has(id) || this.deletingConversationIds.has(id)) {
        return false;
      }
      existingIds.add(id);
      return true;
    });
    if (added.length === 0) return [];

    for (const conversation of added) {
      const target = typeof metadataTarget === 'string'
        ? metadataTarget
        : metadataTarget?.get(conversation.id);
      if (target) this.metadataTargets.set(conversation.id, target);
    }

    this.conversations.push(...added);
    this.conversations.sort(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt,
    );
    for (const conversation of added) {
      this.#captureLinkedContentIdentity(conversation);
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
      this.executionBindings.delete(shell.id);
      this.linkedContentPathsByConversationId.delete(shell.id);
      this.metadataTargets.delete(shell.id);
      this.#invalidateConversation(shell.id);
    }
  }

  getAll(): Conversation[] {
    this.#restoreAllLinkedContentIdentities();
    return this.conversations;
  }

  async create(options?: {
    providerId?: ProviderId;
    sessionId?: string;
    selectedModel?: string;
    linkedContentPath?: string;
  }): Promise<Conversation> {
    const settings = this.deps.getSettings();
    const providerId = options?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    const sessionId = options?.sessionId;
    const id = sessionId ?? this.generateId();
    if (this.deletedConversationIds.has(id)) {
      throw new Error(`Conversation was deleted in this session: ${id}`);
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
      title: this.#generateDefaultTitle(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: sessionId ?? null,
      selectedModel,
      messages: [],
      linkedContentPath: options?.linkedContentPath === undefined
        ? undefined
        : assertLinkedContentPath(options.linkedContentPath),
    };

    this.metadataTargets.set(conversation.id, 'device');
    this.conversations.unshift(conversation);
    this.#captureLinkedContentIdentity(conversation);
    if (!sessionId) {
      this.hydratedConversationIds.add(conversation.id);
    }
    try {
      await this.save(conversation);
    } catch (error) {
      this.discardUnresolvedMetadataShells([conversation]);
      throw error;
    }
    return conversation;
  }

  async switchTo(id: string): Promise<Conversation | null> {
    return this.ensureHydrated(id);
  }

  async assignToCurrentDevice(id: string): Promise<boolean> {
    const conversation = this.getSync(id);
    if (!conversation) return false;

    return this.#enqueuePersistence(id, async () => {
      if (!await this.#canWriteConversation(conversation)) return false;
      const source = this.#requireMetadataTarget(id);
      if (source === 'device') return false;

      await this.#writeMetadata(conversation, {
        preserveProviderState: !this.hydratedConversationIds.has(id),
      });
      await this.persistence.assignMetadataToDevice(id);
      this.metadataTargets.set(id, 'device');
      return true;
    });
  }

  async delete(id: string): Promise<void> {
    const index = this.conversations.findIndex(
      (conversation) => conversation.id === id,
    );
    if (index === -1) {
      if (this.deletedConversationIds.has(id)) {
        await this.retryDeletedConversationCleanup(id);
      }
      return;
    }

    const conversation = this.conversations[index];
    const pendingHydration = this.hydrationPromises.get(id) ?? null;
    const deletionState: ConversationDeletionState = {
      conversation,
      generation: this.#getConversationGeneration(id),
      executionBinding: this.executionBindings.get(id) ?? null,
    };
    this.deletionStates.set(id, deletionState);
    this.deletingConversationIds.add(id);
    this.deletedConversationIds.add(id);
    this.conversations.splice(index, 1);
    this.hydratedConversationIds.delete(id);
    this.hydrationPromises.delete(id);
    this.#invalidateConversation(id);

    if (pendingHydration) {
      await Promise.allSettled([pendingHydration]);
    }

    let metadataRemoved = false;
    try {
      await this.#enqueuePersistence(id, async () => {
        const target = this.#requireMetadataTarget(id);
        await (target === 'device'
          ? this.persistence.deleteCurrentMetadata(id)
          : this.persistence.deleteCurrentMetadata(id, target));
        metadataRemoved = true;
        this.deletingConversationIds.delete(id);
        this.deletionStates.delete(id);
        this.executionBindings.delete(id);
        await this.#finalizeDeletedConversation(id);
      });
    } catch (error) {
      if (!metadataRemoved) {
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
        this.#invalidateConversation(id);
        await this.#replayDeletionSnapshot(id, deletionState);
      }
      throw error;
    }
  }

  async retryDeletedConversationCleanup(id: string): Promise<void> {
    if (!this.deletedConversationIds.has(id)) {
      return;
    }
    this.deletedConversationIds.add(id);
    this.deletingConversationIds.delete(id);
    await this.#enqueuePersistence(
      id,
      () => this.#finalizeDeletedConversation(id),
    );
  }

  async handleMissingProviderSession(
    id: string,
    missingProviderSessionId?: string,
  ): Promise<'deleted' | 'reset' | 'preserved' | 'not_found'> {
    const conversation = this.getSync(id);
    if (!conversation) return 'not_found';
    const generation = this.#getConversationGeneration(id);

    const historyService = ProviderRegistry.getConversationHistoryService(
      conversation.providerId,
    );
    if (!historyService.resolveMissingConversationSession) return 'preserved';

    const vaultPath = this.deps.getVaultPath();
    let resolution: 'delete' | 'reset' | 'preserve';
    let nativeReadCompleted = false;
    try {
      const outcome = await this.#readProviderHistory(conversation, async draft => {
        const result = await historyService.resolveMissingConversationSession!(
          draft,
          vaultPath,
          missingProviderSessionId,
          this.#getHistoryPathContext(draft.providerId, vaultPath),
        );
        nativeReadCompleted = true;
        return result;
      }, value => value === 'reset');
      if (!outcome.current) return 'preserved';
      resolution = outcome.value;
    } catch (error) {
      // Native inspection is best effort; a failed durable transition must surface.
      if (nativeReadCompleted) throw error;
      return 'preserved';
    }
    // Acceptance can supersede the native decision before this await continuation.
    if (!this.#isConversationCurrent(conversation, generation)) return 'preserved';
    if (resolution === 'delete') {
      await this.delete(id);
      return 'deleted';
    }
    if (resolution === 'reset') {
      this.hydratedConversationIds.delete(id);
      this.#invalidateConversation(id);
      return 'reset';
    }
    return 'preserved';
  }

  async rename(id: string, title: string): Promise<void> {
    await this.#mutateMetadata(id, () => ({
      title: title.trim() || this.#generateDefaultTitle(),
    }));
  }

  async update(id: string, updates: ConversationMutablePatch): Promise<void> {
    const attemptedImmutableFields = IMMUTABLE_CONVERSATION_PATCH_FIELDS.filter(
      field => Object.prototype.hasOwnProperty.call(updates, field),
    );
    if (attemptedImmutableFields.length > 0) {
      throw new Error(
        `Conversation update cannot change immutable fields: ${attemptedImmutableFields.join(', ')}`,
      );
    }
    const conversation = this.getSync(id);
    if (!conversation) return;
    const safeUpdates = { ...updates };
    if ('selectedModel' in safeUpdates) {
      const selectedModel = normalizeProviderModelSelection(
        conversation.providerId,
        this.deps.getSettings(),
        safeUpdates.selectedModel,
      );
      if (selectedModel) {
        safeUpdates.selectedModel = selectedModel;
        // Explicit intent supersedes pending automatic model recovery immediately.
        this.#markSelectedModelMutation(conversation);
      } else {
        delete safeUpdates.selectedModel;
      }
    }
    if ('sessionId' in safeUpdates || 'providerState' in safeUpdates || 'resumeAtMessageId' in safeUpdates) {
      // Fence native reads as soon as a replacement binding is accepted.
      this.hydratedConversationIds.delete(id);
      this.#invalidateConversation(id);
    }
    await this.#mutateMetadata(id, () => safeUpdates);
  }

  async setPinned(id: string, isPinned: boolean): Promise<void> {
    await this.#mutateMetadata(id, conversation => (
      (isPinned && conversation.isArchived) || conversation.isPinned === isPinned
        ? null
        : { isPinned }
    ));
  }

  async setArchived(id: string, isArchived: boolean): Promise<void> {
    await this.#mutateMetadata(id, conversation => (
      conversation.isArchived === isArchived && (!isArchived || conversation.isPinned === false)
        ? null
        : { isArchived, ...(isArchived ? { isPinned: false } : {}) }
    ));
  }

  /** Serializes a metadata decision through persistence and committed publication. */
  #mutateMetadata(
    id: string,
    createPatch: (conversation: Conversation) => ConversationMutablePatch | null,
  ): Promise<void> {
    const conversation = this.getSync(id);
    if (!conversation) return Promise.resolve();
    const generation = this.#getConversationGeneration(id);
    return this.#enqueuePersistence(id, async () => {
      if (!await this.#canWriteConversation(conversation)) return;
      const patch = createPatch(conversation);
      if (!patch) return;
      const discardSupersededSessionFields = (): void => {
        const deletion = this.deletionStates.get(id);
        if (
          this.#getConversationGeneration(id) === generation
          || (deletion?.conversation === conversation && deletion.generation === generation)
        ) return;
        delete patch.sessionId;
        delete patch.providerState;
        delete patch.resumeAtMessageId;
        delete patch.messages;
      };
      discardSupersededSessionFields();
      await this.#writeMetadata({ ...conversation, ...patch });
      if (!this.#isConversationRetained(conversation)) return;
      // Session invalidation cannot cancel an unrelated committed title or pin edit.
      discardSupersededSessionFields();
      Object.assign(conversation, patch);
      if ('sessionId' in patch || 'providerState' in patch || 'resumeAtMessageId' in patch) {
        this.hydratedConversationIds.delete(id);
        this.#invalidateConversation(id);
      }
    });
  }

  invalidateProviderSessions(providerIds: ProviderId[]): Conversation[] {
    if (providerIds.length === 0) return [];
    const providers = new Set(providerIds);
    const drafts = this.conversations
      .filter(conversation => providers.has(conversation.providerId))
      .map(conversation => cloneJSON(conversation));
    const invalidated = ProviderSettingsCoordinator.invalidateConversationSessions(drafts, providerIds);
    return invalidated.flatMap(draft => {
      const conversation = this.getSync(draft.id);
      if (!conversation) return [];
      conversation.sessionId = draft.sessionId;
      conversation.providerState = draft.providerState;
      conversation.resumeAtMessageId = draft.resumeAtMessageId;
      this.hydratedConversationIds.delete(conversation.id);
      this.#invalidateConversation(conversation.id);
      return [conversation];
    });
  }

  async persistProviderSessionInvalidations(providerIds: ProviderId[]): Promise<void> {
    const providers = new Set(providerIds);
    await this.persistConversations(this.conversations.filter(conversation => providers.has(conversation.providerId)));
  }

  async persistConversations(
    conversations: readonly Conversation[],
  ): Promise<void> {
    await Promise.all(
      conversations.map((conversation) => this.save(conversation)),
    );
  }

  registerHistoricalModelRecoverySources(
    conversations: readonly Conversation[],
  ): void {
    for (const source of conversations) {
      const target = this.getSync(source.id);
      if (
        !target
        || getStoredModelSelection(target.selectedModel)
        || getStoredModelSelection(source.selectedModel)
        || this.historicalModelRecoverySources.has(source.id)
      ) {
        continue;
      }
      const recoverySource = getModelRecoverySource(source)
        ?? getModelRecoverySource(target);
      if (!recoverySource) continue;

      target.modelRecoverySource ??= cloneModelRecoverySource(recoverySource);
      this.historicalModelRecoverySources.set(
        source.id,
        applyModelRecoverySource(source, recoverySource),
      );
    }
  }

  async recoverMissingSelectedModels(): Promise<Conversation[]> {
    const candidates = this.conversations.filter(conversation => (
      !getStoredModelSelection(conversation.selectedModel)
    ));
    const recovered = await mapWithConcurrency(
      candidates,
      async (conversation): Promise<Conversation | null> => {
        const recovery = this.#recoverHistoricalModelSelection(conversation);
        if (!recovery) return null;
        const result = await recovery;
        return result === 'recovered' && this.getSync(conversation.id) === conversation
          ? conversation
          : null;
      },
      HISTORICAL_MODEL_RECOVERY_CONCURRENCY,
    );
    return recovered.filter(
      (conversation): conversation is Conversation => conversation !== null,
    );
  }

  #recoverHistoricalModelSelection(
    conversation: Conversation,
  ): Promise<HistoricalModelRecoveryResult> | null {
    if (getStoredModelSelection(conversation.selectedModel)) {
      return null;
    }

    const existing = this.historicalModelRecoveryPromises.get(conversation.id);
    if (existing) return existing;

    const persistedRecoverySource = conversation.modelRecoverySource
      ? cloneModelRecoverySource(conversation.modelRecoverySource)
      : null;
    const recoverySource = this.historicalModelRecoverySources.get(conversation.id)
      ?? (persistedRecoverySource
        ? applyModelRecoverySource(conversation, persistedRecoverySource)
        : conversation);
    let recoverModelSelection: HistoricalModelRecovery | undefined;
    try {
      const historyService = ProviderRegistry.getConversationHistoryService(
        recoverySource.providerId,
      );
      if (historyService.hasConversationModelRecoverySource?.(recoverySource) === false) {
        return null;
      }
      recoverModelSelection = historyService.recoverConversationModelSelection
        ?.bind(historyService);
    } catch {
      return null;
    }
    if (!recoverModelSelection) return null;

    const generation = this.#getConversationGeneration(conversation.id);
    const recovery = this.#runHistoricalModelRecovery(
      conversation,
      generation,
      recoverModelSelection,
      recoverySource,
    );
    this.historicalModelRecoveryPromises.set(conversation.id, recovery);
    return recovery;
  }

  async #runHistoricalModelRecovery(
    conversation: Conversation,
    generation: number,
    recoverModelSelection: HistoricalModelRecovery,
    recoverySource: Conversation,
  ): Promise<HistoricalModelRecoveryResult> {
    const mutationVersion = this.#getSelectedModelMutationVersion(conversation);
    let selectedModel: string | null;
    try {
      const vaultPath = this.deps.getVaultPath();
      selectedModel = (await recoverModelSelection(
        recoverySource,
        vaultPath,
        this.#getHistoryPathContext(recoverySource.providerId, vaultPath),
      ))?.trim() || null;
    } catch {
      return 'unresolved';
    }
    if (!selectedModel) return 'unresolved';
    if (
      !this.#isConversationCurrent(conversation, generation)
      || this.#getSelectedModelMutationVersion(conversation) !== mutationVersion
      || getStoredModelSelection(conversation.selectedModel)
    ) {
      return 'superseded';
    }

    const resolvedRecoveredModel = resolveConversationModel(
      this.deps.getSettings(),
      conversation.providerId,
      { ...conversation, selectedModel },
    );
    const recoveredModelToPersist = getConversationModelPersistenceTarget(
      resolvedRecoveredModel,
    );
    selectedModel = recoveredModelToPersist || selectedModel;

    let didPersist: boolean;
    try {
      didPersist = await this.#persistSelectedModelBeforePublish(
        conversation,
        selectedModel,
        true,
      );
    } catch {
      return 'unresolved';
    }
    if (
      didPersist
      &&
      this.#isConversationCurrent(conversation, generation)
      && conversation.selectedModel === selectedModel
    ) {
      this.historicalModelRecoverySources.delete(conversation.id);
      return 'recovered';
    }
    return 'superseded';
  }

  async rewriteLinkedContentPaths(
    oldPath: string,
    newPath: string,
    options: { includeDescendants?: boolean } = {},
  ): Promise<void> {
    const normalizedOldPath = normalizeLinkedContentPath(oldPath);
    const normalizedNewPath = normalizeLinkedContentPath(newPath);
    if (
      normalizedOldPath === null
      || normalizedNewPath === null
      || normalizedOldPath === normalizedNewPath
    ) {
      return;
    }

    const rename: LinkedContentPathRename = {
      oldPath: normalizedOldPath,
      newPath: normalizedNewPath,
      includeDescendants: options.includeDescendants ?? false,
    };
    this.linkedContentPathRenames.push(rename);
    const changed = this.conversations.filter(conversation => (
      this.#applyLinkedContentPathRename(conversation, rename)
    ));
    await this.persistConversations(changed);
  }

  registerExecutionBinding(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
  ): void {
    const conversation = this.getSync(conversationId);
    if (!conversation) throw new Error(`Conversation is no longer available: ${conversationId}`);
    const existing = this.executionBindings.get(conversationId);
    if (existing && !existing.closed) {
      if (existing.bindingId === bindingId && existing.providerGeneration === providerGeneration) return;
      throw new Error('This conversation already has an active execution owner in another tab.');
    }
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

    return this.#persistLatestExecutionSnapshot(conversationId, binding);
  }

  #persistLatestExecutionSnapshot(
    conversationId: string,
    binding: ExecutionBindingState,
  ): Promise<boolean> {
    return this.#enqueuePersistence(conversationId, async () => {
      if (
        this.executionBindings.get(conversationId) !== binding
        || !binding.latestSnapshot
        || binding.latestSnapshot.revision <= binding.lastPersistedRevision
      ) {
        return false;
      }
      const current = this.getSync(conversationId);
      if (!current || !await this.#canWriteConversation(current)) {
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
      this.#applySnapshot(current, latest);
      await this.#writeMetadata(current);
      binding.lastPersistedRevision = latest.revision;
      return true;
    });
  }

  #replayDeletionSnapshot(
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

  async assertConversationExecutionAuthority(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
  ): Promise<void> {
    const conversation = this.getSync(conversationId);
    const binding = this.executionBindings.get(conversationId);
    if (!conversation || !await this.#canWriteConversation(conversation)
      || this.getSync(conversationId) !== conversation
      || !binding || binding.closed
      || binding.bindingId !== bindingId || binding.providerGeneration !== providerGeneration
      || this.executionBindings.get(conversationId) !== binding) {
      throw new Error(`Conversation is no longer available: ${conversationId}`);
    }
  }

  async recordConversationActivity(conversationId: string, timestamp: number): Promise<void> {
    const conversation = this.getSync(conversationId);
    if (!conversation) return;
    conversation.lastActivityAt = Math.max(conversation.lastActivityAt, timestamp);
    await this.save(conversation);
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.ensureHydrated(id);
  }

  getCachedConversation(id: string): Conversation | null {
    return this.getSync(id);
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

    const generation = this.#getConversationGeneration(id);
    const promise = this.hydratedConversationIds.has(id)
      ? this.#reconcileHydratedConversation(conversation, generation)
      : this.#hydrateConversation(id, generation);
    this.hydrationPromises.set(id, promise);
    try {
      return await promise;
    } finally {
      if (this.hydrationPromises.get(id) === promise) {
        this.hydrationPromises.delete(id);
      }
    }
  }

  async #reconcileHydratedConversation(
    conversation: Conversation,
    generation: number,
  ): Promise<Conversation | null> {
    await this.ensureSelectedModel(conversation);
    if (!this.#isConversationCurrent(conversation, generation)) return null;
    return this.#isConversationCurrent(conversation, generation)
      ? conversation
      : null;
  }

  async #hydrateConversation(
    id: string,
    generation: number,
  ): Promise<Conversation | null> {
    const conversation = this.getSync(id);
    if (!conversation) {
      return null;
    }

    if (!await this.#reconcileProviderSession(conversation)) return null;
    if (!this.#isConversationCurrent(conversation, generation)) return null;
    await this.ensureSelectedModel(conversation);
    if (!this.#isConversationCurrent(conversation, generation)) return null;
    if (!await this.#hydrateProviderHistory(conversation)) return null;
    if (!this.#isConversationCurrent(conversation, generation)) return null;
    if (!this.#isConversationCurrent(conversation, generation)) return null;
    this.hydratedConversationIds.add(id);
    return conversation;
  }

  getSync(id: string): Conversation | null {
    const conversation = this.conversations.find(
      (conversation) => conversation.id === id,
    ) ?? null;
    if (conversation) {
      this.#restoreLinkedContentIdentity(conversation);
    }
    return conversation;
  }

  list(): ConversationMeta[] {
    this.#restoreAllLinkedContentIdentities();
    return this.conversations.map((conversation) => ({
      id: conversation.id,
      providerId: conversation.providerId,
      selectedModel: conversation.selectedModel,
      title: conversation.title,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
      messageCount: conversation.messages.length,
      preview: this.#getPreview(conversation),
      linkedContentPath: conversation.linkedContentPath,
      isPinned: conversation.isPinned,
      isArchived: conversation.isArchived,
      titleGenerationStatus: conversation.titleGenerationStatus,
      isLegacySession: this.#isLegacyMetadataTarget(conversation.id),
    }));
  }

  isSelectedModelPublicationSafe(conversation: Conversation): boolean {
    const storedModel = getStoredModelSelection(conversation.selectedModel);
    if (
      !storedModel
      || !ProviderRegistry.getRegisteredProviderIds().includes(conversation.providerId)
    ) {
      return true;
    }

    const resolved = resolveConversationModel(
      this.deps.getSettings(),
      conversation.providerId,
      conversation,
    );
    const modelToPersist = getConversationModelPersistenceTarget(resolved);
    return !(
      resolved.shouldPersist
      && modelToPersist
      && modelToPersist !== storedModel
    );
  }

  async reconcileSelectedModels(providerId: ProviderId): Promise<Conversation[]> {
    const changed: Conversation[] = [];
    for (const conversation of this.conversations) {
      if (
        conversation.providerId !== providerId
        || !getStoredModelSelection(conversation.selectedModel)
      ) {
        continue;
      }

      const previousModel = conversation.selectedModel;
      await this.ensureSelectedModel(conversation);
      if (conversation.selectedModel !== previousModel) {
        changed.push(conversation);
      }
    }
    return changed;
  }

  #applyLinkedContentPathRenamesToHydratedConversation(
    conversation: Conversation,
  ): boolean {
    const originalPath = conversation.linkedContentPath;
    let currentPath = normalizeLinkedContentPath(originalPath) ?? undefined;
    for (const rename of this.linkedContentPathRenames) {
      if (!currentPath) break;
      currentPath = this.#rewriteLinkedContentPath(currentPath, rename) ?? currentPath;
    }
    if (currentPath === originalPath) return false;

    this.#assignLinkedContentPath(conversation, currentPath);
    return true;
  }

  #applyLinkedContentPathRename(
    conversation: Conversation,
    rename: LinkedContentPathRename,
  ): boolean {
    const currentPath = this.#getAuthoritativeLinkedContentPath(conversation);
    if (!currentPath) return false;
    const rewrittenPath = this.#rewriteLinkedContentPath(currentPath, rename);
    if (!rewrittenPath || rewrittenPath === currentPath) return false;

    this.#setLinkedContentIdentity(conversation, rewrittenPath);
    return true;
  }

  #rewriteLinkedContentPath(
    contentPath: string,
    rename: LinkedContentPathRename,
  ): string | null {
    return rewriteVaultPathAfterRename(
      contentPath,
      rename.oldPath,
      rename.newPath,
      rename.includeDescendants,
    );
  }

  #captureLinkedContentIdentity(conversation: Conversation): void {
    const path = normalizeLinkedContentPath(conversation.linkedContentPath)
      ?? undefined;
    this.#setLinkedContentIdentity(conversation, path);
  }

  #setLinkedContentIdentity(
    conversation: Conversation,
    path: string | undefined,
  ): void {
    this.linkedContentPathsByConversationId.set(conversation.id, path);
    this.#assignLinkedContentPath(conversation, path);
  }

  #restoreLinkedContentIdentity(conversation: Conversation): void {
    if (!this.linkedContentPathsByConversationId.has(conversation.id)) return;
    this.#assignLinkedContentPath(
      conversation,
      this.linkedContentPathsByConversationId.get(conversation.id),
    );
  }

  #restoreAllLinkedContentIdentities(): void {
    for (const conversation of this.conversations) {
      this.#restoreLinkedContentIdentity(conversation);
    }
  }

  #getAuthoritativeLinkedContentPath(
    conversation: Conversation,
  ): string | undefined {
    if (this.linkedContentPathsByConversationId.has(conversation.id)) {
      const path = this.linkedContentPathsByConversationId.get(conversation.id);
      this.#assignLinkedContentPath(conversation, path);
      return path;
    }
    return normalizeLinkedContentPath(conversation.linkedContentPath) ?? undefined;
  }

  #assignLinkedContentPath(
    conversation: Conversation,
    path: string | undefined,
  ): void {
    const mutableConversation = conversation as MutableLinkedContentConversation;
    if (path === undefined) {
      delete mutableConversation.linkedContentPath;
      return;
    }
    mutableConversation.linkedContentPath = path;
  }

  async #reconcileProviderSession(
    conversation: Conversation,
  ): Promise<boolean> {
    const historyService = ProviderRegistry.getConversationHistoryService(
      conversation.providerId,
    );

    const vaultPath = this.deps.getVaultPath();
    const pathContext = this.#getHistoryPathContext(
      conversation.providerId,
      vaultPath,
    );
    if (historyService.recoverConversationSessionReference) {
      try {
        const outcome = await this.#readProviderHistory(conversation, draft => (
          historyService.recoverConversationSessionReference!(draft, vaultPath, pathContext)
        ), changed => changed);
        if (!outcome.current) return false;
      } catch {
        return true;
      }
    }

    if (!historyService.getConversationSessionAvailability) return true;
    try {
      const availability = await this.#readProviderHistory(conversation, draft => (
        historyService.getConversationSessionAvailability!(draft, vaultPath, pathContext)
      ));
      if (!availability.current) return false;
      if (
        availability.value !== 'relocated'
        || !historyService.prepareRelocatedConversationSession
      ) return true;
      const outcome = await this.#readProviderHistory(conversation, draft => (
        historyService.prepareRelocatedConversationSession!(draft, vaultPath, pathContext)
      ), changed => changed);
      return outcome.current;
    } catch {
      // Failed reads only discard their isolated draft.
      return true;
    }
  }

  private async ensureSelectedModel(
    conversation: Conversation,
  ): Promise<void> {
    const mutationVersion = this.#getSelectedModelMutationVersion(conversation);
    let recoveryResult: HistoricalModelRecoveryResult | 'unsupported' = 'unsupported';
    if (!getStoredModelSelection(conversation.selectedModel)) {
      const recovery = this.#recoverHistoricalModelSelection(conversation);
      if (recovery) recoveryResult = await recovery;
    }
    const resolved = resolveConversationModel(
      this.deps.getSettings(),
      conversation.providerId,
      conversation,
    );
    const modelToPersist = getConversationModelPersistenceTarget(resolved);
    if (
      recoveryResult === 'unresolved' && resolved.source === 'usage'
    ) {
      return;
    }
    if (
      !resolved.shouldPersist
      || !modelToPersist
      || conversation.selectedModel === modelToPersist
    ) {
      return;
    }

    if (this.#getSelectedModelMutationVersion(conversation) !== mutationVersion) return;
    await this.#persistSelectedModelBeforePublish(conversation, modelToPersist);
  }

  async #reconcileIncomingSelectedModel(conversation: Conversation): Promise<void> {
    if (
      !getStoredModelSelection(conversation.selectedModel)
    ) {
      return;
    }

    const resolved = resolveConversationModel(
      this.deps.getSettings(),
      conversation.providerId,
      conversation,
    );
    const modelToPersist = getConversationModelPersistenceTarget(resolved);
    if (
      !resolved.shouldPersist
      || !modelToPersist
      || conversation.selectedModel === modelToPersist
    ) {
      return;
    }

    const snapshot = { ...conversation, selectedModel: modelToPersist };
    const didPersist = await this.#enqueuePersistence(conversation.id, async () => {
      if (
        this.getSync(conversation.id)
        || this.deletedConversationIds.has(conversation.id)
        || this.deletingConversationIds.has(conversation.id)
      ) {
        return false;
      }
      await this.#writeMetadata(snapshot, {
        preserveProviderState: true,
      });
      return true;
    });
    if (didPersist && !this.getSync(conversation.id)) {
      conversation.selectedModel = modelToPersist;
    }
  }

  async #persistSelectedModelBeforePublish(
    conversation: Conversation,
    selectedModel: string,
    clearRecoverySource = false,
  ): Promise<boolean> {
    const previousSelectedModel = conversation.selectedModel;
    const selectedModelMutationVersion = this.#markSelectedModelMutation(conversation);
    return this.#enqueuePersistence(conversation.id, async () => {
      if (
        this.#getSelectedModelMutationVersion(conversation) !== selectedModelMutationVersion
        || !await this.#canWriteConversation(conversation)
        || this.#getSelectedModelMutationVersion(conversation) !== selectedModelMutationVersion
        || conversation.selectedModel !== previousSelectedModel
      ) {
        return false;
      }
      const snapshot = {
        ...conversation,
        selectedModel,
        ...(clearRecoverySource ? { modelRecoverySource: undefined } : {}),
      };
      await this.#writeMetadata(snapshot, {
        preserveProviderState: !this.hydratedConversationIds.has(conversation.id),
      });
      if (!this.#isConversationRetained(conversation)) return false;
      // Publish inside the same queue slot; a later explicit intent commits next.
      conversation.selectedModel = selectedModel;
      if (clearRecoverySource) {
        conversation.modelRecoverySource = undefined;
      }
      return true;
    });
  }

  #markSelectedModelMutation(conversation: Conversation): number {
    const nextVersion = this.#getSelectedModelMutationVersion(conversation) + 1;
    this.selectedModelMutationVersions.set(conversation, nextVersion);
    return nextVersion;
  }

  #getSelectedModelMutationVersion(conversation: Conversation): number {
    return this.selectedModelMutationVersions.get(conversation) ?? 0;
  }

  async #hydrateProviderHistory(
    conversation: Conversation,
  ): Promise<boolean> {
    const vaultPath = this.deps.getVaultPath();
    const outcome = await this.#readProviderHistory(conversation, draft => (
      ProviderRegistry.getConversationHistoryService(draft.providerId)
        .hydrateConversationHistory(
          draft,
          vaultPath,
          this.#getHistoryPathContext(draft.providerId, vaultPath),
        )
    ));
    return outcome.current;
  }

  /** Native readers may mutate only this detached draft; the repository publishes it. */
  async #readProviderHistory<T>(
    conversation: Conversation,
    read: (draft: Conversation) => Promise<T>,
    shouldPersist: (value: T) => boolean = () => false,
  ): Promise<{ current: false } | { current: true; value: T }> {
    const generation = this.#getConversationGeneration(conversation.id);
    // Reads must not decide against a binding whose replacement is still committing.
    const pendingWrite = this.persistenceQueues.get(conversation.id);
    if (pendingWrite) await pendingWrite;
    if (!this.#isConversationCurrent(conversation, generation)) return { current: false };
    const fields = ['sessionId', 'providerState', 'resumeAtMessageId', 'messages'] as const;
    const before = fields.map(field => JSON.stringify(conversation[field]));
    const draft = cloneJSON(conversation);
    const value = await read(draft);
    const isCurrent = (): boolean => (
      this.#isConversationCurrent(conversation, generation)
      && fields.every((field, index) => JSON.stringify(conversation[field]) === before[index])
    );
    if (!isCurrent()) return { current: false };
    const patch: ConversationMutablePatch = {};
    if (JSON.stringify(draft.messages) !== before[3]) patch.messages = draft.messages;
    if (JSON.stringify(draft.sessionId) !== before[0]) patch.sessionId = draft.sessionId;
    if (JSON.stringify(draft.providerState) !== before[1]) patch.providerState = draft.providerState;
    if (JSON.stringify(draft.resumeAtMessageId) !== before[2]) patch.resumeAtMessageId = draft.resumeAtMessageId;
    if (shouldPersist(value)) {
      const persisted = await this.#enqueuePersistence(conversation.id, async () => {
        if (!await this.#canWriteConversation(conversation) || !isCurrent()) return false;
        await this.#writeMetadata({ ...conversation, ...patch });
        return true;
      });
      if (!persisted || !isCurrent()) return { current: false };
    }
    Object.assign(conversation, patch);
    return { current: true, value };
  }

  #applySnapshot(
    conversation: Conversation,
    snapshot: ProviderSessionSnapshot,
  ): void {
    const establishesFreshProviderSession = snapshot.status !== 'invalidated'
      && typeof snapshot.providerSessionId === 'string'
      && snapshot.providerSessionId.trim().length > 0;
    if (
      establishesFreshProviderSession
      && (
        conversation.modelRecoverySource
        || this.historicalModelRecoverySources.has(conversation.id)
        || this.historicalModelRecoveryPromises.has(conversation.id)
      )
    ) {
      conversation.modelRecoverySource = undefined;
      this.#invalidateConversation(conversation.id);
    }
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
  }

  private save(conversation: Conversation): Promise<void> {
    this.#restoreLinkedContentIdentity(conversation);
    return this.#enqueuePersistence(conversation.id, async () => {
      // Flush the current projection; a binding change does not cancel its metadata.
      if (!await this.#canWriteConversation(conversation)) return;
      this.#restoreLinkedContentIdentity(conversation);
      await this.#writeMetadata(conversation);
    });
  }

  /** A committed write also belongs in the projection retained for deletion rollback. */
  #isConversationRetained(conversation: Conversation): boolean {
    return this.getSync(conversation.id) === conversation
      || this.deletionStates.get(conversation.id)?.conversation === conversation;
  }

  async #canWriteConversation(
    conversation: Conversation,
  ): Promise<boolean> {
    return (
      this.getSync(conversation.id) === conversation
      && !this.deletedConversationIds.has(conversation.id)
      && !this.deletingConversationIds.has(conversation.id)
    );
  }

  #writeMetadata(
    conversation: Conversation,
    options: { preserveProviderState?: boolean } = {},
  ): Promise<void> {
    const metadata = this.toSessionMetadata(conversation, options);
    const target = this.#requireMetadataTarget(conversation.id);
    return target === 'device'
      ? this.persistence.saveMetadata(metadata)
      : this.persistence.saveMetadata(metadata, target);
  }

  #requireMetadataTarget(conversationId: string): SessionMetadataAuthority {
    const authority = this.metadataTargets.get(conversationId);
    if (!authority) {
      throw new Error(`Conversation metadata ownership is unresolved: ${conversationId}`);
    }
    return authority;
  }

  #isLegacyMetadataTarget(conversationId: string): boolean {
    return this.metadataTargets.get(conversationId) === 'unscoped';
  }

  private toSessionMetadata(
    conversation: Conversation,
    options: { preserveProviderState?: boolean } = {},
  ): SessionMetadata {
    const linkedContentPath = this.#getAuthoritativeLinkedContentPath(conversation);
    const historyService = ProviderRegistry.getConversationHistoryService(
      conversation.providerId,
    );
    const providerState = !options.preserveProviderState
      && historyService.buildPersistedProviderState
      ? historyService.buildPersistedProviderState(conversation)
      : conversation.providerState;
    return {
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      titleGenerationStatus: conversation.titleGenerationStatus,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
      sessionId: conversation.sessionId,
      selectedModel: conversation.selectedModel,
      providerState:
        providerState && Object.keys(providerState).length > 0
          ? providerState
          : undefined,
      ...(!getStoredModelSelection(conversation.selectedModel)
        && conversation.modelRecoverySource
        ? {
            modelRecoverySource: cloneModelRecoverySource(
              conversation.modelRecoverySource,
            ),
          }
        : {}),
      linkedContentPath,
      isPinned: conversation.isPinned,
      isArchived: conversation.isArchived,
      usage: conversation.usage,
      resumeAtMessageId: conversation.resumeAtMessageId,
    };
  }

  async #finalizeDeletedConversation(id: string): Promise<void> {
    let callbackError: unknown;
    try {
      await this.deps.onConversationDeleted(id);
    } catch (error) {
      callbackError = error;
    }

    this.linkedContentPathsByConversationId.delete(id);
    if (callbackError !== undefined) {
      throw toError(callbackError);
    }
    this.metadataTargets.delete(id);
  }

  #enqueuePersistence<T>(
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

  #getHistoryPathContext(
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

  #getConversationGeneration(id: string): number {
    return this.conversationGenerations.get(id) ?? 0;
  }

  #invalidateConversation(id: string): void {
    this.historicalModelRecoveryPromises.delete(id);
    this.historicalModelRecoverySources.delete(id);
    this.conversationGenerations.set(
      id,
      this.#getConversationGeneration(id) + 1,
    );
  }

  #isConversationCurrent(
    conversation: Conversation,
    generation: number,
  ): boolean {
    return (
      this.getSync(conversation.id) === conversation
      && this.#getConversationGeneration(conversation.id) === generation
    );
  }

  private generateId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  #generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  #getPreview(conversation: Conversation): string {
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

function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
