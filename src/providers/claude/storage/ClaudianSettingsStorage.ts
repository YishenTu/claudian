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

import {
  normalizeHiddenProviderCommands,
} from '../../../core/providers/commands/hiddenCommands';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type { PlatformBlockedCommands } from '../../../core/types';
import { getDefaultBlockedCommands } from '../../../core/types';
import type { ClaudianSettings } from '../../../core/types/settings';
import type { ClaudeModel } from '../types/models';
import { DEFAULT_SETTINGS } from '../types/settings';

/** Path to Claudian settings file relative to vault root. */
export const CLAUDIAN_SETTINGS_PATH = '.claude/claudian-settings.json';

/** Settings stored in .claude/claudian-settings.json. */
export type StoredClaudianSettings = ClaudianSettings;

function stripLegacyFields(settings: Record<string, unknown>): Record<string, unknown> {
  const {
    activeConversationId: _activeConversationId,
    show1MModel: _show1MModel,
    hiddenSlashCommands: _hiddenSlashCommands,
    slashCommands: _slashCommands,
    ...cleaned
  } = settings;
  return cleaned;
}

function normalizeCommandList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

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
    const hiddenProviderCommands = normalizeHiddenProviderCommands(
      stored.hiddenProviderCommands,
      stored.hiddenSlashCommands,
    );
    const storedWithoutLegacy = stripLegacyFields({
      ...stored,
      hiddenProviderCommands,
    });

    // Remove legacy persisted fields from disk when present.
    if (
      'show1MModel' in stored
      || 'slashCommands' in stored
      || 'hiddenSlashCommands' in stored
      || 'activeConversationId' in stored
    ) {
      await this.adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify(storedWithoutLegacy, null, 2));
    }

    const blockedCommands = normalizeBlockedCommands(stored.blockedCommands);
    const claudeHostnameCliPaths = normalizeHostnameCliPaths(stored.claudeCliPathsByHost);
    const codexHostnameCliPaths = normalizeHostnameCliPaths(stored.codexCliPathsByHost);
    const legacyCliPath = typeof stored.claudeCliPath === 'string' ? stored.claudeCliPath : '';
    const legacyCodexCliPath = typeof stored.codexCliPath === 'string' ? stored.codexCliPath : '';

    return {
      ...this.getDefaults(),
      ...storedWithoutLegacy,
      blockedCommands,
      claudeCliPath: legacyCliPath,
      claudeCliPathsByHost: claudeHostnameCliPaths,
      codexCliPath: legacyCodexCliPath,
      codexCliPathsByHost: codexHostnameCliPaths,
      hiddenProviderCommands,
    } as StoredClaudianSettings;
  }

  async save(settings: StoredClaudianSettings): Promise<void> {
    const content = JSON.stringify(
      stripLegacyFields(settings as unknown as Record<string, unknown>),
      null,
      2,
    );
    await this.adapter.write(CLAUDIAN_SETTINGS_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(CLAUDIAN_SETTINGS_PATH);
  }

  async update(updates: Partial<StoredClaudianSettings>): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, ...updates });
  }

  async setLastModel(model: ClaudeModel, isCustom: boolean): Promise<void> {
    if (isCustom) {
      await this.update({ lastCustomModel: model });
    } else {
      await this.update({ lastClaudeModel: model });
    }
  }

  async setLastEnvHash(hash: string): Promise<void> {
    await this.update({ lastEnvHash: hash });
  }

  /**
   * Get default settings (excluding separately loaded fields).
   */
  private getDefaults(): StoredClaudianSettings {
    return DEFAULT_SETTINGS;
  }
}
