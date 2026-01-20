/**
 * CCSettingsStorage - Handles CC-compatible settings.json read/write.
 *
 * Manages the .claude/settings.json file in Claude Code compatible format.
 * This file is shared with Claude Code CLI for interoperability.
 *
 * Only CC-compatible fields are stored here:
 * - permissions (allow/deny/ask)
 * - model (optional override)
 * - env (optional environment variables)
 *
 * Claudian-specific settings go in claudian-settings.json.
 */

import type {
  CCPermissions,
  CCSettings,
  LegacyPermission,
  PermissionRule,
} from '../types';
import {
  DEFAULT_CC_PERMISSIONS,
  DEFAULT_CC_SETTINGS,
  legacyPermissionsToCCPermissions,
} from '../types';
import { CLAUDIAN_ONLY_FIELDS } from './migrationConstants';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Path to CC settings file relative to vault root. */
export const CC_SETTINGS_PATH = '.claude/settings.json';

/** Schema URL for CC settings. */
const CC_SETTINGS_SCHEMA = 'https://json.schemastore.org/claude-code-settings.json';

/**
 * Check if a settings object contains any Claudian-only fields.
 */
function hasClaudianOnlyFields(data: Record<string, unknown>): boolean {
  return Object.keys(data).some(key => CLAUDIAN_ONLY_FIELDS.has(key));
}

/**
 * Check if a settings object uses the legacy Claudian permissions format.
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

/**
 * Normalize permissions to ensure all arrays exist.
 */
function normalizePermissions(permissions: unknown): CCPermissions {
  if (!permissions || typeof permissions !== 'object') {
    return { ...DEFAULT_CC_PERMISSIONS };
  }

  const p = permissions as Record<string, unknown>;
  return {
    allow: Array.isArray(p.allow) ? p.allow.filter((r): r is string => typeof r === 'string').map(r => r as PermissionRule) : [],
    deny: Array.isArray(p.deny) ? p.deny.filter((r): r is string => typeof r === 'string').map(r => r as PermissionRule) : [],
    ask: Array.isArray(p.ask) ? p.ask.filter((r): r is string => typeof r === 'string').map(r => r as PermissionRule) : [],
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode as CCPermissions['defaultMode'] : undefined,
    additionalDirectories: Array.isArray(p.additionalDirectories)
      ? p.additionalDirectories.filter((d): d is string => typeof d === 'string')
      : undefined,
  };
}

/**
 * Storage for CC-compatible settings.
 *
 * Note: Permission update methods (addAllowRule, addDenyRule, etc.) use a
 * read-modify-write pattern. Concurrent calls may race and lose updates.
 * In practice this is fine since user interactions are sequential.
 */
export class CCSettingsStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /**
   * Load CC settings from .claude/settings.json.
   * Returns default settings if file doesn't exist.
   * Throws if file exists but cannot be read or parsed.
   */
  async load(): Promise<CCSettings> {
    if (!(await this.adapter.exists(CC_SETTINGS_PATH))) {
      return { ...DEFAULT_CC_SETTINGS };
    }

    const content = await this.adapter.read(CC_SETTINGS_PATH);
    const stored = JSON.parse(content) as Record<string, unknown>;

    // Check for legacy format and migrate if needed
    if (isLegacyPermissionsFormat(stored)) {
      const legacyPerms = stored.permissions as LegacyPermission[];
      const ccPerms = legacyPermissionsToCCPermissions(legacyPerms);

      // Return migrated permissions but keep other CC fields
      return {
        $schema: CC_SETTINGS_SCHEMA,
        ...stored,
        permissions: ccPerms,
      };
    }

    // Normalize permissions
    return {
      $schema: CC_SETTINGS_SCHEMA,
      ...stored,
      permissions: normalizePermissions(stored.permissions),
    };
  }

  /**
   * Save CC settings to .claude/settings.json.
   * Preserves unknown fields for CC compatibility.
   *
   * @param stripClaudianFields - If true, remove Claudian-only fields (only during migration)
   */
  async save(settings: CCSettings, stripClaudianFields: boolean = false): Promise<void> {
    // Load existing to preserve CC-specific fields we don't manage
    let existing: Record<string, unknown> = {};
    if (await this.adapter.exists(CC_SETTINGS_PATH)) {
      try {
        const content = await this.adapter.read(CC_SETTINGS_PATH);
        const parsed = JSON.parse(content) as Record<string, unknown>;

        // Only strip Claudian-only fields during explicit migration
        if (stripClaudianFields && (isLegacyPermissionsFormat(parsed) || hasClaudianOnlyFields(parsed))) {
          existing = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (!CLAUDIAN_ONLY_FIELDS.has(key)) {
              existing[key] = value;
            }
          }
          // Also strip legacy permissions array format
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

    // Merge: existing CC fields + our updates
    const merged: CCSettings = {
      ...existing,
      $schema: CC_SETTINGS_SCHEMA,
      permissions: settings.permissions ?? { ...DEFAULT_CC_PERMISSIONS },
    };

    // Include enabledPlugins if present in settings
    if (settings.enabledPlugins !== undefined) {
      merged.enabledPlugins = settings.enabledPlugins;
    }

    const content = JSON.stringify(merged, null, 2);
    await this.adapter.write(CC_SETTINGS_PATH, content);
  }

  /**
   * Check if settings file exists.
   */
  async exists(): Promise<boolean> {
    return this.adapter.exists(CC_SETTINGS_PATH);
  }

  /**
   * Get permissions from CC settings.
   */
  async getPermissions(): Promise<CCPermissions> {
    const settings = await this.load();
    return settings.permissions ?? { ...DEFAULT_CC_PERMISSIONS };
  }

  /**
   * Update permissions in CC settings.
   */
  async updatePermissions(permissions: CCPermissions): Promise<void> {
    const settings = await this.load();
    settings.permissions = permissions;
    await this.save(settings);
  }

  /**
   * Add a rule to the allow list.
   */
  async addAllowRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.allow?.includes(rule)) {
      permissions.allow = [...(permissions.allow ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  /**
   * Add a rule to the deny list.
   */
  async addDenyRule(rule: PermissionRule): Promise<void> {
    const permissions = await this.getPermissions();
    if (!permissions.deny?.includes(rule)) {
      permissions.deny = [...(permissions.deny ?? []), rule];
      await this.updatePermissions(permissions);
    }
  }

  /**
   * Add a rule to the ask list.
   */
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

  // ============================================
  // Plugin Methods
  // ============================================

  /**
   * Get enabled plugins map from CC settings.
   * Returns empty object if not set.
   */
  async getEnabledPlugins(): Promise<Record<string, boolean>> {
    const settings = await this.load();
    return settings.enabledPlugins ?? {};
  }

  /**
   * Set plugin enabled state.
   * Writes to .claude/settings.json so CLI respects the state.
   *
   * @param pluginId - Full plugin ID (e.g., "plugin-name@source")
   * @param enabled - true to enable, false to disable
   */
  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const settings = await this.load();
    const enabledPlugins = settings.enabledPlugins ?? {};

    enabledPlugins[pluginId] = enabled;
    settings.enabledPlugins = enabledPlugins;

    await this.save(settings);
  }

  /**
   * Get list of plugin IDs that are explicitly enabled.
   * Used for PluginManager initialization.
   */
  async getExplicitlyEnabledPluginIds(): Promise<string[]> {
    const enabledPlugins = await this.getEnabledPlugins();
    return Object.entries(enabledPlugins)
      .filter(([, enabled]) => enabled === true)
      .map(([id]) => id);
  }

  /**
   * Check if a plugin is explicitly disabled.
   * Returns true only if the plugin is set to false.
   * Returns false if not set (inherits from global) or set to true.
   */
  async isPluginDisabled(pluginId: string): Promise<boolean> {
    const enabledPlugins = await this.getEnabledPlugins();
    return enabledPlugins[pluginId] === false;
  }
}
