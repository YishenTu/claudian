/**
 * GeminiCLISettingsStorage - Handles Gemini CLI-compatible settings.json read/write.
 *
 * Manages the .gemini/settings.json file in Gemini CLI compatible format.
 * This file is shared with Gemini CLI for interoperability.
 *
 * Only Gemini CLI-compatible fields are stored here:
 * - permissions (allow/deny/ask)
 * - model (optional override)
 * - env (optional environment variables)
 *
 * Geminian-specific settings go in geminian-settings.json.
 */

import type {
  GeminiCLISettings,
  GeminiPermissions,
  LegacyPermission,
  PermissionRule,
} from '../types';
import {
  DEFAULT_GEMINI_CLI_SETTINGS,
  DEFAULT_GEMINI_PERMISSIONS,
  legacyPermissionsToCCPermissions,
} from '../types';
import { GEMINIAN_ONLY_FIELDS } from './migrationConstants';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to Gemini CLI settings file relative to vault root. */
export const GEMINI_CLI_SETTINGS_PATH = '.gemini/settings.json';

/** Schema URL for Gemini CLI settings. */
const GEMINI_CLI_SETTINGS_SCHEMA = 'https://json.schemastore.org/gemini-cli-settings.json';

function hasGeminianOnlyFields(data: Record<string, unknown>): boolean {
  return Object.keys(data).some(key => GEMINIAN_ONLY_FIELDS.has(key));
}

/**
 * Check if a settings object uses the legacy Geminian permissions format.
 * Legacy format: permissions is an array of objects with toolName/pattern.
 */
export function isLegacyPermissionsFormat(data: unknown): data is { permissions: LegacyPermission[] } {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.permissions)) return false;
  if (obj.permissions.length === 0) return false;

  // Check if first item has legacy structure
  const first = obj.permissions[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    'toolName' in first &&
    'pattern' in first
  );
}

function normalizeRuleList(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is string => typeof r === 'string') as PermissionRule[];
}

function normalizePermissions(permissions: unknown): GeminiPermissions {
  if (!permissions || typeof permissions !== 'object') {
    return { ...DEFAULT_GEMINI_PERMISSIONS };
  }

  const p = permissions as Record<string, unknown>;
  return {
    allow: normalizeRuleList(p.allow),
    deny: normalizeRuleList(p.deny),
    ask: normalizeRuleList(p.ask),
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode as GeminiPermissions['defaultMode'] : undefined,
    additionalDirectories: Array.isArray(p.additionalDirectories)
      ? p.additionalDirectories.filter((d): d is string => typeof d === 'string')
      : undefined,
  };
}

/**
 * Storage for Gemini CLI-compatible settings.
 *
 * Note: Permission update methods (addAllowRule, addDenyRule, etc.) use a
 * read-modify-write pattern. Concurrent calls may race and lose updates.
 * In practice this is fine since user interactions are sequential.
 */
export class GeminiCLISettingsStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /**
   * Load Gemini CLI settings from .gemini/settings.json.
   * Returns default settings if file doesn't exist.
   * Throws if file exists but cannot be read or parsed.
   */
  async load(): Promise<GeminiCLISettings> {
    if (!(await this.adapter.exists(GEMINI_CLI_SETTINGS_PATH))) {
      return { ...DEFAULT_GEMINI_CLI_SETTINGS };
    }

    const content = await this.adapter.read(GEMINI_CLI_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;

    // Check for legacy format and migrate if needed
    if (isLegacyPermissionsFormat(stored)) {
      const legacyPerms = stored.permissions as LegacyPermission[];
      const geminiPerms = legacyPermissionsToCCPermissions(legacyPerms);

      return {
        $schema: GEMINI_CLI_SETTINGS_SCHEMA,
        ...stored,
        permissions: geminiPerms,
      };
    }

    return {
      $schema: GEMINI_CLI_SETTINGS_SCHEMA,
      ...stored,
      permissions: normalizePermissions(stored.permissions),
    };
  }

  /**
   * Save Gemini CLI settings to .gemini/settings.json.
   * Preserves unknown fields for Gemini CLI compatibility.
   *
   * @param stripGeminianFields - If true, remove Geminian-only fields (only during migration)
   */
  async save(settings: GeminiCLISettings, stripGeminianFields: boolean = false): Promise<void> {
    let existing: Record<string, unknown> = {};
    if (await this.adapter.exists(GEMINI_CLI_SETTINGS_PATH)) {
      try {
        const content = await this.adapter.read(GEMINI_CLI_SETTINGS_PATH);
        const parsed = JSON.parse(content) as Record<string, unknown>;

        if (stripGeminianFields && (isLegacyPermissionsFormat(parsed) || hasGeminianOnlyFields(parsed))) {
          existing = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (!GEMINIAN_ONLY_FIELDS.has(key)) {
              existing[key] = value;
            }
          }
          if (Array.isArray(existing.permissions)) {
            delete existing.permissions;
          }
        } else {
          existing = parsed;
        }
      } catch {
        // Parse error - start fresh with default settings
      }
    }

    const merged: GeminiCLISettings = {
      ...existing,
      $schema: GEMINI_CLI_SETTINGS_SCHEMA,
      permissions: settings.permissions ?? { ...DEFAULT_GEMINI_PERMISSIONS },
    };

    if (settings.enabledExtensions !== undefined) {
      merged.enabledExtensions = settings.enabledExtensions;
    }

    const content = JSON.stringify(merged, null, 2);
    await this.adapter.write(GEMINI_CLI_SETTINGS_PATH, content);
  }

  async exists(): Promise<boolean> {
    return this.adapter.exists(GEMINI_CLI_SETTINGS_PATH);
  }

  async getPermissions(): Promise<GeminiPermissions> {
    const settings = await this.load();
    return settings.permissions ?? { ...DEFAULT_GEMINI_PERMISSIONS };
  }

  async updatePermissions(permissions: GeminiPermissions): Promise<void> {
    const settings = await this.load();
    settings.permissions = permissions;
    await this.save(settings);
  }

  async addAllowRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.allow?.includes(rule)) {
      permissions.allow = [...(permissions.allow ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  async addDenyRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.deny?.includes(rule)) {
      permissions.deny = [...(permissions.deny ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  async addAskRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.ask?.includes(rule)) {
      permissions.ask = [...(permissions.ask ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  /**
   * Remove a rule from all lists.
   */
  async removeRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    permissions.allow = permissions.allow?.filter(r => r !== rule);
    permissions.deny = permissions.deny?.filter(r => r !== rule);
    permissions.ask = permissions.ask?.filter(r => r !== rule);
    await this.updatePermissions(permissions);
  }

  /**
   * Get enabled extensions map from Gemini CLI settings.
   * Returns empty object if not set.
   */
  async getEnabledExtensions(): Promise<Record<string, boolean>> {
    const settings = await this.load();
    return settings.enabledExtensions ?? {};
  }

  /**
   * Set extension enabled state.
   * Writes to .gemini/settings.json so CLI respects the state.
   *
   * @param extensionId - Full extension ID (e.g., "extension-name@source")
   * @param enabled - true to enable, false to disable
   */
  async setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
    const settings = await this.load();
    const enabledExtensions = settings.enabledExtensions ?? {};

    enabledExtensions[extensionId] = enabled;
    settings.enabledExtensions = enabledExtensions;

    await this.save(settings);
  }

  /**
   * Get list of extension IDs that are explicitly enabled.
   */
  async getExplicitlyEnabledExtensionIds(): Promise<string[]> {
    const enabledExtensions = await this.getEnabledExtensions();
    return Object.entries(enabledExtensions)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);
  }

  /**
   * Check if an extension is explicitly disabled.
   * Returns true only if the extension is set to false.
   * Returns false if not set (inherits from global) or set to true.
   */
  async isExtensionDisabled(extensionId: string): Promise<boolean> {
    const enabledExtensions = await this.getEnabledExtensions();
    return enabledExtensions[extensionId] === false;
  }
}
