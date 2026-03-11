/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - Gemini CLI settings in .gemini/settings.json (Gemini CLI-compatible, shareable)
 * - Geminian settings in .gemini/geminian-settings.json (Geminian-specific)
 * - Slash commands in .gemini/commands/*.md
 * - Chat sessions in .gemini/sessions/*.jsonl
 * - MCP configs in .gemini/mcp.json
 *
 * Handles migration from legacy formats:
 * - Old settings.json with Geminian fields → split into Gemini CLI + Geminian files
 * - Old permissions array → Gemini CLI permissions object
 * - data.json state → geminian-settings.json
 */

import type { App, Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import type {
  Conversation,
  GeminiCLISettings,
  GeminiModel,
  GeminiPermissions,
  LegacyPermission,
  SlashCommand,
} from '../types';
import {
  createPermissionRule,
  DEFAULT_GEMINI_PERMISSIONS,
  DEFAULT_SETTINGS,
  legacyPermissionsToCCPermissions,
} from '../types';
import { AGENTS_PATH, AgentVaultStorage } from './AgentVaultStorage';
import { GEMINI_CLI_SETTINGS_PATH, GeminiCLISettingsStorage, isLegacyPermissionsFormat } from './CCSettingsStorage';
import {
  GeminianSettingsStorage,
  normalizeBlockedCommands,
  type StoredGeminianSettings,
} from './ClaudianSettingsStorage';
import { McpStorage } from './McpStorage';
import {
  convertEnvObjectToString,
  GEMINIAN_ONLY_FIELDS,
  mergeEnvironmentVariables,
} from './migrationConstants';
import { SESSIONS_PATH, SessionStorage } from './SessionStorage';
import { SKILLS_PATH, SkillStorage } from './SkillStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
import { VaultFileAdapter } from './VaultFileAdapter';

/** Base path for all Geminian storage. */
export const GEMINI_PATH = '.gemini';

/** Legacy settings path (now Gemini CLI settings). */
export const SETTINGS_PATH = GEMINI_CLI_SETTINGS_PATH;

/**
 * Combined settings for the application.
 * Merges Gemini CLI settings (permissions) with Geminian settings.
 */
export interface CombinedSettings {
  /** Gemini CLI-compatible settings (permissions, etc.) */
  geminiCli: GeminiCLISettings;
  /** Geminian-specific settings */
  geminian: StoredGeminianSettings;
}

/** Legacy data format (pre-split migration). */
interface LegacySettingsJson {
  // Old Geminian fields that were in settings.json
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
  geminiCliPath?: string;
  geminiCliPaths?: unknown;
  loadUserGeminiSettings?: boolean;
  enableAutoTitleGeneration?: boolean;
  titleGenerationModel?: string;

  // Gemini CLI fields
  $schema?: string;
  env?: Record<string, string>;
}

/** Legacy data.json format. */
interface LegacyDataJson {
  activeConversationId?: string | null;
  lastEnvHash?: string;
  lastGeminiModel?: GeminiModel;
  lastCustomModel?: GeminiModel;
  conversations?: Conversation[];
  slashCommands?: SlashCommand[];
  migrationVersion?: number;
  [key: string]: unknown;
}

export class StorageService {
  readonly geminiCliSettings: GeminiCLISettingsStorage;
  readonly geminianSettings: GeminianSettingsStorage;
  readonly commands: SlashCommandStorage;
  readonly skills: SkillStorage;
  readonly sessions: SessionStorage;
  readonly mcp: McpStorage;
  readonly agents: AgentVaultStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private app: App;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.adapter = new VaultFileAdapter(this.app);
    this.geminiCliSettings = new GeminiCLISettingsStorage(this.adapter);
    this.geminianSettings = new GeminianSettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.skills = new SkillStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.mcp = new McpStorage(this.adapter);
    this.agents = new AgentVaultStorage(this.adapter);
  }

  async initialize(): Promise<CombinedSettings> {
    await this.ensureDirectories();
    await this.runMigrations();

    const geminiCli = await this.geminiCliSettings.load();
    const geminian = await this.geminianSettings.load();

    return { geminiCli, geminian };
  }

  private async runMigrations(): Promise<void> {
    const geminiCliExists = await this.geminiCliSettings.exists();
    const geminianExists = await this.geminianSettings.exists();
    const dataJson = await this.loadDataJson();

    // Check if old settings.json has Geminian fields that need migration
    if (geminiCliExists && !geminianExists) {
      await this.migrateFromOldSettingsJson();
    }

    if (dataJson) {
      const hasState = this.hasStateToMigrate(dataJson);
      const hasLegacyContent = this.hasLegacyContentToMigrate(dataJson);

      // Migrate data.json state to geminian-settings.json
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

  private hasStateToMigrate(data: LegacyDataJson): boolean {
    return (
      data.lastEnvHash !== undefined ||
      data.lastGeminiModel !== undefined ||
      data.lastCustomModel !== undefined
    );
  }

  private hasLegacyContentToMigrate(data: LegacyDataJson): boolean {
    return (
      (data.slashCommands?.length ?? 0) > 0 ||
      (data.conversations?.length ?? 0) > 0
    );
  }

  /**
   * Migrate from old settings.json (with Geminian fields) to split format.
   *
   * Handles:
   * - Legacy Geminian fields (userName, model, etc.) → geminian-settings.json
   * - Legacy permissions array → Gemini CLI permissions object
   * - Gemini CLI env object → Geminian environmentVariables string
   * - Preserves existing permissions if already in Gemini CLI format
   */
  private async migrateFromOldSettingsJson(): Promise<void> {
    const content = await this.adapter.read(GEMINI_CLI_SETTINGS_PATH);
    const oldSettings = JSON.parse(content) as LegacySettingsJson;

    const hasGeminianFields = Array.from(GEMINIAN_ONLY_FIELDS).some(
      field => (oldSettings as Record<string, unknown>)[field] !== undefined
    );

    if (!hasGeminianFields) {
      return;
    }

    let environmentVariables = oldSettings.environmentVariables ?? '';
    if (oldSettings.env && typeof oldSettings.env === 'object') {
      const envFromCli = convertEnvObjectToString(oldSettings.env);
      if (envFromCli) {
        environmentVariables = mergeEnvironmentVariables(environmentVariables, envFromCli);
      }
    }

    const geminianFields: Partial<StoredGeminianSettings> = {
      userName: oldSettings.userName ?? DEFAULT_SETTINGS.userName,
      enableBlocklist: oldSettings.enableBlocklist ?? DEFAULT_SETTINGS.enableBlocklist,
      blockedCommands: normalizeBlockedCommands(oldSettings.blockedCommands),
      model: (oldSettings.model as GeminiModel) ?? DEFAULT_SETTINGS.model,
      thinkingBudget: (oldSettings.thinkingBudget as StoredGeminianSettings['thinkingBudget']) ?? DEFAULT_SETTINGS.thinkingBudget,
      permissionMode: (oldSettings.permissionMode as StoredGeminianSettings['permissionMode']) ?? DEFAULT_SETTINGS.permissionMode,
      excludedTags: oldSettings.excludedTags ?? DEFAULT_SETTINGS.excludedTags,
      mediaFolder: oldSettings.mediaFolder ?? DEFAULT_SETTINGS.mediaFolder,
      environmentVariables,
      envSnippets: oldSettings.envSnippets as StoredGeminianSettings['envSnippets'] ?? DEFAULT_SETTINGS.envSnippets,
      systemPrompt: oldSettings.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
      allowedExportPaths: oldSettings.allowedExportPaths ?? DEFAULT_SETTINGS.allowedExportPaths,
      persistentExternalContextPaths: DEFAULT_SETTINGS.persistentExternalContextPaths,
      keyboardNavigation: oldSettings.keyboardNavigation as StoredGeminianSettings['keyboardNavigation'] ?? DEFAULT_SETTINGS.keyboardNavigation,
      geminiCliPath: oldSettings.geminiCliPath ?? DEFAULT_SETTINGS.geminiCliPath,
      geminiCliPathsByHost: DEFAULT_SETTINGS.geminiCliPathsByHost,
      loadUserGeminiSettings: oldSettings.loadUserGeminiSettings ?? DEFAULT_SETTINGS.loadUserGeminiSettings,
      enableAutoTitleGeneration: oldSettings.enableAutoTitleGeneration ?? DEFAULT_SETTINGS.enableAutoTitleGeneration,
      titleGenerationModel: oldSettings.titleGenerationModel ?? DEFAULT_SETTINGS.titleGenerationModel,
      lastGeminiModel: DEFAULT_SETTINGS.lastGeminiModel,
      lastCustomModel: DEFAULT_SETTINGS.lastCustomModel,
      lastEnvHash: DEFAULT_SETTINGS.lastEnvHash,
    };

    await this.geminianSettings.save(geminianFields as StoredGeminianSettings);

    const savedGeminian = await this.geminianSettings.load();
    if (!savedGeminian || savedGeminian.userName === undefined) {
      throw new Error('Failed to verify geminian-settings.json was saved correctly');
    }

    let geminiPermissions: GeminiPermissions;
    if (isLegacyPermissionsFormat(oldSettings)) {
      geminiPermissions = legacyPermissionsToCCPermissions(oldSettings.permissions);
    } else if (oldSettings.permissions && typeof oldSettings.permissions === 'object' && !Array.isArray(oldSettings.permissions)) {
      const existingPerms = oldSettings.permissions as unknown as GeminiPermissions;
      geminiPermissions = {
        allow: existingPerms.allow ?? [],
        deny: existingPerms.deny ?? [],
        ask: existingPerms.ask ?? [],
        defaultMode: existingPerms.defaultMode,
        additionalDirectories: existingPerms.additionalDirectories,
      };
    } else {
      geminiPermissions = { ...DEFAULT_GEMINI_PERMISSIONS };
    }

    const geminiCliSettings: GeminiCLISettings = {
      $schema: 'https://json.schemastore.org/gemini-cli-settings.json',
      permissions: geminiPermissions,
    };

    await this.geminiCliSettings.save(geminiCliSettings, true);
  }

  private async migrateFromDataJson(dataJson: LegacyDataJson): Promise<void> {
    const geminian = await this.geminianSettings.load();

    if (dataJson.lastEnvHash !== undefined && !geminian.lastEnvHash) {
      geminian.lastEnvHash = dataJson.lastEnvHash;
    }
    if (dataJson.lastGeminiModel !== undefined && !geminian.lastGeminiModel) {
      geminian.lastGeminiModel = dataJson.lastGeminiModel;
    }
    if (dataJson.lastCustomModel !== undefined && !geminian.lastCustomModel) {
      geminian.lastCustomModel = dataJson.lastCustomModel;
    }

    await this.geminianSettings.save(geminian);
  }

  private async migrateLegacyDataJsonContent(dataJson: LegacyDataJson): Promise<{ hadErrors: boolean }> {
    let hadErrors = false;

    if (dataJson.slashCommands && dataJson.slashCommands.length > 0) {
      for (const command of dataJson.slashCommands) {
        try {
          const filePath = this.commands.getFilePath(command);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.commands.save(command);
        } catch {
          hadErrors = true;
        }
      }
    }

    if (dataJson.conversations && dataJson.conversations.length > 0) {
      for (const conversation of dataJson.conversations) {
        try {
          const filePath = this.sessions.getFilePath(conversation.id);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.sessions.saveConversation(conversation);
        } catch {
          hadErrors = true;
        }
      }
    }

    return { hadErrors };
  }

  private async clearLegacyDataJson(): Promise<void> {
    const dataJson = await this.loadDataJson();
    if (!dataJson) {
      return;
    }

    const cleaned: Record<string, unknown> = { ...dataJson };
    delete cleaned.lastEnvHash;
    delete cleaned.lastGeminiModel;
    delete cleaned.lastCustomModel;
    delete cleaned.conversations;
    delete cleaned.slashCommands;
    delete cleaned.migrationVersion;

    if (Object.keys(cleaned).length === 0) {
      await this.plugin.saveData({});
      return;
    }

    await this.plugin.saveData(cleaned);
  }

  private async loadDataJson(): Promise<LegacyDataJson | null> {
    try {
      const data = await this.plugin.loadData();
      return data || null;
    } catch {
      // data.json may not exist on fresh installs
      return null;
    }
  }

  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(GEMINI_PATH);
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

  async getPermissions(): Promise<GeminiPermissions> {
    return this.geminiCliSettings.getPermissions();
  }

  async updatePermissions(permissions: GeminiPermissions): Promise<void> {
    return this.geminiCliSettings.updatePermissions(permissions);
  }

  async addAllowRule(rule: string): Promise<void> {
    return this.geminiCliSettings.addAllowRule(createPermissionRule(rule));
  }

  async addDenyRule(rule: string): Promise<void> {
    return this.geminiCliSettings.addDenyRule(createPermissionRule(rule));
  }

  async removePermissionRule(rule: string): Promise<void> {
    return this.geminiCliSettings.removeRule(createPermissionRule(rule));
  }

  async updateGeminianSettings(updates: Partial<StoredGeminianSettings>): Promise<void> {
    return this.geminianSettings.update(updates);
  }

  async saveGeminianSettings(settings: StoredGeminianSettings): Promise<void> {
    return this.geminianSettings.save(settings);
  }

  async loadGeminianSettings(): Promise<StoredGeminianSettings> {
    return this.geminianSettings.load();
  }

  /**
   * Get legacy activeConversationId from storage (geminian-settings.json or data.json).
   */
  async getLegacyActiveConversationId(): Promise<string | null> {
    const fromSettings = await this.geminianSettings.getLegacyActiveConversationId();
    if (fromSettings) {
      return fromSettings;
    }

    const dataJson = await this.loadDataJson();
    if (dataJson && typeof dataJson.activeConversationId === 'string') {
      return dataJson.activeConversationId;
    }

    return null;
  }

  /**
   * Remove legacy activeConversationId from storage after migration.
   */
  async clearLegacyActiveConversationId(): Promise<void> {
    await this.geminianSettings.clearLegacyActiveConversationId();

    const dataJson = await this.loadDataJson();
    if (!dataJson || !('activeConversationId' in dataJson)) {
      return;
    }

    const cleaned: Record<string, unknown> = { ...dataJson };
    delete cleaned.activeConversationId;
    await this.plugin.saveData(cleaned);
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
