/**
 * SettingsStorage - Handles settings.json read/write in vault/.claude/
 *
 * Settings are stored as JSON in the vault's .claude/settings.json file.
 * This replaces the previous approach of storing settings in Obsidian's data.json.
 *
 * User-facing settings go here (including permissions, like Claude Code).
 * Machine-specific state (lastEnvHash, model tracking) stays in Obsidian's data.json.
 */

import type { ClaudianSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Fields that are machine-specific state or loaded separately. */
type StateFields =
  | 'slashCommands'
  | 'lastEnvHash'
  | 'lastClaudeModel'
  | 'lastCustomModel';

/** Settings stored in .claude/settings.json (user-facing, shareable). */
export type StoredSettings = Omit<ClaudianSettings, StateFields>;

/** Path to settings file relative to vault root. */
export const SETTINGS_PATH = '.claude/settings.json';

export class SettingsStorage {
  constructor(private adapter: VaultFileAdapter) {}

  /** Load settings from .claude/settings.json, merging with defaults. */
  async load(): Promise<StoredSettings> {
    try {
      if (!(await this.adapter.exists(SETTINGS_PATH))) {
        return this.getDefaults();
      }

      const content = await this.adapter.read(SETTINGS_PATH);
      const stored = JSON.parse(content) as Partial<StoredSettings>;
      return { ...this.getDefaults(), ...stored };
    } catch (error) {
      console.error('[Claudian] Failed to load settings:', error);
      return this.getDefaults();
    }
  }

  /** Save settings to .claude/settings.json. */
  async save(settings: StoredSettings): Promise<void> {
    try {
      const content = JSON.stringify(settings, null, 2);
      await this.adapter.write(SETTINGS_PATH, content);
    } catch (error) {
      console.error('[Claudian] Failed to save settings:', error);
      throw error;
    }
  }

  /** Check if settings file exists. */
  async exists(): Promise<boolean> {
    return this.adapter.exists(SETTINGS_PATH);
  }

  /** Get default settings (excluding state fields). */
  private getDefaults(): StoredSettings {
    const {
      slashCommands: _,
      lastEnvHash: __,
      lastClaudeModel: ___,
      lastCustomModel: ____,
      ...defaults
    } = DEFAULT_SETTINGS;
    return defaults;
  }
}
