/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - CC settings in .claude/settings.json (CC-compatible, shareable)
 * - Claudian settings in .claude/claudian-settings.json (Claudian-specific)
 * - Slash commands in .claude/commands/*.md
 * - Chat sessions in .claude/sessions/*.jsonl
 * - MCP configs in .claude/mcp.json
 */

import type { App, Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import { ClaudianSettingsStorage, type StoredClaudianSettings } from '../../../app/settings/ClaudianSettingsStorage';
import { SESSIONS_PATH, SessionStorage } from '../../../core/bootstrap/SessionStorage';
import { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type {
  SlashCommand,
} from '../../../core/types';
import {
  type CCPermissions,
  type CCSettings,
  createPermissionRule,
} from '../types/settings';
import { AGENTS_PATH, AgentVaultStorage } from './AgentVaultStorage';
import { CCSettingsStorage } from './CCSettingsStorage';
import { McpStorage } from './McpStorage';
import { SKILLS_PATH, SkillStorage } from './SkillStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';

/** Base path for all Claudian storage. */
export const CLAUDE_PATH = '.claude';

/**
 * Combined settings for the application.
 * Merges CC settings (permissions) with Claudian settings.
 */
export interface CombinedSettings {
  /** CC-compatible settings (permissions, etc.) */
  cc: CCSettings;
  /** Claudian-specific settings */
  claudian: StoredClaudianSettings;
}

export class StorageService {
  readonly ccSettings: CCSettingsStorage;
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly commands: SlashCommandStorage;
  readonly skills: SkillStorage;
  readonly sessions: SessionStorage;
  readonly mcp: McpStorage;
  readonly agents: AgentVaultStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private app: App;

  constructor(plugin: Plugin, adapter?: VaultFileAdapter) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.adapter = adapter ?? new VaultFileAdapter(this.app);
    this.ccSettings = new CCSettingsStorage(this.adapter);
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.skills = new SkillStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.mcp = new McpStorage(this.adapter);
    this.agents = new AgentVaultStorage(this.adapter);
  }

  async initialize(): Promise<CombinedSettings> {
    await this.ensureDirectories();

    const cc = await this.ccSettings.load();
    const claudian = await this.claudianSettings.load();

    return { cc, claudian };
  }

  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDE_PATH);
    await this.adapter.ensureFolder(COMMANDS_PATH);
    await this.adapter.ensureFolder(SKILLS_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
    await this.adapter.ensureFolder(AGENTS_PATH);
  }

  async loadAllSlashCommands(): Promise<SlashCommand[]> {
    const commands = await this.commands.loadAll();
    const skills = await this.skills.loadAll();
    return [...commands, ...skills];
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  async getPermissions(): Promise<CCPermissions> {
    return this.ccSettings.getPermissions();
  }

  async updatePermissions(permissions: CCPermissions): Promise<void> {
    return this.ccSettings.updatePermissions(permissions);
  }

  async addAllowRule(rule: string): Promise<void> {
    return this.ccSettings.addAllowRule(createPermissionRule(rule));
  }

  async addDenyRule(rule: string): Promise<void> {
    return this.ccSettings.addDenyRule(createPermissionRule(rule));
  }

  /**
   * Remove a permission rule from all lists.
   */
  async removePermissionRule(rule: string): Promise<void> {
    return this.ccSettings.removeRule(createPermissionRule(rule));
  }

  async updateClaudianSettings(updates: Partial<StoredClaudianSettings>): Promise<void> {
    return this.claudianSettings.update(updates);
  }

  async saveClaudianSettings(settings: StoredClaudianSettings): Promise<void> {
    return this.claudianSettings.save(settings);
  }

  async loadClaudianSettings(): Promise<StoredClaudianSettings> {
    return this.claudianSettings.load();
  }

  /**
   * Get tab manager state from data.json with runtime validation.
   */
  async getTabManagerState(): Promise<TabManagerPersistedState | null> {
    try {
      const data = await this.plugin.loadData();
      if (data?.tabManagerState) {
        return this.validateTabManagerState(data.tabManagerState);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Validates and sanitizes tab manager state from storage.
   * Returns null if the data is invalid or corrupted.
   */
  private validateTabManagerState(data: unknown): TabManagerPersistedState | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const state = data as Record<string, unknown>;

    if (!Array.isArray(state.openTabs)) {
      return null;
    }

    const validatedTabs: Array<{ tabId: string; conversationId: string | null }> = [];
    for (const tab of state.openTabs) {
      if (!tab || typeof tab !== 'object') {
        continue; // Skip invalid entries
      }
      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.tabId !== 'string') {
        continue; // Skip entries without valid tabId
      }
      validatedTabs.push({
        tabId: tabObj.tabId,
        conversationId:
          typeof tabObj.conversationId === 'string' ? tabObj.conversationId : null,
      });
    }

    const activeTabId =
      typeof state.activeTabId === 'string' ? state.activeTabId : null;

    return {
      openTabs: validatedTabs,
      activeTabId,
    };
  }

  async setTabManagerState(state: TabManagerPersistedState): Promise<void> {
    try {
      const data = (await this.plugin.loadData()) || {};
      data.tabManagerState = state;
      await this.plugin.saveData(data);
    } catch {
      new Notice('Failed to save tab layout');
    }
  }
}

/**
 * Persisted state for the tab manager.
 * Stored in data.json (machine-specific, not shared).
 */
export interface TabManagerPersistedState {
  openTabs: Array<{ tabId: string; conversationId: string | null }>;
  activeTabId: string | null;
}
