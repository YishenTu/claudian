/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - CC settings in .claude/settings.json (CC-compatible, shareable)
 * - Claudian settings in .claude/claudian-settings.json (Claudian-specific)
 * - Slash commands in .claude/commands/*.md
 * - Chat sessions in .claude/sessions/*.jsonl
 * - MCP configs in .claude/mcp.json
 *
 * Handles migration from legacy formats:
 * - Old settings.json with Claudian fields → split into CC + Claudian files
 * - Old permissions array → CC permissions object
 * - data.json state → claudian-settings.json
 */

import type { App, Plugin } from 'obsidian';

import type {
  CCPermissions,
  CCSettings,
  ClaudeModel,
  Conversation,
  LegacyPermission,
  SlashCommand,
} from '../types';
import {
  createPermissionRule,
  DEFAULT_CC_PERMISSIONS,
  DEFAULT_SETTINGS,
  legacyPermissionsToCCPermissions,
} from '../types';
import { CC_SETTINGS_PATH, CCSettingsStorage, isLegacyPermissionsFormat } from './CCSettingsStorage';
import {
  ClaudianSettingsStorage,
  normalizeBlockedCommands,
  normalizeCliPaths,
  type StoredClaudianSettings,
} from './ClaudianSettingsStorage';
import { McpStorage } from './McpStorage';
import {
  CLAUDIAN_ONLY_FIELDS,
  convertEnvObjectToString,
  mergeEnvironmentVariables,
} from './migrationConstants';
import { SESSIONS_PATH, SessionStorage } from './SessionStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
import { VaultFileAdapter } from './VaultFileAdapter';

/** Base path for all Claudian storage. */
export const CLAUDE_PATH = '.claude';

/** Legacy settings path (now CC settings). */
export const SETTINGS_PATH = CC_SETTINGS_PATH;

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

/** Legacy data format (pre-split migration). */
interface LegacySettingsJson {
  // Old Claudian fields that were in settings.json
  userName?: string;
  enableBlocklist?: boolean;
  blockedCommands?: unknown;
  model?: string;
  thinkingBudget?: string;
  permissionMode?: string;
  lastNonPlanPermissionMode?: string;
  permissions?: LegacyPermission[];
  excludedTags?: string[];
  mediaFolder?: string;
  environmentVariables?: string;
  envSnippets?: unknown[];
  systemPrompt?: string;
  allowedExportPaths?: string[];
  keyboardNavigation?: unknown;
  claudeCliPath?: string;
  claudeCliPaths?: unknown;
  loadUserClaudeSettings?: boolean;
  enableAutoTitleGeneration?: boolean;
  titleGenerationModel?: string;

  // CC fields
  $schema?: string;
  env?: Record<string, string>;
}

/** Legacy data.json format. */
interface LegacyDataJson {
  activeConversationId?: string | null;
  lastEnvHash?: string;
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  conversations?: Conversation[];
  slashCommands?: SlashCommand[];
  migrationVersion?: number;
  // May also contain old settings if not yet migrated
  [key: string]: unknown;
}

// CLAUDIAN_ONLY_FIELDS is imported from ./migrationConstants

export class StorageService {
  readonly ccSettings: CCSettingsStorage;
  readonly claudianSettings: ClaudianSettingsStorage;
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
    this.ccSettings = new CCSettingsStorage(this.adapter);
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.mcp = new McpStorage(this.adapter);
  }

  /**
   * Initialize storage, running migrations if needed.
   */
  async initialize(): Promise<CombinedSettings> {
    // Ensure .claude directory structure exists
    await this.ensureDirectories();

    // Run migrations if needed
    await this.runMigrations();

    // Load both settings
    const cc = await this.ccSettings.load();
    const claudian = await this.claudianSettings.load();

    return { cc, claudian };
  }

  /**
   * Run all necessary migrations.
   */
  private async runMigrations(): Promise<void> {
    const ccExists = await this.ccSettings.exists();
    const claudianExists = await this.claudianSettings.exists();
    const dataJson = await this.loadDataJson();

    // Check if old settings.json has Claudian fields that need migration
    if (ccExists && !claudianExists) {
      await this.migrateFromOldSettingsJson();
    }

    if (dataJson) {
      const hasState = this.hasStateToMigrate(dataJson);
      const hasLegacyContent = this.hasLegacyContentToMigrate(dataJson);

      // Migrate data.json state to claudian-settings.json
      if (hasState) {
        await this.migrateFromDataJson(dataJson);
      }

      // Migrate slash commands and conversations from data.json
      let legacyContentHadErrors = false;
      if (hasLegacyContent) {
        const result = await this.migrateLegacyDataJsonContent(dataJson);
        legacyContentHadErrors = result.hadErrors;
      }

      // Clear legacy data.json only after successful migrations
      if ((hasState || hasLegacyContent) && !legacyContentHadErrors) {
        await this.clearLegacyDataJson();
      }
    }
  }

  /**
   * Check if data.json has state fields that need migration.
   */
  private hasStateToMigrate(data: LegacyDataJson): boolean {
    return (
      data.activeConversationId !== undefined ||
      data.lastEnvHash !== undefined ||
      data.lastClaudeModel !== undefined ||
      data.lastCustomModel !== undefined
    );
  }

  /**
   * Check if data.json has legacy content (slash commands or conversations).
   */
  private hasLegacyContentToMigrate(data: LegacyDataJson): boolean {
    return (
      (data.slashCommands?.length ?? 0) > 0 ||
      (data.conversations?.length ?? 0) > 0
    );
  }

  /**
   * Migrate from old settings.json (with Claudian fields) to split format.
   *
   * Handles:
   * - Legacy Claudian fields (userName, model, etc.) → claudian-settings.json
   * - Legacy permissions array → CC permissions object
   * - CC env object → Claudian environmentVariables string
   * - Preserves existing CC permissions if already in CC format
   */
  private async migrateFromOldSettingsJson(): Promise<void> {
    try {
      const content = await this.adapter.read(CC_SETTINGS_PATH);
      const oldSettings = JSON.parse(content) as LegacySettingsJson;

      // Check if this has Claudian-specific fields
      const hasClaudianFields = Array.from(CLAUDIAN_ONLY_FIELDS).some(
        field => (oldSettings as Record<string, unknown>)[field] !== undefined
      );

      if (!hasClaudianFields) {
        console.log('[Claudian] settings.json is already CC-compatible, no migration needed');
        return;
      }

      console.log('[Claudian] Migrating old settings.json to split format...');

      // Log what we're migrating for debugging
      const fieldsToMigrate = Array.from(CLAUDIAN_ONLY_FIELDS).filter(
        field => (oldSettings as Record<string, unknown>)[field] !== undefined
      );
      console.log('[Claudian] Fields to migrate:', fieldsToMigrate);

      // Handle environment variables: merge Claudian string format with CC object format
      let environmentVariables = oldSettings.environmentVariables ?? '';
      if (oldSettings.env && typeof oldSettings.env === 'object') {
        const envFromCC = convertEnvObjectToString(oldSettings.env);
        if (envFromCC) {
          console.log('[Claudian] Converting CC env object to environmentVariables');
          environmentVariables = mergeEnvironmentVariables(environmentVariables, envFromCC);
        }
      }

      // Extract Claudian-specific fields
      const claudianFields: Partial<StoredClaudianSettings> = {
        userName: oldSettings.userName ?? DEFAULT_SETTINGS.userName,
        enableBlocklist: oldSettings.enableBlocklist ?? DEFAULT_SETTINGS.enableBlocklist,
        blockedCommands: normalizeBlockedCommands(oldSettings.blockedCommands),
        model: (oldSettings.model as ClaudeModel) ?? DEFAULT_SETTINGS.model,
        thinkingBudget: (oldSettings.thinkingBudget as StoredClaudianSettings['thinkingBudget']) ?? DEFAULT_SETTINGS.thinkingBudget,
        permissionMode: (oldSettings.permissionMode as StoredClaudianSettings['permissionMode']) ?? DEFAULT_SETTINGS.permissionMode,
        excludedTags: oldSettings.excludedTags ?? DEFAULT_SETTINGS.excludedTags,
        mediaFolder: oldSettings.mediaFolder ?? DEFAULT_SETTINGS.mediaFolder,
        environmentVariables, // Merged from both sources
        envSnippets: oldSettings.envSnippets as StoredClaudianSettings['envSnippets'] ?? DEFAULT_SETTINGS.envSnippets,
        systemPrompt: oldSettings.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
        allowedExportPaths: oldSettings.allowedExportPaths ?? DEFAULT_SETTINGS.allowedExportPaths,
        persistentExternalContextPaths: DEFAULT_SETTINGS.persistentExternalContextPaths,
        keyboardNavigation: oldSettings.keyboardNavigation as StoredClaudianSettings['keyboardNavigation'] ?? DEFAULT_SETTINGS.keyboardNavigation,
        claudeCliPath: oldSettings.claudeCliPath ?? DEFAULT_SETTINGS.claudeCliPath,
        claudeCliPaths: normalizeCliPaths(oldSettings.claudeCliPaths),
        loadUserClaudeSettings: oldSettings.loadUserClaudeSettings ?? DEFAULT_SETTINGS.loadUserClaudeSettings,
        enableAutoTitleGeneration: oldSettings.enableAutoTitleGeneration ?? DEFAULT_SETTINGS.enableAutoTitleGeneration,
        titleGenerationModel: oldSettings.titleGenerationModel ?? DEFAULT_SETTINGS.titleGenerationModel,
        activeConversationId: null,
        lastClaudeModel: DEFAULT_SETTINGS.lastClaudeModel,
        lastCustomModel: DEFAULT_SETTINGS.lastCustomModel,
        lastEnvHash: DEFAULT_SETTINGS.lastEnvHash,
      };

      // Save Claudian settings FIRST (before stripping from settings.json)
      await this.claudianSettings.save(claudianFields as StoredClaudianSettings);

      // Verify Claudian settings were saved
      const savedClaudian = await this.claudianSettings.load();
      if (!savedClaudian || savedClaudian.userName === undefined) {
        throw new Error('Failed to verify claudian-settings.json was saved correctly');
      }
      console.log('[Claudian] Verified claudian-settings.json saved successfully');

      // Handle permissions: convert legacy format OR preserve existing CC format
      let ccPermissions: CCPermissions;
      if (isLegacyPermissionsFormat(oldSettings)) {
        console.log('[Claudian] Converting legacy permissions to CC format');
        ccPermissions = legacyPermissionsToCCPermissions(oldSettings.permissions);
      } else if (oldSettings.permissions && typeof oldSettings.permissions === 'object' && !Array.isArray(oldSettings.permissions)) {
        // Already in CC format - preserve it including defaultMode and additionalDirectories
        console.log('[Claudian] Preserving existing CC format permissions');
        const existingPerms = oldSettings.permissions as unknown as CCPermissions;
        ccPermissions = {
          allow: existingPerms.allow ?? [],
          deny: existingPerms.deny ?? [],
          ask: existingPerms.ask ?? [],
          defaultMode: existingPerms.defaultMode,
          additionalDirectories: existingPerms.additionalDirectories,
        };
      } else {
        console.log('[Claudian] No permissions found, using defaults');
        ccPermissions = { ...DEFAULT_CC_PERMISSIONS };
      }

      // Rewrite settings.json with only CC fields
      const ccSettings: CCSettings = {
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        permissions: ccPermissions,
      };

      // Pass true to strip Claudian-only fields during migration
      await this.ccSettings.save(ccSettings, true);

      // Verify settings.json was cleaned
      const savedCC = await this.ccSettings.load();
      console.log('[Claudian] Migration complete. Permissions:', {
        allow: savedCC.permissions?.allow?.length ?? 0,
        deny: savedCC.permissions?.deny?.length ?? 0,
        ask: savedCC.permissions?.ask?.length ?? 0,
      });
    } catch (error) {
      console.error('[Claudian] Failed to migrate old settings.json:', error);
      // Re-throw to prevent silent data loss - caller must handle migration failure
      throw error;
    }
  }

  /**
   * Migrate state from data.json to claudian-settings.json.
   */
  private async migrateFromDataJson(dataJson: LegacyDataJson): Promise<void> {
    try {
      console.log('[Claudian] Migrating state from data.json to claudian-settings.json...');

      const claudian = await this.claudianSettings.load();

      // Only migrate if not already set (claudian-settings.json takes precedence)
      if (dataJson.activeConversationId !== undefined && !claudian.activeConversationId) {
        claudian.activeConversationId = dataJson.activeConversationId;
      } else if (dataJson.activeConversationId !== undefined) {
        console.debug('[Claudian] Skipping activeConversationId migration: already set in claudian-settings.json');
      }
      if (dataJson.lastEnvHash !== undefined && !claudian.lastEnvHash) {
        claudian.lastEnvHash = dataJson.lastEnvHash;
      } else if (dataJson.lastEnvHash !== undefined) {
        console.debug('[Claudian] Skipping lastEnvHash migration: already set in claudian-settings.json');
      }
      if (dataJson.lastClaudeModel !== undefined && !claudian.lastClaudeModel) {
        claudian.lastClaudeModel = dataJson.lastClaudeModel;
      } else if (dataJson.lastClaudeModel !== undefined) {
        console.debug('[Claudian] Skipping lastClaudeModel migration: already set in claudian-settings.json');
      }
      if (dataJson.lastCustomModel !== undefined && !claudian.lastCustomModel) {
        claudian.lastCustomModel = dataJson.lastCustomModel;
      } else if (dataJson.lastCustomModel !== undefined) {
        console.debug('[Claudian] Skipping lastCustomModel migration: already set in claudian-settings.json');
      }

      await this.claudianSettings.save(claudian);

      console.log('[Claudian] State migration from data.json complete');
    } catch (error) {
      console.error('[Claudian] Failed to migrate data.json state:', error);
      // Re-throw to prevent silent state loss - caller must handle migration failure
      throw error;
    }
  }

  /**
   * Migrate slash commands and conversations from legacy data.json.
   */
  private async migrateLegacyDataJsonContent(dataJson: LegacyDataJson): Promise<{ hadErrors: boolean }> {
    let hadErrors = false;

    // Migrate slash commands
    if (dataJson.slashCommands && dataJson.slashCommands.length > 0) {
      for (const command of dataJson.slashCommands) {
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
    }

    // Migrate conversations
    if (dataJson.conversations && dataJson.conversations.length > 0) {
      for (const conversation of dataJson.conversations) {
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
    }

    if (!hadErrors && (dataJson.slashCommands?.length || dataJson.conversations?.length)) {
      console.log('[Claudian] Legacy content migration complete');
    }

    return { hadErrors };
  }

  /**
   * Clear legacy data.json after successful migration.
   */
  private async clearLegacyDataJson(): Promise<void> {
    await this.plugin.saveData({});
    console.log('[Claudian] Cleared legacy data.json');
  }

  /**
   * Load legacy data.json content.
   */
  private async loadDataJson(): Promise<LegacyDataJson | null> {
    try {
      const data = await this.plugin.loadData();
      return data || null;
    } catch (error) {
      // Log but don't throw - data.json may not exist on fresh installs
      console.warn('[Claudian] Could not load data.json:', error);
      return null;
    }
  }

  /**
   * Ensure all required directories exist.
   */
  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDE_PATH);
    await this.adapter.ensureFolder(COMMANDS_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
  }

  /**
   * Get the vault file adapter for direct file operations.
   */
  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  // ============================================================================
  // Convenience methods for common operations
  // ============================================================================

  /**
   * Get CC permissions.
   */
  async getPermissions(): Promise<CCPermissions> {
    return this.ccSettings.getPermissions();
  }

  /**
   * Update CC permissions.
   */
  async updatePermissions(permissions: CCPermissions): Promise<void> {
    return this.ccSettings.updatePermissions(permissions);
  }

  /**
   * Add a rule to allow list.
   */
  async addAllowRule(rule: string): Promise<void> {
    return this.ccSettings.addAllowRule(createPermissionRule(rule));
  }

  /**
   * Add a rule to deny list.
   */
  async addDenyRule(rule: string): Promise<void> {
    return this.ccSettings.addDenyRule(createPermissionRule(rule));
  }

  /**
   * Remove a permission rule from all lists.
   */
  async removePermissionRule(rule: string): Promise<void> {
    return this.ccSettings.removeRule(createPermissionRule(rule));
  }

  /**
   * Update active conversation ID.
   */
  async setActiveConversationId(id: string | null): Promise<void> {
    return this.claudianSettings.setActiveConversationId(id);
  }

  /**
   * Update Claudian settings.
   */
  async updateClaudianSettings(updates: Partial<StoredClaudianSettings>): Promise<void> {
    return this.claudianSettings.update(updates);
  }

  /**
   * Save Claudian settings.
   */
  async saveClaudianSettings(settings: StoredClaudianSettings): Promise<void> {
    return this.claudianSettings.save(settings);
  }

  /**
   * Load Claudian settings.
   */
  async loadClaudianSettings(): Promise<StoredClaudianSettings> {
    return this.claudianSettings.load();
  }
}
