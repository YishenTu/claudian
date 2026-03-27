import type { AppSessionStorage, AppTabManagerState } from '../providers/types';

/**
 * Minimal shared app storage contract.
 *
 * This interface covers only the storage concerns that are shared across
 * all providers: Claudian settings, tab manager state, session metadata,
 * and legacy migration helpers.
 *
 * Provider-specific storage surfaces (CC settings, slash commands, skills,
 * agents, MCP config) live behind provider-owned modules.
 */
export interface SharedAppStorage {
  initialize(): Promise<{ claudian: Record<string, unknown> }>;
  saveClaudianSettings(settings: Record<string, unknown>): Promise<void>;
  setTabManagerState(state: AppTabManagerState): Promise<void>;
  getTabManagerState(): Promise<AppTabManagerState | null>;
  getLegacyActiveConversationId(): Promise<string | null>;
  clearLegacyActiveConversationId(): Promise<void>;
  sessions: AppSessionStorage;
}
