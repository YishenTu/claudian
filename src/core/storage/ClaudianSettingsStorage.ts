/**
 * GeminianSettingsStorage - Handles geminian-settings.json read/write.
 *
 * Manages the .gemini/geminian-settings.json file for Geminian-specific settings.
 * These settings are NOT shared with Gemini CLI.
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

import type { GeminianSettings, GeminiModel, PlatformBlockedCommands } from '../types';
import { DEFAULT_SETTINGS, getDefaultBlockedCommands } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to Geminian settings file relative to vault root. */
export const GEMINIAN_SETTINGS_PATH = '.gemini/geminian-settings.json';

/** Fields that are loaded separately (slash commands from .gemini/commands/). */
type SeparatelyLoadedFields = 'slashCommands';

/** Settings stored in .gemini/geminian-settings.json. */
export type StoredGeminianSettings = Omit<GeminianSettings, SeparatelyLoadedFields>;

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

export class GeminianSettingsStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /**
  * Load Geminian settings from .gemini/geminian-settings.json.
  * Returns default settings if file doesn't exist.
  * Throws if file exists but cannot be read or parsed.
  */
  async load(): Promise<StoredGeminianSettings> {
    if (!(await this.adapter.exists(GEMINIAN_SETTINGS_PATH))) {
      return this.getDefaults();
    }

    const content = await this.adapter.read(GEMINIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const { activeConversationId: _activeConversationId, ...storedWithoutLegacy } = stored;

    const blockedCommands = normalizeBlockedCommands(stored.blockedCommands);
    const hostnameCliPaths = normalizeHostnameCliPaths(stored.geminiCliPathsByHost);
    const legacyCliPath = typeof stored.geminiCliPath === 'string' ? stored.geminiCliPath : '';

    return {
      ...this.getDefaults(),
      ...storedWithoutLegacy,
      blockedCommands,
      geminiCliPath: legacyCliPath,
      geminiCliPathsByHost: hostnameCliPaths,
    } as StoredGeminianSettings;
  }

  async save(settings: StoredGeminianSettings): Promise<void> {
    const content = JSON.stringify(settings, null, 2);
    await this.adapter.write(GEMINIAN_SETTINGS_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(GEMINIAN_SETTINGS_PATH);
  }

  async update(updates: Partial<StoredGeminianSettings>): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, ...updates });
  }

  /**
   * Read legacy activeConversationId from geminian-settings.json, if present.
   * Used only for one-time migration to tabManagerState.
   */
  async getLegacyActiveConversationId(): Promise<string | null> {
    if (!(await this.adapter.exists(GEMINIAN_SETTINGS_PATH))) {
      return null;
    }

    const content = await this.adapter.read(GEMINIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const value = stored.activeConversationId;

    if (typeof value === 'string') {
      return value;
    }

    return null;
  }

  /**
   * Remove legacy activeConversationId from geminian-settings.json.
   */
  async clearLegacyActiveConversationId(): Promise<void> {
    if (!(await this.adapter.exists(GEMINIAN_SETTINGS_PATH))) {
      return;
    }

    const content = await this.adapter.read(GEMINIAN_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;

    if (!('activeConversationId' in stored)) {
      return;
    }

    delete stored.activeConversationId;
    const nextContent = JSON.stringify(stored, null, 2);
    await this.adapter.write(GEMINIAN_SETTINGS_PATH, nextContent);
  }

  async setLastModel(model: GeminiModel, isCustom: boolean): Promise<void> {
    if (isCustom) {
      await this.update({ lastCustomModel: model });
    } else {
      await this.update({ lastGeminiModel: model });
    }
  }

  async setLastEnvHash(hash: string): Promise<void> {
    await this.update({ lastEnvHash: hash });
  }

  /**
   * Get default settings (excluding separately loaded fields).
   */
  private getDefaults(): StoredGeminianSettings {
    const {
      slashCommands: _,
      ...defaults
    } = DEFAULT_SETTINGS;

    return defaults;
  }
}
