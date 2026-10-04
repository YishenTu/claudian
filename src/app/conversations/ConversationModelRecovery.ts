import {
  getConversationModelPersistenceTarget,
  resolveConversationModel,
} from '@/core/providers/conversationModel';
import type { ProviderConversationHistoryService, ProviderId } from '@/core/providers/types';
import type { Conversation, ConversationModelRecoverySource } from '@/core/types';
import { mapWithConcurrency } from '@/utils/concurrency';

import type { ConversationProviderCatalog, ConversationRecordFence } from './ConversationRecordFence';

type HistoricalModelRecoveryResult =
  | 'recovered'
  | 'superseded'
  | 'unresolved';

type HistoricalModelRecovery = NonNullable<
  ProviderConversationHistoryService['recoverConversationModelSelection']
>;

const HISTORICAL_MODEL_RECOVERY_CONCURRENCY = 2;

export function getStoredModelSelection(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function cloneModelRecoverySource(
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

/**
 * Owns historical model recovery and selected-model availability reconciliation
 * for repository records. Every write goes through the repository fence, so
 * recovery is best-effort and never overwrites a newer explicit selection.
 */
export class ConversationModelRecovery {
  private readonly recoveryPromises = new Map<string, Promise<HistoricalModelRecoveryResult>>();
  private readonly recoverySources = new Map<string, Conversation>();
  private readonly selectedModelMutationVersions = new WeakMap<Conversation, number>();

  constructor(
    private readonly fence: ConversationRecordFence,
    private readonly providers: ConversationProviderCatalog,
  ) {}

  clear(): void {
    this.recoveryPromises.clear();
    this.recoverySources.clear();
  }

  /** Drops recovery state captured for a superseded generation. */
  forget(id: string): void {
    this.recoveryPromises.delete(id);
    this.recoverySources.delete(id);
  }

  hasPendingRecovery(id: string): boolean {
    return this.recoverySources.has(id) || this.recoveryPromises.has(id);
  }

  registerSources(conversations: readonly Conversation[]): void {
    for (const source of conversations) {
      const target = this.fence.getRecord(source.id);
      if (
        !target
        || getStoredModelSelection(target.selectedModel)
        || getStoredModelSelection(source.selectedModel)
        || this.recoverySources.has(source.id)
      ) {
        continue;
      }
      const recoverySource = getModelRecoverySource(source)
        ?? getModelRecoverySource(target);
      if (!recoverySource) continue;

      target.modelRecoverySource ??= cloneModelRecoverySource(recoverySource);
      this.recoverySources.set(
        source.id,
        applyModelRecoverySource(source, recoverySource),
      );
    }
  }

  /** Resolves the records whose model was recovered and is still current. */
  async recoverMissing(conversations: readonly Conversation[]): Promise<Conversation[]> {
    const candidates = conversations.filter(conversation => (
      !getStoredModelSelection(conversation.selectedModel)
    ));
    const recovered = await mapWithConcurrency(
      candidates,
      async (conversation): Promise<Conversation | null> => {
        const recovery = this.#recover(conversation);
        if (!recovery) return null;
        const result = await recovery;
        return result === 'recovered' && this.fence.getRecord(conversation.id) === conversation
          ? conversation
          : null;
      },
      HISTORICAL_MODEL_RECOVERY_CONCURRENCY,
    );
    return recovered.filter(
      (conversation): conversation is Conversation => conversation !== null,
    );
  }

  /** Resolves the records of this provider whose selected model changed. */
  async reconcileProvider(
    conversations: readonly Conversation[],
    providerId: ProviderId,
  ): Promise<Conversation[]> {
    const changed: Conversation[] = [];
    for (const conversation of conversations) {
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

  isPublicationSafe(conversation: Conversation): boolean {
    const storedModel = getStoredModelSelection(conversation.selectedModel);
    if (
      !storedModel
      || !this.providers.getRegisteredProviderIds().includes(conversation.providerId)
    ) {
      return true;
    }

    const resolved = resolveConversationModel(
      this.fence.getSettings(),
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

  /** Explicit intent supersedes pending automatic model recovery immediately. */
  markSelectedModelMutation(conversation: Conversation): number {
    const nextVersion = this.#getSelectedModelMutationVersion(conversation) + 1;
    this.selectedModelMutationVersions.set(conversation, nextVersion);
    return nextVersion;
  }

  async ensureSelectedModel(
    conversation: Conversation,
  ): Promise<void> {
    const mutationVersion = this.#getSelectedModelMutationVersion(conversation);
    let recoveryResult: HistoricalModelRecoveryResult | 'unsupported' = 'unsupported';
    if (!getStoredModelSelection(conversation.selectedModel)) {
      const recovery = this.#recover(conversation);
      if (recovery) recoveryResult = await recovery;
    }
    const resolved = resolveConversationModel(
      this.fence.getSettings(),
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

  /** Persists availability reconciliation for a metadata shell before it is adopted. */
  async reconcileIncoming(conversation: Conversation): Promise<void> {
    if (
      !getStoredModelSelection(conversation.selectedModel)
    ) {
      return;
    }

    const resolved = resolveConversationModel(
      this.fence.getSettings(),
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
    const didPersist = await this.fence.enqueuePersistence(conversation.id, async () => {
      if (!this.fence.canAdopt(conversation.id)) {
        return false;
      }
      await this.fence.writeMetadata(snapshot, {
        preserveProviderState: true,
      });
      return true;
    });
    if (didPersist && !this.fence.getRecord(conversation.id)) {
      conversation.selectedModel = modelToPersist;
    }
  }

  #recover(
    conversation: Conversation,
  ): Promise<HistoricalModelRecoveryResult> | null {
    if (getStoredModelSelection(conversation.selectedModel)) {
      return null;
    }

    const existing = this.recoveryPromises.get(conversation.id);
    if (existing) return existing;

    const persistedRecoverySource = conversation.modelRecoverySource
      ? cloneModelRecoverySource(conversation.modelRecoverySource)
      : null;
    const recoverySource = this.recoverySources.get(conversation.id)
      ?? (persistedRecoverySource
        ? applyModelRecoverySource(conversation, persistedRecoverySource)
        : conversation);
    let recoverModelSelection: HistoricalModelRecovery | undefined;
    try {
      const historyService = this.providers.getConversationHistoryService(
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

    const generation = this.fence.getGeneration(conversation.id);
    const recovery = this.#runRecovery(
      conversation,
      generation,
      recoverModelSelection,
      recoverySource,
    );
    this.recoveryPromises.set(conversation.id, recovery);
    return recovery;
  }

  async #runRecovery(
    conversation: Conversation,
    generation: number,
    recoverModelSelection: HistoricalModelRecovery,
    recoverySource: Conversation,
  ): Promise<HistoricalModelRecoveryResult> {
    const mutationVersion = this.#getSelectedModelMutationVersion(conversation);
    let selectedModel: string | null;
    try {
      const vaultPath = this.fence.getVaultPath();
      selectedModel = (await recoverModelSelection(
        structuredClone(recoverySource),
        vaultPath,
        this.fence.getHistoryPathContext(recoverySource.providerId, vaultPath),
      ))?.trim() || null;
    } catch {
      return 'unresolved';
    }
    if (!selectedModel) return 'unresolved';
    if (
      !this.fence.isCurrent(conversation, generation)
      || this.#getSelectedModelMutationVersion(conversation) !== mutationVersion
      || getStoredModelSelection(conversation.selectedModel)
    ) {
      return 'superseded';
    }

    const resolvedRecoveredModel = resolveConversationModel(
      this.fence.getSettings(),
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
      this.fence.isCurrent(conversation, generation)
      && conversation.selectedModel === selectedModel
    ) {
      this.recoverySources.delete(conversation.id);
      return 'recovered';
    }
    return 'superseded';
  }

  async #persistSelectedModelBeforePublish(
    conversation: Conversation,
    selectedModel: string,
    clearRecoverySource = false,
  ): Promise<boolean> {
    const previousSelectedModel = conversation.selectedModel;
    const selectedModelMutationVersion = this.markSelectedModelMutation(conversation);
    return this.fence.enqueuePersistence(conversation.id, async () => {
      if (
        this.#getSelectedModelMutationVersion(conversation) !== selectedModelMutationVersion
        || !await this.fence.canWrite(conversation)
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
      await this.fence.writeMetadata(snapshot, {
        preserveProviderState: !this.fence.isHydrated(conversation.id),
      });
      if (!this.fence.isRetained(conversation)) return false;
      // Publish inside the same queue slot; a later explicit intent commits next.
      conversation.selectedModel = selectedModel;
      if (clearRecoverySource) {
        conversation.modelRecoverySource = undefined;
      }
      return true;
    });
  }

  #getSelectedModelMutationVersion(conversation: Conversation): number {
    return this.selectedModelMutationVersions.get(conversation) ?? 0;
  }
}
