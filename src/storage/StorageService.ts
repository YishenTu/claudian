/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - Settings in .claude/settings.json (user-facing, shareable)
 * - Slash commands in .claude/commands/*.md
 * - Chat sessions in .claude/sessions/*.jsonl
 * - Plugin state in data.json (machine-specific)
 *
 * Handles migration from legacy data.json format on first load.
 */

import type { App, Plugin } from 'obsidian';

import type {
  ClaudeModel,
  ClaudianSettings,
  Conversation,
  SlashCommand,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { McpStorage } from './McpStorage';
import { SESSIONS_PATH, SessionStorage } from './SessionStorage';
import { SettingsStorage, type StoredSettings } from './SettingsStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
import { VaultFileAdapter } from './VaultFileAdapter';

/** Base path for all Claudian storage. */
export const CLAUDE_PATH = '.claude';

/** Machine-specific state stored in Obsidian's data.json. */
export interface PluginState {
  activeConversationId: string | null;
  lastEnvHash: string;
  lastClaudeModel: ClaudeModel;
  lastCustomModel: ClaudeModel;
}

/** Default plugin state. */
const DEFAULT_STATE: PluginState = {
  activeConversationId: null,
  lastEnvHash: '',
  lastClaudeModel: 'haiku',
  lastCustomModel: '',
};

/** Legacy data format (pre-migration). */
interface LegacyData extends ClaudianSettings {
  conversations?: Conversation[];
  activeConversationId?: string;
  migrationVersion?: number;
}

export class StorageService {
  readonly settings: SettingsStorage;
  readonly commands: SlashCommandStorage;
  readonly sessions: SessionStorage;
  readonly mcp: McpStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private app: App;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.adapter = new VaultFileAdapter(this.app);
    this.settings = new SettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.mcp = new McpStorage(this.adapter);
  }

  /** Initialize storage, running migration if needed. */
  async initialize(): Promise<{
    settings: StoredSettings;
    state: PluginState;
  }> {
    // Ensure .claude directory structure exists
    await this.ensureDirectories();

    // Check if migration is needed based on legacy data.json contents
    const settingsExist = await this.settings.exists();
    const legacyData = await this.loadLegacyData();
    if (legacyData && this.needsMigration(legacyData)) {
      console.log('[Claudian] Migrating from legacy data.json to distributed storage...');
      const migrated = await this.runMigration(legacyData, { migrateSettings: !settingsExist });
      if (migrated) {
        console.log('[Claudian] Migration complete.');
      } else {
        console.warn('[Claudian] Migration incomplete; will retry on next launch.');
      }
    }

    // Load settings from .claude/settings.json
    const settings = await this.settings.load();

    // Load plugin state from data.json
    const state = await this.loadState();

    return { settings, state };
  }

  /** Check if migration is needed. */
  needsMigration(legacyData: LegacyData | null): boolean {
    if (!legacyData) return false;

    // Check if there's data to migrate
    const hasConversations = legacyData.conversations && legacyData.conversations.length > 0;
    const hasSlashCommands = legacyData.slashCommands && legacyData.slashCommands.length > 0;
    const stateKeys = new Set([
      'conversations',
      'slashCommands',
      'activeConversationId',
      'lastEnvHash',
      'lastClaudeModel',
      'lastCustomModel',
      'migrationVersion',
    ]);
    const hasSettings = Object.keys(legacyData).some(key => !stateKeys.has(key));

    return hasConversations || hasSlashCommands || hasSettings;
  }

  /** Run migration from legacy data.json to distributed storage. */
  async runMigration(
    legacyData: LegacyData,
    options: { migrateSettings: boolean } = { migrateSettings: true }
  ): Promise<boolean> {
    let hadErrors = false;

    // 1. Migrate settings (exclude state fields and slashCommands)
    if (options.migrateSettings) {
      try {
        await this.migrateSettings(legacyData);
      } catch (error) {
        hadErrors = true;
        console.error('[Claudian] Failed to migrate settings:', error);
      }
    }

    // 2. Migrate slash commands to individual files
    if (await this.migrateSlashCommands(legacyData.slashCommands || [])) {
      hadErrors = true;
    }

    // 3. Migrate conversations to individual JSONL files
    if (await this.migrateConversations(legacyData.conversations || [])) {
      hadErrors = true;
    }

    if (hadErrors) {
      return false;
    }

    // 4. Update data.json to state-only format
    await this.saveState({
      activeConversationId: legacyData.activeConversationId || null,
      lastEnvHash: legacyData.lastEnvHash || '',
      lastClaudeModel: legacyData.lastClaudeModel || 'haiku',
      lastCustomModel: legacyData.lastCustomModel || '',
    });

    return true;
  }

  /** Load legacy data from Obsidian's data.json. */
  private async loadLegacyData(): Promise<LegacyData | null> {
    try {
      const data = await this.plugin.loadData();
      return data || null;
    } catch {
      return null;
    }
  }

  /** Load plugin state from data.json. */
  async loadState(): Promise<PluginState> {
    try {
      const data = await this.plugin.loadData();
      return {
        activeConversationId: data?.activeConversationId ?? DEFAULT_STATE.activeConversationId,
        lastEnvHash: data?.lastEnvHash ?? DEFAULT_STATE.lastEnvHash,
        lastClaudeModel: data?.lastClaudeModel ?? DEFAULT_STATE.lastClaudeModel,
        lastCustomModel: data?.lastCustomModel ?? DEFAULT_STATE.lastCustomModel,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  /** Save plugin state to data.json. */
  async saveState(state: PluginState): Promise<void> {
    await this.plugin.saveData(state);
  }

  /** Update specific state fields in data.json. */
  async updateState(updates: Partial<PluginState>): Promise<void> {
    const current = await this.loadState();
    await this.saveState({ ...current, ...updates });
  }

  /** Ensure all required directories exist. */
  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDE_PATH);
    await this.adapter.ensureFolder(COMMANDS_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
  }

  /** Migrate settings from legacy format. */
  private async migrateSettings(legacyData: LegacyData): Promise<void> {
    // Extract settings fields (exclude state fields, slashCommands, conversations)
    const {
      slashCommands: _,
      conversations: __,
      activeConversationId: ___,
      lastEnvHash: ____,
      lastClaudeModel: _____,
      lastCustomModel: ______,
      migrationVersion: _______,
      ...settingsFields
    } = legacyData;

    // Merge with defaults (permissions is now part of settings)
    const settings: StoredSettings = {
      ...this.getDefaultSettings(),
      ...settingsFields,
    };

    await this.settings.save(settings);
  }

  /** Migrate slash commands to individual files. */
  private async migrateSlashCommands(commands: SlashCommand[]): Promise<boolean> {
    let hadErrors = false;
    for (const command of commands) {
      try {
        const filePath = this.commands.getFilePath(command);
        if (await this.adapter.exists(filePath)) {
          continue;
        }
        await this.commands.save(command);
      } catch (error) {
        hadErrors = true;
        console.error(`[Claudian] Failed to migrate command ${command.name}:`, error);
      }
    }
    return hadErrors;
  }

  /** Migrate conversations to individual JSONL files. */
  private async migrateConversations(conversations: Conversation[]): Promise<boolean> {
    let hadErrors = false;
    for (const conversation of conversations) {
      try {
        const filePath = this.sessions.getFilePath(conversation.id);
        if (await this.adapter.exists(filePath)) {
          continue;
        }
        await this.sessions.saveConversation(conversation);
      } catch (error) {
        hadErrors = true;
        console.error(`[Claudian] Failed to migrate conversation ${conversation.id}:`, error);
      }
    }
    return hadErrors;
  }

  /** Get default settings (excluding state fields and slashCommands). */
  private getDefaultSettings(): StoredSettings {
    const {
      slashCommands: _,
      lastEnvHash: __,
      lastClaudeModel: ___,
      lastCustomModel: ____,
      ...defaults
    } = DEFAULT_SETTINGS;
    return defaults;
  }

  /** Get the vault file adapter for direct file operations. */
  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }
}
