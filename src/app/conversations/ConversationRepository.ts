import {
  computeConversationInputDigest,
  CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
  type ConversationInputLedger,
  type ConversationInputLedgerReadResult,
  type ConversationInputRecord,
} from '../../core/bootstrap/ConversationInputLedgerStorage';
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
  type ChatMessage,
  type Conversation,
  type ConversationMeta,
  type ConversationModelRecoverySource,
  type ConversationMutablePatch,
  isCanonicalUserMessage,
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

interface LoadedLedgerState {
  status: 'loaded';
  ledger: ConversationInputLedger;
  needsMigration: boolean;
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

interface LinkedContentPathRename {
  oldPath: string;
  newPath: string;
  includeDescendants: boolean;
}

interface InputLedgerCorrelationResult {
  ledgerChanged: boolean;
  lastAcceptedInputAt: number | null;
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
      this.invalidateConversation(conversation.id);
    }
    for (const conversation of conversations) {
      this.applyLinkedContentPathRenamesToHydratedConversation(conversation);
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
      this.captureLinkedContentIdentity(conversation);
    }
    this.hydratedConversationIds = new Set(
      this.conversations
        .filter((conversation) => conversation.messages.length > 0)
        .map(({ id }) => id),
    );
    this.hydrationPromises.clear();
    this.historicalModelRecoveryPromises.clear();
    this.historicalModelRecoverySources.clear();
    this.ledgerStates.clear();
    this.ledgerLoadPromises.clear();
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
      const target = source === 'legacy' ? 'unscoped' : source;
      this.metadataTargets.set(conversation.id, target);
    }
    const linkedContentPathCorrectedIds = new Set<string>();
    for (const { conversation } of entries) {
      const current = this.getSync(conversation.id);
      if (this.pendingLinkedContentPathCorrectionIds.has(conversation.id)) {
        linkedContentPathCorrectedIds.add(conversation.id);
      } else if (
        !current
        && this.applyLinkedContentPathRenamesToHydratedConversation(conversation)
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
        await this.reconcileIncomingSelectedModel(conversation);
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
        ({ conversation, needsMigration, source }) =>
          (
            (source === 'legacy' || needsMigration)
            && (addedIds.has(conversation.id) || !!this.getSync(conversation.id))
          )
          || linkedContentPathCorrectedIds.has(conversation.id),
      )
      .map(({ conversation, source }) => this.enqueuePersistence(
        conversation.id,
        async () => {
          const current = this.getSync(conversation.id);
          if (!current || !await this.canWriteConversation(current)) return;
          await this.writeMetadata(current, {
            preserveProviderState: !this.hydratedConversationIds.has(current.id),
          });
          this.pendingLinkedContentPathCorrectionIds.delete(current.id);
          if (source === 'legacy') {
            await this.persistence.deleteLegacyMetadata(current.id);
          }
        },
      ));
    await Promise.all(migrations);
  }

  mergeMetadataConversations(
    conversations: Conversation[],
    metadataTarget: SessionMetadataAuthority | null = 'device',
  ): Conversation[] {
    const existingIds = new Set(this.conversations.map(({ id }) => id));
    for (const conversation of conversations) {
      if (existingIds.has(conversation.id)) {
        this.getSync(conversation.id);
        continue;
      }
      if (this.applyLinkedContentPathRenamesToHydratedConversation(conversation)) {
        this.pendingLinkedContentPathCorrectionIds.add(conversation.id);
      }
    }
    const added = conversations.filter(
      ({ id }) =>
        !existingIds.has(id)
        && !this.deletedConversationIds.has(id)
        && !this.deletingConversationIds.has(id),
    );
    if (added.length === 0) {
      return [];
    }

    if (metadataTarget) {
      for (const conversation of added) {
        this.metadataTargets.set(conversation.id, metadataTarget);
      }
    }

    this.conversations.push(...added);
    this.conversations.sort(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt,
    );
    for (const conversation of added) {
      this.captureLinkedContentIdentity(conversation);
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
      this.linkedContentPathsByConversationId.delete(shell.id);
      this.metadataTargets.delete(shell.id);
      this.invalidateConversation(shell.id);
    }
  }

  getAll(): Conversation[] {
    this.restoreAllLinkedContentIdentities();
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
    this.captureLinkedContentIdentity(conversation);
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

    return this.enqueuePersistence(id, async () => {
      if (!await this.canWriteConversation(conversation)) return false;
      const source = this.requireMetadataTarget(id);
      if (source === 'device') return false;

      await this.writeMetadata(conversation, {
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
      if (
        this.deletedConversationIds.has(id)
        || await this.isDeletedInAnyMetadataTarget(id)
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
        await this.persistence.markDeleted(
          id,
          Date.now(),
          this.requireMetadataTarget(id),
        );
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
      && !await this.isDeletedInAnyMetadataTarget(id)
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
    await this.save(conversation);
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
        this.markSelectedModelMutation(conversation);
      } else {
        delete safeUpdates.selectedModel;
      }
    }
    Object.assign(conversation, safeUpdates);
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

  async setPinned(id: string, isPinned: boolean): Promise<void> {
    const conversation = this.getSync(id);
    if (
      !conversation
      || (isPinned && conversation.isArchived)
      || conversation.isPinned === isPinned
    ) return;

    conversation.isPinned = isPinned;
    await this.save(conversation);
  }

  async setArchived(id: string, isArchived: boolean): Promise<void> {
    const conversation = this.getSync(id);
    if (!conversation) return;
    if (
      conversation.isArchived === isArchived
      && (!isArchived || conversation.isPinned === false)
    ) return;

    conversation.isArchived = isArchived;
    if (isArchived) {
      conversation.isPinned = false;
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
        const recovery = this.recoverHistoricalModelSelection(conversation);
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

  private recoverHistoricalModelSelection(
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

    const generation = this.getConversationGeneration(conversation.id);
    const recovery = this.runHistoricalModelRecovery(
      conversation,
      generation,
      recoverModelSelection,
      recoverySource,
    );
    this.historicalModelRecoveryPromises.set(conversation.id, recovery);
    return recovery;
  }

  private async runHistoricalModelRecovery(
    conversation: Conversation,
    generation: number,
    recoverModelSelection: HistoricalModelRecovery,
    recoverySource: Conversation,
  ): Promise<HistoricalModelRecoveryResult> {
    let selectedModel: string | null;
    try {
      const vaultPath = this.deps.getVaultPath();
      selectedModel = (await recoverModelSelection(
        recoverySource,
        vaultPath,
        this.getHistoryPathContext(recoverySource.providerId, vaultPath),
      ))?.trim() || null;
    } catch {
      return 'unresolved';
    }
    if (!selectedModel) return 'unresolved';
    if (
      !this.isConversationCurrent(conversation, generation)
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
      didPersist = await this.persistSelectedModelBeforePublish(
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
      this.isConversationCurrent(conversation, generation)
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
      this.applyLinkedContentPathRename(conversation, rename)
    ));
    await this.persistConversations(changed);
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
      await this.writeMetadata(current);
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

  async assertConversationExecutionAuthority(
    conversationId: string,
  ): Promise<void> {
    const conversation = this.getSync(conversationId);
    if (!conversation) {
      throw new ConversationInputStageRejectedError(conversationId);
    }
    const target = this.requireMetadataTarget(conversationId);
    if (!await this.canWriteConversation(conversation)) {
      throw new ConversationInputStageRejectedError(conversationId);
    }
    await this.persistence.assertMetadataWriteAuthority(conversationId, target);
    if (
      this.getSync(conversationId) !== conversation
      || this.requireMetadataTarget(conversationId) !== target
    ) {
      throw new ConversationInputStageRejectedError(conversationId);
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
        await this.writeInputLedger(conversationId, ledger);
        this.markInputLedgerCanonical(conversationId, ledger);
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
      conversation.lastActivityAt = Math.max(
        conversation.lastActivityAt,
        record.timestamp,
      );
    }

    await this.enqueuePersistence(conversationId, async () => {
      if (!await this.canWriteLedger(conversationId, ledger)) return;
      await this.writeInputLedger(conversationId, ledger);
      this.markInputLedgerCanonical(conversationId, ledger);
      const current = this.getSync(conversationId);
      if (current && await this.canWriteConversation(current)) {
        await this.writeMetadata(current);
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
      selectedModel: conversation.selectedModel,
      title: conversation.title,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
      messageCount: conversation.messages.length,
      preview: this.getPreview(conversation),
      linkedContentPath: conversation.linkedContentPath,
      isPinned: conversation.isPinned,
      isArchived: conversation.isArchived,
      titleGenerationStatus: conversation.titleGenerationStatus,
      isLegacySession: this.isLegacyMetadataTarget(id),
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
    const conversation = this.conversations.find(
      (conversation) => conversation.id === id,
    ) ?? null;
    if (conversation) {
      this.restoreLinkedContentIdentity(conversation);
    }
    return conversation;
  }

  findEmpty(): Conversation | null {
    this.restoreAllLinkedContentIdentities();
    return this.conversations.find(
      (conversation) => conversation.messages.length === 0,
    ) ?? null;
  }

  list(): ConversationMeta[] {
    this.restoreAllLinkedContentIdentities();
    return this.conversations.map((conversation) => ({
      id: conversation.id,
      providerId: conversation.providerId,
      selectedModel: conversation.selectedModel,
      title: conversation.title,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
      messageCount: conversation.messages.length,
      preview: this.getPreview(conversation),
      linkedContentPath: conversation.linkedContentPath,
      isPinned: conversation.isPinned,
      isArchived: conversation.isArchived,
      titleGenerationStatus: conversation.titleGenerationStatus,
      isLegacySession: this.isLegacyMetadataTarget(conversation.id),
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

  private applyLinkedContentPathRenamesToHydratedConversation(
    conversation: Conversation,
  ): boolean {
    const originalPath = conversation.linkedContentPath;
    let currentPath = normalizeLinkedContentPath(originalPath) ?? undefined;
    for (const rename of this.linkedContentPathRenames) {
      if (!currentPath) break;
      currentPath = this.rewriteLinkedContentPath(currentPath, rename) ?? currentPath;
    }
    if (currentPath === originalPath) return false;

    this.assignLinkedContentPath(conversation, currentPath);
    return true;
  }

  private applyLinkedContentPathRename(
    conversation: Conversation,
    rename: LinkedContentPathRename,
  ): boolean {
    const currentPath = this.getAuthoritativeLinkedContentPath(conversation);
    if (!currentPath) return false;
    const rewrittenPath = this.rewriteLinkedContentPath(currentPath, rename);
    if (!rewrittenPath || rewrittenPath === currentPath) return false;

    this.setLinkedContentIdentity(conversation, rewrittenPath);
    return true;
  }

  private rewriteLinkedContentPath(
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

  private captureLinkedContentIdentity(conversation: Conversation): void {
    const path = normalizeLinkedContentPath(conversation.linkedContentPath)
      ?? undefined;
    this.setLinkedContentIdentity(conversation, path);
  }

  private setLinkedContentIdentity(
    conversation: Conversation,
    path: string | undefined,
  ): void {
    this.linkedContentPathsByConversationId.set(conversation.id, path);
    this.assignLinkedContentPath(conversation, path);
  }

  private restoreLinkedContentIdentity(conversation: Conversation): void {
    if (!this.linkedContentPathsByConversationId.has(conversation.id)) return;
    this.assignLinkedContentPath(
      conversation,
      this.linkedContentPathsByConversationId.get(conversation.id),
    );
  }

  private restoreAllLinkedContentIdentities(): void {
    for (const conversation of this.conversations) {
      this.restoreLinkedContentIdentity(conversation);
    }
  }

  private getAuthoritativeLinkedContentPath(
    conversation: Conversation,
  ): string | undefined {
    if (this.linkedContentPathsByConversationId.has(conversation.id)) {
      const path = this.linkedContentPathsByConversationId.get(conversation.id);
      this.assignLinkedContentPath(conversation, path);
      return path;
    }
    return normalizeLinkedContentPath(conversation.linkedContentPath) ?? undefined;
  }

  private assignLinkedContentPath(
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

  private async reconcileProviderSession(
    conversation: Conversation,
  ): Promise<void> {
    const historyService = ProviderRegistry.getConversationHistoryService(
      conversation.providerId,
    );

    const vaultPath = this.deps.getVaultPath();
    const pathContext = this.getHistoryPathContext(
      conversation.providerId,
      vaultPath,
    );
    if (historyService.recoverConversationSessionReference) {
      const previousSessionId = conversation.sessionId;
      const previousProviderState = conversation.providerState;
      const previousResumeAtMessageId = conversation.resumeAtMessageId;
      try {
        if (
          await historyService.recoverConversationSessionReference(
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
        return;
      }
    }

    if (!historyService.getConversationSessionAvailability) return;

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
    let recoveryResult: HistoricalModelRecoveryResult | 'unsupported' = 'unsupported';
    if (!getStoredModelSelection(conversation.selectedModel)) {
      const recovery = this.recoverHistoricalModelSelection(conversation);
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

    await this.persistSelectedModelBeforePublish(conversation, modelToPersist);
  }

  private async reconcileIncomingSelectedModel(conversation: Conversation): Promise<void> {
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
    const didPersist = await this.enqueuePersistence(conversation.id, async () => {
      if (
        this.getSync(conversation.id)
        || this.deletedConversationIds.has(conversation.id)
        || this.deletingConversationIds.has(conversation.id)
        || await this.persistence.isDeleted(
          conversation.id,
          this.requireMetadataTarget(conversation.id),
        )
      ) {
        return false;
      }
      await this.writeMetadata(snapshot, {
        preserveProviderState: true,
      });
      return true;
    });
    if (didPersist && !this.getSync(conversation.id)) {
      conversation.selectedModel = modelToPersist;
    }
  }

  private async persistSelectedModelBeforePublish(
    conversation: Conversation,
    selectedModel: string,
    clearRecoverySource = false,
  ): Promise<boolean> {
    const previousSelectedModel = conversation.selectedModel;
    const selectedModelMutationVersion = this.markSelectedModelMutation(conversation);
    const didPersist = await this.enqueuePersistence(conversation.id, async () => {
      if (
        this.getSelectedModelMutationVersion(conversation) !== selectedModelMutationVersion
        || !await this.canWriteConversation(conversation)
        || this.getSelectedModelMutationVersion(conversation) !== selectedModelMutationVersion
      ) {
        return false;
      }
      const snapshot = {
        ...conversation,
        selectedModel,
        ...(clearRecoverySource ? { modelRecoverySource: undefined } : {}),
      };
      await this.writeMetadata(snapshot, {
        preserveProviderState: !this.hydratedConversationIds.has(conversation.id),
      });
      return true;
    });
    if (
      !didPersist
      || this.getSelectedModelMutationVersion(conversation) !== selectedModelMutationVersion
      || conversation.selectedModel !== previousSelectedModel
    ) {
      return false;
    }

    conversation.selectedModel = selectedModel;
    if (clearRecoverySource) {
      conversation.modelRecoverySource = undefined;
    }
    return true;
  }

  private markSelectedModelMutation(conversation: Conversation): number {
    const nextVersion = this.getSelectedModelMutationVersion(conversation) + 1;
    this.selectedModelMutationVersions.set(conversation, nextVersion);
    return nextVersion;
  }

  private getSelectedModelMutationVersion(conversation: Conversation): number {
    return this.selectedModelMutationVersions.get(conversation) ?? 0;
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
    const correlation = this.correlateInputLedger(conversation, state.ledger);
    if (correlation.ledgerChanged) {
      try {
        await this.persistLedgerOnly(conversation.id, state.ledger);
      } catch {
        // Native history remains usable; the accepted promotion stays dirty.
      }
    }
    if (
      correlation.lastAcceptedInputAt !== null
      && correlation.lastAcceptedInputAt > conversation.lastActivityAt
    ) {
      conversation.lastActivityAt = correlation.lastAcceptedInputAt;
      try {
        await this.save(conversation);
      } catch {
        // The repaired activity remains in memory for the next metadata write.
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
          state = {
            status: 'loaded',
            ledger: result.ledger,
            needsMigration: result.needsMigration,
          };
        } else if (result.status === 'missing') {
          state = {
            status: 'loaded',
            ledger: {
              schemaVersion: CONVERSATION_INPUT_LEDGER_SCHEMA_VERSION,
              conversationId,
              records: [],
            },
            needsMigration: false,
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
  ): InputLedgerCorrelationResult {
    const usedRecordIds = new Set<string>();
    let ledgerChanged = false;
    let lastAcceptedInputAt: number | null = null;
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
        ledgerChanged = true;
      }
      if (!record.providerAssistantMessageId) {
        const assistant = findAssistantForCanonicalUserTurn(
          conversation.messages,
          messageIndex,
        );
        if (assistant?.assistantMessageId) {
          record.providerAssistantMessageId = assistant.assistantMessageId;
          ledgerChanged = true;
        }
      }
      this.attachRecordToMessage(message, record);
      if (record.state === 'staged') {
        record.state = 'accepted';
        ledgerChanged = true;
      }
      lastAcceptedInputAt = lastAcceptedInputAt === null
        ? record.timestamp
        : Math.max(lastAcceptedInputAt, record.timestamp);
    }
    return { ledgerChanged, lastAcceptedInputAt };
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
      await this.writeInputLedger(conversationId, ledger);
      this.markInputLedgerCanonical(conversationId, ledger);
    });
  }

  private markInputLedgerCanonical(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): void {
    const state = this.ledgerStates.get(conversationId);
    if (state?.status === 'loaded' && state.ledger === ledger) {
      state.needsMigration = false;
    }
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
    if (
      !isCurrent()
      || await this.persistence.isDeleted(
        conversationId,
        this.requireMetadataTarget(conversationId),
      )
    ) {
      return false;
    }
    return isCurrent();
  }

  private applySnapshot(
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
      this.invalidateConversation(conversation.id);
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
    this.restoreLinkedContentIdentity(conversation);
    const generation = this.getConversationGeneration(conversation.id);
    return this.enqueuePersistence(conversation.id, async () => {
      if (
        !this.isConversationCurrent(conversation, generation)
        || !await this.canWriteConversation(conversation)
      ) {
        return;
      }
      this.restoreLinkedContentIdentity(conversation);
      await this.writeMetadata(conversation);
    });
  }

  private async canWriteConversation(
    conversation: Conversation,
  ): Promise<boolean> {
    return (
      this.getSync(conversation.id) === conversation
      && !this.deletedConversationIds.has(conversation.id)
      && !this.deletingConversationIds.has(conversation.id)
      && !await this.persistence.isDeleted(
        conversation.id,
        this.requireMetadataTarget(conversation.id),
      )
    );
  }

  private writeMetadata(
    conversation: Conversation,
    options: { preserveProviderState?: boolean } = {},
  ): Promise<void> {
    const metadata = this.toSessionMetadata(conversation, options);
    const target = this.requireMetadataTarget(conversation.id);
    return target === 'device'
      ? this.persistence.saveMetadata(metadata)
      : this.persistence.saveMetadata(metadata, target);
  }

  private writeInputLedger(
    conversationId: string,
    ledger: ConversationInputLedger,
  ): Promise<void> {
    const target = this.requireMetadataTarget(conversationId);
    return target === 'device'
      ? this.persistence.saveInputLedger(conversationId, ledger)
      : this.persistence.saveInputLedger(conversationId, ledger, target);
  }

  private async isDeletedInAnyMetadataTarget(
    conversationId: string,
  ): Promise<boolean> {
    const [deviceDeleted, unscopedDeleted] = await Promise.all([
      this.persistence.isDeleted(conversationId, 'device'),
      this.persistence.isDeleted(conversationId, 'unscoped'),
    ]);
    return deviceDeleted || unscopedDeleted;
  }

  private requireMetadataTarget(conversationId: string): SessionMetadataAuthority {
    const authority = this.metadataTargets.get(conversationId);
    if (!authority) {
      throw new Error(`Conversation metadata ownership is unresolved: ${conversationId}`);
    }
    return authority;
  }

  private isLegacyMetadataTarget(conversationId: string): boolean {
    return this.metadataTargets.get(conversationId) === 'unscoped';
  }

  private toSessionMetadata(
    conversation: Conversation,
    options: { preserveProviderState?: boolean } = {},
  ): SessionMetadata {
    const linkedContentPath = this.getAuthoritativeLinkedContentPath(conversation);
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
      externalContextPaths: conversation.externalContextPaths,
      usage: conversation.usage,
      resumeAtMessageId: conversation.resumeAtMessageId,
    };
  }

  private async cleanupDeletedConversation(id: string): Promise<void> {
    const target = this.metadataTargets.get(id);
    if (target === 'device') {
      await this.persistence.deleteCurrentMetadata(id);
    } else if (target === 'unscoped') {
      await this.persistence.deleteCurrentMetadata(id, target);
    } else if (!target) {
      await this.persistence.deleteCurrentMetadata(id, 'device');
      await this.persistence.deleteCurrentMetadata(id, 'unscoped');
    }
    await this.persistence.deleteLegacyMetadata(id);
    await this.persistence.deleteInputLedger(id);
    this.ledgerStates.delete(id);
    this.ledgerLoadPromises.delete(id);
    this.linkedContentPathsByConversationId.delete(id);
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
    this.metadataTargets.delete(id);
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
    this.historicalModelRecoveryPromises.delete(id);
    this.historicalModelRecoverySources.delete(id);
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
