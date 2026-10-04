import type { ProviderSessionSnapshot } from '@/core/execution';
import type { ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';

import type { ConversationRecordFence } from './ConversationRecordFence';

export interface ExecutionBindingState {
  readonly bindingId: string;
  readonly providerId: ProviderId;
  readonly providerGeneration: number;
  closed: boolean;
  latestSnapshot: ProviderSessionSnapshot | null;
  lastPersistedRevision: number;
}

export interface ConversationExecutionBindingsDeps {
  readonly fence: ConversationRecordFence;
  /** The binding was captured by a deletion whose metadata removal is still pending. */
  isTransientDeletionBinding(conversationId: string, binding: ExecutionBindingState): boolean;
  /** A fresh native session supersedes any pending historical model recovery. */
  discardModelRecovery(conversation: Conversation): void;
}

/**
 * Owns execution bindings and fences provider snapshot writes to the binding,
 * provider generation, and revision that produced them.
 */
export class ConversationExecutionBindings {
  private readonly bindings = new Map<string, ExecutionBindingState>();

  constructor(private readonly deps: ConversationExecutionBindingsDeps) {}

  get(conversationId: string): ExecutionBindingState | null {
    return this.bindings.get(conversationId) ?? null;
  }

  delete(conversationId: string): void {
    this.bindings.delete(conversationId);
  }

  clear(): void {
    this.bindings.clear();
  }

  register(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
  ): void {
    const conversation = this.deps.fence.getRecord(conversationId);
    if (!conversation) throw new Error(`Conversation is no longer available: ${conversationId}`);
    const existing = this.bindings.get(conversationId);
    if (existing && !existing.closed) {
      if (existing.bindingId === bindingId && existing.providerGeneration === providerGeneration) return;
      throw new Error('This conversation already has an active execution owner in another tab.');
    }
    this.bindings.set(conversationId, {
      bindingId,
      providerId: conversation.providerId,
      providerGeneration,
      closed: false,
      latestSnapshot: null,
      lastPersistedRevision: -1,
    });
  }

  persistSnapshot(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
    snapshot: ProviderSessionSnapshot,
  ): Promise<boolean> {
    const binding = this.bindings.get(conversationId);
    const conversation = this.deps.fence.getRecord(conversationId);
    const isTransientDeletionBinding = (
      !conversation
      && !!binding
      && this.deps.isTransientDeletionBinding(conversationId, binding)
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
      binding.latestSnapshot = structuredClone(snapshot);
    }

    if (!conversation) {
      return Promise.resolve(false);
    }

    return this.#persistLatestSnapshot(conversationId, binding);
  }

  /** Replays the newest unpersisted snapshot after a failed deletion restores its record. */
  replayAfterDeletionRollback(
    conversationId: string,
    binding: ExecutionBindingState | null,
    restoredConversation: Conversation,
  ): Promise<boolean> {
    if (
      !binding
      || binding.closed
      || this.bindings.get(conversationId) !== binding
      || this.deps.fence.getRecord(conversationId) !== restoredConversation
      || !binding.latestSnapshot
      || binding.latestSnapshot.revision <= binding.lastPersistedRevision
    ) {
      return Promise.resolve(false);
    }
    return this.persistSnapshot(
      conversationId,
      binding.bindingId,
      binding.providerGeneration,
      binding.latestSnapshot,
    );
  }

  release(
    conversationId: string,
    bindingId: string,
  ): void {
    const binding = this.bindings.get(conversationId);
    if (binding?.bindingId === bindingId) {
      binding.closed = true;
    }
  }

  async assertAuthority(
    conversationId: string,
    bindingId: string,
    providerGeneration: number,
  ): Promise<void> {
    const { fence } = this.deps;
    const conversation = fence.getRecord(conversationId);
    const binding = this.bindings.get(conversationId);
    if (!conversation || !await fence.canWrite(conversation)
      || fence.getRecord(conversationId) !== conversation
      || !binding || binding.closed
      || binding.bindingId !== bindingId || binding.providerGeneration !== providerGeneration
      || this.bindings.get(conversationId) !== binding) {
      throw new Error(`Conversation is no longer available: ${conversationId}`);
    }
  }

  #persistLatestSnapshot(
    conversationId: string,
    binding: ExecutionBindingState,
  ): Promise<boolean> {
    const { fence } = this.deps;
    return fence.enqueuePersistence(conversationId, async () => {
      if (
        this.bindings.get(conversationId) !== binding
        || !binding.latestSnapshot
        || binding.latestSnapshot.revision <= binding.lastPersistedRevision
      ) {
        return false;
      }
      const current = fence.getRecord(conversationId);
      if (!current || !await fence.canWrite(current)) {
        return false;
      }
      if (
        this.bindings.get(conversationId) !== binding
        || !binding.latestSnapshot
        || binding.latestSnapshot.revision <= binding.lastPersistedRevision
      ) {
        return false;
      }

      const latest = binding.latestSnapshot;
      this.#applySnapshot(current, latest);
      await fence.writeMetadata(current);
      binding.lastPersistedRevision = latest.revision;
      return true;
    });
  }

  #applySnapshot(
    conversation: Conversation,
    snapshot: ProviderSessionSnapshot,
  ): void {
    const establishesFreshProviderSession = snapshot.status !== 'invalidated'
      && typeof snapshot.providerSessionId === 'string'
      && snapshot.providerSessionId.trim().length > 0;
    if (establishesFreshProviderSession) {
      this.deps.discardModelRecovery(conversation);
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
}
