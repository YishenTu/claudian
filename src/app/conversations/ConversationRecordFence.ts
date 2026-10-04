import type { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderHistoryPathContext, ProviderId } from '@/core/providers/types';
import type { Conversation } from '@/core/types';

/** Provider catalog lookups the conversation repository depends on. */
export type ConversationProviderCatalog = Pick<
  typeof ProviderRegistry,
  'getCapabilities' | 'getConversationHistoryService' | 'getRegisteredProviderIds'
>;

/** Provider settings policy the conversation repository depends on. */
export type ConversationProviderSettings = Pick<
  typeof ProviderSettingsCoordinator,
  'getProviderSettingsSnapshot' | 'invalidateConversationSessions'
>;

export interface ConversationMetadataWriteOptions {
  preserveProviderState?: boolean;
}

/**
 * Repository-owned record access and write fences shared with its collaborators.
 * Collaborators mutate records only inside these fences; the repository remains
 * the single mutation authority and the owner of every generation.
 */
export interface ConversationRecordFence {
  getRecord(id: string): Conversation | null;
  getGeneration(id: string): number;
  /** The record is still the repository's projection and its generation is unchanged. */
  isCurrent(conversation: Conversation, generation: number): boolean;
  /** The record is live or retained for deletion rollback. */
  isRetained(conversation: Conversation): boolean;
  canWrite(conversation: Conversation): Promise<boolean>;
  /** No live, deleting, or deleted record owns this id. */
  canAdopt(id: string): boolean;
  isHydrated(id: string): boolean;
  /** Advances the record generation, superseding in-flight provider reads and recovery. */
  invalidate(id: string): void;
  enqueuePersistence<T>(id: string, operation: () => Promise<T>): Promise<T>;
  writeMetadata(conversation: Conversation, options?: ConversationMetadataWriteOptions): Promise<void>;
  getSettings(): Record<string, unknown>;
  getVaultPath(): string | null;
  getHistoryPathContext(providerId: ProviderId, vaultPath: string | null): ProviderHistoryPathContext;
}
