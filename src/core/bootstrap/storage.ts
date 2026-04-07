import type { AppSessionStorage, AppTabManagerState } from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type { SkillRun, SlashCommand } from '../types';

/**
 * Minimal shared app storage contract.
 *
 * This interface covers only the storage concerns that are shared across
 * all providers: Claudian settings, tab manager state, and session metadata.
 *
 * Provider-specific storage surfaces (CC settings, slash commands, skills,
 * agents, MCP config) live behind provider-owned modules.
 */
export interface SharedAppStorage {
  initialize(): Promise<{ claudian: Record<string, unknown> }>;
  saveClaudianSettings(settings: Record<string, unknown>): Promise<void>;
  setTabManagerState(state: AppTabManagerState): Promise<void>;
  getTabManagerState(): Promise<AppTabManagerState | null>;
  getSkillRuns(): Promise<SkillRun[]>;
  getSkillRunUsageCounts(): Promise<Record<string, number>>;
  setSkillRunState(runs: SkillRun[], usageCounts: Record<string, number>): Promise<void>;
  skills: { loadAll(): Promise<SlashCommand[]> };
  sessions: AppSessionStorage;
  getAdapter(): VaultFileAdapter;
}
