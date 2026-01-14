/**
 * ClaudianSettingsStorage - Handles claudian-settings.json read/write.
 *
 * Manages the .claude/claudian-settings.json file for Claudian-specific settings.
 * These settings are NOT shared with Claude Code CLI.
 *
 * Includes:
 * - User preferences (userName)
 * - Security (blocklist, permission mode)
 * - Model & thinking settings
 * - Content settings (tags, media, prompts)
 * - Environment (string format, snippets)
 * - UI settings (keyboard navigation)
 * - CLI paths
 * - State (merged from data.json)
 */

import type { ClaudeModel, ClaudianSettings, PlatformBlockedCommands } from '../types';
import { DEFAULT_SETTINGS, getDefaultBlockedCommands } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to Claudian settings file relative to vault root. */
export const CLAUDIAN_SETTINGS_PATH = '.claude/claudian-settings.json';

/** Fields that are loaded separately (slash commands from .claude/commands/). */
type SeparatelyLoadedFields = 'slashCommands';

/** Settings stored in .claude/claudian-settings.json. */
export type StoredClaudianSettings = Omit<ClaudianSettings, SeparatelyLoadedFields>;

/**
 * Normalize a command list, filtering invalid entries.
 */
function normalizeCommandList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Normalize platform-keyed blocked commands.
 */
export function normalizeBlockedCommands(value: unknown): PlatformBlockedCommands {
  const defaults = getDefaultBlockedCommands();

  // Migrate old string[] format to new platform-keyed structure
  if (Array.isArray(value)) {
    return {
      unix: normalizeCommandList(value, defaults.unix),
      windows: [...defaults.windows],
    };
  }

  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  return {
    unix: normalizeCommandList(candidate.unix, defaults.unix),
    windows: normalizeCommandList(candidate.windows, defaults.windows),
  };
}

/**
 * Normalize hostname-keyed CLI paths.
 */
function normalizeHostnameCliPaths(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && val.trim()) {
      result[key] = val.trim();
    }
  }
  return result;
}

export class ClaudianSettingsStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /**
  * Load Claudian settings from .claude/claudian-settings.json.
  * Returns default settings if file doesn't exist.
  * Throws if file exists but cannot be read or parsed.
  */
  async load(): Promise<StoredClaudianSettings> {
    if (!(await this.adapter.exists(CLAUDIAN_SETTINGS_PATH))) {
      return this.getDefaults();
    }

    const content = await this.adapter.read(CLAUDIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const { activeConversationId: _activeConversationId, ...storedWithoutLegacy } = stored;

    // Normalize complex fields
    const blockedCommands = normalizeBlockedCommands(stored.blockedCommands);
    const hostnameCliPaths = normalizeHostnameCliPaths(stored.claudeCliPathsByHost);
    const legacyCliPath = typeof stored.claudeCliPath === 'string' ? stored.claudeCliPath : '';

    return {
      ...this.getDefaults(),
      ...storedWithoutLegacy,
      blockedCommands,
      claudeCliPath: legacyCliPath,
      claudeCliPathsByHost: hostnameCliPaths,
    } as StoredClaudianSettings;
  }

  /**
   * Save Claudian settings to .claude/claudian-settings.json.
   */
  async save(settings: StoredClaudianSettings): Promise<void> {
    const content = JSON.stringify(settings, null, 2);
    await this.adapter.write(CLAUDIAN_SETTINGS_PATH, content);
  }

  /**
   * Check if settings file exists.
   */
  async exists(): Promise<boolean> {
    return this.adapter.exists(CLAUDIAN_SETTINGS_PATH);
  }

  /**
   * Update specific fields in settings.
   */
  async update(updates: Partial<StoredClaudianSettings>): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, ...updates });
  }

  /**
   * Read legacy activeConversationId from claudian-settings.json, if present.
   * Used only for one-time migration to tabManagerState.
   */
  async getLegacyActiveConversationId(): Promise<string | null> {
    if (!(await this.adapter.exists(CLAUDIAN_SETTINGS_PATH))) {
      return null;
    }

    const content = await this.adapter.read(CLAUDIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const value = stored.activeConversationId;

    if (typeof value === 'string') {
      return value;
    }

    return null;
  }

  /**
   * Remove legacy activeConversationId from claudian-settings.json.
   */
  async clearLegacyActiveConversationId(): Promise<void> {
    if (!(await this.adapter.exists(CLAUDIAN_SETTINGS_PATH))) {
      return;
    }

    const content = await this.adapter.read(CLAUDIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;

    if (!('activeConversationId' in stored)) {
      return;
    }

    delete stored.activeConversationId;
    const nextContent = JSON.stringify(stored, null, 2);
    await this.adapter.write(CLAUDIAN_SETTINGS_PATH, nextContent);
  }

  /**
   * Update last used model.
   */
  async setLastModel(model: ClaudeModel, isCustom: boolean): Promise<void> {
    if (isCustom) {
      await this.update({ lastCustomModel: model });
    } else {
      await this.update({ lastClaudeModel: model });
    }
  }

  /**
   * Update environment hash.
   */
  async setLastEnvHash(hash: string): Promise<void> {
    await this.update({ lastEnvHash: hash });
  }

  /**
   * Get default settings (excluding separately loaded fields).
   */
  private getDefaults(): StoredClaudianSettings {
    const {
      slashCommands: _,
      ...defaults
    } = DEFAULT_SETTINGS;

    return defaults;
  }
}
