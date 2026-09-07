import type { AppTabManagerState } from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type { SessionMetadataReader } from './SessionStorage';

/**
 * Minimal shared app storage contract.
 *
 * This interface covers only the storage concerns that are shared across
 * all providers: Claudian settings, legacy tab state migration, and session metadata.
 *
 * Provider-specific storage surfaces (CC settings, slash commands, skills,
 * agents, MCP config) live behind provider-owned modules.
 */
export interface SharedAppStorage {
  initialize(): Promise<{ claudian: Record<string, unknown> }>;
  saveClaudianSettings(settings: Record<string, unknown>): Promise<void>;
  getTabManagerState(): Promise<AppTabManagerState | null>;
  clearTabManagerState(): Promise<void>;
  /** Read-only startup metadata access; conversation writers stay repository-private. */
  sessions: SessionMetadataReader;
  getAdapter(): VaultFileAdapter;
}
